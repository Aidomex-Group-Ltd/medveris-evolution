# MedVeris — Production Blocker Closure Matrix

- **Date:** 2026-11-25
- **Repo:** `/home/aidomex/medveris`
- **Verdict under review:** **B — DEPLOYED BUT NOT APPROVED FOR REAL PATIENT DATA**
- **Authority:** `docs/operations/MEDVERIS_PRODUCTION_RECOVERY_MASTER_PLAN.md` (canonical active register)

## Status vocabulary

| Status | Meaning |
|---|---|
| `OPEN` | Blocker not yet dispositioned. |
| `INVESTIGATING` | Analysis in progress. |
| `IMPLEMENTED_LOCALLY` | Source remediation implemented; local verification pending/running. |
| `VERIFIED_LOCALLY` | Source remediated and verified in local environment/tests. |
| `VERIFIED_IN_STAGING` | Verified in isolated staging environment. |
| `AWAITING_OPERATOR_APPROVAL` | Implementation ready; production/operator action required. |
| `APPLIED_TO_PRODUCTION` | Remediation applied to production with evidence. **Reserved — not yet granted.** |
| `VERIFIED_IN_PRODUCTION` | Production behavior verified. **Reserved — not yet granted.** |
| `BLOCKED_BY_EXTERNAL_DEPENDENCY` | Awaiting legal/provider/operator/external action. |
| `ACCEPTED_RISK_WITH_APPROVAL` | Accepted by authorised human with documented sign-off. |

No blocker in this matrix may be moved to `APPLIED_TO_PRODUCTION` or `VERIFIED_IN_PRODUCTION` without actual production evidence.

## Closure matrix

