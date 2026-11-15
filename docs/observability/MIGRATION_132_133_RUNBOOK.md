# DBA Runbook — Support Roles for Migrations 132 and 133

Covers `packages/db/migrations/132_assistant_read_only.sql` (role
`medveris_assistant`) and `packages/db/migrations/133_break_glass_narrow_role.sql`
(role `medveris_operator_guard`).

> Status: NOT applied to staging or production.
>
> **These migrations no longer create roles.** Both roles are created by the
> database bootstrap (`npm run db:setup`, `scripts/db-setup.ts`), which connects
> as the database admin. The migrations verify the role exists with the intended
> attributes and apply the grants. See §2 for why.

---

## 1. What these migrations do

| Migration | Requires | Grants |
|---|---|---|
| `132_assistant_read_only.sql` | role `medveris_assistant` to exist (LOGIN, NOSUPERUSER, NOBYPASSRLS) | USAGE on schemas `public` and `app`; EXECUTE on `app.security_event_summary(integer)` and `app.outbox_backlog()`. No table privileges anywhere. |
| `133_break_glass_narrow_role.sql` | role `medveris_operator_guard` to exist (LOGIN, NOSUPERUSER, NOBYPASSRLS) | USAGE on schema `app`; EXECUTE on `app.is_platform_operator()` only. No table access, no USAGE on `public`. |

Both roles are LOGIN roles. Their passwords are set separately (see §3); neither
the bootstrap nor the migrations set one.

## 2. Why role creation moved out of the migrations

The repository's migration role `medveris_migrator` is
`NOSUPERUSER NOCREATEROLE NOBYPASSRLS` on purpose, and `scripts/db-migrate.ts`
refuses to run as superuser. Role DDL in a migration therefore cannot execute
under the normal migration path:

```
$ npm run db:migrate
applied 131_support_center_tickets.sql
migration failed (rolled back): 132_assistant_read_only.sql
error: permission denied to create role
```

That made **every fresh database unmigratable** — CI included — because the
runner stops at the first failure. The earlier workaround (apply 132/133 by hand
as a superuser and insert the `schema_migrations` rows) hid the problem instead
of fixing it and could not be reproduced by anyone else.

Privilege options considered:

- **(a) grant the migrator `CREATEROLE`.** Rejected. The migrator is the DDL
  role; `CREATEROLE` lets it create arbitrary login roles and is a privilege
  escalation far wider than "add two fixed support roles".
- **(b) create the roles in the operator bootstrap, and let the migrations
  verify and grant.** Chosen. `npm run db:setup` already provisions the runtime,
  jobs, exchange and transfer-guard roles as admin; the two support roles belong
  next to them. The migrator keeps `NOCREATEROLE`, the runner keeps its
  superuser refusal, and a fresh database migrates end to end.

The migrations themselves remain the single source of truth for *grants*. They
raise an actionable error if the bootstrap was skipped, and refuse to continue
if an existing role is `SUPERUSER` or `BYPASSRLS`:

```
ERROR:  role medveris_assistant is missing: run the operator bootstrap (npm run db:setup) before migrating
HINT:   The migration role is NOCREATEROLE by design; see docs/observability/MIGRATION_132_133_RUNBOOK.md
```

## 3. One-time operator action (each existing environment)

**Run this before the next `db:migrate` on any environment that predates this
change, and before deploying a Worker that needs either role.** It is the only
step that requires elevated privileges; run it as the database admin, not as
`medveris_migrator`, `medveris_runtime` or `medveris_jobs`.

1. **Backup / restore point.** Confirm the latest automated backup and a recent
   restore drill per `docs/production-gate` requirements. Record the timestamp.

2. **Create the roles** (idempotent; safe to re-run). Either run the bootstrap
   with admin credentials:

   ```bash
   # PGADMIN_URL must point at the same server as MIGRATION_DATABASE_URL.
   PGADMIN_URL='postgres://<admin>@<host>:5432/postgres' \
   MIGRATION_DATABASE_URL='postgres://medveris_migrator@<host>:5432/<db>' \
     npm run db:setup
   ```

   …or run the equivalent DDL by hand:

   ```sql
   CREATE ROLE medveris_assistant
     LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
   CREATE ROLE medveris_operator_guard
     LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;

   COMMENT ON ROLE medveris_assistant IS
     'Read-only assistant surface: EXECUTE on count-only app helpers, no table privileges, no BYPASSRLS.';
   COMMENT ON ROLE medveris_operator_guard IS
     'Break-glass verification: EXECUTE on app.is_platform_operator() only. No table access, no BYPASSRLS.';
   ```

   `db:setup` leaves an existing role untouched, so re-running it never widens
   privileges.

3. **Set the passwords from the secret manager** (never in git or shell history):

   ```sql
   ALTER ROLE medveris_assistant      PASSWORD '<from secret manager: ASSISTANT_DB_PASSWORD>';
   ALTER ROLE medveris_operator_guard PASSWORD '<from secret manager: OPERATOR_GUARD_DB_PASSWORD>';
   ```

