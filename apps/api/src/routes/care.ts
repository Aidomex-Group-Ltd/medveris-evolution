import { Hono } from "hono";
import { followUpStatusSchema, referralStatusSchema, uuidSchema } from "@medveris/contracts";
import {
  assertClinicalRead,
  assertClinicalWrite,
  type ActorContext,
} from "@medveris/authz";
import {
  canTransitionFollowUp,
  canTransitionReferral,
  type FollowUpStatus,
  type ReferralStatus,
} from "@medveris/domain";
import type { Tx } from "@medveris/db";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { auditMeta, ensureMatch, parseJson } from "../lib/http.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

export const careRoutes = new Hono<AppEnv>();

function actor(c: Parameters<typeof requireStaff>[0]): ActorContext {
  const auth = c.get("auth")!;
  return {
    userId: auth.user.id,
    roles: auth.activeTenant?.roles ?? [],
    tenantId: auth.activeTenant?.id ?? null,
    patientId: auth.patientId,
    mfaVerified: auth.mfaVerified,
    mfaEnrolled: Boolean(auth.user.mfaEnrolledAt),
    platformRoles: auth.platformRoles,
  };
}

async function followUpForUpdate(tx: Tx, tenantId: string, id: string) {
  const rows = await tx`
    select id, patient_id, encounter_id, due_date, instructions, status, version
      from follow_ups where id = ${id} and tenant_id = ${tenantId} for update
  `;
  if (!rows[0]) throw new NotFoundError("Follow-up not found");
  return rows[0];
}

async function referralForUpdate(tx: Tx, tenantId: string, id: string) {
  const rows = await tx`
    select id, patient_id, encounter_id, to_facility, reason, priority, status, version
      from referrals where id = ${id} and tenant_id = ${tenantId} for update
  `;
  if (!rows[0]) throw new NotFoundError("Referral not found");
  return rows[0];
}

careRoutes.get("/care/follow-ups", async (c) => {
  requireStaff(c);
  assertClinicalRead(actor(c));
  const auth = c.get("auth")!;
  const status = c.req.query("status") ?? "pending";
  const due = c.req.query("due") ?? "all";
  if (!["pending", "completed", "cancelled", "all"].includes(status)) throw new ValidationError("Invalid follow-up status filter");
  if (!["all", "overdue", "upcoming"].includes(due)) throw new ValidationError("Invalid follow-up due filter");
  const rows = await withStaffActor(c, async (tx) => tx`
    select f.id, f.patient_id, f.encounter_id, f.due_date, f.instructions, f.status, f.version,
           f.status_note, f.status_changed_at, f.created_at,
           (f.status = 'pending' and f.due_date < current_date) as overdue,
           p.public_id, p.given_name, p.family_name,
           u.display_name as author_name
      from follow_ups f
      join patients p on p.id = f.patient_id
      left join users u on u.id = f.author_id
     where f.tenant_id = ${auth.activeTenant!.id}
       and (${status} = 'all' or f.status = ${status})
       and (${due} = 'all'
         or (${due} = 'overdue' and f.status = 'pending' and f.due_date < current_date)
         or (${due} = 'upcoming' and f.status = 'pending' and f.due_date >= current_date))
     order by case when f.status = 'pending' and f.due_date < current_date then 0
                   when f.status = 'pending' then 1 else 2 end,
              f.due_date, f.created_at desc
     limit 200
  `);
  return c.json({ followUps: rows });
});

