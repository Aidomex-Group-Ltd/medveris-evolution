import { Hono } from "hono";
import {
  createGrantSchema,
  emergencyOverrideSchema,
  publicPatientIdSchema,
  revokeGrantSchema,
  uuidSchema,
} from "@medveris/contracts";
import { assertClinicalRead, canAudit, canReadClinical, canUseEmergencyOverride, type ActorContext } from "@medveris/authz";
import { decryptSecret, verifyPassword, verifyTotp } from "@medveris/auth";
import { requirePatient, requireStaff, withActor, withStaffActor } from "../auth/middleware.js";
import { auditMeta, parseJson } from "../lib/http.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

export const consentRoutes = new Hono<AppEnv>();

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

consentRoutes.post("/patients/:patientId/consents", async (c) => {
  const auth = requirePatient(c);
  const deps = c.get("deps");
  const patientId = uuidSchema.parse(c.req.param("patientId"));
  if (patientId !== auth.patientId) throw new NotFoundError("Patient not found");
  const body = await parseJson(c, createGrantSchema);
  const id = crypto.randomUUID();
  const grant = await withActor(c, async (tx) => {
    if (body.patientId !== patientId) throw new ValidationError("Patient context mismatch");
    if (new Date(body.expiresAt).getTime() <= new Date(body.startsAt).getTime()) throw new ValidationError("Consent expiry must be after the start time");
    if (new Date(body.expiresAt).getTime() <= Date.now()) throw new ValidationError("Consent expiry must be in the future");
    const recipient = await tx`select id from tenants where id = ${body.recipientTenantId} and status = 'active'`;
    if (!recipient.length) throw new NotFoundError("Recipient facility not found");
    const links = await tx`
      select tenant_id from tenant_patient_links where patient_id = ${patientId} and release_signed_records = true
    `;
    const linked = new Set(links.map((l) => String(l.tenantId)));
    for (const source of body.sourceTenantIds) {
      if (!linked.has(source)) throw new ValidationError("A requested source facility is not authorized by the patient's release settings");
    }
    if (body.recipientTenantId && body.sourceTenantIds.includes(body.recipientTenantId)) {
      throw new ValidationError("Recipient facility cannot also be the source facility");
    }
    await tx`
      insert into exchange_grants (id, patient_id, grantor_user_id, recipient_tenant_id, source_tenant_ids, categories, purpose,
        legal_basis, authorization_evidence, starts_at, expires_at, sensitivity_exclusions)
      values (${id}, ${patientId}, ${auth.user.id}, ${body.recipientTenantId}, ${body.sourceTenantIds}, ${body.categories},
        ${body.purpose}, ${body.legalBasis}, ${body.authorizationEvidence}, ${body.startsAt}, ${body.expiresAt}, ${body.sensitivityExclusions})
    `;
    await writeAudit(tx, deps.config, {
      actorKind: "patient",
      actorUserId: auth.user.id,
      subjectPatientId: patientId,
      action: "consent.grant.create",
      resourceType: "Consent",
      resourceId: id,
      grantId: id,
      ...auditMeta(c),
      metadata: {
        recipientTenantId: body.recipientTenantId,
        sourceTenantIds: body.sourceTenantIds,
        categories: body.categories,
        purpose: body.purpose,
        legalBasis: body.legalBasis,
        expiresAt: body.expiresAt,
      },
    });
    await writeOutbox(tx, {
      eventType: "consent.grant.created",
      aggregateId: id,
      payload: { grantId: id, patientId, recipientTenantId: body.recipientTenantId },
      idempotencyKey: `consent-created-${id}`,
    });
    return { id };
  });
  return c.json({ ok: true, consentId: grant.id }, 201);
});

consentRoutes.post("/consents/:consentId/revoke", async (c) => {
  const auth = requirePatient(c);
  const deps = c.get("deps");
  const consentId = uuidSchema.parse(c.req.param("consentId"));
  const body = await parseJson(c, revokeGrantSchema);
  await withActor(c, async (tx) => {
    const rows = await tx`
      update exchange_grants set revoked_at = now(), revoked_by = ${auth.user.id}, revoked_reason = ${body.reason}
       where id = ${consentId} and patient_id = ${auth.patientId} and revoked_at is null
       returning id, recipient_tenant_id
    `;
    if (!rows[0]) throw new NotFoundError("Active consent not found");
    await writeAudit(tx, deps.config, {
      actorKind: "patient",
      actorUserId: auth.user.id,
      subjectPatientId: auth.patientId,
      action: "consent.grant.revoke",
      resourceType: "Consent",
      resourceId: consentId,
      grantId: consentId,
      ...auditMeta(c),
      metadata: { reason: body.reason },
    });
    await writeOutbox(tx, {
      eventType: "consent.grant.revoked",
      aggregateId: consentId,
      payload: { grantId: consentId, patientId: auth.patientId, recipientTenantId: rows[0].recipientTenantId },
      idempotencyKey: `consent-revoked-${consentId}`,
    });
  });
  return c.json({ ok: true });
});

