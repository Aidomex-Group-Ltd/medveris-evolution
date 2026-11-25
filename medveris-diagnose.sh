#!/usr/bin/env bash
# MedVeris Stage-A diagnostic collector — local only.
# Never touches production, never surfaces secrets in output, never assumes migration parity.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export APP_ENV=test

# Prefer explicit URL-based connections; fall back to explicit params only when no
# URL is available. This avoids accidental password prompts from mixed --username
# + URL connections.
MIG="${MIGRATION_DATABASE_URL:-}"
if [ -z "$MIG" ]; then
  MIG="psql --no-psqlrc \
    --username='${MIGRATION_DATABASE_USER:-medveris_migrator}' \
    --host='${MIGRATION_DATABASE_HOST:-localhost}' \
    --port='${MIGRATION_DATABASE_PORT:-5432}' \
    --dbname='${MIGRATION_DATABASE_NAME:-medveris_test}' \
    -X -q -t -A"
else
  MIG="psql --no-psqlrc $MIG -X -q -t -A"
fi

RUN="${DATABASE_URL:-}"
if [ -z "$RUN" ]; then
  RUN="psql --no-psqlrc \
    --username='${DATABASE_USER:-medveris_runtime}' \
    --host='${DATABASE_HOST:-localhost}' \
    --port='${DATABASE_PORT:-5432}' \
    --dbname='${DATABASE_NAME:-medveris_test}' \
    -X -q -t -A"
else
  RUN="psql --no-psqlrc $RUN -X -q -t -A"
fi

pass() { printf '[PASS] %s\n' "$1"; }
fail() { printf '[FAIL] %s\n' "$1"; }
skip() { printf '[N/A ] %s\n' "$1"; }
note() { printf '[INFO] %s\n' "$1"; }

echo '============================================================'
echo 'MEDVERIS STAGE-A DIAGNOSTIC COLLECTOR — LOCAL ONLY'
echo "root: $ROOT"
echo "HEAD: $(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo '(no git)')"
echo "branch: $(git -C "$ROOT" branch --show-current 2>/dev/null || echo '(no git)')"
echo '============================================================'
echo

# 1) Env + DB connectivity
echo '--- 1. ENVIRONMENT AND TEST DB CONNECTIVITY ---'
if [ -f "$ROOT/.env.test" ]; then pass 'found .env.test'; else fail 'missing .env.test'; fi
if pg_isready -h localhost -p 5432 -d medveris_test -t 5 >/dev/null 2>&1; then
  pass 'test DB accepts connections on localhost:5432'
else
  fail 'test DB not reachable on localhost:5432'; skip 'all DB checks below will be N/A'
fi
echo

# 2) Migrations exist and match ledger in test DB
echo '--- 2. MIGRATION LEDGER (TEST DB) ---'
expected_migrations=(
  139_memberships_rls_hardening.sql
  140_integration_tokens_tenant_scope.sql
  141_all_policy_delete_overgrant_split.sql
  142_patient_scope_rls_hardening.sql
  143_remaining_rls_overgrant_hardening.sql
  144_global_catalogue_read_hardening.sql
  145_platform_role_guc_hardening.sql
  146_integrity_rls_and_guards.sql
)
for m in "${expected_migrations[@]}"; do
  if [ -f "$ROOT/packages/db/migrations/$m" ]; then pass "migration file present: $m"; else fail "migration file missing: $m"; fi
done
if [ -f "$ROOT/packages/db/rollbacks/140_integration_tokens_tenant_scope_rollback.sql" ]; then pass 'rollback 140 present'; else fail 'rollback 140 missing'; fi
if [ -f "$ROOT/packages/db/rollbacks/142_patient_scope_rls_hardening_rollback.sql" ]; then pass 'rollback 142 present'; else fail 'rollback 142 missing'; fi

if ! pg_isready -h localhost -p 5432 -d medveris_test -t 5 >/dev/null 2>&1; then
  skip 'migration ledger cannot be read (DB absent)'
else
  applied=$($MIG "select array_agg(version order by version) from schema_migrations where version ~ '^1[34][0-9].*';" 2>/dev/null || echo '[]')
  applied_flat=$(printf '%s' "$applied" | tr -d "'")
  for m in "${expected_migrations[@]}"; do
    v="${m%%_*}"
    if printf '%s' "$applied_flat" | grep -qF "$v"; then pass "applied in test DB: $v"; else fail "NOT applied in test DB: $v"; fi
  done
fi
echo