| Canonical ID | Original finding | Implementation | Tests | Local evidence | Staging evidence | Production evidence | Reviewer | Status |
|---|---|---|---|---|---|---|---|---|
| `MIG-001` | `IND-01` / `DB-CRIT-01` — production ledger behind reviewed source (89 rows / latest `138`; `139`–`146` absent) | Migrations `139`–`146` source hardening present in reviewed tree | Gate count over eight versions → expected `8` / production `0` | Local: migrations applied to `medveris_test` (ledger `97` / latest `146`); targeted gate/RLS/patient tests pass | n/a | **FAIL IN PRODUCTION** (catalog read) | human / release engineer | `AWAITING_OPERATOR_APPROVAL` |
| `MIG-002` | `DB-HIGH-01` — no production ledger checksum/source identity | Migration-set digest computed in gate; ledger checksum checker not yet added | `scripts/check-migration-checksums.mjs` not present | Local: set digest computable via `migrationSetDigest` | n/a | n/a | agent / database owner | `OPEN` (checker to be added) |
| `MIG-003` | `DB-MED-01` — lexical vs numeric migration ordering | `scripts/migrations.ts` numeric sort verified (`146_integrity_rls_and_guards.sql`) | `tests/unit/migrations-walker.test.ts` | Local: resolves latest `146` | n/a | n/a | agent | `VERIFIED_LOCALLY` |
| `MIG-004` | `DB-MED-03` — hyphenated DB name in `db-setup` | Hyphen fix applied in `scripts/db-setup.ts` (uncommitted) | n/a | Local: source fix present, not production-verified | n/a | n/a | agent / release engineer | `AWAITING_OPERATOR_APPROVAL` (commit + verify) |
| `LOC-001` | `DB-MED-02` — local ledger drift | Local ledger `97` / latest `146`; parity baseline | `npm test` | Local: `VERIFIED_IN_LOCAL_TEST_DATABASE` | n/a | n/a | QA owner | `VERIFIED_LOCALLY` |
| `RLS-001` | `RLS-CRIT-01` / `SEC-01` — unconditional `integration_tokens_all` | Migration `140` replaces token policy with tenant-scoped policies | `tests/integration/rls.test.ts`; prod policy count → `0` | Local: scoped policies verified (6/6), oversize tests | n/a | **FAIL IN PRODUCTION** (policy still unconditional) | security / database owner | `AWAITING_OPERATOR_APPROVAL` |
| `RLS-002` | `RLS-CRIT-02` — broad staff patient reads | Migration `142` scopes patient reads via tenant linkage / grants | `tests/integration/rls.test.ts`; prod policy qual → narrow | Local: `6/6` + `patients 9/9` | n/a | **FAIL IN PRODUCTION** (broad policy) | security / database owner | `AWAITING_OPERATOR_APPROVAL` |
| `RLS-003` | `RLS-CRIT-03` / `SEC-05` — enrollment helper without tenant linkage | Migration `142` adds `app.patient_enrollment_lookup` tenant linkage | `patients 9/9`; cross-tenant tests | Local: `VERIFIED_IN_LOCAL_TEST_DATABASE` | n/a | **FAIL IN PRODUCTION** (helper absent) | security / database owner | `AWAITING_OPERATOR_APPROVAL` |
| `RLS-004` | `RLS-HIGH-01` — expired exchange grants readable | Migration `142` re-introduces active-window filters; negative test added | `tests/integration/rls.test.ts -t expired` | Local: negative test added; `6/6` pass | n/a | n/a | security / database owner | `VERIFIED_LOCALLY` (negative path) |
| `RLS-005` | `RLS-HIGH-02` / `DB-HIGH-03` — integrity tables RLS disabled | Migration `146` enables + forces RLS; runtime/jobs scoping | Prod count → `0`; local `6/6` | Local: `VERIFIED_IN_LOCAL_TEST_DATABASE` | n/a | **FAIL IN PRODUCTION** (RLS disabled) | security / database owner | `AWAITING_OPERATOR_APPROVAL` |
| `RLS-006` | `SEC-06` / `DB-HIGH-02` — 13 unconditional ALL + runtime DELETE overgrants | Migration `141` splits ALL; `143` narrows writes; DELETE grants revoked | Prod unconditional ALL → `0`; local policy diff | Local: policy split verified | n/a | **FAIL IN PRODUCTION** (overgrants present) | security / database owner | `AWAITING_OPERATOR_APPROVAL` |
| `RLS-007` | `SEC-08` / `RLS-HIGH-03` — forgeable platform-role GUC gates | Migration `145` replaces GUC gates with DB-backed checks | `tests/integration/platform-role-guc.test.ts` 6/6; forged-GUC negatives pass | Local: `VERIFIED_IN_LOCAL_TEST_DATABASE` | n/a | **FAIL IN PRODUCTION** (legacy GUC) | security / database owner | `AWAITING_OPERATOR_APPROVAL` |
| `DR-001` | `IND-02` / `SEC-02` / `DR-CRIT-02` / `INF-HIGH-02` — pgBackRest unstable | Operator action: stop restart storm, repair service | n/a | n/a | n/a | **FAIL IN PRODUCTION** (service `activating (start-post)`, exit `37`, `NRestarts=17417`) | SRE / infrastructure owner | `AWAITING_OPERATOR_APPROVAL` |
| `DR-002` | `DR-CRIT-01` / `DR-CRIT-03` — missing real inventory / empty backup label | Capture `pgbackrest info --stanza=medveris --output=json`; store `PRODUCTION_BACKUP_INVENTORY`; set real label | Gate backup-inventory validation | n/a | n/a | **FAIL IN PRODUCTION** (inventory absent, label empty) | SRE / release engineer | `AWAITING_OPERATOR_APPROVAL` |
| `DR-003` | `DR-HIGH-01` — no accepted post-incident PITR drill | Isolated staging PITR drill + attestation | n/a | n/a | n/a | **FAIL IN PRODUCTION** (no accepted drill) | SRE / database owner | `AWAITING_OPERATOR_APPROVAL` |
| `DR-004` | `DR-HIGH-02` / `INF-MED-01` — scoped audited sudo diagnostics | Operator action: narrow sudoers | n/a | n/a | n/a | **BLOCKED** (interactive sudo) | SRE / host owner | `AWAITING_OPERATOR_APPROVAL` |
| `DR-005` | `DR-MED-01` — unsafe PITR helper | Prohibited script untracked; must not execute; excluded from release | n/a | n/a | n/a | n/a | release engineer | `OPEN` (prohibited) |
| `INF-001` | `IND-03` / `SEC-03` / `INF-HIGH-03` — deployed tag ≠ reviewed HEAD | Reviewed immutable artifact pending deploy | n/a | n/a | n/a | **FAIL IN PRODUCTION** (tag `18f842a` vs HEAD `7117f36`) | release engineer | `AWAITING_OPERATOR_APPROVAL` |
| `INF-002` | `IND-04` / `SEC-04` — dirty tree blocks release | Remediation changes staged on `recovery/production-remediation-20261123`; release blocked until clean reviewed commit | `git status --porcelain` | Local: dirty (23 modified / 18 untracked incl. new storage test) | n/a | n/a | release engineer | `AWAITING_OPERATOR_APPROVAL` |
| `INF-003` | `IND-06` / `SEC-07` / `INF-HIGH-01` — Cloudflared unit root-run writable | Operator action: unit ownership/permissions | n/a | n/a | n/a | **FAIL IN PRODUCTION** (unit `deploy:deploy 0644 User=root`) | host owner | `AWAITING_OPERATOR_APPROVAL` |
| `INF-004` | `IND-09` / `SEC-11` / `INF-MED-04` — alert webhook / health monitor / integrations | Operator action: webhook + monitor + live probes | n/a | n/a | n/a | **FAIL IN PRODUCTION** (webhook empty, no monitor) | SRE / release engineer | `AWAITING_OPERATOR_APPROVAL` |
| `INF-005` | `INF-MED-02` / `PERF-01` — locality/residency benchmark | n/a | n/a | n/a | n/a | **FAIL IN PRODUCTION** (no placement benchmark) | architecture / legal owner | `AWAITING_OPERATOR_APPROVAL` |
| `INF-006` | `INF-MED-03` / `PERF-02` — whole-object buffering | Size-limit remediation implemented in `apps/api/src/lib/storage.ts` + regression tests | `tests/unit/storage.test.ts` 3/3; lint/typecheck | Local: `VERIFIED_LOCALLY` | n/a | n/a | backend owner | `VERIFIED_LOCALLY` |
| `INF-007` | `PERF-03` — slow-query/lock diagnostics | n/a | n/a | n/a | n/a | **FAIL IN PRODUCTION** (no diagnostics doc) | SRE / database owner | `AWAITING_OPERATOR_APPROVAL` |
| `PRIV-001` | `IND-07` / `SEC-09` — notice promises “Settings > Privacy”; self-service incomplete | Notice/`me.ts` gap analyzed; legal amendment/implementation held at approval boundary | `tests/integration/privacy-self-service.test.ts` absent | Local: analysis only | n/a | n/a | legal / product owner | `AWAITING_OPERATOR_APPROVAL` |
| `PAY-001` | `IND-08` / `SEC-10` — adapter/gate/config mismatch (Yo-only adapter vs LivePay config) | LivePay primary selected; `LIVEPAY_ACCOUNT_NUMBER` persisted (`LP2610311719`); `FEATURE_PAYMENTS=false` | `tests/integration/workflow-payments.test.ts` etc. | Local: full suite green | n/a | n/a | payments owner | `AWAITING_OPERATOR_APPROVAL` (live verification) |
| `TEST-001` | `RLS-MED-01` / `FUNC-01` — full suite red | Full suite now green: 109 files / 978 tests; lint/typecheck/build/audit clean | `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm run audit:runtime` | Local: **PASS** | n/a | n/a | QA owner | `VERIFIED_LOCALLY` |
| `TEST-002` | `FUNC-02` — radiology failures | Full suite green incl. radiology suites | n/a | Local: **PASS** via full suite | n/a | n/a | QA owner | `VERIFIED_LOCALLY` |
| `TEST-003` | `FUNC-03` — directory failures | Full suite green incl. directory suites | n/a | Local: **PASS** via full suite | n/a | n/a | QA owner | `VERIFIED_LOCALLY` |
| `TEST-004` | `FUNC-04` — patient linkage | Targeted `patients 9/9`; full suite green | n/a | Local: **PASS** | n/a | n/a | QA owner | `VERIFIED_LOCALLY` (prod pending migrations) |
| `TEST-005` | `FUNC-05` — data-exchange scope failure | Full suite green incl. data-exchange | n/a | Local: **PASS** via full suite | n/a | n/a | QA owner | `VERIFIED_LOCALLY` |