careRoutes.post("/care/follow-ups/:id/status", async (c) => {
  requireStaff(c);
  assertClinicalWrite(actor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, followUpStatusSchema);
  const result = await withStaffActor(c, async (tx) => {
    const record = await followUpForUpdate(tx, auth.activeTenant!.id, id);
    ensureMatch(body.expectedVersion, Number(record.version));
    const from = String(record.status) as FollowUpStatus;
    if (!canTransitionFollowUp(from, body.status)) {
      throw new ConflictError(`Cannot move a ${from} follow-up to ${body.status}`);
    }
    const rows = await tx`
      update follow_ups
         set status = ${body.status}, version = version + 1, status_note = ${body.note},
             status_changed_by = ${auth.user.id}, status_changed_at = now()
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} and status = ${from} and version = ${body.expectedVersion}
       returning version
    `;
    if (!rows[0]) throw new ConflictError("The follow-up changed while you were updating it");
    const version = Number(rows[0].version);
    await writeAudit(tx, c.get("deps").config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "follow-up.status-change",
      subjectPatientId: String(record.patientId),
      resourceType: "FollowUp",
      resourceId: id,
      ...auditMeta(c),
      metadata: { from, to: body.status, note: body.note },
    });
    await writeOutbox(tx, {
      tenantId: auth.activeTenant!.id,
      eventType: "follow-up.status-changed",
      aggregateId: id,
      aggregateVersion: version,
      payload: { from, to: body.status, patientId: record.patientId, encounterId: record.encounterId },
    });
    return { id, status: body.status, version };
  });
  return c.json({ ok: true, followUp: result });
});

careRoutes.get("/care/referrals", async (c) => {
  requireStaff(c);
  assertClinicalRead(actor(c));
  const auth = c.get("auth")!;
  const status = c.req.query("status") ?? "pending";
  if (!["pending", "accepted", "declined", "completed", "cancelled", "all"].includes(status)) {
    throw new ValidationError("Invalid referral status filter");
  }
  const rows = await withStaffActor(c, async (tx) => tx`
    select r.id, r.patient_id, r.encounter_id, r.to_facility, r.reason, r.priority, r.status, r.version,
           r.status_note, r.status_changed_at, r.created_at,
           p.public_id, p.given_name, p.family_name,
           u.display_name as author_name
      from referrals r
      join patients p on p.id = r.patient_id
      left join users u on u.id = r.author_id
     where r.tenant_id = ${auth.activeTenant!.id}
       and (${status} = 'all' or r.status = ${status})
     order by case r.priority when 'emergency' then 0 when 'urgent' then 1 else 2 end,
              case when r.status = 'pending' then 0 else 1 end, r.created_at desc
     limit 200
  `);
  return c.json({ referrals: rows });
});

careRoutes.post("/care/referrals/:id/status", async (c) => {
  requireStaff(c);
  assertClinicalWrite(actor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, referralStatusSchema);
  const result = await withStaffActor(c, async (tx) => {
    const record = await referralForUpdate(tx, auth.activeTenant!.id, id);
    ensureMatch(body.expectedVersion, Number(record.version));
    const from = String(record.status) as ReferralStatus;
    if (!canTransitionReferral(from, body.status)) {
      throw new ConflictError(`Cannot move a ${from} referral to ${body.status}`);
    }
    const rows = await tx`
      update referrals
         set status = ${body.status}, version = version + 1, status_note = ${body.note},
             status_changed_by = ${auth.user.id}, status_changed_at = now()
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} and status = ${from} and version = ${body.expectedVersion}
       returning version
    `;
    if (!rows[0]) throw new ConflictError("The referral changed while you were updating it");
    const version = Number(rows[0].version);
    await writeAudit(tx, c.get("deps").config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "referral.status-change",
      subjectPatientId: String(record.patientId),
      resourceType: "Referral",
      resourceId: id,
      ...auditMeta(c),
      metadata: { from, to: body.status, note: body.note },
    });
    await writeOutbox(tx, {
      tenantId: auth.activeTenant!.id,
      eventType: "referral.status-changed",
      aggregateId: id,
      aggregateVersion: version,
      payload: { from, to: body.status, patientId: record.patientId, encounterId: record.encounterId },
    });
    return { id, status: body.status, version };
  });
  return c.json({ ok: true, referral: result });
});