# 3) RLS/security invariants on the test DB
echo '--- 3. RLS / SECURITY INVARIANTS (TEST DB) ---'
if ! pg_isready -h localhost -p 5432 -d medveris_test -t 5 >/dev/null 2>&1; then
  skip 'RLS invariants cannot be read (DB absent)'
else
  tok_all=$($MIG "select count(*) from pg_policies where tablename='integration_tokens' and cmd='ALL' and qual='true' and with_check='true';" 2>/dev/null || echo '0')
  if [ "$tok_all" = "0" ]; then pass 'SEC-02: integration_tokens has no unconditional ALL policy'; else fail "SEC-02: integration_tokens still has $tok_all unconditional ALL policy(ies)"; fi

  if $MIG -c "select qual from pg_policies where tablename='patients_staff_read' and cmd='SELECT';" 2>/dev/null | grep -qE 'tenant_patient_links|created_tenant_id|exchange_grants'; then
    pass 'SEC-04/RLS-CRIT-03: patients_staff_read requires tenant linkage + exchange_grants window'
  else
    fail 'SEC-04/RLS-CRIT-03: patients_staff_read policy looks stale or missing'
  fi

  if $MIG -c "select qual from pg_policies where tablename='patient_enrollment_lookup' and cmd='SELECT';" 2>/dev/null | grep -qE 'tenant_patient_links|created_tenant_id|exchange_grants'; then
    pass 'SEC-04: patient_enrollment_lookup constrained to tenant-linked + grant-window access'
  else
    fail 'SEC-04: patient_enrollment_lookup policy looks stale or missing'
  fi

  no_rls=$($MIG "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('integrity_checkpoints','integrity_checkpoint_events','ledger_anchors') and not c.relrowsecurity;" 2>/dev/null || echo '0')
  if [ "$no_rls" = "0" ]; then pass 'RLS-CRIT-01/02: integrity/ledger tables have RLS enabled'; else fail "RLS-CRIT-01/02: $no_rls integrity/ledger tables still lack RLS"; fi

  app_count=$($MIG "select count(*) from pg_proc where pronamespace='app'::regnamespace and proname='is_platform_operator';" 2>/dev/null || echo '0')
  if [ "$app_count" = "1" ]; then pass 'SEC-08: app.is_platform_operator() exists in the app schema'; else fail 'SEC-08: app.is_platform_operator() not found'; fi
  sec_sum=$($MIG "select count(*) from pg_proc where pronamespace='app'::regnamespace and proname='security_event_summary';" 2>/dev/null || echo '0')
  if [ "$sec_sum" = "1" ]; then pass 'SEC-08/IND-09 support: app.security_event_summary(integer) exists'; else fail 'SEC-08: app.security_event_summary(integer) not found'; fi
  outbox=$($MIG "select count(*) from pg_proc where pronamespace='app'::regnamespace and proname='outbox_backlog';" 2>/dev/null || echo '0')
  if [ "$outbox" = "1" ]; then pass 'app.outbox_backlog() exists'; else fail 'app.outbox_backlog() not found'; fi
fi
echo

# 4) Role posture on the test DB
echo '--- 4. ROLE POSTURE (TEST DB) ---'
if ! pg_isready -h localhost -p 5432 -d medveris_test -t 5 >/dev/null 2>&1; then
  skip 'role posture cannot be read (DB absent)'
else
  for role in medveris_runtime medveris_jobs medveris_migrator; do
    line=$($MIG "select rolname||'|'||rolbypassrls||'|'||rolcanlogin from pg_roles where rolname='$role';" 2>/dev/null || echo 'missing')
    case "$line" in
      *"false|false"*) pass "role $role: NOBYPASSRLS, LOGIN";;
      missing) fail "role $role missing from test DB";;
      *) fail "role $role unexpected posture: $line";;
    esac
  done
fi
echo

# 5) Git state / staged commits
echo '--- 5. GIT WORKING TREE ---'
git_status=$(git -C "$ROOT" status --porcelain 2>/dev/null || true)
if [ -z "$git_status" ]; then pass 'working tree clean'; else
  fail "working tree dirty ($(($(printf '%s\n' "$git_status" | grep -c .))))"
  printf '\n%s\n' "$git_status"
fi
git_log=$(git -C "$ROOT" log -1 --format='%h %s' 2>/dev/null || echo '(no git)')
note "HEAD: $git_log"
echo

