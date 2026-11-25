# Production Go-Live Acceptance

| Item | Value |
|---|---|
| Audit timestamp | `2026-11-23T09:49:39Z` (UTC) |
| Application source reviewed | `7117f36813126010d03e20d975ce97437ecd3388` |
| Deployed Worker version | `13001954-5d14-48c3-9378-ca65c04c370c`, tag `18f842a`, created `2026-11-13T13:20:37.83605Z` |
| Production database | `medveris-prod`, PostgreSQL `18.6`, user `medveris_migrator` |
| Audit mode | Read-only; no production changes |
| Final verdict | **B. DEPLOYED BUT NOT APPROVED FOR REAL PATIENT DATA** |

## Acceptance criteria

| # | Criterion | Status | Evidence |
|---:|---|---|---|
| 1 | Deployed code matches reviewed commit | Fail | Worker tag `18f842a` != local HEAD `7117f36` |
| 2 | Working tree is clean or release is sourced from immutable artifact | Fail | `21` modified tracked files, `5` untracked files |
| 3 | Production migration parity with reviewed tree | Fail | `89` ledger rows; latest numeric `138`; pending `139`–`146` |
| 4 | RLS/tenant isolation verified | Fail | Unconditional `integration_tokens_all`; broad staff patient reads; cross-tenant helper defect |
| 5 | Integrity/ledger tables protected | Fail | `integrity_checkpoints`, `integrity_checkpoint_events`, `ledger_anchors` without RLS |
| 6 | Full automated test suite passes | Fail | `7` failed tests, `8` failed files in full log |
| 7 | Lint and typecheck pass | Pass | `npm run lint`, `npm run typecheck` |
| 8 | Backup inventory available to gate | Fail | `PRODUCTION_BACKUP_INVENTORY` absent; no valid inventory |
| 9 | Attestation has non-empty backup label and valid drill | Fail | `backupLabel=""`; gate errors |
| 10 | pgBackRest service healthy | Fail | `NRestarts=16221`, `status=37` |
| 11 | Root-run services are not writable by non-root users | Fail | `/etc/systemd/system/cloudflared-medveris.service` owned by `deploy`, `User=root` |
| 12 | Secrets values and provider callbacks verified | Blocked | Only names/scope metadata checked; values not exposed or exercised |
| 13 | Payment mode/adapters/gate consistent | Fail | Yo-only adapter; LivePay-capable paths; gate requires Yo; missing `LIVEPAY_ACCOUNT_NUMBER` |
| 14 | Privacy self-service implemented or notice corrected | Fail | Notice promises “Settings > Privacy”; routes absent |
| 15 | Alert delivery verified | Partial | URL reachability only; destination/token unverified |
| 16 | Observability/performance evidence | Partial/Unverified | No slow-query evidence; placement unresolved; storage buffers objects |
| 17 | Production approvals and on-call routing verified | Blocked | No evidence collected in this audit |
| 18 | No production changes during audit | Pass | All production checks were read-only |

## Blocking findings

| ID | Severity | Summary |
|---|---|---|
| `IND-01` / `DB-CRIT-01` | Critical | Production is 8 migrations behind; RLS hardening absent |
| `IND-02` / `DR-CRIT-01..03` | Critical | Backup/PITR recovery unverified; pgBackRest crash loop; invalid attestation |
| `RLS-CRIT-01..03` | Critical | Broad token policy, broad staff patient reads, cross-tenant helper |
| `SEC-03` / `INF-HIGH-03` | High | Deployed Worker source mismatch |
| `IND-04` | High | Dirty working tree blocks controlled deployment |
| `SEC-06` | High | Overbroad grants/ALL policies; integrity tables without RLS |
| `SEC-07` / `INF-HIGH-01` | High | Root-run Cloudflared unit writable by `deploy` |
| `SEC-09` | High | Missing privacy self-service routes |
| `SEC-10` | Medium | Payment adapter/config mismatch |
| `SEC-11` | Medium | Alerting and integration availability not fully verified |

## Working tree state

Modified tracked files from `git status --short`:

```text
.github/workflows/deploy-production.yml
apps/api/src/routes/auth.ts
apps/api/src/routes/me.ts
apps/api/src/routes/organizations.ts
apps/api/src/routes/promotions.ts
apps/api/src/routes/reception.ts
docs/deployment-runbook.md
packages/db/migrations/139_memberships_rls_hardening.sql
packages/db/migrations/140_integration_tokens_tenant_scope.sql
packages/db/migrations/142_patient_scope_rls_hardening.sql
packages/db/migrations/143_remaining_rls_overgrant_hardening.sql
packages/db/rollbacks/140_integration_tokens_tenant_scope_rollback.sql
packages/db/rollbacks/142_patient_scope_rls_hardening_rollback.sql
scripts/db-setup.ts
scripts/production-deploy.mjs
scripts/production-gate.mjs
tests/integration/invitations.test.ts
tests/integration/rls.test.ts
tests/unit/production-gate.test.ts
```

Untracked files:

```text
docs/incident-2026-11-22-wal-archiving.md
medveris-verify-pitr-fixed.sh
seed-drill-prod.sql
sshpass_1.09-1_amd64.deb
tmp-patch-seeded-db.py
```

These files were preserved and not executed or overwritten by the audit. `medveris-verify-pitr-fixed.sh` has side effects and must not be run as audit evidence.

## Required remediation and retest sequence

1. Resolve or intentionally preserve all working-tree changes; produce an immutable release commit/artifact.
2. Deploy the exact reviewed artifact and record Worker version, tag, deployment ID, and health results.
3. Apply migrations `139`–`146` through the controlled path; verify ledger, numeric ordering, RLS catalog, and grants.
4. Fix cross-tenant RLS defects, especially `app.patient_enrollment_lookup` and expired-grant semantics; rerun tenant-isolation tests with synthetic data.
5. Repair pgBackRest, capture real inventory, perform post-fix full restore and PITR drill, set a non-empty backup label, and pass the gate without weakening checks.
6. Fix root-owned service file permissions and privileged diagnostic access.
7. Align payment adapter/gate/config, privacy notice/routes, alert delivery, integration availability labels, and provider documentation.
8. Rerun `npm test`, `npm run lint`, `npm run typecheck`, production gate dry-run, and production smoke checks; archive all logs.
9. Re-review evidence and issue a new verdict; do not infer approval from this report after remediation without retest.

## Verdict

**B. DEPLOYED BUT NOT APPROVED FOR REAL PATIENT DATA**

Rationale: the deployment is live, but unresolved Critical and High findings affect patient confidentiality, integrity, availability, authentication, and recovery. Acceptance criteria 1, 3, 4, 5, 6, 8, 9, 10, 11, and 14 are failed. Real patient data must not be introduced until remediation and retest are complete.

## Assumptions and limitations

- Local HEAD is treated as the intended reviewed source; production source equivalence was not proven.
- Read-only production checks used aggregate counts and catalog metadata only.
- External providers, live payments, alert delivery, and privileged server operations were not exercised.
- Privileged verification was blocked by interactive sudo requirements.
- No secret values or PHI were printed or stored in reports.