4. **Migrate normally.** The runner applies 132 and 133 like any other migration
   and records them:

   ```bash
   npm run db:migrate
   ```

   If an environment already applied 132/133 by hand, the versions are recorded
   and the runner skips them; the grants are unchanged by this runbook.

## 4. Verification queries (run on each environment after applying)

```sql
-- 4a. Roles exist with the right attributes and can log in.
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
  FROM pg_roles
 WHERE rolname IN ('medveris_assistant','medveris_operator_guard')
 ORDER BY 1;
-- Expect: rolsuper=f, rolbypassrls=f, rolcanlogin=t for both.

-- 4b. Assistant grants are exactly: schema USAGE + two helper EXECUTEs.
SELECT has_schema_privilege('medveris_assistant','public','USAGE')  AS pub_usage,
       has_schema_privilege('medveris_assistant','app','USAGE')     AS app_usage,
       has_function_privilege('medveris_assistant','app.security_event_summary(integer)','EXECUTE') AS ses_exec,
       has_function_privilege('medveris_assistant','app.outbox_backlog()','EXECUTE')                 AS ob_exec;
-- Expect: all true.

-- 4c. Assistant holds SELECT on NO table in public.
SELECT count(*) AS assistant_select_tables
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
   AND has_table_privilege('medveris_assistant', c.oid, 'SELECT');
-- Expect: 0.

-- 4d. Guard grants are exactly: schema app USAGE + is_platform_operator EXECUTE.
SELECT has_function_privilege('medveris_operator_guard','app.is_platform_operator()','EXECUTE') AS guard_exec,
       has_schema_privilege('medveris_operator_guard','app','USAGE')                           AS guard_app_usage,
       has_schema_privilege('medveris_operator_guard','public','USAGE')                        AS guard_pub_usage;
-- Expect: guard_exec=t, guard_app_usage=t, guard_pub_usage=f.

-- 4e. Live refusal checks (connect AS each role, not as the DBA).
--   psql "postgres://medveris_operator_guard:<pw>@<host>:<port>/<db>" -c "SELECT app.is_platform_operator();"
--     -> succeeds (false without the operator GUC)
--   psql ... -c "SELECT count(*) FROM clinical_entries;"   -> permission denied / relation does not exist
--   psql ... -c "SELECT count(*) FROM platform_roles;"     -> permission denied
--   psql "postgres://medveris_assistant:<pw>@..." -c "SELECT * FROM app.security_event_summary(60);"
--     -> succeeds, returns 0 rows without the operator GUC
--   psql ... -c "SELECT count(*) FROM patients;"           -> permission denied for table patients

-- 4f. schema_migrations parity.
SELECT version FROM schema_migrations
 WHERE version IN ('132_assistant_read_only.sql','133_break_glass_narrow_role.sql')
 ORDER BY version;
-- Expect both rows.
```

## 5. Idempotency

Re-running 132/133 is a no-op for the runner once recorded. Applied by hand
again, both are safe for any role: the role block only reads `pg_roles`, and the
`REVOKE ALL` baseline prevents privilege accumulation. Verified on a disposable
database: a second application exited 0 with identical privilege state.

Dropping a role and re-running the migration fails loudly rather than silently
granting nothing (see §2).

## 6. Rollback

Both roles own no objects, so rollback is a single statement per role. Revoke
first if the role was granted anything out of band, then drop:

```sql
-- 132
DROP ROLE medveris_assistant;        -- grants die with the role
-- 133
DROP ROLE medveris_operator_guard;
```

`DROP ROLE` fails if the role still holds privileges in **another** database on
the same server, or owns objects. If it does:
```sql
-- In each database where the role holds privileges:
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM medveris_assistant;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM medveris_assistant;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app    FROM medveris_assistant;
REVOKE ALL ON SCHEMA public FROM medveris_assistant;
REVOKE ALL ON SCHEMA app    FROM medveris_assistant;
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM medveris_operator_guard;  -- if ever granted
REVOKE ALL ON SCHEMA app    FROM medveris_operator_guard;
REVOKE ALL ON SCHEMA public FROM medveris_operator_guard;
```
Then remove the version rows:
```sql
DELETE FROM schema_migrations
 WHERE version IN ('132_assistant_read_only.sql','133_break_glass_narrow_role.sql');
```

After dropping the roles, no application code path is affected: no runtime code
references either role (they are only consumed by tests and the held
`platform-operator.ts` CLI).

## 7. Not part of this runbook

- Do not grant `CREATEROLE` to `medveris_migrator` to make role DDL "work" in a
  migration. Create roles in the bootstrap instead.
- Do not attach the roles to Hyperdrive bindings or Worker secrets. They are for
  out-of-band support/break-glass tooling only.
