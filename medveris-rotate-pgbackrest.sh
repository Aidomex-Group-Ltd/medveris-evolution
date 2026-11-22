#!/usr/bin/env bash
set -Eeuo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }
cd /tmp
STANZA=medveris
CONF=/etc/pgbackrest/pgbackrest.conf
ENVF=/root/medveris-pgbackrest.env
REPO=/var/lib/pgbackrest
TS=$(date -u +%Y%m%dT%H%M%SZ)
OLD=${REPO}.old-$TS
PGB="runuser -u postgres -- pgbackrest --stanza=$STANZA"
umask 077

read -r -p "Type ROTATE to replace the repo1 passphrase and start a fresh backup repo: " A
[ "$A" = "ROTATE" ] || { echo aborted; exit 1; }

REPO_U=$(stat -c %U "$REPO"); REPO_G=$(stat -c %G "$REPO"); REPO_M=$(stat -c %a "$REPO")
install -m 600 -o root -g root "$CONF" /root/pgbackrest.conf.bak-$TS
install -m 600 -o root -g root "$ENVF" /root/medveris-pgbackrest.env.bak-$TS

rollback(){
  echo "!! FAILED - rolling back to the old repo and passphrase"
  if [ -d "$OLD" ]; then rm -rf "$REPO"; mv "$OLD" "$REPO"; fi
  install -m 640 -o root -g postgres /root/pgbackrest.conf.bak-$TS "$CONF"
  install -m 600 -o root -g root /root/medveris-pgbackrest.env.bak-$TS "$ENVF"
  $PGB start || true
  echo "Rolled back. Verify with: sudo -u postgres pgbackrest --stanza=$STANZA check"
}
trap rollback ERR

echo "== 1. pre-check on the old repo =="
$PGB check

echo "== 2. generate new passphrase (never printed) =="
NEW=$(openssl rand -base64 32)

echo "== 3. stop archiving, move old repo aside =="
$PGB stop
mv "$REPO" "$OLD"
install -d -m "$REPO_M" -o "$REPO_U" -g "$REPO_G" "$REPO"

echo "== 4. install new passphrase =="
TMP=$(mktemp)
NEWPASS="$NEW" awk 'BEGIN{p=ENVIRON["NEWPASS"]} /^repo1-cipher-pass=/{print "repo1-cipher-pass=" p; next} {print}' "$CONF" > "$TMP"
grep -q '^repo1-cipher-pass=' "$TMP"
install -m 640 -o root -g postgres "$TMP" "$CONF"; rm -f "$TMP"
printf 'PGBACKREST_CIPHER_PASS=%s\n' "$NEW" > "$ENVF"
chown root:root "$ENVF"; chmod 600 "$ENVF"
unset NEW
! cmp -s "$CONF" /root/pgbackrest.conf.bak-$TS   # config must differ from the old one

echo "== 5. start archiving, create stanza on new repo =="
$PGB start
$PGB stanza-create
$PGB check

echo "== 6. first full backup on the new repo =="
$PGB --type=full --start-fast backup
$PGB info

echo "== 7. archiver state =="
runuser -u postgres -- psql -Atc "select 'failed_count='||failed_count||' last_archived_wal='||last_archived_wal from pg_stat_archiver"
stat -c "%a %U:%G %n" "$CONF" "$ENVF" "$REPO"

trap - ERR
echo "OK. Old repo kept at $OLD (encrypted with the OLD exposed passphrase)."
echo "Old config/env copies: /root/pgbackrest.conf.bak-$TS /root/medveris-pgbackrest.env.bak-$TS"
