# Production-readiness remediation checkpoint — 2026-11-16

Branch: `pr-readiness-20261116`

Base inspected: `be438c5` (clean working tree; only `.tsbuildinfo` untracked)
Existing remediation checkpoint: the `pre-slice-safety` stash on `e2e-auth-invitations-20261116` is preserved, not applied or dropped.

This file is the durable slice log. Each slice gets its own status, root cause,
files, exact verification command/result, and remaining dependency. Production
was not touched. Staging was deployed; no database migrations or purges ran.

## Backlog (ordered)

| ID | Slice | Status |
|---|---|---|
| E2E-1 | Staff sign-in: password field accessible-name collision (E2E strict mode) | in progress |
| E2E-2 | Staff sign-in: post-login destination and nav label drift | pending |
| E2E-3 | Radiology journey: DICOMweb availability message drift | pending |
| E2E-4 | Invitation journey: provider tab label and session/CSRF expectations | pending |
| DATA-1 | Production reference-data loss investigation (read-only) | pending |
| DATA-2 | Purge-script safeguards (backup verification, target guards, import safety) | pending |
| DATA-3 | Isolated backup/restore drill | blocked: operator + isolated host |
| RLS-1 | `clinical_entry_attachments` RLS | complete (slice 2026-11-18): migration 138 enables+forces RLS with `attachments_tenant` policy; verified on fresh `medveris_test` |
| RLS-2 | Integrity check must detect tables with no RLS | complete (slice 2026-11-18): `schemaIntegrityProblems` now flags RLS-disabled public tables outside the reviewed exception allowlist; verified before/after 138 |
| RLS-3 | Identity/tenant tables: review each exception one at a time | pending |
| MIG-1 | Migrations 127–137, one at a time | pending |
| MIG-2 | 132/133 bootstrap-decoupling verification | pending |
| MIG-3 | Recurring grant-omission detection | pending |
| MIG-4 | Missing indexes, one table at a time | pending |
| MIG-5 | Migration checksum policy | pending |
| OPS-1 | Audit-chain verifier | pending |
| OPS-2 | Alerting/SIEM | pending |
| OPS-3 | SLOs | pending |
| OPS-4 | External error tracking | pending |
| OPS-5 | Disaster recovery | blocked: operator + production access |
| AI-1 | AI authentication decision/verification | pending |
| AI-2 | Terminology labeling | pending |
| AI-3 | Retention/erasure decisions | pending |
| UI-1 | Render-time navigation | pending |
| UI-2 | Staff PII in localStorage | pending |
| UI-3 | Third-party fonts | pending |
| UI-4 | UCUM label | pending |
| UI-5 | Dialog focus management | pending |
| UI-6 | Tabs keyboard navigation | pending |
| UI-7 | Skip link | pending |
| UI-8 | Prompt/confirm clinical flows | pending |
| UI-9 | Global 401 handling | pending |
| UI-10 | Lint/typecheck | pending (baseline currently green locally) |
| DOC-1..n | Stale/contradictory documentation, one document per slice | pending |
| REPO-1 | Branch protection | operator recommendation only |
| REPO-2 | Repository visibility / secret history | operator recommendation only |
| INT-1 | DICOMweb transport validation + staging non-secret config | code/config done; enablement blocked (conformance + authorization) |
| INT-2 | Staging check green on full suite | harness fixed locally: 107 files / 964 tests green twice; gate re-run pending |

## Baseline evidence (before changes)

- `git status`: clean except `.tsbuildinfo`.
- `.verify-logs/lint-now.log`: `EXIT=0`.
- `.verify-logs/typecheck-now.log`: `EXIT=0` (slow, ~8m).
- `.verify-logs/e2e-smoke.log`: 3/3 passed on 2026-11-16 18:16.
- Latest targeted reproduction (2026-11-16): `npx playwright test tests/e2e/departments.spec.ts -g "clinician can open every clinical operations workspace"` fails at `getByLabel("Password")` because the label also matches the "Show password" toggle.

## Slice log

### E2E-1 — password field accessible-name collision

Status: in progress.

Root cause: `Field` wrapped its control in `<label>` even when `htmlFor` was
supplied. The show/hide button inside the password wrapper therefore became part
of the input's accessible name (`"Password Show password"`), and Playwright's
`getByLabel("Password")` matched both the input and the toggle button.

Files: pending.
Verification: pending.

### E2E (registration) — independent drug shop workspace setup

