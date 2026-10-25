import { hmacHex } from "@medveris/auth";
import { canonicalJson, sha256Hex } from "@medveris/domain";
import type { Sql } from "@medveris/db";

interface AuditRow {
  id: string;
  eventHash: string;
  occurredAt: Date;
}

export interface CheckpointResult {
  tenantId: string;
  batchNumber: number;
  eventCount: number;
  merkleRoot: string;
  ledgerState: string;
}

export async function maybeCreateCheckpoint(sql: Sql, tenantId: string, signingKey: string, keyId: string): Promise<CheckpointResult | null> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`integrity:${tenantId}`}))`;
    const last = (await tx`
      select batch_number, range_end, signature from integrity_checkpoints
       where tenant_id = ${tenantId} order by batch_number desc limit 1
    `)[0];
    const rangeStart = last ? new Date(last.rangeEnd as Date) : new Date(0);
    const rangeEnd = new Date();
    const events = await tx`
      select id, event_hash, occurred_at from audit_events
       where tenant_id = ${tenantId} and occurred_at > ${rangeStart} and occurred_at <= ${rangeEnd}
       order by occurred_at, id
    `;
    if (!events.length) return null;
    const leaves: AuditRow[] = events.map((row) => ({
      id: String(row.id),
      eventHash: String(row.eventHash),
      occurredAt: row.occurredAt as Date,
    }));
    const merkleRoot = await merkleRootOf(leaves);
    const batchNumber = last ? Number(last.batchNumber) + 1 : 1;
    const previousCheckpointHash = last ? String(last.signature) : null;
    const id = crypto.randomUUID();
    const payload = {
      tenantId,
      batchNumber,
      eventCount: leaves.length,
      rangeStart: leaves[0]!.occurredAt.toISOString(),
      rangeEnd: leaves[leaves.length - 1]!.occurredAt.toISOString(),
      merkleRoot,
      previousCheckpointHash,
      keyId,
      algorithm: "SHA-256-MERKLE+HMAC-SHA256",
    };
    const signature = await hmacHex(signingKey, canonicalJson(payload));
    const inserted = await tx`
      insert into integrity_checkpoints (id, tenant_id, batch_number, event_count, range_start, range_end,
        merkle_root, previous_checkpoint_hash, signature, signature_key_id, algorithm, ledger_state)
      values (${id}, ${tenantId}, ${batchNumber}, ${leaves.length}, ${leaves[0]!.occurredAt}, ${leaves[leaves.length - 1]!.occurredAt},
        ${merkleRoot}, ${previousCheckpointHash}, ${signature}, ${keyId}, 'SHA-256-MERKLE+HMAC-SHA256', 'not-requested')
      on conflict (tenant_id, batch_number) do nothing
      returning id
    `;
    if (!inserted.length) return null;
    return { tenantId, batchNumber, eventCount: leaves.length, merkleRoot, ledgerState: "not-requested" };
  }) as Promise<CheckpointResult | null>;
}

export async function merkleRootOf(leaves: AuditRow[]): Promise<string> {
  if (!leaves.length) return await sha256Hex("");
  let level: string[] = [];
  for (const leaf of leaves) level.push(await sha256Hex(`${leaf.id}:${leaf.eventHash}`));
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]!;
      const right = level[index + 1] ?? left;
      next.push(await sha256Hex(`${left}${right}`));
    }
    level = next;
  }
  return level[0]!;
}

export async function checkpointAllTenants(sql: Sql, signingKey: string, keyId: string): Promise<CheckpointResult[]> {
  const tenants = await sql`select id from tenants where status = 'active' order by id`;
  const results: CheckpointResult[] = [];
  for (const tenant of tenants) {
    const result = await maybeCreateCheckpoint(sql, String(tenant.id), signingKey, keyId);
    if (result) results.push(result);
  }
  return results;
}