consentRoutes.get("/exchange/grants", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  if (!canReadClinical(actor(c))) throw new ForbiddenError("Clinical access is required");
  const rows = await withStaffActor(c, async (tx) => tx`
    select g.id, g.patient_id, p.public_id, p.given_name, p.family_name, g.categories, g.purpose, g.legal_basis,
           g.starts_at, g.expires_at, g.revoked_at, g.version, g.created_at
      from exchange_grants g join patients p on p.id = g.patient_id
     where g.recipient_tenant_id = ${auth.activeTenant!.id}
     order by g.created_at desc limit 100
  `);
  return c.json({ grants: rows });
});

consentRoutes.get("/exchange/patients/:publicId/records", async (c) => {
  requireStaff(c);
  const a = actor(c);
  assertClinicalRead(a);
  const deps = c.get("deps");
  const auth = c.get("auth")!;
  const publicId = publicPatientIdSchema.parse(c.req.param("publicId"));
  const grantId = uuidSchema.parse(c.req.query("grantId") ?? "");
  const data = await withStaffActor(c, async (tx) => {
    const patientRows = await tx`select id, public_id, given_name, family_name from patients where public_id = ${publicId} and merged_into is null limit 1`;
    const patient = patientRows[0];
    if (!patient) throw new NotFoundError("Exchange records are not available");
    const grantRows = await tx`
      select id from exchange_grants
       where id = ${grantId} and patient_id = ${patient.id} and recipient_tenant_id = ${auth.activeTenant!.id}
         and revoked_at is null and starts_at <= now() and expires_at > now()
    `;
    if (!grantRows.length) {
      await writeAudit(tx, deps.config, {
        tenantId: auth.activeTenant!.id,
        actorKind: "staff",
        actorUserId: auth.user.id,
        actorRoles: auth.activeTenant!.roles,
        action: "exchange.records.read",
        subjectPatientId: String(patient.id),
        resourceType: "ExchangeProjection",
        resourceId: grantId,
        decision: "deny",
        reasonCode: "no-active-grant",
        grantId,
        ...auditMeta(c),
      });
      throw new NotFoundError("Exchange records are not available");
    }
    let records: unknown[];
    try {
      records = Array.from(await tx`select * from app.exchange_project(${grantId}, ${auth.activeTenant!.id}, ${patient.id})`);
    } catch {
      await writeAudit(tx, deps.config, {
        tenantId: auth.activeTenant!.id,
        actorKind: "staff",
        actorUserId: auth.user.id,
        actorRoles: auth.activeTenant!.roles,
        action: "exchange.records.read",
        subjectPatientId: String(patient.id),
        resourceType: "ExchangeProjection",
        resourceId: grantId,
        decision: "deny",
        reasonCode: "grant-policy-denied",
        grantId,
        ...auditMeta(c),
      });
      throw new NotFoundError("Exchange records are not available");
    }
    await writeAudit(tx, deps.config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "exchange.records.read",
      subjectPatientId: String(patient.id),
      resourceType: "ExchangeProjection",
      resourceId: grantId,
      grantId,
      ...auditMeta(c),
      metadata: { recordCount: records.length },
    });
    return { patient: { publicId: patient.publicId, givenName: patient.givenName, familyName: patient.familyName }, grantId, records };
  });
  return c.json(data);
});