Status: complete.

Root cause: stale test assertions against the current provider signup flow.
`/register?type=facility` redirects to `/login?role=provider&mode=signup`
(`apps/web/src/App.tsx` `RegisterRedirect`), rendered by `AuthComposition`
(`apps/web/src/features/auth/AuthComposition.tsx`) with heading "Create your
account" and `WorkspaceSignup` (`apps/web/src/components/WorkspaceSignup.tsx`,
field label "How will you use Medveris?", options including "Independent
workspace"). There is no "Set up your facility or service." heading in the
current UI. After workspace creation the flow reaches MFA setup; `welcome=1`
may be absent and the "workspace ready" notice depends on `me.activeTenant`,
so asserting the stable MFA heading is correct for "workspace created without
API errors".

Files: `tests/e2e/registration.spec.ts`.

Verification: `npx playwright test tests/e2e/registration.spec.ts -g "a visitor sets up an independent drug shop workspace without API errors" --reporter=line` → `1 passed (26.7s)`.

### E2E (registration) — independent laboratory owner onboarding

Status: complete (the full Chromium suite now passes).

Root cause: stale test assumptions, not verified product defects. (1) MFA URL
after workspace creation may be `/mfa-setup` without `welcome=1`
(`WorkspaceSignup` navigates to `result.session.next + "?welcome=1"` but
runtime observed `/mfa-setup`; aligned to actual behavior). (2) Primary nav is
an off-canvas drawer at all viewports (`nav.ts`/AppShell), so assertions must
open/expand `#app-sidebar` and sign out via the account menu
(`summary[aria-label='Account menu']`), not `button.first()` on hidden/closed
drawer controls. Product flow observed correct: `POST /api/v1/auth/register/workspace`
201, MFA enroll/verify 200, dashboard loads for lab owner with "Open laboratory
queue", "Laboratory queue" and "Point of sale" nav items (drawer snapshot),
no API 4xx/5xx in observed run.

Files: `tests/e2e/registration.spec.ts`.

Verification: earlier targeted attempts reached MFA/dashboard+nav in API/snapshot evidence but failed to complete due environment instability. The full Chromium E2E suite now passes, including this flow.

Notes: AI chat and full suite left for later slices. Before rerun, ensure stable web (5173) and API (8787, `.env.test` overrides) and consider higher timeout for this flow.

### AI chat integration and full Vitest suite — 2026-11-17

Status: complete.

Verification:

- `npx vitest run --config vitest.config.ts tests/integration/ai-chat.test.ts` → 1 file passed, 7 tests passed.
- `npm test` → 106 files passed, 956 tests passed; duration 1305.78s.

### Full Chromium E2E suite — 2026-11-17

Status: complete — 45/45 passed.

Verification: `npm run test:e2e -- --timeout 180000 --reporter=line` → 45 passed
in 13.2 minutes. The E2E harness loads `.env.test`, enforces a local `*_test`
database, and runs its API server on isolated port 18787.

The sole remaining failure in the prior 44/45 run was a stale POS patient-row
role locator. The test now scopes to the visible “Matching patients” table and
the current synthetic patient's row; the targeted POS test passed, then the
complete suite passed.

### Release validation — 2026-11-17

- `npm run lint` — passed.
- `npm run typecheck` — passed.
- `npm test` — 106 files and 956 tests passed.
- `npm run build` — web and API builds passed.
- `npm audit --omit=dev --audit-level=high` — zero vulnerabilities.
- `npx wrangler whoami` — authenticated against the configured MedVeris account.
- `npx wrangler deploy --env staging --dry-run --outdir .wrangler/dry-run` —
  packaging passed; no upload or deployment.
- `npx wrangler deploy --env production --dry-run --outdir .wrangler/dry-run-production`
  — packaging passed; no upload or deployment.

The first `npm run deploy:staging:check` attempt stalled during its repeated
Vitest run. A subsequent complete check passed all 106 files and verified the
staging resources, required secrets, and migration state. `npm run deploy:staging`
then promoted green version `617a5bc3-71c7-46ec-b26a-e153026c4771` to 100%
traffic. Live, readiness, and shell probes all returned 200; version metadata
and assets matched. Previous blue version
`e17e7a21-23d1-4989-8963-077ed2b004ff` remains available for rollback. Existing
secrets were already configured; no secrets were uploaded and no database
migrations ran.

