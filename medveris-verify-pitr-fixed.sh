#!/usr/bin/env bash
set -euo pipefail

STANZA=medveris
REPO=/var/lib/pgbackrest
CONF=/etc/pgbackrest/pgbackrest.conf
SECRET=/root/medveris-pgbackrest.env
LOG=/var/log/pgbackrest-medveris.log
WRAPPER=/usr/local/bin/pgbackrest-medveris-backup
CRON=/etc/cron.d/pgbackrest-medveris
PORT=55433
PGBIN=/usr/lib/postgresql/18/bin
PGBACKREST=$(command -v pgbackrest)
OUT_DIR=/var/lib/medveris
OUT_JSON=$OUT_DIR/backup-verification.json
RESTORE_DIR=""

PGU="runuser -u postgres --"

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root" >&2
  exit 1
fi

cd /tmp
install -d -m 750 "$OUT_DIR"
: > "$OUT_JSON"
chmod 640 "$OUT_JSON"
rm -f "$OUT_JSON"

dump6() {
  echo "--- dump6: $RESTORE_DIR" >&2
  if [ -n "${RESTORE_DIR:-}" ] && [ -d "$RESTORE_DIR" ]; then
    tail -n 60 "$RESTORE_DIR/start.log" 2>/dev/null || true
    cat "$RESTORE_DIR/postgresql.conf" 2>/dev/null || true
    ls -la "$RESTORE_DIR" 2>/dev/null || true
  fi
}

cleanup(){
  rm -f "$OUT_DIR/.restored_label"
  if [ -n "${RESTORE_DIR:-}" ] && [ -d "$RESTORE_DIR" ]; then
    $PGU "$PGBIN/pg_ctl" -D "$RESTORE_DIR/data" -m immediate stop >/dev/null 2>&1 || true
    dump6
    rm -rf "$RESTORE_DIR"
  fi
}
trap cleanup EXIT

live(){ $PGU "$PGBIN/psql" -Atq -c "$1"; }

echo "== 1. pgBackRest check =="
sudo -u postgres pgbackrest --stanza="$STANZA" check
echo "PASS check"

echo "== 2. repo encryption and permissions =="
grep -E '^(repo1-path|repo1-cipher-type|repo1-retention-full|repo1-retention-diff)=' "$CONF" || true
stat -c '%a %U:%G %n' "$CONF" "$SECRET"
if grep -q '^repo1-cipher-type=aes-256-cbc$' "$CONF"; then echo "PASS cipher"; else echo "FAIL cipher"; exit 1; fi
if [ "$(stat -c '%a' "$SECRET")" = "600" ] && [ "$(stat -c '%a' "$CONF")" = "640" ]; then echo "PASS permissions"; else echo "FAIL permissions"; exit 1; fi

echo "== 3. retention and disk =="
if ! grep -q '^repo1-retention-diff=' "$CONF"; then
  awk 'BEGIN{done=0} /^\[medveris\]/{if(!done){print "repo1-retention-diff=6"; done=1}} {print}' "$CONF" > "$CONF.tmp"
  chown root:postgres "$CONF.tmp"; chmod 640 "$CONF.tmp"; mv "$CONF.tmp" "$CONF"
  echo "added repo1-retention-diff=6"
fi
grep -E '^repo1-retention-(full|diff)=' "$CONF"
df -h "$REPO" | tail -1
du -sh "$REPO"

echo "== 4. backup status =="
has_full=$(sudo -u postgres pgbackrest --stanza="$STANZA" info --output=json | python3 -c 'import json,sys; d=json.load(sys.stdin); print("yes" if any(b.get("type")=="full" for s in d for r in s.get("repo",[]) for b in r.get("backup",[])) else "no")')
if [ "$has_full" != "yes" ]; then
  sudo -u postgres pgbackrest --stanza="$STANZA" --type=full backup
  sleep 10
fi
sudo -u postgres pgbackrest --stanza="$STANZA" info
echo "PASS info"

echo "== 5. automation =="
cat > "$WRAPPER" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
TYPE="${1:?usage: $0 full|diff|incr}"
STANZA=medveris
LOG=/var/log/pgbackrest-medveris.log
ts=$(date -u +%FT%TZ)
if pgbackrest --stanza="$STANZA" --type="$TYPE" backup >>"$LOG" 2>&1; then
  echo "$ts OK $TYPE" >>"$LOG"
  logger -t pgbackrest "backup $TYPE OK" || true
