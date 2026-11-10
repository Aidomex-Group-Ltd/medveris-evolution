# Phase 1A Remediation 1B — Verification Report
Branch: `fix/phase1a-authz-remediation-1` (safety snapshot `f34666a` preserved). No push/merge/deploy/secrets/remote changes.

## A. Isolation
- `.env.test`: created from `.env`; `APP_ENV=test`; `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `JOBS_DATABASE_URL` -> `/medveris_test`. `.env.test` added to `.gitignore`.
  - `DATABASE_URL=postgres://medveris_runtime:***@localhost:5432/medveris_test`
  - `MIGRATION_DATABASE_URL=postgres://medveris_migrator:***@localhost:5432/medveris_test`
  - `JOBS_DATABASE_URL=postgres://medveris_jobs:***@localhost:5432/medveris_test`
- `tests/setup.ts`: loads `.env.test` if present (else `.env`), forces `APP_ENV=test`, throws unless `DATABASE_URL` host is localhost/127.0.0.1/::1 and DB name ends `_test`.
- Migrate/seed: **test DB only** (`medveris_test`, local). Pre-check table count 251; `npm run db:migrate` applied pending migrations to `medveris_test`; `npm run db:reset:synthetic -- --yes` (target `medveris_test`) recreated schema, migrated, seeded synthetic data successfully (exit 0).
- Guard proof: `DATABASE_URL='postgres://medveris_runtime:x@localhost:5432/medveris_dev' npx vitest run tests/unit/authz.test.ts` -> `FAIL` setup with `Error: Refusing to run tests: DATABASE_URL must target a local *_test database` (no tests collected/run).

