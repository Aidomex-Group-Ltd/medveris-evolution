# Data Safety, Migration & Rollback Protocol (Phase 0.3)

Applies to all refactoring/enhancement work on Medveris. **No destructive database change or irreversible data operation may proceed without an approved migration/recovery plan.**

## Current mechanisms (observed)

- **Migrations:** `packages/db/migrations/*.sql`, loaded/sorted lexically by `scripts/migrations.ts`; applied via `scripts/db-migrate.ts` in runner-controlled transactions, recorded in `schema_migrations` (append-only by usage). Runner strips single BEGIN/COMMIT wrappers, enforces single migration dir, performs preflight (DB/user, migrator not SUPERUSER/BYPASSRLS, target confirmation for risky DBs) and post-migration integrity checks (`app.*` RLS helpers, policies, RLS forced, audit immutability trigger).
- **Setup/reset:** `scripts/db-setup.ts` provisions roles/db/grants; `scripts/db-reset-synthetic.ts` is **destructive** (drops/recreates schemas) and guarded for dev/test/synthetic use only - never for environments with real/protected data.
- **Runtime DB safety:** `packages/db/src/index.ts` sets per-transaction RLS context (`app.tenant_id/user_id/patient_id/actor_kind/roles/...`) with statement/idle timeouts; RLS forced on critical tables.
- **Known risks:** migration numbering gaps/irregular sequence, no down migrations/checksums, some large cross-domain migrations, privilege/RLS drift risk when adding tables without policies/grants.

## Mandatory rules for future changes

1. **Forward-only, additive, backward-compatible**
   - Prefer `CREATE TABLE/INDEX CONCURRENTLY`-equivalent planning where supported by tooling, additive columns/tables/views/functions, nullable/backfilled additions, compatible defaults, and expand/contract deployments.
   - Do not drop/rename columns, tables, constraints, policies, functions, or enums in-place without a staged deprecation plan and evidence they are unused in all deployed code paths.
   - Preserve existing table/column semantics, IDs, referential integrity, and historical records (clinical/financial/audit).
2. **RLS, grants, and invariants**
   - Every new/changed table must have explicit RLS enable/force as appropriate, least-privilege grants to runtime roles (`medveris_runtime`, `medveris_jobs`, `medveris_exchange` etc. as applicable), and policies aligned with tenant/patient/role scoping.
   - Preserve/extend immutability triggers for audit/ledger/version tables; never weaken `app.*` security helpers without replacement and integrity verification.
3. **Transactions and idempotency**
   - Multi-record business operations must be transactional and retry-safe (idempotency keys/unique constraints/conflict handling) to prevent duplicate orders, charges, payments, or clinical artifacts.
4. **No destructive production-path operations by default**
   - No `DROP SCHEMA/TABLE/COLUMN`, `TRUNCATE`, mass `DELETE/UPDATE` without predicates and safeguards, or reset scripts against non-synthetic targets.
   - `db-reset-synthetic` remains dev/test only.

## Migration authoring checklist

- [ ] Additive and backward-compatible with currently deployed API/web/jobs.
- [ ] Lexical filename/version chosen without breaking existing applied history; document intent in file header/comment.
- [ ] No hidden reliance on superuser/bypassrls behavior in runtime.
- [ ] Includes necessary indexes, FKs, checks, defaults, and backfill strategy (batched if large).
- [ ] RLS enabled/forced + policies + grants added/updated.
- [ ] Idempotency/uniqueness constraints for retryable workflows where applicable.
- [ ] Post-conditions covered by `schemaIntegrityProblems` or explicit verification query.

## Pre-migration (required for risky/shared/staging/prod-like changes)

- Identify affected tables, services, jobs, routes, reports, and integrations.
- Take/verify **backup and restore point** (PITR/snapshot as available) and record location/time.
- Validate migration on: (a) empty/local synthetic DB, (b) copy/representative dataset mirroring production shape and edge cases.
- Review lock impact and runtime for large tables; plan maintenance window if needed.
- Prepare rollback/compensation procedure (see below).

## Apply procedure

1. Deploy compatible code if expand/contract required (code must tolerate old+new schema during transition).
2. Run `db:migrate` with appropriate target confirmation in controlled environment.
3. Verify: migration recorded, integrity checks pass, key queries/smoke paths work, RLS/policy behavior correct, no duplicate/idempotency regressions.
4. Monitor errors, latency, locks, and audit/outbox health.

## Rollback / recovery

- **Preferred:** restore from verified backup/PITR to pre-change point (RPO/RTO must be defined per environment).
- **If restore not immediately required:** apply compensating forward migration (additive fix) rather than editing applied migration files.
- Never manually delete `schema_migrations` rows or edit applied SQL in place to "fix" history.
- Document incident, data impact assessment, and corrective actions.

## Verification evidence to record per migration/change

- Migration id/file, environment, timestamp, operator.
- Backup/restore point reference.
- Pre/post checks and query results.
- Test/smoke outcomes and any data backfill counts.
- Rollback readiness confirmation.

## Environment-specific notes

- Local/dev: synthetic data only; reset allowed only via guarded scripts.
- Staging/production: separate DBs/infrastructure; changes require release/deploy controls, secret safety, and (for real data in future) clinical/privacy/governance approval. Current known external gaps: recurring restore drills/RPO-RTO targets, key rotation/recovery drills, hosted CI/promotion gates.