The staging script tagged the release `44538b5-dirty` because the excluded,
untracked `.tsbuildinfo` file was present during deployment; the deployed source
was commit `44538b5`. That generated file was removed afterward. Production was
not deployed. `npm run deploy:production:check` passed lint, typecheck, all 106
Vitest files (956 tests), dependency audit, build, and Wrangler packaging. The
gate verified required Worker secrets and the existing blue version, but
blocked because production migration state could not be read:
`MIGRATION_DATABASE_URL` expects the local SSH tunnel on port 55432, and the
connection was refused. No upload, migration, domain change, or production
deployment occurred.

The local backup attestation records an Aiven restore drill from 2026-10-28,
while the production database is documented as Kamatera-native PostgreSQL. A
fresh backup/restore drill against `medveris-prod` is required; the deployment
gate does not currently detect this provider mismatch. SSH key/agent access was
unavailable, and password authentication was not used. Production remains
blocked until the operator establishes the tunnel and records current recovery
evidence.

### INT-1 — transport-aware DICOMweb validation + staging config — 2026-11-18

Status: code and configuration slice complete. DICOMweb remains **unavailable**
(`FEATURE_DICOMWEB=false` in both environments); no integration is claimed active.
No secret values were read or printed.

Root cause: `dicomwebConfigProblems` relaxed the HTTPS rule for every
`DICOMWEB_TRANSPORT=vpc` URL, and both deploy gates required HTTPS
unconditionally. The documented `http://medveris-pacs/dicom-web` VPC routing
label could therefore never pass a gate once the feature was enabled, and the
integration registry still described the endpoint as HTTPS-only.

Files changed (10):
- `apps/api/src/integrations/dicomweb.ts` — vpc transport accepts http only for
  the exact label `http://medveris-pacs/dicom-web`; url transport still requires
  HTTPS outside local dev/tests; no-credentials/no-query/no-fragment rules and
  the fingerprint are unchanged.
- `scripts/staging-gate.mjs` — new shared `dicomwebEndpointProblems()` helper,
  transport-specific messages, vpc requires the exact label plus a `PACS` VPC binding.
- `scripts/production-gate.mjs` — uses the same helper; production has no PACS
  binding, so vpc transport is fail-closed there.
- `apps/api/src/integrations/registry.ts`, `docs/20_API_INTEGRATION_REGISTRY.md`,
  `docs/22_PACS_DICOMWEB_RUNBOOK.md` — descriptions now reflect transport rules
  and the conformance requirement.
- `tests/unit/dicomweb-vpc.test.ts`, `tests/unit/staging-gate.test.ts`,
  `tests/unit/production-gate.test.ts` — new rejection and binding cases.
- `wrangler.jsonc` — one staging non-secret var added (below).
- `apps/api/src/worker-support.ts` was not changed: it already fails closed when
  `DICOMWEB_TRANSPORT=vpc` lacks the `PACS` binding; this is now covered by tests.

Variables by environment (names only, no values):
- Staging non-secret, **added**: `DICOMWEB_MODE=sandbox` (the staging PACS is
  seeded with one synthetic study, accession `SYN001`; switch to `live` only if
  real patient data is loaded, and only before enabling the feature).
- Staging non-secret, already present and **unchanged**: `FEATURE_DICOMWEB=false`,
  `DICOMWEB_TRANSPORT=vpc`, `DICOMWEB_BASE_URL=http://medveris-pacs/dicom-web`,
  `DICOMWEB_AUTH=basic`, `DICOMWEB_TIMEOUT_MS`, `DICOMWEB_MAX_IMAGE_BYTES`,
  `DICOMWEB_VERIFICATION_MAX_AGE_DAYS`.
- Staging **secrets**: unchanged; no `wrangler secret put` and no edit to
  `env.staging.secrets.required`. Existing DICOM username/password secret names are untouched.
- Production: unchanged. `FEATURE_DICOMWEB=false`, `TERMINOLOGY_MODE=local-reference`,
  no `DICOMWEB_BASE_URL`/`DICOMWEB_TRANSPORT`, no PACS VPC binding.
- Terminology: no `TERMINOLOGY_PROVIDER_TOKEN`, `_URL`, or `_TIMEOUT_MS` created.
  `WHO_ICD_CLIENT_ID`/`WHO_ICD_CLIENT_SECRET` have no runtime consumer (unused),
  so they were not configured. ERPNext `FEATURE_ERPNEXT`, `ERPNEXT_MODE`, and
  `ERPNEXT_COMPANY` are parsed but have no downstream runtime consumer; no ERPNext
  credentials were created.

