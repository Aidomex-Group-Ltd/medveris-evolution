# 07 — Clean-State Baseline Report (Phase 0, READ-ONLY)

**Date:** 2026-11-11  
**Scope:** Repository inspection, environment/config classification, schema/migration/application/data/security baseline. No source or database mutations performed beyond creating this report.

## 1. Repository baseline

| Item | Value |
|---|---|
| Branch | `phase1a/shared-supply-security-closure` |
| HEAD | `af526cf79e1905620ea5bdd300f9453f5fb1e800` |
| Pre-existing modified (preserved) | `REFACTOR.md`, `apps/api/src/routes/organizations.ts`, `apps/api/src/routes/workspace.ts`, `docs/refactor/phase1a/REMEDIATION_1_REPORT.md`, `scripts/db-setup.ts`, `scripts/seed.ts`, `tests/integration/workspaces.test.ts` |
| Pre-existing untracked (preserved) | `docs/refactor/final-remediation-20261111/` (01–06), `docs/refactor/gates/GATE_READINESS_REPORT.md`, `packages/db/migrations/125_organization_link_dispatched_transfers.sql`, `packages/db/migrations/126_transfer_guard_privileges.sql` |
| Existing recovery snapshot (inspected, not modified) | `/home/aidomex/medveris-final-remediation-20261111-184840` (`FINAL_REMEDIATION_PROMPT.md`, git-history/status, worktree/untracked archives) |
| New pre-modification snapshot (created this run) | `/home/aidomex/medveris-final-remediation-20261111-191359` (prior snapshot copy, `git-status.txt`, `worktree.patch`, `untracked.tar.gz`) |

**Working-tree delta (current):** focused on shared-supply/organization closure, local DB provisioning/seed hardening, workspaces tests, and remediation docs/migrations (see `git diff --stat`). No commit/push/merge/branch change/reset/clean performed.

## 2. Environment classification (credentials redacted)