consentRoutes.post("/patients/:patientId/emergency-overrides", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const deps = c.get("deps");
  const a = actor(c);
  if (!canUseEmergencyOverride(a)) throw new ForbiddenError("Emergency override requires an eligible clinical role, enrolled MFA and a verified session");
  const patientId = uuidSchema.parse(c.req.param("patientId"));
  const body = await parseJson(c, emergencyOverrideSchema);
  if (body.patientId !== patientId) throw new ValidationError("Patient context mismatch");
  const validPassword = await verifyPassword(body.password, (await deps.sql`select password_hash from users where id = ${auth.user.id}`)[0]?.passwordHash as string);
  if (!validPassword) throw new ForbiddenError("Reauthentication failed");
  if (!auth.user.totpSecretEnc) throw new ForbiddenError("MFA is not enrolled");
  const secret = await decryptSecret(auth.user.totpSecretEnc, deps.config.mfaEncryptionKey);
  if (!(await verifyTotp(secret, body.totpCode))) throw new ForbiddenError("Reauthentication failed");
  const id = crypto.randomUUID();
  const record = await withStaffActor(c, async (tx) => {
    const encounter = await tx`select id from encounters where id = ${body.encounterId} and patient_id = ${patientId} and tenant_id = ${auth.activeTenant!.id}`;
    if (!encounter.length) throw new NotFoundError("Encounter or patient context not found");
    const expiresAt = new Date(Date.now() + deps.config.emergencyOverrideMinutes * 60_000);
    const reviewDueAt = new Date(Date.now() + deps.config.emergencyReviewDueHours * 60 * 60_000);
    await tx`
      insert into emergency_overrides (id, tenant_id, patient_id, encounter_id, user_id, reason, mfa_verified_at, expires_at, review_due_at)
      values (${id}, ${auth.activeTenant!.id}, ${patientId}, ${body.encounterId}, ${auth.user.id}, ${body.reason}, now(), ${expiresAt}, ${reviewDueAt})
    `;
    await writeAudit(tx, deps.config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "emergency.override.create",
      subjectPatientId: patientId,
      resourceType: "EmergencyOverride",
      resourceId: id,
      overrideId: id,
      ...auditMeta(c),
      metadata: { reason: body.reason, encounterId: body.encounterId, expiresAt: expiresAt.toISOString() },
    });
    await writeOutbox(tx, {
      tenantId: auth.activeTenant!.id,
      eventType: "emergency.override.created",
      aggregateId: id,
      payload: { overrideId: id, patientId, reviewDueAt: reviewDueAt.toISOString() },
      idempotencyKey: `override-created-${id}`,
    });
    return { id, expiresAt, reviewDueAt };
  });
  return c.json({ ok: true, override: { id: record.id, expiresAt: record.expiresAt, reviewStatus: "pending" } }, 201);
});

consentRoutes.get("/emergency-overrides", async (c) => {
  requireStaff(c);
  const a = actor(c);
  if (!canAudit(a)) throw new ForbiddenError("Governance review access is required");
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select eo.id, eo.reason, eo.started_at, eo.expires_at, eo.review_status, eo.review_due_at, eo.reviewed_at, eo.review_note,
           p.public_id, p.given_name, p.family_name, u.display_name as clinician_name
      from emergency_overrides eo join patients p on p.id = eo.patient_id join users u on u.id = eo.user_id
     where eo.tenant_id = ${auth.activeTenant!.id}
     order by eo.created_at desc limit 100
  `);
  return c.json({ overrides: rows });
});

consentRoutes.post("/emergency-overrides/:id/review", async (c) => {
  requireStaff(c);
  const a = actor(c);
  if (!canAudit(a)) throw new ForbiddenError("Governance review access is required");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await c.req.json<{ status?: string; note?: string }>();
  if (body.status !== "reviewed-acceptable" && body.status !== "reviewed-escalated") throw new ValidationError("Invalid review status");
  if (!body.note || body.note.trim().length < 5) throw new ValidationError("A review note is required");
  const status = body.status;
  const note = body.note.trim();
  await withStaffActor(c, async (tx) => {
    const rows = await tx`
      update emergency_overrides set review_status = ${status}, reviewed_by = ${auth.user.id}, reviewed_at = now(), review_note = ${note}
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} and review_status = 'pending' returning id
    `;
    if (!rows[0]) throw new NotFoundError("Pending emergency override not found");
    await writeAudit(tx, c.get("deps").config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "emergency.override.review",
      resourceType: "EmergencyOverride",
      resourceId: id,
      overrideId: id,
      ...auditMeta(c),
      metadata: { status: body.status, note: body.note },
    });
  });
  return c.json({ ok: true });
});

consentRoutes.get("/emergency-overrides/:id/records", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const deps = c.get("deps");
  const rows = await withStaffActor(c, async (tx) => {
    const overrides = await tx`
      select id, patient_id from emergency_overrides
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} and user_id = ${auth.user.id}
         and revoked_at is null and started_at <= now() and expires_at > now()
    `;
    if (!overrides[0]) throw new NotFoundError("Active emergency override not found");
    const records = await tx`select * from app.emergency_project(${id}, ${auth.activeTenant!.id}, ${overrides[0].patientId})`;
    await writeAudit(tx, deps.config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "emergency.override.records.read",
      subjectPatientId: String(overrides[0].patientId),
      resourceType: "EmergencyOverride",
      resourceId: id,
      overrideId: id,
      ...auditMeta(c),
      metadata: { recordCount: records.length },
    });
    return records;
  });
  return c.json({ records: rows });
});