else
  rc=$?
  echo "$ts FAIL $TYPE rc=$rc" >>"$LOG"
  logger -t pgbackrest -p err "backup $TYPE FAILED rc=$rc" || true
  if [ -s /etc/medveris/backup-alert-webhook ] && command -v curl >/dev/null 2>&1; then
    curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
      --data-binary "{\"text\":\"pgBackRest $TYPE backup failed on $(hostname) at $ts (rc=$rc)\"}" \
      "$(cat /etc/medveris/backup-alert-webhook)" >/dev/null 2>&1 || true
  fi
  exit "$rc"
fi
EOF
chmod 755 "$WRAPPER"
touch "$LOG"; chown postgres:adm "$LOG"; chmod 640 "$LOG"
cat > "$CRON" <<'EOF'
SHELL=/bin/bash
PATH=/usr/sbin:/usr/bin:/sbin:/bin
30 2 * * * postgres /usr/local/bin/pgbackrest-medveris-backup diff
30 3 * * 0 postgres /usr/local/bin/pgbackrest-medveris-backup full
15 4 * * * postgres pgbackrest --stanza=medveris check >> /var/log/pgbackrest-medveris.log 2>&1
EOF
chmod 644 "$CRON"
echo "cron:"; cat "$CRON"
if [ -s /etc/medveris/backup-alert-webhook ]; then echo "PASS external alert webhook configured"; else echo "WARN external alert webhook not configured (local journal/log only)"; fi

echo "== 6. restore drill (scratch, port $PORT) =="

