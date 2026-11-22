#!/usr/bin/env bash
set -euo pipefail
cd /tmp
PGBIN=/usr/lib/postgresql/18/bin
STANZA=medveris
PORT=55433
PGU="runuser -u postgres --"
R=$(mktemp -d /var/tmp/medveris-restore-XXXXXX)
DATA=$R/data
mkdir "$DATA"; chown -R postgres:postgres "$R"; chmod 700 "$R" "$DATA"

cleanup(){
  $PGU $PGBIN/pg_ctl -D "$DATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$R"; echo "cleaned up $R"
}
trap cleanup EXIT

live(){ $PGU psql -Atq -c "$1"; }

echo "== live reference =="
DBS=$(live "select datname from pg_database where not datistemplate and datname<>'postgres' order by 1")
echo "databases: ${DBS:-<none besides postgres>}"
Q="select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')"
declare -A LIVE
for db in $DBS; do LIVE[$db]=$($PGU psql -d "$db" -Atq -c "$Q"); echo "live $db tables: ${LIVE[$db]}"; done

echo "== create PITR target with later WAL activity =="
sleep 3
TARGET=$(date -u '+%Y-%m-%d %H:%M:%S+00')
sleep 3
$PGU psql -Atq -c "select txid_current()" -c "select pg_switch_wal()" >/dev/null
sleep 5
echo "target: $TARGET"

echo "== restore (archiving disabled in restored copy) =="
$PGU pgbackrest --stanza=$STANZA --pg1-path="$DATA" --type=time --target="$TARGET" \
  --target-action=promote --archive-mode=off restore

echo "== scratch config (must match primary sizing params for recovery) =="
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

echo "== start scratch instance =="
$PGU $PGBIN/pg_ctl -D "$DATA" -o "-c config_file=$R/postgresql.conf" -w -t 180 -l "$R/start.log" start

for i in $(seq 1 60); do
  [ "$($PGU psql -h "$R" -p $PORT -d postgres -Atq -c 'select pg_is_in_recovery()')" = "f" ] && break
  sleep 1
done
echo "in_recovery: $($PGU psql -h "$R" -p $PORT -d postgres -Atq -c 'select pg_is_in_recovery()')"

echo "== sanity comparison =="
FAIL=0
for db in $DBS; do
  N=$($PGU psql -h "$R" -p $PORT -d "$db" -Atq -c "$Q")
  echo "restored $db tables: $N (live: ${LIVE[$db]})"
  [ "$N" = "${LIVE[$db]}" ] && echo "PASS $db" || { echo "FAIL $db"; FAIL=1; }
done
tail -n 15 "$R/start.log" || true
[ $FAIL -eq 0 ] && echo "PASS restore test" || { echo "FAIL restore test"; exit 1; }
