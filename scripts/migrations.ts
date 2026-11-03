import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { Client } from "pg";

export interface Migration {
  version: string;
  body: string;
}

const TRANSACTION_CONTROL = /^[ \t]*(BEGIN|COMMIT|ROLLBACK|START[ \t]+TRANSACTION|END[ \t]+TRANSACTION)[ \t]*;[ \t]*$/gim;
const REQUIRED_APP_FUNCTIONS = [
  "app.current_tenant()",
  "app.current_user()",
  "app.current_patient()",
  "app.actor_kind()",
  "app.roles()",
  "app.has_any_role(text[])",
  "app.is_platform_reviewer()",
  "app.reject_immutable_mutation()",
];

/**
 * Migration files wrap themselves in BEGIN/COMMIT. The runner owns the
 * transaction instead, so the wrapper is removed; any other top-level
 * transaction control would commit early and is rejected.
 */
export function stripTransactionWrapper(version: string, sql: string): string {
  const matches = [...sql.matchAll(TRANSACTION_CONTROL)];
  if (matches.length === 0) return sql;
  const first = matches[0]!;
  const last = matches[matches.length - 1]!;
  const before = sql.slice(0, first.index).replace(/--[^\n]*/g, "").trim();
  const after = sql.slice(last.index! + last[0].length).replace(/--[^\n]*/g, "").trim();
  if (
    matches.length !== 2
    || first[1]!.toUpperCase() !== "BEGIN"
    || last[1]!.toUpperCase() !== "COMMIT"
    || before !== ""
    || after !== ""
  ) {
    throw new Error(`${version}: only a single leading BEGIN; and trailing COMMIT; are supported as transaction control`);
  }
  return sql.slice(first.index! + first[0].length, last.index);
}

const MIGRATIONS_DIRECTORY = resolve(process.cwd(), "packages/db/migrations");
const IGNORED_TREE_DIRECTORIES = new Set(["node_modules", ".git", ".wrangler", ".freebuff", ".worktree", "dist", "build", "coverage", "test-results", ".data", ".mail-sink"]);

/**
 * Migration files are only applied from the loaded directory. A `.sql` file in
 * any other `migrations/` folder (for example `apps/api/src/db/migrations`) is
 * silently ignored by the runner, so it must fail instead of being forgotten.
 */
export async function misplacedMigrations(root = process.cwd(), loadedDir = MIGRATIONS_DIRECTORY): Promise<string[]> {
  const loaded = resolve(loadedDir);
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (IGNORED_TREE_DIRECTORIES.has(entry.name) || entry.name.startsWith(".aider")) continue;
      const child = resolve(dir, entry.name);
      if (child === loaded) continue;
      if (entry.name === "migrations") {
        const files = (await readdir(child)).filter((file) => file.endsWith(".sql")).sort();
        for (const file of files) found.push(relative(root, resolve(child, file)) || file);
        continue;
      }
      await walk(child);
    }
  }
  await walk(root);
  return found.sort();
}

export async function assertMigrationsInLoadedDirectory(root = process.cwd(), loadedDir = MIGRATIONS_DIRECTORY): Promise<void> {
  const misplaced = await misplacedMigrations(root, loadedDir);
  if (!misplaced.length) return;
  throw new Error(
    `Migration files exist outside the loaded directory ${relative(root, loadedDir) || loadedDir}: ${misplaced.join(", ")}. `
    + "Move them into the loaded directory (and renumber without collisions) before migrating.",
  );
}

export async function loadMigrations(dir = MIGRATIONS_DIRECTORY): Promise<Migration[]> {
  // The guard only makes sense for the real project layout; an explicit custom
  // directory is used by tests and does not describe this repository.
  if (resolve(dir) === MIGRATIONS_DIRECTORY) await assertMigrationsInLoadedDirectory(process.cwd(), dir);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    migrations.push({ version: file, body: stripTransactionWrapper(file, await readFile(resolve(dir, file), "utf8")) });
  }
  return migrations;
}

export async function ensureMigrationTable(client: Client): Promise<void> {
  await client.query(`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`);
}

/** Runs inside the caller's transaction; the migration and its record commit together. */
export async function applyMigration(client: Client, migration: Migration): Promise<void> {
  await client.query(migration.body);
  await client.query("insert into schema_migrations(version) values ($1)", [migration.version]);
}

/**
 * Detects a recorded-but-broken schema, e.g. helper functions dropped with
 * the app schema, which also cascades to every RLS policy and trigger using them.
 */
export async function schemaIntegrityProblems(client: Client): Promise<string[]> {
  const problems: string[] = [];
  const functions = await client.query<{ signature: string }>(
    "select f as signature from unnest($1::text[]) f where to_regprocedure(f) is null",
    [REQUIRED_APP_FUNCTIONS],
  );
  for (const row of functions.rows) problems.push(`missing function ${row.signature}`);
  const unprotected = await client.query<{ relname: string }>(`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r','p')
       and (c.relrowsecurity or c.relforcerowsecurity)
       and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
     order by 1`);
  if (unprotected.rowCount) {
    const names = unprotected.rows.map((row) => row.relname);
    problems.push(`${names.length} RLS tables have no policies (${names.slice(0, 5).join(", ")}${names.length > 5 ? ", ..." : ""})`);
  }
  const notForced = await client.query<{ relname: string }>(`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r','p') and c.relrowsecurity and not c.relforcerowsecurity
     order by 1`);
  if (notForced.rowCount) problems.push(`RLS not forced on ${notForced.rows.map((row) => row.relname).join(", ")}`);
  const auditTrigger = await client.query(`
    select 1 from pg_trigger where tgrelid = to_regclass('public.audit_events') and tgname = 'audit_events_immutable' and not tgisinternal`);
  if (!auditTrigger.rowCount) problems.push("missing audit_events_immutable trigger");
  return problems;
}