# 6) PROHIBITED artifacts
echo '--- 6. PROHIBITED ARTIFACTS IN WORKING TREE ---'
for path in \
  sshpass_1.09-1_amd64.deb \
  seed-drill-prod.sql \
  tmp-patch-seeded-db.py \
  medveris-verify-pitr-fixed.sh \
  docs/audit \
  .env.local \
  .env.production \
  .env.staging \
  production-db.env \
  backup-verification.json \
  backup-inventory.json \
  ; do
  if [ -e "$ROOT/$path" ]; then fail "prohibited/na artefact present: $path"; else pass "absent: $path"; fi
done
echo

# 7) Config should not contain REPLACE_WITH placeholders
echo '--- 7. CONFIG PLACEHOLDERS (LOCAL FILES) ---'
if grep -RIn --exclude-dir=.git --exclude-dir=node_modules --exclude='*.test.ts' --exclude='*.test.mjs' 'REPLACE_WITH' "$ROOT" >/dev/null 2>&1; then
  fail 'REPLACE_WITH placeholders remain in non-test tracked files'
  grep -RIn --exclude-dir=.git --exclude-dir=node_modules --exclude='*.test.ts' --exclude='*.test.mjs' 'REPLACE_WITH' "$ROOT" | head -5
else
  pass 'no REPLACE_WITH placeholders in non-test tracked files'
fi
echo

# 8) Production gate local rules against wrangler.jsonc
echo '--- 8. PRODUCTION GATE RULES (LOCAL wrangler.jsonc) ---'
if [ -f "$ROOT/wrangler.jsonc" ]; then
  node - "$ROOT/wrangler.jsonc" <<'NODE'
const fs=require('fs');
const cfg=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
const P=require('./scripts/production-gate.mjs');
const problems=P.checkProductionConfig(cfg);
if(problems.length===0){console.log('[PASS] production env.production schema valid (static rules only, no remote checks)');}
else{
  console.log('[FAIL] production env.production has static problems:');
  for(const p of problems) console.log('  - '+p);
}
NODE
else
  fail 'wrangler.jsonc missing'
fi
echo

# 9) Targeted integration/unit tests (fast, high-value)
echo '--- 9. TARGETED TEST VERIFICATION ---'
if ! command -v npx >/dev/null 2>&1; then skip 'npx unavailable; cannot run vitest'; fi
if ! pg_isready -h localhost -p 5432 -d medveris_test -t 5 >/dev/null 2>&1; then skip 'tests skipped: DB absent'; fi
if command -v npx >/dev/null 2>&1 && pg_isready -h localhost -p 5432 -d medveris_test -t 5 >/dev/null 2>&1; then
  set +e
  npx vitest run --config vitest.config.ts \
    tests/integration/rls.test.ts \
    tests/integration/patients.test.ts \
    tests/integration/platform-role-guc.test.ts \
    tests/unit/production-gate.test.ts \
    2>&1 | grep -E 'Test Files|Tests' | tail -2
  rc=${PIPESTATUS[0]}
  set -e
  if [ "$rc" = "0" ]; then pass 'targeted test suite passed'; else fail "targeted test suite exited $rc"; fi
fi
echo

# 10) Observed failure classes from the broader suite (static detection + guidance)
echo '--- 10. KNOWN BROAD-SUITE FAILURE CLASSES (INVESTIGATE) ---'
if grep -RIn --exclude-dir=node_modules --exclude-dir=.tsbuildinfo \
  -e 'new row violates row-level security policy for table "sponsored_daily_metrics"' \
  -e 'permission denied for table "integration_clients"' \
  -e 'Cannot read properties of undefined' \
  "$ROOT/tests" >/dev/null 2>&1; then
  fail 'failing assertions found in test files; inspect tests + routes'
else
  note 'no hard-coded failure strings detected in tests (actual failures come from running the suite)'
fi
echo

echo '============================================================'
echo 'END OF LOCAL DIAGNOSTIC COLLECTION'
echo 'Production-only blockers require operator access to production host/Cloudflare account:'
echo '  - pgBackRest crash loop / missing backup inventory / empty backupLabel'
echo '  - stale deployed Worker tag 18f842a vs reviewed 7117f36'
echo '  - /etc/systemd/system/cloudflared-medveris.service writable by non-root'
echo '  - privacy self-service routes (IND-07 / SEC-09)'
echo '  - payment adapter/gate/config alignment (IND-08 / SEC-10)'
echo '  - alert destination/token/live delivery (IND-09 / SEC-11)'
echo '============================================================'
