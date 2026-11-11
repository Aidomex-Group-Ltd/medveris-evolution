# 04 — Security, DBA, and Hosted-Operations Blockers Report

## Items requiring DBA decision/provisioning (stop points for hosted rollout)

1. **Role provisioning (staging/production):** create/provision `medveris_transfer_guard` as NOLOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, BYPASSRLS (or equivalent approved least-privilege posture) per security policy.
2. **Membership/ownership prerequisites:** grant `medveris_transfer_guard` to `medveris_migrator` as required for ownership transfer during migration application, and transfer ownership of `app.organization_link_dispatched_transfers(uuid,uuid)` to `medveris_transfer_guard`.
3. **Privilege reconciliation (must satisfy migration 126 invariants):** EXECUTE on helper for `medveris_runtime` and `medveris_transfer_guard`; no PUBLIC EXECUTE; EXECUTE on `app.organization_role(uuid)` for guard; narrow schema USAGE and column-level SELECT grants on `public.organization_stock_transfers`/`public.organization_links` as specified.
4. **Migration application governance:** apply additive migrations 125/126 only through approved `db-migrate` flow with required `--confirm-database=<target>`/environment controls after review; verify helper owner/privileges/RLS and `schema_migrations` parity.
5. **Backups/restore:** take and verify staging/production backups (and restore procedure) before applying migrations; local restore rehearsal evidence is not a substitute for hosted RPO/RTO validation.

## Hosted operations / external blockers (not performed)
- No inspection or modification of staging/production databases or credentials; staging 125/126 state and role provisioning **unverified**.
- No deploy, wrangler/Cloudflare mutations, or `deploy:staging:check` certification in hosted context.
- `GATE_READINESS_REPORT.md` previously noted local-only script/migration adjustments; **DBA must review/approve** rather than relying on local shortcuts.

## Security review notes
- RLS remains enabled/forced on `organization_stock_transfers` per prior/local checks; runtime role expected nosuperuser/nobypassrls. Any hosted drift must be reconciled.
- SECURITY DEFINER helper intentionally limited to count/existence semantics with access checks; ownership and EXECUTE surface must be tightly controlled (DBA-owned).
- Outbox consumer delivery/poison/dedup and exhaustive denial-audit semantics across all endpoints/actors remain **not fully verified** and should be included in hosted/staging validation plan.

## Explicit stop condition
Per instructions, work stops at DBA decision/hosted-operation boundaries: **do not apply 125/126, alter roles/grants, or run migrations against staging/production without DBA action and approval**.

## Verified production posture (read-only, this session)

Production `medveris-prod` (PG 18.6) is at **77/77** recorded migrations and already
contains the reviewed helper posture:

- `app.organization_link_dispatched_transfers(uuid,uuid)`: `SECURITY DEFINER`,
  `STABLE`, owner `medveris_transfer_guard`, `proconfig = search_path=public, pg_temp`.
- ACL: `{medveris_transfer_guard=X/medveris_transfer_guard, medveris_runtime=X/medveris_transfer_guard}`
  — **no PUBLIC**, no migrator EXECUTE.
- `medveris_transfer_guard`: `NOLOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`,
  `BYPASSRLS`. `medveris_migrator` is **not** a member and has `NOBYPASSRLS`.
- `medveris_runtime`, `medveris_jobs`, `medveris_app`: `NOBYPASSRLS`; `medveris_app`
  logs in and is a member of `medveris_runtime`.
- Guard holds only column-level SELECT: `organization_stock_transfers(id,
  organization_id, status, source_tenant_id, destination_tenant_id)` and
  `organization_links(id, organization_id, tenant_id)`; no table-level SELECT.
- `organization_stock_transfers`, `organization_links`, `organization_memberships`:
  RLS enabled **and forced** (3/3/4 policies), owned by `medveris_migrator`.
- Access gate: `app.organization_role(p_org)` is `SECURITY DEFINER` (owner
  `medveris_exchange`, BYPASSRLS) and filters `organization_memberships` by
  `app.current_user()` with `status='active'`. The guard helper returns only a count
  and raises `42501` (denied) or `P0002` (link not found); no row payload is exposed.
- Predicate helpers `app.is_platform_operator()`, `app.is_facility_admin()`,
  `app.is_platform_reviewer()`: `SECURITY DEFINER`, owner `medveris_exchange`,
  EXECUTE only to exchange/runtime/jobs, no PUBLIC, `search_path=public, pg_temp`,
  no dynamic SQL.

Residual review notes (accepted, not blockers): (a) the guard helper's owner has
BYPASSRLS, so any future edit to the function body must preserve the
`app.organization_role(p_org)` gate and avoid dynamic SQL; (b) `pg_temp` is present
in `search_path` but ordered after `public`, and the function uses no dynamic SQL;
(c) `is_platform_reviewer()` does not additionally check `users.status`, relying on
platform-role revocation/expiry; (d) `app.organization_role()` uses `LIMIT 1` without
ordering (only non-null is required).

## Verified staging state and DBA blocker (read-only, this session)

Staging `medveris_staging` (Neon, PG 18.6) is at **66/77**. Missing migrations are
`116`–`126` (not only 125/126). `medveris_transfer_guard` does not exist;
`medveris_migrator` owns `app` and `public`; `medveris_exchange` exists as
`NOLOGIN … BYPASSRLS`. Neon admin roles `neondb_owner`/`neon_service` (CREATEROLE +
BYPASSRLS) and `cloud_admin` (SUPERUSER) are available.

The staging `PGADMIN_URL` in `~/.config/medveris/staging/db.env` is **stale** (old
Aiven host that no longer resolves). Therefore `scripts/db-setup.ts` must not be
used against staging; DBA provisioning must run through a Neon admin connection
(SQL Editor or a fresh `neondb_owner` URL). Prepared artifacts:
`08_NEON_DBA_MIGRATIONS_125_126_RUNBOOK.md`, `08a_…pre…sql`, `08b_…post…sql`.

## Production seed root cause (see 06)

The production synthetic seed was blocked by `loadConfig()` before any insert:
`SESSION_SECRET` → `APP_ORIGIN` → `TERMINOLOGY_MODE=synthetic is not allowed in
production`. It is not a DB-permission or data-corruption failure. The temporary
`ALLOW_PRODUCTION_SYNTHETIC_SEED=1` patch only bypassed the environment guard; it
did not satisfy `loadConfig()`. Production bootstrap must use the reviewed
`platform-operator` break-glass path, not the synthetic seed.
