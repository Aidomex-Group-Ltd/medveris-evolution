# Production Active Remediation Summary

Date: 2026-11-23  
Verdict: **B — DEPLOYED BUT NOT APPROVED FOR REAL PATIENT DATA**.  
Authoritative detail: `docs/operations/MEDVERIS_PRODUCTION_RECOVERY_MASTER_PLAN.md`.

This summary uses existing evidence only. No production connection or mutation was performed for this reconciliation. No canonical blocker is `APPLIED TO PRODUCTION` or `VERIFIED IN PRODUCTION`.

## 1. Resolved locally

| Item | Current disposition | Evidence |
|---|---|---|
| `LOC-001` | `VERIFIED IN LOCAL TEST DATABASE` | Local ledger `97`, numeric latest `146`; targeted tests pass. |
| `TEST-004` | `VERIFIED IN LOCAL TEST DATABASE`; production verification pending | `patients.test.ts` `9/9`, including linkage of a patient registered elsewhere. |
| `MIG-001`–`MIG-003`, `MIG-004`, `RLS-001`–`RLS-007` source slices | `SOURCE TESTED` where targeted tests exist | Gate `26/26`, platform-role `6/6`, RLS `6/6`, patients `9/9`; lint/typecheck `0`. |

Local resolution does not close a production blocker.

## 2. Awaiting production application

| Item | Blocker | Owner |
|---|---|---|
| `MIG-001` | Migrations `139`–`146` absent from production ledger `89` | Release engineer |
| `RLS-001` | Unconditional `integration_tokens_all` policy | Security / database owner |
| `RLS-002` | Broad staff patient reads | Security / database owner |
| `RLS-003` | Patient enrollment helper absent in production | Security / database owner |
| `RLS-004` | Expired exchange-grant visibility | Security / database owner |
| `RLS-005` | Integrity/ledger RLS disabled | Security / database owner |
| `RLS-006` | Unconditional `ALL` policies and broad DELETE grants | Security / database owner |
| `RLS-007` | Legacy GUC authorization gates | Security / database owner |
| `INF-006` | Whole-object buffering fix | Backend owner |
| `PAY-001` | Provider/adapter/gate/config alignment | Payments owner |

## 3. Awaiting production verification

| Item | Required verification |
|---|---|
| `MIG-001` | Production ledger count for all eight versions → `8`; catalog parity. |
| `MIG-002` | Checksum/source-identity mechanism verifies production migration set. |
| `MIG-003` | Reviewed numeric migration order resolves latest → `146_integrity_rls_and_guards.sql`. |
| `MIG-004` | Hyphenated DB setup succeeds on a disposable synthetic DB. |
| `RLS-001`–`RLS-007` | Production catalog queries, targeted tests in a production-equivalent synthetic environment, and negative cross-tenant evidence. |
| `TEST-004` | Patient linkage test after migration parity and production catalog enrollment-helper check. |
| `INF-001` | Wrangler production deployment tag matches approved commit. |
| `INF-002` | Clean reviewed release passes `npm run deploy:production:check`. |

## 4. Awaiting infrastructure or operator action

| Item | Blocker | Owner |
|---|---|---|
| `DR-001` | pgBackRest restart storm and TLS server-auth error | SRE / infrastructure owner |
| `DR-002` | Missing real inventory secret and empty backup label | SRE / release engineer |
| `DR-003` | No post-incident isolated PITR drill | SRE / database owner |
| `DR-004` | No scoped audited sudo diagnostics | SRE / host owner |
| `DR-005` | Unsafe PITR helper must be excluded | Release engineer |
| `INF-002` | `21` modified tracked entries, `17` untracked entries | Release engineer |
| `INF-003` | Root-run Cloudflared unit writable by `deploy` | Host owner |
| `INF-004` | Empty alert webhook, no health monitor, static integration truth | SRE / release engineer |
| `INF-005` | No locality/residency benchmark | Architecture owner |
| `INF-007` | No slow-query/lock diagnostics | SRE / database owner |
| `TEST-001` | Full suite still open | QA owner |
| `TEST-002` | Radiology failure not re-verified | QA owner |
| `TEST-003` | Directory failures not re-verified | QA owner |
| `TEST-005` | Data-exchange scope failure not re-verified | QA owner |

## 5. Awaiting legal or business decision

| Item | Decision required | Owner |
|---|---|---|
| `PRIV-001` | Implement “Settings > Privacy” flows or amend the notice before real patient data. | Legal / product owner |
| `PAY-001` | Choose one payment provider and align adapter, gate, secrets, config, and tests. | Payments owner |
| `INF-005` | Approve Worker/DB/backup regions and residency rationale. | Architecture / legal owner |
| `DR-003` | Approve RTO/RPO and PITR target time for post-incident evidence. | SRE / business owner |

## 6. Release boundary

- Preserve the current `21` modified tracked and `17` untracked entries; do not discard, stage, or commit them in this task.
- Exclude `sshpass_1.09-1_amd64.deb`, `seed-drill-prod.sql`, `tmp-*`, and `medveris-verify-pitr-fixed.sh` from any release.
- Do not weaken gates, RLS, tests, or evidence requirements.
- Keep real patient data out of production until the master plan’s exact verification commands pass.
