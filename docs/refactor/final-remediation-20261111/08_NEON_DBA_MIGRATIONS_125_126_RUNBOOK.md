# 08 — Neon DBA runbook: staging migrations 116–126 (125/126 helper owner)

## Why this is needed

Staging (`medveris_staging` on Neon, PG 18.6) is at **66/77** recorded migrations.
Missing: `116`–`126`. Only `125`/`126` require DBA action, because migration 125
transfers ownership of a `SECURITY DEFINER` function to the dedicated
`medveris_transfer_guard` role and migration 126 asserts that posture. A
`NOCREATEROLE`/`NOBYPASSRLS` migrator cannot do that alone.

Verified staging state (read-only, this session):

- `medveris_transfer_guard` **does not exist**.
- `medveris_migrator` owns schemas `app` and `public` (prerequisite is satisfied).
- `medveris_exchange` already exists as `NOLOGIN … BYPASSRLS`; `medveris_migrator`,
  `medveris_runtime`, `medveris_jobs` are `NOBYPASSRLS`.
- `schema_migrations` = 66; missing `116`–`126`.
- Neon admin roles available: `neondb_owner` (CREATEROLE + BYPASSRLS),
  `neon_service` (CREATEROLE + BYPASSRLS), `cloud_admin` (SUPERUSER).
- `~/.config/medveris/staging/db.env` `PGADMIN_URL` is **stale (old Aiven host)**.
  Do **not** run `scripts/db-setup.ts` against staging with it. Use the Neon
  project owner / SQL Editor (or a fresh `neondb_owner` connection string).

## Preconditions

1. **Backup/restore point.** Create a Neon branch (instant, copy-on-write) or take a
   `pg_dump` of `medveris_staging` and record the restore command. Do not proceed
   without a verified restore point.
2. Confirm the operator has the **staging** `MIGRATION_DATABASE_URL` (role
   `medveris_migrator`, database `medveris_staging`) and `APP_ENV=staging`.
3. Confirm the migration files `116`–`126` are present in
   `packages/db/migrations/` on the checkout that will run the migrator.

## Step 1 — DBA PRE (as Neon admin)

Run `08a_NEON_DBA_pre_125_126.sql` against `medveris_staging` as
`neondb_owner` / `neon_service` / `cloud_admin`.

Expected notices:

- `created role medveris_transfer_guard` (or `already exists`)
- `temporary membership granted: medveris_migrator -> medveris_transfer_guard (INHERIT FALSE, SET TRUE)`

Why `SET TRUE`: PostgreSQL requires the ability to `SET ROLE` to the target role in
order to execute `ALTER … OWNER TO`. Why `INHERIT FALSE`: the migrator must **not**
silently inherit `BYPASSRLS`. The membership is temporary and is removed in Step 3.

## Step 2 — Apply migrations 116–126 (approved runner, as migrator)

```bash
set -a; . ~/.config/medveris/staging/db.env; set +a
export APP_ENV=staging
npm run db:migrate -- --confirm-database=medveris_staging
```

Expected: `applied 116_…` through `applied 126_…`, then `migrations complete`.
The runner refuses `SUPERUSER`/`BYPASSRLS` sessions; `medveris_migrator` still has
its own `NOBYPASSRLS` attribute, so this check passes while the temporary
`SET TRUE` membership is in effect.

If a migration fails, its transaction rolls back (including 125/126). Capture the
error, fix forward, and re-run; then still run Step 3 to close the window.

## Step 3 — DBA POST (as Neon admin)

Run `08b_NEON_DBA_post_125_126.sql` against `medveris_staging` as the same admin role.

This revokes the temporary membership **first**, then fails closed unless:

- `medveris_transfer_guard` is `NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS`;
- `medveris_migrator` is not a member and does not inherit the guard;
- `app.organization_link_dispatched_transfers(uuid,uuid)` is `SECURITY DEFINER`
  and owned by `medveris_transfer_guard`;
- EXECUTE is granted only to `medveris_transfer_guard` and `medveris_runtime`
  (no PUBLIC, no migrator);
- the guard has EXECUTE on `app.organization_role(uuid)`;
- the guard holds only the required **column-level** SELECT grants;
- RLS stays enabled+forced on `organization_stock_transfers` and `organization_links`;
- `schema_migrations` records both 125 and 126 (total expected 77).

## Step 4 — Evidence to attach

```sql
SELECT count(*) FROM schema_migrations;                      -- 77
SELECT version FROM schema_migrations WHERE version LIKE '12%' ORDER BY version;
SELECT rolname, rolsuper, rolcreaterole, rolbypassrls, rolcanlogin
  FROM pg_roles WHERE rolname LIKE 'medveris%' ORDER BY rolname;
SELECT p.oid::regprocedure::text, pg_get_userbyid(p.proowner) AS owner, p.proacl::text
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'app' AND p.proname = 'organization_link_dispatched_transfers';
SELECT m.member::regrole, m.roleid::regrole, m.admin_option, m.inherit_option, m.set_option
  FROM pg_auth_members m WHERE m.roleid = 'medveris_transfer_guard'::regrole;
```

Then run the application-level staging smoke/gate (health + a real admin/tenant
workflow) before certifying staging.

## Rollback

- **Before Step 2 completes:** run `08b` (it revokes the temporary membership) and
  discard/restore from the backup taken in Preconditions.
- **After 125/126 applied:** do not drop the role or function. Restore the Neon
  branch/backup, or apply a reviewed forward migration. Removing the guard role
  would break org-link transitions.

## Explicit non-goals

- This runbook does **not** touch production (`medveris-prod` already has 77/77 and
  the verified guard posture; see 09).
- This runbook does **not** run the synthetic seed; production/staging seeding is a
  separate, explicitly gated operation.
