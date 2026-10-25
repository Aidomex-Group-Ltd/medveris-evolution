import type { Context } from "hono";
import type { ActorContext } from "@medveris/authz";
import type { AppEnv } from "../types.js";
import { auditMeta } from "./http.js";
import type { AuditInput } from "./audit.js";
import { NotFoundError } from "./errors.js";
import type { Tx } from "@medveris/db";

export function requestActor(c: Context<AppEnv>): ActorContext {
  const auth = c.get("auth");
  if (!auth) throw new NotFoundError("Authenticated actor context is missing");
  return {
    userId: auth.user.id,
    roles: auth.activeTenant?.roles ?? (auth.patientId ? ["patient"] : []),
    tenantId: auth.activeTenant?.id ?? null,
    patientId: auth.patientId,
    mfaVerified: auth.mfaVerified,
    mfaEnrolled: Boolean(auth.user.mfaEnrolledAt),
    platformRoles: auth.platformRoles,
  };
}

export function requestAudit(
  c: Context<AppEnv>,
  action: string,
  input: Omit<AuditInput, "actorKind" | "action" | "actorUserId" | "tenantId" | "actorRoles"> & {
    metadata?: Record<string, unknown>;
  } = {},
): AuditInput {
  const auth = c.get("auth")!;
  const meta = auditMeta(c);
  return {
    tenantId: auth.activeTenant?.id ?? null,
    actorUserId: auth.user.id,
    actorKind: auth.activeTenant ? "staff" : "patient",
    actorRoles: auth.activeTenant?.roles ?? [],
    action,
    ...input,
    ...meta,
    metadata: input.metadata ?? {},
  };
}

export async function requireRows<T>(rows: T[], message: string): Promise<T> {
  if (!rows[0]) throw new NotFoundError(message);
  return rows[0];
}

export async function lockEncounter(tx: Tx, tenantId: string, encounterId: string) {
  const rows = await tx`
    select id, patient_id, state, type, version from encounters
     where id = ${encounterId} and tenant_id = ${tenantId} for update
  `;
  return requireRows(rows, "Encounter not found");
}