### Local env files (present; values not printed)
- `.env`, `.env.example`, `.env.test` define `NODE_ENV/APP_ENV` and `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `JOBS_DATABASE_URL` (all redacted). `.worktree/base` contains env/wrangler copies (artifact state; not treated as active config without verification).
- `wrangler.jsonc`: top-level local dev placeholders (`local-dev-hydrive-placeholder` bindings, `medveris-local-jobs` queues), `workers_dev=false`, `account_id` pinned. `env.staging` has concrete Hyperdrive IDs (`83900f032d264402bf1aaf495f4b0d23`, `13b44b13563a4d3690caf6484acaff4e`), `APP_ENV=staging`, `EXPECTED_DATABASE_NAME=medveris_staging`, R2 bucket `medveris-staging-uploads`, staging queues/cron, Resend/LivePay vars; secrets listed as required but not present in repo. No production environment block observed in `wrangler.jsonc` during this read.

| Target (as configured/known) | Classification | Evidence | DB name / host / PG version | App env | Migration / runtime / jobs role | Genuine customer data? | Verified backup? |
|---|---|---|---|---|---|---|---|
| Local `.env` / `.env.test` | **Local development/test (unverified identities)** | env files exist; values redacted | **Unknown** (must be verified before any action) | dev/test per files (unverified) | `MIGRATION_DATABASE_URL` / `DATABASE_URL` / `JOBS_DATABASE_URL` (unverified) | **Unknown — treat as protected until classified** | **Unknown** |
| `wrangler.jsonc` top-level | Local Worker dev config | placeholders, local queues | N/A (Hyperdrive placeholders) | local | HYPERDRIVE/HYPERDRIVE_JOBS bindings (local placeholders) | N/A | N/A |
| `wrangler.jsonc` `env.staging` | **Hosted staging configuration (declared, not connected)** | named worker `medveris-staging`, Hyperdrive IDs, `medveris_staging` expected, R2/queues/cron/secrets required | **DB name declared `medveris_staging`; host/PG version/runtime identities not verified from repo** | `staging` | Declared runtime/jobs via Hyperdrive (roles not verifiable here) | **Unknown — must assume protected/retain unless explicitly classified disposable** | **Unknown / not verified** |
| Production | **Unknown / not identified in repo config reviewed** | no production wrangler env block found in sampled config | **Unknown** | **Unknown** | **Unknown** | **Must be treated as genuine/protected** | **Unknown** |

**Stop condition (Phase 0):** Exact hosted database identities, contents, roles, backups, and PG versions cannot be established from local inspection alone. All non-explicitly-verified targets remain **protected**; no hosted or destructive actions permitted.

## 3. Schema and migration consistency

- **Migration files discovered:** 77 (`packages/db/migrations/*.sql`).
- **Latest by numeric/intent sequence:** `126_transfer_guard_privileges.sql` (follows 125).
- **Filename ordering defect:** `ls`/lexicographic sort places `98_add_unit_type.sql`, `99_backfill_unit_type.sql` **after `126`** (`121..126, 98, 99`). Runner loads via lexicographic sort (`scripts/migrations.ts`), so a fresh apply order is **not** numeric/intended historical order. **Version/history gaps present:** missing `044`, `114`; jumps `050 -> 098`, `113 -> 115`.
- **Duplicate versions:** none detected by prefix (no same numeric prefix duplicated in current tree).
- **Misplaced migrations:** runner enforces loaded-directory-only and scans for other `migrations/*.sql` outside loaded dir (`assertMigrationsInLoadedDirectory`); no runtime scan executed here, but guard exists. `.worktree/base` contains separate tree copies (artifact) — must not be treated as active migrations.
- **DB-applied history vs files:** **Not verified** (no DB connection/mutation in Phase 0). Cannot confirm every file is recorded, no orphan history versions, or absence of schema objects outside migrations.
- **Migration runner behavior:** `scripts/db-migrate.ts` applies pending migrations sequentially in its own transaction per migration and records only on commit; blocks `rolsuper/rolbypassrls` migration role; runs post-apply `schemaIntegrityProblems`. **No checkpoint/pause/resume mechanism** for DBA-owned steps between migrations.

### Migration 125/126 (design observations, not execution approval)
- `125`: creates `app.organization_link_dispatched_transfers(uuid,uuid)` (SECURITY DEFINER, `search_path public,pg_temp`), grants `USAGE,CREATE` on schema `app` and EXECUTE on `app.organization_role` to `medveris_transfer_guard`, sets owner to `medveris_transfer_guard`, revokes PUBLIC, grants runtime EXECUTE. **Assumes migrator can perform owner/privilege operations in target environment.**
- `126`: validates role/function/owner/EXECUTE invariants and applies narrow `USAGE` + column-level `SELECT` grants to `medveris_transfer_guard`; explicitly requires DBA prerequisites for ownership/EXECUTE states it cannot self-satisfy. This is a **verification/reconciliation** migration with hard-fail checks — compatible with “record only when complete” intent but requires a safe DBA checkpoint process outside/around runner today.
- `db-setup.ts` (local): grants `medveris_exchange` and `medveris_transfer_guard` membership to migrator and provisions local schema grants — **local-only per prior gate; conflicts with non-negotiable “no permanent migrator membership in BYPASSRLS role” for hardened/hosted model** and must be reworked under approved architecture.

## 4. Defect inventory (baseline)

| Area | Finding | Severity / confidence | Notes |
|---|---|---|---|
| Migration ordering | Lexicographic load places `98/99` after `126`; numeric gaps (`044`,`114`, etc.) | **High** | Risk of inconsistent fresh rebuilds or confusing history; must be resolved with a reviewed, history-safe strategy (no blind renumber on applied DBs). |
| Migration checkpointing | No runner support for DBA ownership-transfer pause/resume | **High** | Blocks safe 125/126 application on managed DBs under least-privilege constraints. |
| Role provisioning | `db-setup.ts` grants migrator membership in `medveris_exchange` and `medveris_transfer_guard` (BYPASSRLS NOLOGIN roles) | **High (policy/security)** | Acceptable only as explicit local synthetic bootstrap if tightly constrained; not acceptable for hosted/permanent design. |
| Synthetic seed determinism/idempotency | Prior gate reported seed non-idempotent in earlier state; seed now has some conflict-guard inserts and RLS-aware contexts but remains a large multi-entity script with mixed fixed IDs/hash IDs and potential duplicate side effects on rerun | **Medium-High** | Requires full dependency map and rerun proof in isolated synthetic DB. |
| Data cleanup tooling | No dedicated, dependency-aware defective-synthetic cleanup/reconciliation workflow documented; `db-reset-synthetic` drops/recreates schemas for `medveris_dev|test` only | **Medium** | Correct safety boundary for reset script; targeted cleanup for other synthetic datasets not yet established. |
| Shared-supply/org integrity | Working-tree hardening present (locked link revalidation in dispatch, helper-based in-transit checks, 42883 fail-closed); correctness and regression coverage **not fully re-verified in this run** | **Medium** | Must be validated by tests and security review. |
| Obsolete refs (payment/infra) | **Not exhaustively verified** in Phase 0; repo contains LivePay/Resend/staging config and integration flags — requires targeted audit | **Unknown** | No blanket removal justified without classification. |
| FK/orphans/duplicates/tenant links/sequences in live data | **Not assessed** (no DB access) | **Unknown** | Requires per-database, read-only inventory in approved environments. |

## 5. Data classification

- **Definite synthetic/dev scaffolding:** `scripts/seed.ts` synthetic identities/tenants/patients, `db-reset-synthetic.ts` limited to `medveris_(dev|test)`, test fixtures/integration suites.
- **Potentially retainable/non-synthetic:** any hosted staging/production content **unclassified** from repo alone.
- **Rule applied:** no record treated as deletable unless proven invalid synthetic/test in an approved, isolated scope with backup/approval gates.

## 6. Security findings (baseline)

- **Positive controls observed:** tx-scoped context via `set_config(..., true)` with timeouts (`packages/db`), migration-role checks, RLS helper usage in app routes, `FORCE RLS`/immutability patterns implied by migrations/scripts, narrow 126 grants, fail-closed behavior for missing helper in routes.
- **Risks/open items:** migrator membership in BYPASSRLS-capable helper owners in local setup; absence of explicit pooling/session-leak and identity-spoof integration evidence in this run; `medveris_exchange` broad ownership model must be preserved/reviewed carefully; no confirmation of hosted role posture, public EXECUTE revocations, or function `search_path` completeness across all SECURITY DEFINER functions.
- **Hosted mutation safety:** no hosted connections, migrations, role changes, deploys, or traffic/secret changes performed.

## 7. Risks

1. **Critical:** environment/database identity ambiguity blocks safe cleanup/migration/deploy decisions.
2. **High:** migration ordering/checkpointing and privileged ownership transfer are release blockers for managed DBs.
3. **High:** any attempt to “clean” without classification risks data loss; production/staging contents unknown.
4. **Medium:** synthetic rebuild/seed not yet proven deterministic/idempotent in this pass; prior gate noted partial verification gaps (full suite/build/audit/staging).

## 8. Recommended remediation sequence (proposed, pending approval)

1. **Confirm scope & approvals:** classify each DB (dev/test/disposable synthetic staging vs retained staging vs production), backup/restore evidence, and DBA availability; freeze hosted mutations.
2. **Design migration/role remediation:** define DBA-controlled ownership-transfer checkpoint for 125/126 without permanent migrator membership in BYPASSRLS roles; decide safe handling of `98/99` ordering and history gaps for fresh vs already-applied environments.
3. **Harden provisioning scripts:** split local synthetic bootstrap vs hosted DBA runbooks; strict allowlists, no implicit hosted admin, no permanent privileged memberships.
4. **Application identity & RLS verification:** add/execute spoofing, pooling-leak, fail-closed, and cross-tenant tests in isolated DB.
5. **Synthetic data engineering:** inventory dependencies, implement deterministic/idempotent fixtures, targeted cleanup only for proven-invalid synthetic records with backups.
6. **Integrity fixes:** review shared-supply/org flows, constraints/indexes/sequence state, and remove/replace obsolete refs only where verified.
7. **Full local verification:** lint, typecheck, unit/integration/full tests, build, audit, seed idempotency, reset/restore rehearsals (isolated synthetic only).
8. **Staging gate & execution (separate approval):** preflight, backup/restore rehearsal, reviewed migrations/DBA checkpoints, deploy/smoke, no auto-promotion.
9. **Production readiness package (separate approval):** manifests/checklists/rollback; no production mutation or synthetic seed.

**Phase 0 complete.** Awaiting review/approval before **Step B+** (any file or database modification beyond approved documentation).