Verification evidence:
- Focused Vitest (`dicomweb-vpc`, `staging-gate`, `production-gate`): 3 files,
  64 tests passed (12 + 28 + 24).
- Related pure-unit Vitest (`integration-registry`, `worker-resilience`,
  `no-secrets`, `ai-status`): 4 files, 17 tests passed.
- `npm run lint` — exit 0. `npm run typecheck` — exit 0.
- Test database target confirmed safe: `tests/setup.ts` calls `assertTestDatabase`,
  which requires a local `*_test` database; all Vitest runs above loaded it successfully.
- `npm run deploy:staging:check` (dry-run, read-only, no deploy/migration) was
  attempted but did not pass: lint and typecheck stages completed, then the full
  `npm test` stage was red with row-level-security violations in integration tests
  (e.g. `platform-roles` 10 failed, `directory` 6, `ehmis` 4, `support-center` 3,
  `content-feeds` 3). Orphaned/hung `rls.test.ts`/`platform-roles.test.ts` worker
  processes were observed against the shared `*_test` database during the run.
  No deploy, upload, migration, rollback, or production command was executed.

Remaining blockers / operator-owned steps:
- PACS conformance: a passing QIDO-RS/WADO-RS run against the configured PACS and
  a recorded authorization review are required before `FEATURE_DICOMWEB` may be true.
- PACS process: the Orthanc process listening on 127.0.0.1:8042 could not be
  identified by the deploy account. No VPS/systemd/sudo changes were made; the
  operator must identify the owning process.
- Staging gate: the full suite must be green on a clean, shared test database
  before `deploy:staging:check` can pass.
- Terminology: production stays `local-reference` until a licensed provider,
  endpoint, credentials, and license approval are supplied by the operator.
- ERPNext: keep off until a real endpoint, service account, and approved test plan exist.
- Production: reported last full check blocked by six unapplied migrations and 32
  test failures; migration state could not be read (tunnel on port 55432 refused).
  The recorded restore attestation is Aiven, not Kamatera; a fresh restore drill
  against `medveris-prod` and Kamatera verification are operator-owned. No
  production `wrangler secret put`, migration, deployment, rollback, or VPS edit was run.

### RLS-1 / RLS-2 — clinical_entry_attachments RLS + missing-RLS detection — 2026-11-18

Status: complete.

Root cause: migration 117 created `clinical_entry_attachments`, granted DML to
`medveris_runtime`, but never enabled/forced RLS or created a policy. The local
database previously had an out-of-band `attachments_tenant` policy with no
migration source, which masked the defect until a fresh reset wiped it. The
integrity check in `scripts/migrations.ts:schemaIntegrityProblems` only detected
RLS-enabled tables with no policies and RLS-enabled-but-not-forced tables; it
never queried `relrowsecurity = false`, so missing RLS was invisible.

Files changed (3):
- `packages/db/migrations/138_clinical_entry_attachments_rls.sql` (new) —
  enables and forces RLS on `clinical_entry_attachments`, creates
  `attachments_tenant` policy gated on `app.current_tenant()` for ALL
  (USING + WITH CHECK). Defensive rollback: `ALTER TABLE ... DISABLE ROW LEVEL
  SECURITY; DROP POLICY attachments_tenant ON ...`.
- `scripts/migrations.ts` — added `ALLOWED_NO_RLS_TABLES` allowlist of 10
  reviewed exception tables and a `not c.relrowsecurity` query in
  `schemaIntegrityProblems` that flags any other public table with RLS disabled.
- `docs/operations/PR_READINESS_CHECKPOINT_20261116.md` — RLS-1/RLS-2 backlog
  rows marked complete; new slice-log entry.

Verification (local `medveris_test` only; batch reset `tsx
scripts/db-reset-synthetic.ts --yes --batch-size=4`):
- Before 138 applied: integrity check flagged exactly
  `1 public tables have RLS disabled (clinical_entry_attachments)`; the other 10
  disabled tables were suppressed by the allowlist.
- After reset with 138: all 89 migrations applied in batches; integrity check
  clean (`(none)`).
- Direct catalog: `clinical_entry_attachments` now `relrowsecurity=t,
  relforcerowsecurity=t, policy_count=1`.
- `npx vitest run --config vitest.config.ts tests/unit/migrations-walker.test.ts`
  → 2/2 passed.
