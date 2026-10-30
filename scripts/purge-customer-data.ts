import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { Client } from "pg";
import { databaseName, loadLocalEnv } from "./lib.js";

loadLocalEnv();

const PRESERVE_TABLES = new Set([
  "api_products",
  "content_sources",
  "onboarding_catalogues",
  "plan_resource_rules",
  "schema_migrations",
  "sponsored_packages",
  "subscription_plans",
  "usage_resources",
]);
const ALLOWED_DATABASES = new Set(["medveris_staging", "medveris_production"]);
const SYSTEM_USER_ID = "00000000-0000-4000-8000-000000000001";
const SYSTEM_USER_EMAIL = "system@medveris.invalid";

interface ColumnRow {
  column_name: string;
  identity_generation: string | null;
  is_generated: string;
  is_identity: string;
}

interface FkRow {
  table: string;
  refTable: string;
  columns: string[];
  refColumns: string[];
  nullable: boolean;
  sourceSchema: string;
  refSchema: string;
}

interface SessionRow {
  db: string;
  usr: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
}

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function qualified(table: string): string {
  return `${quoteIdent("public")}.${quoteIdent(table)}`;
}

function backupName(table: string): string {
  return `_purge_backup_${table}`;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function countRows(client: Client, table: string): Promise<number> {
  const result = await client.query<{ n: string }>(`select count(*)::text as n from ${qualified(table)}`);
  return Number(result.rows[0]?.n ?? 0);
}

async function countTempRows(client: Client, table: string): Promise<number> {
  const result = await client.query<{ n: string }>(
    `select count(*)::text as n from pg_temp.${quoteIdent(backupName(table))}`,
  );
  return Number(result.rows[0]?.n ?? 0);
}

async function main(): Promise<void> {
  const dryRun = hasFlag("dry-run");
  const execute = hasFlag("yes");
  const allowProduction = hasFlag("allow-production");
  const confirmed = argValue("confirm-database");
  const backupFile = argValue("backup-file");

  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  const adminBase = process.env.PURGE_DATABASE_URL ?? process.env.PGADMIN_URL;
  if (!adminBase) throw new Error("PURGE_DATABASE_URL or PGADMIN_URL is required");

  let connectionString: string;
  let target: string;
  if (process.env.PURGE_DATABASE_URL) {
    connectionString = process.env.PURGE_DATABASE_URL;
    target = databaseName(connectionString);
    if (migrationUrl && databaseName(migrationUrl) !== target) {
      throw new Error("PURGE_DATABASE_URL and MIGRATION_DATABASE_URL target different databases");
    }
  } else {
    if (!migrationUrl) throw new Error("MIGRATION_DATABASE_URL is required when PURGE_DATABASE_URL is not set");
    target = databaseName(migrationUrl);
    const admin = new URL(adminBase);
    if (admin.host !== new URL(migrationUrl).host) {
      throw new Error("PGADMIN_URL and MIGRATION_DATABASE_URL must point at the same database server");
    }
    admin.pathname = `/${target}`;
    connectionString = admin.toString();
  }

  if (!ALLOWED_DATABASES.has(target)) {
    throw new Error(`Refusing to purge ${target}: only ${[...ALLOWED_DATABASES].join(", ")} are permitted`);
  }

  const appEnv = process.env.APP_ENV ?? process.env.NODE_ENV ?? "development";
  const production = appEnv === "production" || target === "medveris_production";
  if (production && !allowProduction) {
    throw new Error(`Refusing to purge ${target} without --allow-production`);
  }

  if (!dryRun) {
    if (!execute) throw new Error("Refusing to purge without --yes");
    if (confirmed !== target) {
      throw new Error(`Refusing to purge without --confirm-database=${target}`);
    }
    if (!backupFile) throw new Error("Refusing to purge without --backup-file=<pg_dump path>");
    if (!existsSync(backupFile) || !statSync(backupFile).isFile() || statSync(backupFile).size === 0) {
      throw new Error(`Backup file is missing or empty: ${backupFile}`);
    }
  }

  console.log(`purge target: database=${target} app_env=${appEnv}${dryRun ? " (dry run)" : ""}`);

  const client = new Client({ connectionString });
  await client.connect();
  let committed = false;
  try {
    const [session] = (await client.query<SessionRow>(
      "select current_database() as db, current_user as usr, r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user",
    )).rows;
    if (!session) throw new Error("Could not identify the connected database role");
    if (session.db !== target) throw new Error(`Connected to ${session.db}, expected ${target}`);
    if (!session.rolsuper && !session.rolbypassrls) {
      throw new Error(`Role ${session.usr} must be SUPERUSER or BYPASSRLS to purge with RLS enabled`);
    }
    console.log(`purge role: ${session.usr}`);

    const allTables = (await client.query<{ table_name: string }>(
      "select tablename as table_name from pg_tables where schemaname = 'public' order by tablename",
    )).rows.map((row) => row.table_name);
    const allTableSet = new Set(allTables);
    const presentPreserve = new Set([...PRESERVE_TABLES].filter((table) => allTableSet.has(table)));
    const missingPreserve = [...PRESERVE_TABLES].filter((table) => !allTableSet.has(table)).sort();
    const purgeTables = allTables.filter((table) => !presentPreserve.has(table));
    if (!purgeTables.length) throw new Error("No tables to purge");
    if (!purgeTables.includes("users")) throw new Error("The users table is missing; refusing to continue");

    const fkRows = (await client.query<{
      conname: string;
      table_name: string;
      ref_table: string;
      columns: string[];
      ref_columns: string[];
      nullable: boolean;
      source_schema: string;
      ref_schema: string;
    }>(
      `select con.conname,
              rel.relname as table_name,
              ref.relname as ref_table,
              array_agg(att.attname order by k.ord) as columns,
              array_agg(refatt.attname order by k.ord) as ref_columns,
              bool_and(not att.attnotnull) as nullable,
              n.nspname as source_schema,
              rn.nspname as ref_schema
         from pg_constraint con
         join pg_class rel on rel.oid = con.conrelid
         join pg_namespace n on n.oid = rel.relnamespace
         join pg_class ref on ref.oid = con.confrelid
         join pg_namespace rn on rn.oid = ref.relnamespace
         join lateral unnest(con.conkey) with ordinality as k(attnum, ord) on true
         join lateral unnest(con.confkey) with ordinality as rk(attnum, ord) on rk.ord = k.ord
         join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
         join pg_attribute refatt on refatt.attrelid = con.confrelid and refatt.attnum = rk.attnum
        where con.contype = 'f'
        group by con.oid, rel.relname, ref.relname, n.nspname, rn.nspname
        order by rel.relname, con.conname`,
    )).rows;
    const fks: FkRow[] = fkRows.map((row) => ({
      table: row.table_name,
      refTable: row.ref_table,
      columns: row.columns,
      refColumns: row.ref_columns,
      nullable: row.nullable,
      sourceSchema: row.source_schema,
      refSchema: row.ref_schema,
    }));

    const affected = new Set(purgeTables);
    for (;;) {
      let added = false;
      for (const fk of fks) {
        if (fk.sourceSchema === "public" && fk.refSchema === "public" && affected.has(fk.refTable) && !affected.has(fk.table)) {
          affected.add(fk.table);
          added = true;
        }
      }
      if (!added) break;
    }

    const external = fks.filter(
      (fk) => fk.sourceSchema !== "public" && fk.refSchema === "public" && affected.has(fk.refTable),
    );
    if (external.length) {
      throw new Error(
        `Tables outside public reference purged tables: ${external.map((fk) => `${fk.sourceSchema}.${fk.table}->${fk.refTable}`).join(", ")}`,
      );
    }

    const affectedPreserve = allTables.filter((table) => presentPreserve.has(table) && affected.has(table));
    const preserveOrder = topoSort(affectedPreserve, fks);
    const preserveUserFks = fks.filter(
      (fk) => fk.sourceSchema === "public" && affectedPreserve.includes(fk.table) && fk.refTable === "users",
    );
    const systemUserCollision = (await client.query<{ n: string }>(
      "select count(*)::text as n from public.users where id = $1 or email = $2",
      [SYSTEM_USER_ID, SYSTEM_USER_EMAIL],
    )).rows[0]?.n;
    if (Number(systemUserCollision ?? 0) > 0) {
      console.log(`existing system placeholder rows: ${systemUserCollision}`);
    }

    const purgeCounts = new Map<string, number>();
    for (const table of purgeTables) purgeCounts.set(table, await countRows(client, table));
    const preserveCounts = new Map<string, number>();
    for (const table of presentPreserve) preserveCounts.set(table, await countRows(client, table));

    const nonEmptyPurge = purgeTables.filter((table) => (purgeCounts.get(table) ?? 0) > 0);
    console.log(`preserved tables: ${[...presentPreserve].sort().join(", ") || "(none)"}`);
    if (missingPreserve.length) console.log(`preserved tables not present in this database: ${missingPreserve.join(", ")}`);
    console.log(`tables to truncate: ${purgeTables.length}`);
    console.log(`preserved tables also truncated by cascade: ${affectedPreserve.join(", ") || "(none)"}`);
    console.log("non-empty tables to purge:");
    for (const table of nonEmptyPurge) console.log(`  ${table}: ${purgeCounts.get(table)}`);
    console.log("preserved row counts:");
    for (const table of [...presentPreserve].sort()) console.log(`  ${table}: ${preserveCounts.get(table)}`);
    if (presentPreserve.has("content_sources")) {
      const scoped = (await client.query<{ n: string }>(
        "select count(*)::text as n from public.content_sources where tenant_id is not null",
      )).rows[0]?.n;
      console.log(`content_sources with tenant_id: ${scoped} (tenant-scoped rows will be removed)`);
    }
    console.log(`system placeholder user: ${SYSTEM_USER_ID} <${SYSTEM_USER_EMAIL}>`);
    if (preserveUserFks.length) console.log(`user references in preserved tables: ${preserveUserFks.length}`);

    if (dryRun) {
      console.log("dry run complete; no changes made");
      return;
    }

    const backupSize = statSync(backupFile!).size;
    console.log(`backup: ${backupFile} (${backupSize} bytes, sha256 ${await sha256(backupFile!)})`);

    await client.query("begin");
    await client.query("set local lock_timeout = '15s'");
    await client.query("set local statement_timeout = '30min'");
    await client.query("set local row_security = off");
    await client.query("set local session_replication_role = replica");

    for (const table of affectedPreserve) {
      await client.query(`create temp table ${quoteIdent(backupName(table))} as table ${qualified(table)}`);
      for (const fk of fks.filter((row) => row.table === table && row.sourceSchema === "public")) {
        if (fk.columns.length !== 1 || fk.refColumns.length !== 1) {
          throw new Error(`Preserved table ${table} has a composite foreign key to ${fk.refTable}; refusing to guess`);
        }
        const column = quoteIdent(fk.columns[0]!);
        const temp = `pg_temp.${quoteIdent(backupName(table))}`;
        if (fk.refTable === "users") {
          await client.query(`update ${temp} set ${column} = $1 where ${column} is not null`, [SYSTEM_USER_ID]);
        } else if ((fk.refTable === "tenants" || fk.refTable === "organizations") && fk.nullable) {
          const removed = await client.query<{ n: string }>(
            `with changed as (delete from ${temp} where ${column} is not null returning 1) select count(*)::text as n from changed`,
          );
          if (Number(removed.rows[0]?.n ?? 0) > 0) {
            console.log(`removed ${removed.rows[0]!.n} ${table} rows scoped to ${fk.refTable}`);
          }
        } else if (fk.refTable === "tenants" || fk.refTable === "organizations") {
          throw new Error(`Preserved table ${table}.${fk.columns[0]} is a required reference to ${fk.refTable}; refusing to continue`);
        }
      }
    }

    const restoreCounts = new Map<string, number>();
    for (const table of affectedPreserve) restoreCounts.set(table, await countTempRows(client, table));

    await client.query(`truncate table ${purgeTables.map(qualified).join(", ")} cascade`);

    await client.query(
      `insert into public.users
         (id, email, email_verified_at, password_hash, display_name, given_name, family_name, status)
       values ($1, $2, now(), $3, 'MedVeris System', 'MedVeris', 'System', 'closed')`,
      [SYSTEM_USER_ID, SYSTEM_USER_EMAIL, `purged-${randomBytes(32).toString("hex")}`],
    );

    for (const table of preserveOrder) {
      const columns = (await client.query<ColumnRow>(
        `select column_name, identity_generation, is_generated, is_identity
           from information_schema.columns
          where table_schema = 'public' and table_name = $1
          order by ordinal_position`,
        [table],
      )).rows.filter((column) => column.is_generated !== "ALWAYS");
      const columnList = columns.map((column) => quoteIdent(column.column_name)).join(", ");
      const override = columns.some(
        (column) => column.is_identity === "YES" && column.identity_generation === "ALWAYS",
      )
        ? " overriding system value"
        : "";
      await client.query(
        `insert into ${qualified(table)} (${columnList})${override} select ${columnList} from pg_temp.${quoteIdent(backupName(table))}`,
      );
    }

    await client.query("set local session_replication_role = origin");

    for (const table of purgeTables) {
      const remaining = await countRows(client, table);
      if (table === "users") {
        const [row] = (await client.query<{ n: string; id: string }>(
          "select count(*)::text as n, min(id::text) as id from public.users",
        )).rows;
        if (Number(row?.n ?? 0) !== 1 || row?.id !== SYSTEM_USER_ID) {
          throw new Error(`users table has ${row?.n ?? 0} rows after purge; expected only ${SYSTEM_USER_ID}`);
        }
      } else if (remaining !== 0) {
        throw new Error(`${table} still has ${remaining} rows after purge`);
      }
    }

    for (const table of presentPreserve) {
      const after = await countRows(client, table);
      const expected = affectedPreserve.includes(table) ? restoreCounts.get(table) : preserveCounts.get(table);
      if (after !== expected) {
        throw new Error(`${table} expected ${expected} rows after purge and now has ${after}`);
      }
    }

    for (const fk of fks.filter((row) => row.sourceSchema === "public" && affectedPreserve.includes(row.table))) {
      if (fk.columns.length !== 1 || fk.refColumns.length !== 1) continue;
      const column = quoteIdent(fk.columns[0]!);
      const refColumn = quoteIdent(fk.refColumns[0]!);
      const orphans = (await client.query<{ n: string }>(
        `select count(*)::text as n
           from ${qualified(fk.table)} c
           left join ${qualified(fk.refTable)} p on c.${column} = p.${refColumn}
          where c.${column} is not null and p.${refColumn} is null`,
      )).rows[0]?.n;
      if (Number(orphans ?? 0) !== 0) {
        throw new Error(`${fk.table}.${fk.columns[0]} has ${orphans} orphan references to ${fk.refTable}`);
      }
    }

    await client.query("commit");
    committed = true;

    console.log(`purge complete: ${purgeTables.length} tables truncated, ${affectedPreserve.length} preserved tables restored`);
    console.log(`remaining users: 1 (${SYSTEM_USER_ID} <${SYSTEM_USER_EMAIL}>)`);
  } catch (error) {
    if (!committed) await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

function topoSort(tables: string[], fks: FkRow[]): string[] {
  const selected = new Set(tables);
  const dependencies = new Map<string, Set<string>>();
  for (const table of tables) dependencies.set(table, new Set());
  for (const fk of fks) {
    if (fk.sourceSchema !== "public" || fk.refSchema !== "public") continue;
    if (selected.has(fk.table) && selected.has(fk.refTable) && fk.table !== fk.refTable) {
      dependencies.get(fk.table)!.add(fk.refTable);
    }
  }

  const order: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(table: string): void {
    if (visited.has(table)) return;
    if (visiting.has(table)) throw new Error(`Cycle in preserved table references involving ${table}`);
    visiting.add(table);
    for (const dependency of dependencies.get(table) ?? []) visit(dependency);
    visiting.delete(table);
    visited.add(table);
    order.push(table);
  }

  for (const table of [...tables].sort()) visit(table);
  return order;
}

await main();
