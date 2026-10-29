import { hmacHex } from "@medveris/auth";
import { canonicalJson, merkleRootOf } from "@medveris/domain";
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
      select batch_number, signature from integrity_checkpoints
       where tenant_id = ${tenantId} order by batch_number desc limit 1
    `)[0];
    // Selection is by recorded membership, not a time range: an event that commits after this
    // checkpoint simply stays unsealed and is picked up by the next one.
    const events = await tx`
      select a.id, a.event_hash, a.occurred_at from audit_events a
       left join integrity_checkpoint_events m on m.event_id = a.id
       where a.tenant_id = ${tenantId} and m.event_id is null
       order by a.occurred_at, a.id
       limit 5000
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
        merkle_root, previous_checkpoint_hash, signature, signature_key_id, algorithm, ledger_state, leaf_selection)
      values (${id}, ${tenantId}, ${batchNumber}, ${leaves.length}, ${leaves[0]!.occurredAt}, ${leaves[leaves.length - 1]!.occurredAt},
        ${merkleRoot}, ${previousCheckpointHash}, ${signature}, ${keyId}, 'SHA-256-MERKLE+HMAC-SHA256', 'not-requested', 'recorded')
      on conflict (tenant_id, batch_number) do nothing
      returning id
    `;
    if (!inserted.length) return null;
    for (const [position, leaf] of leaves.entries()) {
      await tx`
        insert into integrity_checkpoint_events (checkpoint_id, event_id, position) values (${id}, ${leaf.id}, ${position})
      `;
    }
    return { tenantId, batchNumber, eventCount: leaves.length, merkleRoot, ledgerState: "not-requested" };
  }) as Promise<CheckpointResult | null>;
}

export { merkleRootOf };

export async function checkpointAllTenants(sql: Sql, signingKey: string, keyId: string): Promise<CheckpointResult[]> {
  const tenants = await sql`select id from tenants where status = 'active' order by id`;
  const results: CheckpointResult[] = [];
  for (const tenant of tenants) {
    const result = await maybeCreateCheckpoint(sql, String(tenant.id), signingKey, keyId);
    if (result) results.push(result);
  }
  return results;
}
