import type { Context } from "hono";
import { sha256Hex } from "@medveris/auth";
import { withContext } from "@medveris/db";
import { UnauthorizedError, ForbiddenError } from "../lib/errors.js";
import { enforceRateLimit } from "../lib/rate-limit.js";
import type { AppEnv } from "../types.js";

export interface IntegrationClient {
  id: string;
  clientId: string;
  tenantId: string | null;
  environment: "sandbox" | "production";
  scopes: string[];
  products: string[];
  callbackUrl: string | null;
}

export async function requireIntegration(c: Context<AppEnv>, requiredScope: string): Promise<IntegrationClient> {
  const header = c.req.header("authorization") ?? "";
  if (!header.startsWith("Bearer ")) throw new UnauthorizedError("A Bearer integration token is required");
  const token = header.slice(7).trim();
  if (token.length < 20) throw new UnauthorizedError("Invalid integration token");
  const tokenHash = await sha256Hex(token);
  const sql = c.get("deps").sql;
  const result = await withContext(sql, { actorKind: "system", platformRole: "platform_operator" }, async (tx) => {
    const rows = await tx`
      select t.id as token_row_id, t.scopes as token_scopes, t.expires_at, t.revoked_at, t.audience,
             c.id, c.client_id, c.tenant_id, c.environment, c.status, c.scopes as client_scopes,
             c.products, c.callback_url
        from integration_tokens t
        join integration_clients c on c.id = t.client_id
       where t.token_hash = ${tokenHash}
       limit 1
    `;
    const row = rows[0];
    if (!row) return null;
    if (row.revokedAt || row.status !== "active") return null;
    if (new Date(row.expiresAt).getTime() <= Date.now()) return null;
    await tx`update integration_tokens set last_used_at = now() where id = ${row.tokenRowId}`;
    await tx`update integration_clients set last_used_at = now() where id = ${row.id}`;
    return row;
  });
  if (!result) throw new UnauthorizedError("Invalid or expired integration token");
  const scopes = result.tokenScopes as string[];
  if (!scopes.includes(requiredScope)) {
    throw new ForbiddenError(`The integration token does not include the ${requiredScope} scope`);
  }
  await enforceRateLimit(c, "integration.request", String(result.id));
  if (!result.tenantId && requiredScope !== "integration.directory.read") {
    throw new ForbiddenError("The integration client is not bound to a facility tenant");
  }
  return {
    id: result.id,
    clientId: result.clientId,
    tenantId: result.tenantId,
    environment: result.environment,
    scopes,
    products: result.products as string[],
    callbackUrl: result.callbackUrl,
  };
}

export async function withIntegrationContext<T>(
  c: Context<AppEnv>,
  client: IntegrationClient,
  fn: (tx: Parameters<Parameters<typeof withContext>[2]>[0]) => Promise<T>,
): Promise<T> {
  return withContext(c.get("deps").sql, {
    tenantId: client.tenantId,
    actorKind: "system",
    roles: [],
  }, fn);
}
