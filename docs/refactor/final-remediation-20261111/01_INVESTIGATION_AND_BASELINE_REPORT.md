# 01 — Investigation and Baseline Report

## Scope and instructions executed
- Read and followed `/home/aidomex/medveris-final-remediation-20261111-184840/FINAL_REMEDIATION_PROMPT.md`.
- Worked in existing repo `/home/aidomex/medveris` on branch `phase1a/shared-supply-security-closure` (`af526cf`).
- Preserved all pre-existing modified/untracked files and prior remediation artifacts; no reset/clean/commit/push/merge/deploy performed.

## Pre-existing state (preserved)
- Modified: `REFACTOR.md`, `apps/api/src/routes/organizations.ts`, `apps/api/src/routes/workspace.ts`, `docs/refactor/phase1a/REMEDIATION_1_REPORT.md`, `scripts/db-setup.ts`, `scripts/seed.ts`, `tests/integration/workspaces.test.ts`.
- Untracked/preserved artifacts: `docs/refactor/gates/GATE_READINESS_REPORT.md`, `packages/db/migrations/125_organization_link_dispatched_transfers.sql`, `packages/db/migrations/126_transfer_guard_privileges.sql` (also recorded in `untracked-before.tar.gz`).
- Remediation package reviewed: `FINAL_REMEDIATION_PROMPT.md`, `branches.txt`, `git-history.txt`, `git-status-before.txt`, `untracked-before.tar.gz`, `worktree-before.patch`.

## Investigation findings (code/DB safety)
- **Runtime behavior (shared-supply):** `apps/api/src/routes/workspace.ts` dispatch now locks/revalidates source/destination links in deterministic order and checks active+shared-supply+same-org before creating transfer (reduces TOCTOU/race and forged-arrangement dispatch). Receive/cancel paths remain tenant/resource-checked via existing helpers and fail closed for non-dispatched/missing arrangement states (as exercised by tests).
- **Org link transitions:** `apps/api/src/routes/organizations.ts` inventory-mode/end use `app.organization_link_dispatched_transfers` helper with explicit `42883/schema_not_ready` handling to block transitions when schema/helper missing (safe fail-closed behavior).
- **Migrations 125/126:** 125 creates SECURITY DEFINER helper `app.organization_link_dispatched_transfers(uuid,uuid)` owned by `medveris_transfer_guard`, revokes PUBLIC EXECUTE, grants runtime EXECUTE, and includes local-owner prerequisite grants. 126 validates role/function/owner/EXECUTE invariants and applies narrow schema/table/column grants for `organization_stock_transfers` and `organization_links`. Intent is least-privilege and RLS-compatible transfer counting.
- **Local provisioning scripts:** `scripts/db-setup.ts` and `scripts/seed.ts` contain local-only adjustments (transfer guard role/membership/schema grants provisioning hints; idempotent seed guards for billing accounts/subscriptions/events). Prior gate report marked these as **LOCAL ONLY; staging needs DBA provisioning/review**.
- **Prior gate report (`docs/refactor/gates/GATE_READINESS_REPORT.md`):** documents successful local rebuild/migrate/seed, migration parity (77), helper/RLS/runtime-role checks, lint pass, restore rehearsal RC=0, but records blockers: typecheck hung/no-exit in that run, full test/build/audit/staging-check not run, seed non-idempotent in that earlier state, staging/prod state/DBA provisioning not verified/certified.

## Baseline before this increment
- Latest HEAD records targeted authz/workspaces/lint/typecheck verification (`af526cf` / `REFACTOR.md`), but remediation docs still reported partial/unverified security cases and blocked gates.
- Existing integration suite already contained extensive workspace/shared-supply/organization coverage; deterministic RLS fixture and additional closure cases were partially present in working tree diff.
