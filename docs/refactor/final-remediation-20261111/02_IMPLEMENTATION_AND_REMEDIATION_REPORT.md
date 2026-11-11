# 02 — Implementation and Remediation Report

## Authorized local fixes applied/retained in this pass

### 1) Shared-supply security regression coverage (locally authorized)
- **File:** `tests/integration/workspaces.test.ts`
- Added/retained deterministic security-closure coverage:
  - Deterministic RLS isolation fixture for `organization_stock_transfers` (tenant-scoped visibility confirmed; outsider tenant sees zero rows) with cleanup/cancel of fixture transfer.
  - Forged destination/out-of-arrangement dispatch rejection and outsider receive denial without disclosure.
  - Quantity/status/lot invariants: discrepancy without explanation rejected (422), over-available dispatch rejected (409/422), post-receive receive/cancel rejected as non-dispatched (409).
  - Arrangement transition safety: in-transit blocks org inventory-mode/end and workspace leave (409), invalidated/ended-arrangement transfer ops fail closed (403), source/destination guarded transitions behave correctly when clear.
  - Helper/dispatch eligibility cases: dispatch rejected when either link not eligible; `app.organization_link_dispatched_transfers` denies unrelated caller context.
  - Audit assertions: denied mutation produces no success `inventory.inter-site.cancel` audit row for that resource; successful dispatch/cancel produce expected audit actions/resource/tenant linkage.

### 2) Runtime hardening (already present in preserved working tree, verified)
- **`apps/api/src/routes/workspace.ts`:** serialized dispatch eligibility checks via row locks + post-lock revalidation of link state/organization/mode.
- **`apps/api/src/routes/organizations.ts`:** guarded in-transit helper lookup with schema-not-ready fail-closed error mapping.

### 3) DB/provisioning/seed adjustments (preserved local-only changes)
- **`packages/db/migrations/125_organization_link_dispatched_transfers.sql`, `126_transfer_guard_privileges.sql`:** helper + privilege/invariant checks present in working tree/untracked set.
- **`scripts/db-setup.ts`:** local provisioning of `medveris_transfer_guard` role/membership/schema usage (explicitly marked LOCAL ONLY; DBA provisioning required for hosted envs).
- **`scripts/seed.ts`:** idempotency guards for billing account/subscription/event inserts to avoid duplicate-key failures on re-run in synthetic flows.

### 4) Documentation artifacts updated/preserved
- Preserved/updated remediation docs in working tree: `docs/refactor/phase1a/REMEDIATION_1_REPORT.md`, `REFACTOR.md`, `docs/refactor/gates/GATE_READINESS_REPORT.md` (untracked prior artifact).

## Not changed (by design/safety)
- No staging/production DB operations, migrations applied to hosted DBs, or config/secret changes.
- No commits, pushes, merges, resets, cleans, or deploys.
- No weakening of gates/RLS/policies/privilege checks.
