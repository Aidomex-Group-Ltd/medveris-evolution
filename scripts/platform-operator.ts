/**
 * Break-glass platform operator CLI.
 *
 * This is the only path that can create the very first platform operator, and the only
 * path available when the approval workflow cannot be used (for example, every operator
 * has lost access). It runs as the migration role on purpose: platform_roles is protected
 * by RLS and runtime callers can never grant themselves the role.
 *
 * Production requires the explicit --allow-production flag plus --reason=. Run with:
 *   npm run platform:operator -- list
 *   npm run platform:operator -- grant --user <uuid> --reason "..." [--hours 168] [--actor <uuid>]
 *   npm run platform:operator -- revoke --user <uuid> --reason "..." [--actor <uuid>]
 */
import { createSql, setLocalContext } from "@medveris/db";
import { loadConfig } from "../apps/api/src/config.js";
import { assertBreakGlassAllowed, breakGlassGrant, revokePlatformRoleGrant } from "../apps/api/src/lib/platform-roles.js";
import { loadLocalEnv, requireEnv } from "./lib.js";

loadLocalEnv();

function flag(args: string[], name: string): string | null {
  const prefix = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? null : null;
}

const args = process.argv.slice(2);
const command = args[0];
const appEnv = process.env.APP_ENV ?? process.env.NODE_ENV ?? "development";

if (!command || !["list", "grant", "revoke"].includes(command)) {
  console.error("usage: platform-operator <list|grant|revoke> --user <uuid> --reason \"...\"");
  process.exit(2);
}

// Never guess in production: the flag and a written reason are both required.
assertBreakGlassAllowed(appEnv, args);

const config = loadConfig({ ...process.env, APP_ENV: appEnv });
const sql = createSql(requireEnv("MIGRATION_DATABASE_URL"), { max: 1 });

try {
  if (command === "list") {
    const rows = await sql`
      select user_id, role, granted_at, expires_at, revoked_at
        from platform_roles
       where role = 'platform_operator'
       order by granted_at nulls last
    `;
    console.log(JSON.stringify(rows.map((row) => ({
      userId: row.userId,
      grantedAt: row.grantedAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      active: row.revokedAt === null && (row.expiresAt === null || new Date(row.expiresAt) > new Date()),
    })), null, 2));
  } else {
    const userId = flag(args, "user");
    const reason = flag(args, "reason");
    const actor = flag(args, "actor");
    if (!userId) throw new Error("--user <uuid> is required");
    if (!reason) throw new Error("--reason is required");

    const result = await sql.begin(async (tx) => {
      await setLocalContext(tx, { actorKind: "system" });
      // Break-glass bootstrap: platform_roles uses FORCE RLS, so the very first grant (and
      // any grant made when nobody holds the role) needs this CLI-only session flag. No API
      // route ever sets it, so runtime sessions cannot use this path.
      await tx`select set_config('app.platform_roles_bootstrap', 'true', true)`;
      if (command === "grant") {
        const hoursRaw = flag(args, "hours");
        const hours = hoursRaw === null ? undefined : Number.parseInt(hoursRaw, 10);
        return breakGlassGrant(tx, config, userId, reason, actor, {
          allowProduction: args.includes("--allow-production"),
          hours,
        });
      }
      await revokePlatformRoleGrant(tx, config, {}, userId, actor, reason);
      return { revoked: true };
    });
    console.log(JSON.stringify({ ok: true, userId, ...result }, null, 2));
  }
} finally {
  await sql.end({ timeout: 5 });
}
