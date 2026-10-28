import { z } from "zod";

/**
 * Queue message contract. A message names an outbox event and nothing else: no payload, no
 * patient data, no clinical content. The consumer loads the authoritative outbox row with the
 * jobs role, checks that the row's tenant matches the message, and only then acts. Messages
 * are delivered at least once, so every handler must be idempotent.
 */
export const JOB_SCHEMA_VERSION = 1;

export const JOB_KINDS = [
  "notification",
  "search-index",
  "analytics",
  "audit",
  "file-processing",
  "interoperability",
  "maintenance",
  "record",
] as const;

export type JobKind = (typeof JOB_KINDS)[number];

export const jobMessageSchema = z.strictObject({
  v: z.literal(JOB_SCHEMA_VERSION),
  jobId: z.guid(),
  kind: z.enum(JOB_KINDS),
  eventType: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z0-9_-]+)+$/).max(100),
  tenantId: z.guid().nullable(),
  aggregateId: z.guid().nullable(),
  /** Number of times the outbox row has been claimed for delivery, for diagnostics only. */
  claim: z.number().int().min(1).max(1000),
  correlationId: z.string().regex(/^[A-Za-z0-9._:-]{8,64}$/).nullable(),
  enqueuedAt: z.iso.datetime(),
});

export type JobMessage = z.infer<typeof jobMessageSchema>;

/**
 * Routes outbox event types to job kinds. Kinds without a configured external adapter are
 * recorded as handled-locally, exactly as the scheduled drain did before queues existed;
 * adding an adapter later does not change producers.
 */
export function kindForEvent(eventType: string): JobKind {
  if (/^(invitation|notification|appointment)\./.test(eventType)) return "notification";
  if (/^(content|directory)\./.test(eventType)) return "search-index";
  if (/^(report|public-health)\./.test(eventType)) return "analytics";
  if (/^(emergency\.override|patient\.merge|consent)\./.test(eventType)) return "audit";
  if (/^(document|credential)\./.test(eventType)) return "file-processing";
  if (/^(lab|radiology|diagnostic|integration)\./.test(eventType)) return "interoperability";
  if (/^(maintenance|reconcile)\./.test(eventType)) return "maintenance";
  return "record";
}

export interface ParseFailure {
  ok: false;
  /** Reason without message content, safe to log. */
  reason: string;
  jobId: string | null;
}

export function parseJobMessage(body: unknown): { ok: true; message: JobMessage } | ParseFailure {
  const result = jobMessageSchema.safeParse(body);
  if (result.success) return { ok: true, message: result.data };
  const jobId = body && typeof body === "object" && typeof (body as { jobId?: unknown }).jobId === "string"
    && /^[0-9a-f-]{36}$/i.test((body as { jobId: string }).jobId) ? (body as { jobId: string }).jobId : null;
  const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".") || "(root)"))].slice(0, 5);
  return { ok: false, reason: `schema:${fields.join(",")}`, jobId };
}
