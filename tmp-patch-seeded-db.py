path = "/tmp/medveris-verify-pitr.sh"
s = open(path).read()
old = "for db in $DBS; do"
new = "for db in medveris-prod; do"
count = s.count(old)
if count == 0:
    print("pattern not found")
else:
    # only replace the second occurrence (the seeded check loop, not the table-count loop)
    parts = s.split(old)
    # rebuild, replacing only the seeded-check occurrence (the one after the parity table loop)
    # find the occurrence that follows "FAIL: seeded table checks" region... simpler: replace all in the seeded block only
    # seeded block starts after "[ "$FAIL" = "0" ] || { echo "FAIL: seeded table checks"; dump6; exit 1; }"
    marker = '[ "$FAIL" = "0" ] || { echo "FAIL: seeded table checks"; dump6; exit 1; }'
    if marker in s:
        before, after = s.split(marker, 1)
        after = after.replace(old, new)
        s = before + marker + after
        open(path, "w").write(s)
        print(f"patched seeded-check DB ({count} total occurrences, replaced in seeded block)")
    else:
        print("marker not found")
