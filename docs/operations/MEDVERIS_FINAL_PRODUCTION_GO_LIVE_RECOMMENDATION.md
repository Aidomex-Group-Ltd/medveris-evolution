# MedVeris — Final Production Go-Live Recommendation

- **Date:** 2026-11-25
- **Repo:** `/home/aidomex/medveris`
- **Verdict under review:** **B — DEPLOYED BUT NOT APPROVED FOR REAL PATIENT DATA**

## 1. Recommendation

**Hold at Verdict B. Do not introduce real patient data and do not execute further production changes without explicit operator approval.**

The platform is deployed (last recorded release 2026-10-30, Worker tag `18f842a`, synthetic data only) and locally verified in the reviewed tree (`7117f36813126010d03e20d975ce97437ecd3388`), but the mandatory closure conditions of `docs/operations/MEDVERIS_PRODUCTION_RECOVERY_MASTER_PLAN.md` are not yet met.

## 2. What is now verified locally (this recovery session)

| Check | Result |
|---|---|
| `npm run lint` | pass |
| `npm run typecheck` | pass |
| `npm test` | **109 files / 978 tests passed** |
| `npm run audit:runtime` | 0 findings / 0 blocking |
| `npm run build` | pass |
| `tests/unit/storage.test.ts` | 3/3 pass (object-size limit remediation) |

## 3. Source remediation delivered locally

- Object-storage delivery now enforces a reviewed maximum object size with regression coverage (`apps/api/src/lib/storage.ts`, `tests/unit/storage.test.ts`).
- LivePay business account number persisted as `LIVEPAY_ACCOUNT_NUMBER=LP2610311719` (`.env`, `.env.example`).

## 4. Remaining blockers before any go-live change

1. Apply and verify migrations `139`–`146` in production (`MIG-001`, `MIG-002`, `MIG-004`).
2. Apply RLS/authorization hardening in production and verify catalog (`RLS-001`…`RLS-007`).
3. Repair pgBackRest, capture real backup inventory, complete isolated PITR drill, set non-empty label (`DR-001`…`DR-005`).
4. Establish reviewed immutable deployment provenance, clean release tree, corrected Cloudflared unit, live alerts (`INF-001`…`INF-007`).
5. Resolve privacy self-service / legal position (`PRIV-001`).
6. Complete payments provider alignment and live verification (`PAY-001`).
7. Full functional acceptance in production-equivalent environments (`TEST-001`…`TEST-005`).

## 5. Decision

Keep the production verdict at **B**. Re-run the master-plan closure verification commands in their named environments only after the operator-approved remediation window, then re-issue the formal go-live decision.
