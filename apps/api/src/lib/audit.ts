import { hmacHex, randomToken } from "@medveris/auth";
import { canonicalJson, sha256Hex } from "@medveris/domain";
import type { Tx } from "@medveris/db";
import type { AppConfig } from "../config.js";

export interface AuditInput {
  tenantId?: string | null;
  actorUserId?: string | null;
  actorKind: "anonymous" | "registration" | "staff" | "patient" | "system";
  actorRoles?: string[];
  action: string;
  purpose?: string | null;
  subjectPatientId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  decision?: "allow" | "deny";
  reasonCode?: string | null;
  grantId?: string | null;
  overrideId?: string | null;
  correlationId?: string | null;
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}

export interface AuditRecord extends AuditInput {
  id: string;
  occurredAt: Date;
  previousHash: string | null;
  eventHash: string;
  nonce: string;
  signature: string;
}

export async function writeAudit(tx: Tx, config: AppConfig, input: AuditInput): Promise<AuditRecord> {
  const id = crypto.randomUUID();
  const occurredAt = input.occurredAt ?? new Date();
  const nonce = randomToken(16);
  const tenantKey = input.tenantId ?? "global";
  await tx`select pg_advisory_xact_lock(hashtext(${`audit:${tenantKey}`}))`;
  const previous = input.tenantId
    ? await tx`select event_hash from audit_events where tenant_id = ${input.tenantId} order by occurred_at desc, id desc limit 1`
    : await tx`select event_hash from audit_events where tenant_id is null order by occurred_at desc, id desc limit 1`;
  const previousHash = (previous[0]?.eventHash as string | undefined) ?? null;
  const base = {
    id,
    tenantId: input.tenantId ?? null,
    actorUserId: input.actorUserId ?? null,
    actorKind: input.actorKind,
    actorRoles: input.actorRoles ?? [],
    action: input.action,
    purpose: input.purpose ?? null,
    subjectPatientId: input.subjectPatientId ?? null,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    decision: input.decision ?? "allow",
    reasonCode: input.reasonCode ?? null,
    grantId: input.grantId ?? null,
    overrideId: input.overrideId ?? null,
    correlationId: input.correlationId ?? null,
    metadata: input.metadata ?? {},
    occurredAt: occurredAt.toISOString(),
    previousHash,
    nonce,
  };
  const eventHash = await sha256Hex(canonicalJson(base));
  const signature = await hmacHex(config.auditSigningKey, canonicalJson({ ...base, eventHash }));
  const record: AuditRecord = {
    ...input,
    id,
    occurredAt,
    previousHash,
    eventHash,
    nonce,
    signature,
  };
  await tx`
    insert into audit_events (
      id, tenant_id, actor_user_id, actor_kind, actor_roles, action, purpose, subject_patient_id,
      resource_type, resource_id, decision, reason_code, grant_id, override_id, correlation_id,
      ip_address, metadata, occurred_at, previous_hash, event_hash, nonce, signature_key_id, signature
    ) values (
      ${id}, ${input.tenantId ?? null}, ${input.actorUserId ?? null}, ${input.actorKind},
      ${input.actorRoles ?? []}, ${input.action}, ${input.purpose ?? null}, ${input.subjectPatientId ?? null},
      ${input.resourceType ?? null}, ${input.resourceId ?? null}, ${input.decision ?? "allow"},
      ${input.reasonCode ?? null}, ${input.grantId ?? null}, ${input.overrideId ?? null},
      ${input.correlationId ?? null}, ${input.ipAddress ?? null}, ${tx.json((input.metadata ?? {}) as never)},
      ${occurredAt}, ${previousHash}, ${eventHash}, ${nonce}, ${config.auditSigningKeyId}, ${signature}
    )
  `;
  return record;
}

export interface OutboxInput {
  tenantId?: string | null;
  eventType: string;
  aggregateId?: string | null;
  aggregateVersion?: number | null;
  payload?: Record<string, unknown>;
  idempotencyKey?: string | null;
  occurredAt?: Date;
}

export async function writeOutbox(tx: Tx, input: OutboxInput): Promise<string> {
  const id = crypto.randomUUID();
  await tx`
    insert into outbox_events (id, tenant_id, event_type, aggregate_id, aggregate_version, payload, occurred_at, idempotency_key)
    values (${id}, ${input.tenantId ?? null}, ${input.eventType}, ${input.aggregateId ?? null},
      ${input.aggregateVersion ?? null}, ${tx.json((input.payload ?? {}) as never)},
      ${input.occurredAt ?? new Date()}, ${input.idempotencyKey ?? null})
  `;
  return id;
}
