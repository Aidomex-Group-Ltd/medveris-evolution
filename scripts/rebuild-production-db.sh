#!/usr/bin/env bash
# Destructive rebuild of the synthetic production database.
#
# Usage:
#   scripts/rebuild-production-db.sh --dry-run
#   scripts/rebuild-production-db.sh --confirm=medveris-prod
#
# The script never changes role passwords. It preserves the existing
# medveris_app / medveris_jobs / medveris_migrator logins and verifies them
# before and after the rebuild. It temporarily grants the migration role
# membership in the BYPASSRLS helper-owner roles so the migrations can apply
# their grants, then restores the exact pre-rebuild membership state.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${MEDVERIS_PRODUCTION_ENV:-$HOME/.config/medveris/production/db.env}"
TARGET_DB="medveris-prod"
EXPECTED_HOST="127.0.0.1"
EXPECTED_PORT="55432"
BACKUP_DIR="${MEDVERIS_BACKUP_DIR:-$HOME/medveris-backups}"
PSQL="/usr/lib/postgresql/18/bin/psql"
PG_RESTORE="/usr/lib/postgresql/18/bin/pg_restore"

DRY_RUN=0
CONFIRM=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --confirm=*) CONFIRM="${arg#--confirm=}" ;;
    *) echo "unknown argument: $arg" >&2; exit 64 ;;
  esac
done

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "missing $ENV_FILE"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

for name in MIGRATION_DATABASE_URL DATABASE_URL JOBS_DATABASE_URL PGADMIN_URL; do
  [ -n "${!name:-}" ] || die "$name is required in $ENV_FILE"
done

