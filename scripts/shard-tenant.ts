/**
 * Shard directory operations for one tenant. Single-shard deployments use only `status`,
 * `freeze`, `unfreeze` and `fingerprint`; `verify` compares a tenant across two databases and is
 * the gate before any future cut-over. State changes need --confirm-tenant=<uuid> and --reason.
 *
 *   npx tsx scripts/shard-tenant.ts status <tenant>
 *   npx tsx scripts/shard-tenant.ts freeze <tenant> --confirm-tenant=<tenant> --reason="..."
 *   npx tsx scripts/shard-tenant.ts unfreeze <tenant> --confirm-tenant=<tenant> --reason="..."
 *   npx tsx scripts/shard-tenant.ts fingerprint <tenant>            (FINGERPRINT_DATABASE_URL or PGADMIN_URL)
 *   npx tsx scripts/shard-tenant.ts verify <tenant> --source=<env var> --target=<env var>
 *
 * Output never includes row contents, only counts and digests.
 */
import { createSql, readAssignment, setAssignmentState, tenantFingerprint } from "@medveris/db";
import { databaseName, loadLocalEnv } from "./lib.js";

loadLocalEnv();

const [command, tenantId] = process.argv.slice(2);
const flag = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (!command || !tenantId || !UUID.test(tenantId)) {
  console.error("usage: shard-tenant.ts <status|freeze|unfreeze|fingerprint|verify> <tenant-uuid> [options]");
  process.exit(2);
}

function urlFrom(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** Fingerprints need every tenant row regardless of RLS context, so they use an administrative URL for that database. */
function adminUrlFor(url: string): string {
  const admin = new URL(process.env.FINGERPRINT_DATABASE_URL ?? urlFrom("PGADMIN_URL"));
  admin.pathname = `/${databaseName(url)}`;
  return admin.toString();
}

async function main(): Promise<void> {
  if (command === "status") {
    const sql = createSql(urlFrom("MIGRATION_DATABASE_URL"), { max: 1 });
    try {
      console.log(JSON.stringify({ assignment: await readAssignment(sql, tenantId!) }, null, 2));
    } finally {
      await sql.end({ timeout: 5 });
    }
    return;
  }
  if (command === "freeze" || command === "unfreeze") {
    if (flag("confirm-tenant") !== tenantId) throw new Error(`Refusing to change ${tenantId} without --confirm-tenant=${tenantId}`);
    const reason = flag("reason") ?? "";
    if (reason.trim().length < 10) throw new Error("--reason must explain the change (at least 10 characters)");
    const sql = createSql(urlFrom("MIGRATION_DATABASE_URL"), { max: 1 });
    try {
      const assignment = await setAssignmentState(sql, tenantId!, { state: command === "freeze" ? "frozen" : "active", reason });
      console.log(JSON.stringify({ changed: assignment, note: "Workers read the new state on each session lookup; no cache delays it." }, null, 2));
    } finally {
      await sql.end({ timeout: 5 });
    }
    return;
  }
  if (command === "fingerprint") {
    const sql = createSql(adminUrlFor(urlFrom("MIGRATION_DATABASE_URL")), { max: 1 });
    try {
      console.log(JSON.stringify(await tenantFingerprint(sql, tenantId!), null, 2));
    } finally {
      await sql.end({ timeout: 5 });
    }
    return;
  }
  if (command === "verify") {
    const source = createSql(urlFrom(flag("source") ?? "SOURCE_DATABASE_URL"), { max: 1 });
    const target = createSql(urlFrom(flag("target") ?? "TARGET_DATABASE_URL"), { max: 1 });
    try {
      const [a, b] = await Promise.all([tenantFingerprint(source, tenantId!), tenantFingerprint(target, tenantId!)]);
      const differing = Object.keys({ ...a.tables, ...b.tables }).filter((name) => a.tables[name]?.digest !== b.tables[name]?.digest);
      console.log(JSON.stringify({ match: a.digest === b.digest, source: a.digest, target: b.digest, differingTables: differing }, null, 2));
      if (a.digest !== b.digest) process.exitCode = 1;
    } finally {
      await Promise.all([source.end({ timeout: 5 }), target.end({ timeout: 5 })]);
    }
    return;
  }
  throw new Error(`Unknown command ${command}`);
}

await main();
