#!/usr/bin/env python3
path = "/tmp/medveris-verify-pitr.sh"
with open(path) as f:
    lines = f.readlines()

# Insert from bottom to top so line numbers stay valid

# 3. 30-day attestation age gate (epoch-second comparison, avoids timestamp integer-test bug)
# Insert after line 227 (chmod 640 "$OUT_JSON") -> index 228
age_gate = '''
DRILL_EPOCH=$(date -u -d "$DRILL_AT" +%s)
NOW_EPOCH=$(date -u +%s)
AGE_DAYS=$(( (NOW_EPOCH - DRILL_EPOCH) / 86400 ))
if [ "$AGE_DAYS" -gt 30 ]; then
  echo "FAIL: attestation older than 30 days ($AGE_DAYS days)"; exit 1
fi
echo "PASS attestation age ($AGE_DAYS days)"
'''
lines.insert(228, age_gate)

# 2. Non-empty seeded table checks after line 203 (done closing parity loop) -> index 203
seeded = '''
for t in tenants users patients organizations; do
  for db in $DBS; do
    C=$($PGU "$PGBIN/psql" -h "$R" -p $PORT -d "$db" -Atq -c "select count(*) from ${t}" 2>/dev/null || echo 0)
    echo "restored $db.$t rows: $C"
    [ "$C" -gt 0 ] 2>/dev/null || { echo "FAIL: $db.$t is empty"; FAIL=1; }
  done
done
'''
lines.insert(203, seeded)

# 1. Fail on empty backupLabel after line 153 (fi closing fallback) -> index 153
empty_label = '''
if [ -z "$RESTORED_LABEL" ]; then
  echo "FAIL: empty backupLabel; cannot write attestation"; exit 1
fi
'''
lines.insert(153, empty_label)

with open(path, "w") as f:
    f.writelines(lines)
print("patched OK")