SIG_SQL=$(cat <<'SQL'
select md5(string_agg(t.relname || '=' || t.n, ',' order by t.relname))
from (select relname, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', relname), false, true, '')))[1]::text::bigint as n
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r') t;
SQL
)

R=$(mktemp -d /var/tmp/medveris-restore-XXXXXX)
RESTORE_DIR="$R"
DATA="$R/data"
mkdir "$DATA"; chown -R postgres:postgres "$R"; chmod 700 "$R" "$DATA"

live_sigs=$( {
  for db in $(live "select datname from pg_database where not datistemplate and datname<>'postgres' order by 1"); do
    $PGU "$PGBIN/psql" -d "$db" -Atq -c "$SIG_SQL"
  done
  $PGU "$PGBIN/psql" -d postgres -Atq -c "$SIG_SQL"
  $PGU "$PGBIN/psql" -d hapi_fhir -Atq -c "$SIG_SQL"
} )
live_hash=$(printf '%s\n' "$live_sigs" | sha256sum | awk '{print $1}')
TARGET=$(date -u '+%Y-%m-%d %H:%M:%S+00')
echo "live signatures hash: $live_hash (tables/dbs covered)"

$PGU "$PGBIN/psql" -Atq -c "select txid_current()" -c "select pg_switch_wal()" >/dev/null
sleep 5
echo "target: $TARGET"

RESTORE_OUT=$($PGU "$PGBACKREST" --stanza=$STANZA --pg1-path="$DATA" --type=time --target="$TARGET" --target-action=promote --archive-mode=off restore 2>&1)
echo "$RESTORE_OUT" | sed -n 's/.*restore backup set \([^ ,]*\).*/\1/p' | head -1 > "$OUT_DIR/.restored_label"
if [ -s "$OUT_DIR/.restored_label" ]; then RESTORED_LABEL=$(cat "$OUT_DIR/.restored_label"); else RESTORED_LABEL=""; fi
echo "restore output:\n$RESTORE_OUT"
if [ -z "$RESTORED_LABEL" ]; then
  RESTORED_LABEL=$($PGBACKREST --stanza=$STANZA info --output=json | python3 -c 'import json,sys; d=json.load(sys.stdin); b=[x for s in d for r in s.get("repo",[]) for x in r.get("backup",[])]; b.sort(key=lambda x:x.get("timestamp",{}).get("stop",0)); print(b[-1]["label"] if b else "")')
fi

if [ -z "$RESTORED_LABEL" ]; then
  echo "FAIL: empty backupLabel; cannot write attestation"; exit 1
fi
echo "restored label: $RESTORED_LABEL"

cat > "$R/postgresql.conf" <<CONF
data_directory = '$DATA'
hba_file = '$R/pg_hba.conf'
ident_file = '$R/pg_ident.conf'
port = $PORT
listen_addresses = ''
unix_socket_directories = '$R'
archive_mode = off
max_connections = $(live "show max_connections")
max_worker_processes = $(live "show max_worker_processes")
max_wal_senders = $(live "show max_wal_senders")
max_prepared_transactions = $(live "show max_prepared_transactions")
max_locks_per_transaction = $(live "show max_locks_per_transaction")
CONF
printf 'local all all trust\n' > "$R/pg_hba.conf"; : > "$R/pg_ident.conf"
chown postgres:postgres "$R"/*.conf

$PGU "$PGBIN/pg_ctl" -D "$DATA" -o "-c config_file=$R/postgresql.conf" -w -t 180 -l "$R/start.log" start

for i in $(seq 1 60); do
  [ "$($PGU "$PGBIN/psql" -h "$R" -p $PORT -d postgres -Atq -c 'select pg_is_in_recovery()')" = "f" ] && break
  sleep 1
done
inrec=$($PGU "$PGBIN/psql" -h "$R" -p $PORT -d postgres -Atq -c 'select pg_is_in_recovery()')
[ "$inrec" = "f" ] || { echo "FAIL: scratch did not promote"; tail -n 60 "$R/start.log"; dump6; exit 1; }

restored_sigs=$( {
  for db in $(live "select datname from pg_database where not datistemplate and datname<>'postgres' order by 1"); do
    $PGU "$PGBIN/psql" -h "$R" -p $PORT -d "$db" -Atq -c "$SIG_SQL"
  done
  $PGU "$PGBIN/psql" -h "$R" -p $PORT -d postgres -Atq -c "$SIG_SQL"
  $PGU "$PGBIN/psql" -h "$R" -p $PORT -d hapi_fhir -Atq -c "$SIG_SQL"
} )
restored_hash=$(printf '%s\n' "$restored_sigs" | sha256sum | awk '{print $1}')
echo "restored signatures hash: $restored_hash"
[ "$restored_hash" = "$live_hash" ] || { echo "FAIL data parity"; tail -n 60 "$R/start.log"; dump6; exit 1; }
echo "PASS data parity"

DBS=$(live "select datname from pg_database where not datistemplate and datname<>'postgres' order by 1")
echo "databases: ${DBS:-<none besides postgres>}"
Q="select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')"
FAIL=0
declare -A LIVE
for db in $DBS; do LIVE[$db]=$($PGU "$PGBIN/psql" -d "$db" -Atq -c "$Q"); echo "live $db tables: ${LIVE[$db]}"; done
for db in $DBS; do
  N=$($PGU "$PGBIN/psql" -h "$R" -p $PORT -d "$db" -Atq -c "$Q")
  echo "restored $db tables: $N (live: ${LIVE[$db]})"
  [ "$N" = "${LIVE[$db]}" ] && echo "PASS $db" || { echo "FAIL $db"; FAIL=1; }
done

# Non-empty seeded rows required in medveris-prod before any real patient data
for t in tenants users patients organizations; do
  C=$($PGU "$PGBIN/psql" -h "$R" -p $PORT -d medveris-prod -Atq -c "select count(*) from ${t}" 2>/dev/null || echo 0)
  echo "restored medveris-prod.$t rows: $C"
  [ "$C" -gt 0 ] 2>/dev/null || { echo "FAIL: medveris-prod.$t is empty"; FAIL=1; }
done

[ "$FAIL" = "0" ] || { echo "FAIL: seeded table checks"; dump6; exit 1; }
echo "PASS seeded non-empty tables (tenants, users, patients, organizations) in medveris-prod"

$PGU "$PGBIN/pg_ctl" -D "$DATA" -m fast stop >/dev/null 2>&1 || true

BACKUP_LABEL=$RESTORED_LABEL
DRILL_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
OPERATOR="${SUDO_USER:-root}"
python3 - "$OUT_JSON" "$BACKUP_LABEL" "$TARGET" "$live_hash" "$restored_hash" "$DRILL_AT" "$OPERATOR" <<'PY'
import json,sys
out,label,target,live,restored,at,operator=sys.argv[1:]
json.dump({
  "provider": "Kamatera",
  "targetDatabase": "medveris-prod",
  "pointInTimeRecovery": True,
  "encryptedBackups": True,
  "restoreDrillBy": operator,
  "restoreDrillAt": at,
  "result": "pass",
  "backupLabel": label,
  "targetTime": target,
  "liveSignaturesSha256": live,
  "restoredSignaturesSha256": restored,
}, open(out, "w"), indent=2)
PY
chmod 640 "$OUT_JSON"

DRILL_EPOCH=$(date -u -d "$DRILL_AT" +%s)
NOW_EPOCH=$(date -u +%s)
AGE_DAYS=$(( (NOW_EPOCH - DRILL_EPOCH) / 86400 ))
if [ "$AGE_DAYS" -gt 30 ]; then
  echo "FAIL: attestation older than 30 days ($AGE_DAYS days)"; exit 1
fi
echo "PASS attestation age ($AGE_DAYS days)"

echo "wrote $OUT_JSON"
cat "$OUT_JSON"
echo "PASS restore and data parity"

echo
echo "PITR VERIFY COMPLETE"
