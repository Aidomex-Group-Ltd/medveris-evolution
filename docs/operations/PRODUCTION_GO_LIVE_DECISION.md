# Production Go-Live Decision

Date: 2026-11-23  
Repo: `/home/aidomex/medveris`  
Decision scope: approval for real patient data.  
Authoritative register: `docs/operations/MEDVERIS_PRODUCTION_RECOVERY_MASTER_PLAN.md`.

## 1. Verdict

**B — DEPLOYED BUT NOT APPROVED FOR REAL PATIENT DATA.**

The verdict is unchanged. Local source and targeted local verification improved, but production migration parity, RLS and role posture, backup/PITR, deployment provenance, systemd integrity, privacy, payments, and integration truthfulness remain unresolved.

This reconciliation used existing evidence only. No production connection, migration, deployment, secret change, source change, test mutation, or patient-data action was performed for this task.

## 2. What is true now

- Local `medveris_test` is at PostgreSQL `14.24`, ledger `97`, numeric latest migration `146`.
- Production `medveris-prod` evidence at `2026-11-23T16:21:56Z` shows PostgreSQL `18.6`, ledger `89`, numeric latest migration `138`.
- Production aggregate baseline: `3` tenants, `6` users, `2` memberships, `4` patients, `4` sessions, `17` audit events; zero patient accounts, tenant-patient links, exchange grants, outbox events, integration clients, and integration tokens.
- Current Git state is `21` modified tracked entries and `17` untracked entries on HEAD `7117f36813126010d03e20d975ce97437ecd3388`.
- Production still has unconditional token policy, broad patient reads, `13` unconditional `ALL` policies, runtime DELETE on `163` tables, integrity/ledger RLS disabled, and legacy GUC authorization helpers.
- `32` SECURITY DEFINER functions exist; `medveris_exchange` and `medveris_transfer_guard` have `BYPASSRLS`; no production role/grant sign-off exists.
- Deployed Worker tag `18f842a` does not match reviewed HEAD `7117f36`.
- pgBackRest remains unstable with latest observed `NRestarts=17417`; no valid inventory or named backup label exists; no post-incident PITR drill is accepted.
- Lint, typecheck, gate unit, platform-role, RLS, and patients targeted tests pass locally; the full current suite has not passed.

## 3. Gate summary

| Area | Canonical IDs | Status | Evidence |
|---|---|---|---|
| Migration parity | `MIG-001`–`MIG-004`, `LOC-001` | Fail in production | `docs/operations/PRODUCTION_MIGRATION_EVIDENCE.md` |
| RLS / tenant isolation / roles | `RLS-001`–`RLS-007` | Fail in production | `docs/operations/PRODUCTION_SECURITY_RLS_EVIDENCE.md` |
| Backup / PITR | `DR-001`–`DR-005` | Fail | `docs/operations/PRODUCTION_BACKUP_DR_EVIDENCE.md` |
| Infrastructure / provenance | `INF-001`–`INF-007` | Fail | `docs/operations/PRODUCTION_INFRASTRUCTURE_EVIDENCE.md` |
| Functional readiness | `TEST-001`–`TEST-005` | Partial local pass; production fail | `docs/operations/PRODUCTION_FUNCTIONAL_EVIDENCE.md` |
| Privacy | `PRIV-001` | Fail | `docs/audit/PRODUCTION_GO_LIVE_ACCEPTANCE.md` |
| Payments / integrations | `PAY-001`, `INF-004` | Fail | `docs/audit/PRODUCTION_FUNCTIONAL_READINESS_MATRIX.md` |
| Working tree | `INF-002` | Fail | `21` modified tracked entries, `17` untracked entries |

## 4. Mandatory closure checklist

1. Close `MIG-001`–`MIG-004` and `LOC-001` with production migration/catalog parity and reviewed checksum/source identity.
2. Close `RLS-001`–`RLS-007`, including production policy parity, no direct GUC authorization, and SECURITY DEFINER/BYPASSRLS role sign-off.
3. Close `DR-001`–`DR-005`: stable pgBackRest, real inventory secret, latest full-backup label, scoped diagnostics, and isolated PITR evidence.
4. Close `INF-001`–`INF-007`: reviewed immutable deploy, clean tree, corrected Cloudflared unit, live alerts, residency, object limits, and performance diagnostics.
5. Close `PRIV-001` by implementing self-service or amending the notice before real patient data.
6. Close `PAY-001` by aligning adapter, provider, gate, secrets, config, and tests; keep `FEATURE_PAYMENTS=false` until live-verified.
7. Close `TEST-001`–`TEST-005` with a green full suite and passing targeted radiology, directory, patients, RLS, and data-exchange tests.
8. Obtain human/legal sign-off for Uganda Data Protection and Privacy Act 2019 obligations and registration checklist.
9. Confirm all master-plan verification commands pass in their named environments.
10. Confirm no canonical blocker is marked `APPLIED TO PRODUCTION` or `VERIFIED IN PRODUCTION` without production evidence.

## 5. Prohibited actions

- Applying pending migrations without explicit operator approval.
- Manual ledger edits.
- Weakening RLS, gate logic, or tests to obtain a pass.
- Fabricating inventory, attestation, restore evidence, or alert proof.
- Executing `medveris-verify-pitr-fixed.sh` against production.
- Committing `sshpass_1.09-1_amd64.deb`, `seed-drill-prod.sql`, `tmp-*`, or other untracked evidence artifacts.
- Running seed/drill data against production.
- Connecting to or modifying production as part of this documentation reconciliation.

## 6. Final recommendation

Keep real patient data out of production until every canonical blocker has evidence-backed closure and human sign-off. Current local passes are useful source verification, not production approval.