## B. Baseline (commands, exit codes)
| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npx vitest run tests/unit/authz.test.ts tests/unit/authz-phase1a.test.ts` | 28 passed, exit 0 |
| `npx vitest run tests/integration/workspaces.test.ts` | 15 passed (after Part C/D edits), exit 0 |
| `npx vitest run` (full, direct) | **BLOCKED/INCOMPLETE** in captured run (timed out; partial log only, no final summary) |
| `npm run deploy:staging:check` (dry run, includes lint/typecheck/tests) | **INCOMPLETE/TIMED OUT** in this session; observed during run: `tests/integration/billing.test.ts (12 tests \| 2 failed)` — “keeps payments and refunds…” and “voids an unpaid bill…” (stderr/log snippets captured). Not confirmed pre-existing vs branch-caused; other files seen passing in stream (invitations/workflow-payments etc.). Full gate verdict not obtained. |

**Pre-existing vs branch-caused:** not fully separable without a clean full-suite result. Workspace/integration slice and authz units pass; `requestActor` 404->401 is a potential behavior change (see C) but targeted workspace and observed unauthenticated handling behaved as expected.

## C. Regressions fixed (branch-caused/slice)
- `GET /api/v1/workspace/shared-supply` (`apps/api/src/routes/workspace.ts`): when no live accepted shared-supply link, returns `200 { sites: [], transfers: [], permissions: { transfer } }` instead of 403, so `WorkspacePage.tsx` can load safely. Transfer query remains filtered to current tenant (`source_tenant_id = tenant or destination_tenant_id = tenant`). Mutations unchanged (still require arrangement/permissions/domain checks; 403/409 paths preserved).
- `requestActor` 404->401 assessment: many callers rely on it; unauthenticated context now correctly 401. No broad revert applied; full-suite impact **PARTIAL/NOT VERIFIED** due to incomplete full run. `deploy:staging:check` / full test completion required before release confidence.

## D. Security tests added (synthetic; `tests/integration/workspaces.test.ts`)
- **401 unauthenticated:** `GET /workspace/shared-supply` without session -> 401. **VERIFIED**.
- **403 missing permissions:** receptionist (no `inventory.stock.read`) -> 403; nurse/read-only path cannot `POST /workspace/shared-supply/transfers` (manage required) -> 401/403 observed. **PARTIAL** (role mapping depends on seed; explicit per-permission cases for receive/transfer.manage against all endpoints not exhaustive).
- **Cross-tenant transfer access:** outsider `clinician.b` (tenant B) receive by unknown/other id -> 403/404, no disclosure of target resource. **PARTIAL** (uses random id; direct proof against a known tenant-A transfer id not persisted in added test).
- **Tenant A cannot list tenant B transfers:** endpoint filters by current tenant in SQL. **PARTIAL/NOT DIRECTLY ASSERTED** with seeded cross-tenant fixture.
- **Forged destination outside arrangement / receive & cancel after link ended or set independent / quantity-status-lot invariants / happy path:** covered by pre-existing and extended happy-path flow (“moves stock…”), which exercises dispatch, 409 before mutual acceptance, receipt, and ledger effects. Explicit negative cases for forged destination, ended/independent link, lot/status/quantity invariant rejections **NOT ADDED** in this increment. **PARTIAL**.
- **RLS direct query:** `organization_stock_transfers` queried under tenant-B context returns 0 for a hospital/linked transfer id when present (test skips if no row retained). **PARTIAL** (conditional).
- **Audit:** success audit actions exist for inter-site dispatch/receive/cancel in implementation; explicit assertion of correct actor/tenant/resource/action on success and “no success audit row on denial” **NOT FULLY VERIFIED** by new tests. **PARTIAL**.
- **Outbox consumer:** `inventory.inter-site.dispatched` event emitted on dispatch; consumer test (tenant mismatch poison, duplicate delivery dedup) **NOT ADDED** (no harness exercised). **NOT VERIFIED/BLOCKED**.

## E. Commits / diff / deploy check
- Logical local commits (on branch): `test: isolate vitest to local _test env via .env.test`; `fix(workspace): return empty shared-supply view and extend security tests`; `docs: update phase1a remediation 1b report` (plus prior `f34666a wip(phase1a): remediation increment 1 (unreviewed)`).
- `git diff master...HEAD --stat`: includes prior remediation 1 scope and this increment (`.gitignore`, `apps/api/src/routes/workspace.ts`, `tests/setup.ts`, `tests/integration/workspaces.test.ts`, report/docs/authz changes from snapshot).
- `npm run deploy:staging:check` (dry run): **not completed** in-session (long-running; timed out). Partial output captured showing lint/typecheck gates started/passed in sequence and test suite running with observed billing failures (2) — see B. **BLOCKED** for a definitive dry-run pass/fail.

## Requirement status
| Requirement | Status |
|---|---|
| Isolated `.env.test`, guarded setup, test-DB-only migrate/seed, guard proof vs dev | **VERIFIED** |
| Baseline typecheck/lint/authz units/workspaces integration | **VERIFIED** |
| Full suite baseline separated pre-existing vs branch | **BLOCKED/INCOMPLETE** |
| `GET /workspace/shared-supply` UI-safe empty 200, tenant-filtered transfers, mutations 403/409 | **VERIFIED (slice)** |
| `requestActor` 404->401 assessed/fixed as needed | **PARTIAL** (implemented earlier; full impact unverified) |
| 401/403 permission matrix for shared-supply endpoints | **PARTIAL** |
| Cross-tenant list/receive/cancel denial without disclosure | **PARTIAL** |
| Forged destination rejected; receive/cancel fail after link ended/independent | **PARTIAL** (happy-path/invariants partly covered, explicit negatives missing) |
| Quantity/status/lot invariants | **PARTIAL** |
| RLS zero rows via direct `withContext`/tenant-scoped query | **PARTIAL** (conditional) |
| Audit success/no-success-on-denial | **PARTIAL** |
| Outbox consumer dispatched/poison/dedup | **NOT VERIFIED/BLOCKED** |

## Stop
No push, merge, deploy (staging/production), `deploy:production*`, remote/secret/Cloudflare changes, or migrations against persistent environments performed. Branch handed back for human review.