## Closure summary

- Local verification that passed in this session: `npm run lint` (0), `npm run typecheck` (0), `npm test` (109 files / 978 tests), `npm run audit:runtime` (0 findings), `npm run build` (pass), `tests/unit/storage.test.ts` (3/3).
- Source remediated locally this session: object-storage size limit + regression coverage; `LIVEPAY_ACCOUNT_NUMBER` persisted.
- Production-bound blockers remain: migration application/parity (`MIG-001`, `MIG-002`, `MIG-004`), RLS application (`RLS-001`…`RLS-007`), DR recovery (`DR-001`…`DR-005`), infrastructure/provenance (`INF-001`…`INF-007`), privacy/legal (`PRIV-001`), payments (`PAY-001`).
- No blocker is `APPLIED_TO_PRODUCTION` or `VERIFIED_IN_PRODUCTION`; real-patient-data launch stays withheld.

## Operator approvals still required

1. Clean reviewed release source (commit/stash discipline) before `npm run deploy:production:check` / deploy.
2. Production migration window + operator approval to apply `139`–`146`.
3. SRE/host actions for DR-001…DR-005, INF-003, INF-004.
4. Legal/product decision for PRIV-001.
5. Payments owner decision + live verification for PAY-001.
6. Final human/legal sign-off before any real patient data.