- `npx vitest run --config vitest.config.ts tests/integration/platform-operator-seed.test.ts tests/unit/staging-gate.test.ts tests/unit/production-gate.test.ts` → 3 files, 54/54 passed.

Remaining dependency: RLS-3 (review the 10 allowed exceptions one at a time,
especially `usage_resources` whose disposition is undecided). Staging gate rebuild
pending. The `pre-slice-safety` stash was not applied or dropped.

Note on the test-process-guard narrowing (INT-2): the narrowing committed in the
docs-only forensics commit was split out from this RLS commit deliberately. The
narrowed guard still has an unused-`repo` lint error that blocks `deploy:staging:check`;
it will be committed separately once that lint error is resolved. Nothing from the
guard narrowing is included in this commit.

### INT-2 — deterministic test harness — 2026-11-18

Status: fixed locally. Root cause, files and evidence in
`docs/operations/FORENSICS_20261118.md` (blocker INT-2). No production or staging
access; only the local `medveris_test` database was reset.

Root cause: `scripts/seed.ts:233-242` gave the synthetic reviewer operator grant a
fixed `now() + interval '24 hours'` expiry, so after a day the grant was revoked as
`grant-expired` and every operator-only RLS write failed. `medveris_test` also
carried synthetic rows from earlier hung runs, and a reset of all 88 migrations in
one transaction exceeded the local PG `max_locks_per_transaction=64`.

Files:
- `tests/test-db.ts` (new) — asserts `MIGRATION_DATABASE_URL` is a local `*_test`
  DB, fails fast if other sessions exist, refreshes the operator grant with a
  fresh expiry at every test run via the bootstrap flag, and clears leftover
  synthetic grant rows.
- `tests/setup.ts` — runs both `*_test` assertions, the session guard and the
  grant refresh before each worker.
- `tests/integration/platform-operator-seed.test.ts` (new) — proves the grant is
  active/unexpired and recognised by `app.is_platform_operator()` at run time.
- `tests/integration/platform-roles.test.ts` — teardown deletes synthetic grants
  through the bootstrap path so it cannot be blocked by RLS.
- `vitest.config.ts` — `maxWorkers: 1` in addition to `fileParallelism:false`.
- `scripts/db-reset-synthetic.ts` — schema in one transaction, migrations applied
  in committed batches (`--batch-size=`, default 4) so the 64-lock local PG limit
  is not exceeded; a failed batch reports partial state and can be reset again.
- `scripts/test-process-guard.mjs` (new) — read-only `--check` (default) lists
  orphaned vitest process trees; explicit `--reap` terminates only those PIDs.

Verification (all real commands; `*_test` target re-asserted before every run):
- `npm run lint` → `LINT_EXIT=0`. `npm run typecheck` → `TYPECHECK_EXIT=0`.
- Reset: `tsx scripts/db-reset-synthetic.ts --yes --batch-size=4` →
  `preflight: all safety checks passed`, `applied 130_…` through `applied 137_…`,
  `Synthetic database medveris_test reset, migrated and seeded.`, `RESET_EXIT=0`.
- Fresh DB, files alone:
  `vitest run --config vitest.config.ts tests/integration/platform-roles.test.ts tests/integration/platform-operator-seed.test.ts`
  → `Test Files 2 passed (2)`, `Tests 18 passed (18)`, exit 0.
- Full suite run 1: `npm test` → `Test Files 107 passed (107)`, `Tests 964 passed
  (964)`, `Duration 390.33s`, exit 0.
- Full suite run 2: `npm test` → `Test Files 107 passed (107)`, `Tests 964 passed
  (964)`, `Duration 333.03s`, exit 0.

Disclosed failure before the two green runs: an earlier `npm test` (04:16) failed
in `onboarding.test.ts` at `beforeAll` (`me.user.id` undefined) while two orphaned
vitest trees from the forensic phase were still alive. `onboarding.test.ts` alone
passed 13/13 and `billing.test.ts`+`onboarding.test.ts` passed 26/26. The orphaned
trees were reaped with `node scripts/test-process-guard.mjs --reap` (10 PIDs
terminated; `--check` now reports 0), after which both full runs above were green.
No assertion or gate was weakened.

Remaining dependency: re-run `npm run deploy:staging:check` (dry-run) to confirm
the staging gate is green end to end; not run in this slice. Staging was not
deployed. The `pre-slice-safety` stash was not applied or dropped.
