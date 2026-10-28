import type { Sql } from "./index.js";
import type { ShardAssignment, ShardState } from "./shards.js";

/**
 * Directory operations run with the migration role, the only role allowed to change
 * tenant_shard_assignments. Each change is recorded by trigger in the history table with the
 * session user and the reason given here.
 */
export async function readAssignment(sql: Sql, tenantId: string): Promise<ShardAssignment | null> {
  const [row] = await sql`select tenant_id, shard_id, state, routing_version from tenant_shard_assignments where tenant_id = ${tenantId}`;
  return row ? { tenantId: String(row.tenantId), shardId: String(row.shardId), state: row.state as ShardState, routingVersion: Number(row.routingVersion) } : null;
}

export async function setAssignmentState(sql: Sql, tenantId: string, change: { shardId?: string; state: ShardState; reason: string }): Promise<ShardAssignment> {
  if (change.reason.trim().length < 3) throw new Error("A reason is required for every shard directory change");
  const [row] = await sql`
    update tenant_shard_assignments
       set state = ${change.state}, shard_id = coalesce(${change.shardId ?? null}, shard_id), reason = ${change.reason.trim().slice(0, 500)}
     where tenant_id = ${tenantId}
    returning tenant_id, shard_id, state, routing_version
  `;
  if (!row) throw new Error("Tenant has no shard assignment");
  return { tenantId: String(row.tenantId), shardId: String(row.shardId), state: row.state as ShardState, routingVersion: Number(row.routingVersion) };
}

/** Tables holding tenant-owned rows, found from the schema rather than a hand-kept list. */
export async function tenantTables(sql: Sql): Promise<string[]> {
  const rows = await sql`
    select c.table_name from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public' and c.column_name = 'tenant_id' and t.table_type = 'BASE TABLE'
       and c.table_name not in ('tenant_shard_assignments', 'tenant_shard_assignment_history')
     order by c.table_name
  `;
  return rows.map((row) => String(row.tableName));
}

export interface TenantFingerprint {
  tenantId: string;
  tables: Record<string, { rows: number; digest: string }>;
  digest: string;
}

/**
 * Order-independent digest of every tenant-owned row, used to prove a copied tenant matches
 * its source before cut-over. Needs a role that can read all of the tenant's rows (the
 * database owner or an administrative role on the shard), because it must not depend on RLS
 * context. It reads data but never returns or logs row contents.
 */
export async function tenantFingerprint(sql: Sql, tenantId: string, tables?: string[]): Promise<TenantFingerprint> {
  const names = tables ?? (await tenantTables(sql));
  const result: TenantFingerprint["tables"] = {};
  for (const name of names) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unexpected table name ${name}`);
    const [row] = await sql.unsafe(
      `select count(*)::int as rows, coalesce(md5(string_agg(md5(t::text), '' order by md5(t::text))), md5('')) as digest
         from public.${name} t where t.tenant_id = $1`,
      [tenantId],
    );
    result[name] = { rows: Number(row?.rows ?? 0), digest: String(row?.digest ?? "") };
  }
  const combined = Object.entries(result).map(([name, value]) => `${name}:${value.rows}:${value.digest}`).join("|");
  const [overall] = await sql`select md5(${combined}) as digest`;
  return { tenantId, tables: result, digest: String(overall?.digest ?? "") };
}