url_field() {
  node -e '
    const u = new URL(process.argv[1]);
    const field = process.argv[2];
    if (field === "db") process.stdout.write(u.pathname.replace(/^\//, ""));
    else if (field === "host") process.stdout.write(u.hostname);
    else if (field === "port") process.stdout.write(u.port || "5432");
    else if (field === "user") process.stdout.write(decodeURIComponent(u.username));
    else process.exit(2);
  ' "$1" "$2"
}

admin_psql() {
  local database="${1:-$TARGET_DB}"
  node -e '
    const { spawnSync } = require("node:child_process");
    const u = new URL(process.env.PGADMIN_URL);
    const env = {
      ...process.env,
      PGHOST: u.hostname,
      PGPORT: u.port || "5432",
      PGUSER: decodeURIComponent(u.username),
      PGPASSWORD: decodeURIComponent(u.password),
      PGDATABASE: process.argv[1],
    };
    const result = spawnSync(
      "/usr/lib/postgresql/18/bin/psql",
      ["-v", "ON_ERROR_STOP=1", "-X", "-q", "-t", "-A", "-f", "-"],
      { env, stdio: ["inherit", "inherit", "inherit"] },
    );
    process.exit(result.status ?? 1);
  ' "$database"
}

login_user() {
  "$PSQL" "$1" -X -q -t -A -c "select current_user" 2>/dev/null || true
}

migrator_role_check() {
  "$PSQL" "$MIGRATION_DATABASE_URL" -X -q -t -A -c \
    "select current_user || '|' || (select rolbypassrls from pg_roles where rolname = current_user) || '|' || current_setting('row_security')"
}

[ "$(url_field "$MIGRATION_DATABASE_URL" db)" = "$TARGET_DB" ] || die "MIGRATION_DATABASE_URL must target $TARGET_DB"
[ "$(url_field "$DATABASE_URL" db)" = "$TARGET_DB" ] || die "DATABASE_URL must target $TARGET_DB"
[ "$(url_field "$JOBS_DATABASE_URL" db)" = "$TARGET_DB" ] || die "JOBS_DATABASE_URL must target $TARGET_DB"
[ "$(url_field "$MIGRATION_DATABASE_URL" host)" = "$EXPECTED_HOST" ] || die "MIGRATION_DATABASE_URL host must be $EXPECTED_HOST"
[ "$(url_field "$MIGRATION_DATABASE_URL" port)" = "$EXPECTED_PORT" ] || die "MIGRATION_DATABASE_URL port must be $EXPECTED_PORT"
[ "$(url_field "$PGADMIN_URL" host)" = "$EXPECTED_HOST" ] || die "PGADMIN_URL host must be $EXPECTED_HOST"
[ "$(url_field "$PGADMIN_URL" port)" = "$EXPECTED_PORT" ] || die "PGADMIN_URL port must be $EXPECTED_PORT"

ss -ltn "sport = :$EXPECTED_PORT" | grep -q ":$EXPECTED_PORT" || die "SSH tunnel is not listening on $EXPECTED_HOST:$EXPECTED_PORT"
/usr/lib/postgresql/18/bin/pg_isready -h "$EXPECTED_HOST" -p "$EXPECTED_PORT" -t 5 >/dev/null || die "database is not ready on $EXPECTED_HOST:$EXPECTED_PORT"

server_version_num=$(admin_psql postgres <<'SQL'
show server_version_num;
SQL
)
[ "$server_version_num" -ge 160000 ] || die "PostgreSQL 16+ is required for role membership options (found $server_version_num)"

admin_is_super=$(admin_psql postgres <<'SQL'
select rolsuper from pg_roles where rolname = current_user;
SQL
)
[ "$admin_is_super" = "t" ] || die "PGADMIN_URL must be a superuser for the rebuild"

db_exists=$(admin_psql postgres <<'SQL'
select count(*) from pg_database where datname = 'medveris-prod';
SQL
)

if [ "$db_exists" = "1" ]; then
  migrator_check=$(migrator_role_check)
  [ "$migrator_check" = "medveris_migrator|false|on" ] || die "migrator must be NOSUPERUSER NOBYPASSRLS with row_security=on (found $migrator_check)"
  [ "$(login_user "$DATABASE_URL")" = "medveris_app" ] || die "DATABASE_URL cannot log in as medveris_app; role password does not match the configured app credential"
  [ "$(login_user "$JOBS_DATABASE_URL")" = "medveris_jobs" ] || die "JOBS_DATABASE_URL cannot log in as medveris_jobs"
  [ "$(login_user "$MIGRATION_DATABASE_URL")" = "medveris_migrator" ] || die "MIGRATION_DATABASE_URL cannot log in as medveris_migrator"
else
  log "database $TARGET_DB is absent; it will be created by db:setup"
fi

role_state=$(admin_psql postgres <<'SQL'
select rolname || '|' || rolsuper || '|' || rolbypassrls || '|' || rolcanlogin
  from pg_roles
 where rolname in ('medveris_migrator','medveris_runtime','medveris_jobs','medveris_app','medveris_exchange','medveris_transfer_guard','medveris_assistant','medveris_operator_guard')
 order by rolname;
SQL
)
printf '%s\n' "$role_state" | grep -qx 'medveris_app|false|false|true' || die "medveris_app must be LOGIN NOSUPERUSER NOBYPASSRLS"
printf '%s\n' "$role_state" | grep -qx 'medveris_jobs|false|false|true' || die "medveris_jobs must be LOGIN NOSUPERUSER NOBYPASSRLS"
printf '%s\n' "$role_state" | grep -qx 'medveris_migrator|false|false|true' || die "medveris_migrator must be LOGIN NOSUPERUSER NOBYPASSRLS"
printf '%s\n' "$role_state" | grep -qx 'medveris_runtime|false|false|true' || die "medveris_runtime must be LOGIN NOSUPERUSER NOBYPASSRLS"

membership_state=$(admin_psql postgres <<'SQL'
select m.rolname || '|' || am.inherit_option || '|' || am.set_option
  from pg_auth_members am
  join pg_roles r on r.oid = am.member
  join pg_roles m on m.oid = am.roleid
 where r.rolname = 'medveris_migrator'
   and m.rolname in ('medveris_exchange','medveris_transfer_guard')
 order by m.rolname;
SQL
)
printf '%s\n' "$membership_state" | grep -qx 'medveris_exchange|false|true' || die "unexpected migrator membership state (expected medveris_exchange|false|true): $membership_state"
if printf '%s\n' "$membership_state" | grep -q '^medveris_transfer_guard|'; then
  die "unexpected migrator membership in medveris_transfer_guard; refusing to guess"
fi

dump_path_file="$BACKUP_DIR/last-dump.path"
[ -f "$dump_path_file" ] || die "no safety dump recorded at $dump_path_file"
dump_path=$(cat "$dump_path_file")
[ -f "$dump_path" ] || die "safety dump is missing: $dump_path"
[ -f "$dump_path.sha256" ] || die "safety dump checksum is missing: $dump_path.sha256"
(cd "$(dirname "$dump_path")" && sha256sum -c "$(basename "$dump_path").sha256" >/dev/null) || die "safety dump checksum failed"
"$PG_RESTORE" --list "$dump_path" >/dev/null || die "safety dump is not readable by pg_restore"

migration_count=$(find "$ROOT/packages/db/migrations" -maxdepth 1 -name '*.sql' | wc -l)
if [ "$db_exists" = "1" ]; then
  applied_count=$(admin_psql "$TARGET_DB" <<'SQL'
select count(*) from schema_migrations;
SQL
)
else
  applied_count="absent"
fi

log "target: database=$TARGET_DB host=$EXPECTED_HOST port=$EXPECTED_PORT"
log "safety dump: $(basename "$dump_path") (sha256 verified, pg_restore readable)"
log "roles: medveris_app, medveris_jobs, medveris_runtime, medveris_migrator present and NOBYPASSRLS"
log "migrator membership: medveris_exchange inherit=false set=true; no medveris_transfer_guard"
log "migrations: $applied_count / $migration_count in the repository"

if [ "$DRY_RUN" -eq 1 ]; then
  log ""
  log "DRY RUN — no changes made. Planned actions:"
  log "  1. terminate every session on $TARGET_DB"
  log "  2. drop and recreate $TARGET_DB via npm run db:setup (roles left unchanged)"
  log "  3. temporarily grant medveris_exchange and medveris_transfer_guard to medveris_migrator WITH INHERIT TRUE"
  log "  4. APP_ENV=production npm run db:migrate -- --confirm-database=$TARGET_DB"
  log "  5. restore migrator membership (exchange INHERIT FALSE/SET TRUE; revoke transfer_guard)"
  log "  6. grant CONNECT on $TARGET_DB to medveris_app"
  log "  7. verify migration parity, RLS flags, role logins, function grants and data_checksums"
  log "  8. brief live-app outage during steps 1-4"
  exit 0
fi

[ "$CONFIRM" = "$TARGET_DB" ] || die "refusing destructive rebuild: pass --confirm=$TARGET_DB"

TEMP_MEMBERSHIPS=0
restore_memberships() {
  if [ "$TEMP_MEMBERSHIPS" -eq 1 ]; then
    admin_psql postgres <<'SQL' || true
set client_min_messages = warning;
grant medveris_exchange to medveris_migrator with inherit false, set true;
revoke medveris_transfer_guard from medveris_migrator;
SQL
    TEMP_MEMBERSHIPS=0
  fi
}
trap restore_memberships EXIT

log "terminating sessions on $TARGET_DB..."
admin_psql postgres <<'SQL'
select pg_terminate_backend(pid)
  from pg_stat_activity
 where datname = 'medveris-prod'
   and pid <> pg_backend_pid();
SQL

log "dropping $TARGET_DB..."
admin_psql postgres <<'SQL'
drop database if exists "medveris-prod";
SQL

log "provisioning roles and database (passwords unchanged)..."
APP_ENV=production npm run db:setup

log "temporarily granting migration memberships..."
TEMP_MEMBERSHIPS=1
admin_psql postgres <<'SQL'
set client_min_messages = warning;
grant medveris_exchange to medveris_migrator with inherit true, set true;
grant medveris_transfer_guard to medveris_migrator with inherit true, set true;
SQL

log "applying migrations..."
APP_ENV=production npm run db:migrate -- --confirm-database="$TARGET_DB"

log "restoring migrator membership..."
restore_memberships

log "granting CONNECT to medveris_app..."
admin_psql postgres <<'SQL'
grant connect on database "medveris-prod" to medveris_app;
SQL

expected_versions=$(cd "$ROOT" && find packages/db/migrations -maxdepth 1 -name '*.sql' -printf '%f\n' | sort)
applied_versions=$(admin_psql "$TARGET_DB" <<'SQL'
select version from schema_migrations order by version;
SQL
)
pending=$(comm -23 <(printf '%s\n' "$expected_versions") <(printf '%s\n' "$applied_versions") || true)
unknown=$(comm -13 <(printf '%s\n' "$expected_versions") <(printf '%s\n' "$applied_versions") || true)
[ -z "$pending" ] || die "pending migrations after rebuild: $pending"
[ -z "$unknown" ] || die "unknown migration versions after rebuild: $unknown"
[ "$(printf '%s\n' "$applied_versions" | grep -c .)" -eq "$migration_count" ] || die "migration count mismatch after rebuild"

rls_state=$(admin_psql "$TARGET_DB" <<'SQL'
select count(*) filter (where c.relrowsecurity) || '|' || count(*) filter (where c.relforcerowsecurity)
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r','p');
SQL
)

app_check=$("$PSQL" "$DATABASE_URL" -X -q -t -A -c "select current_user || '|' || (select rolbypassrls from pg_roles where rolname = current_user) || '|' || current_setting('row_security')")
jobs_check=$("$PSQL" "$JOBS_DATABASE_URL" -X -q -t -A -c "select current_user || '|' || (select rolbypassrls from pg_roles where rolname = current_user) || '|' || current_setting('row_security')")
migrator_check=$(migrator_role_check)
[ "$app_check" = "medveris_app|false|on" ] || die "runtime role check failed: $app_check"
[ "$jobs_check" = "medveris_jobs|false|on" ] || die "jobs role check failed: $jobs_check"
[ "$migrator_check" = "medveris_migrator|false|on" ] || die "migrator role check failed: $migrator_check"

checksums=$(admin_psql postgres <<'SQL'
show data_checksums;
SQL
)
[ "$checksums" = "on" ] || die "data_checksums is not on"

grant_state=$(admin_psql "$TARGET_DB" <<'SQL'
select has_function_privilege('medveris_runtime','app.is_platform_operator()','EXECUTE')::text || '|' ||
       has_function_privilege('medveris_runtime','app.outbox_backlog()','EXECUTE')::text || '|' ||
       has_function_privilege('medveris_runtime','app.security_event_summary(integer)','EXECUTE')::text || '|' ||
       has_function_privilege('medveris_jobs','app.is_platform_operator()','EXECUTE')::text || '|' ||
       pg_has_role('medveris_app','medveris_runtime','MEMBER')::text || '|' ||
       has_function_privilege('medveris_assistant','app.security_event_summary(integer)','EXECUTE')::text || '|' ||
       has_function_privilege('medveris_assistant','app.outbox_backlog()','EXECUTE')::text || '|' ||
       has_function_privilege('medveris_operator_guard','app.is_platform_operator()','EXECUTE')::text;
SQL
)
[ "$grant_state" = "true|true|true|true|true|true|true|true" ] || die "function/role grant verification failed: $grant_state"

log ""
log "REBUILD COMPLETE"
log "  migrations: $(printf '%s\n' "$applied_versions" | grep -c .)/$migration_count, no pending or unknown"
log "  RLS tables: enabled|forced = $rls_state"
log "  role logins: $app_check ; $jobs_check ; $migrator_check"
log "  data_checksums: $checksums"
log "  helper/role grants: $grant_state"
log ""
log "Next: create the first platform operator account (register, verify email, enrol TOTP), then run:"
log "  APP_ENV=production npm run platform:operator -- grant --user <uuid> --reason \"initial platform bootstrap\" --allow-production"
