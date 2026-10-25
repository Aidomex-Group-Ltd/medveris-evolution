import { Hono } from "hono";
import {
  credentialDecisionSchema,
  credentialSchema,
  uploadSchema,
  uuidSchema,
} from "@medveris/contracts";
import { canManageTenant, type ActorContext } from "@medveris/authz";
import { requireAuth, requirePlatformReviewer, requireStaff, withActor, withStaffActor } from "../auth/middleware.js";
import { auditMeta, parseJson } from "../lib/http.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { rateLimit, clientKey } from "../lib/rate-limit.js";
import type { AppEnv } from "../types.js";

export const credentialRoutes = new Hono<AppEnv>();

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

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function detectType(bytes: Uint8Array): string | null {
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "application/pdf";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) return "application/x-msdownload";
  if (bytes.length >= 2 && bytes[0] === 0x7f && bytes[1] === 0x45) return "application/x-executable";
  return null;
}

const ALLOWED_TYPES = new Set(["application/pdf", "image/png", "image/jpeg"]);

credentialRoutes.post("/uploads", async (c) => {
  const auth = requireStaff(c);
  const deps = c.get("deps");
  rateLimit(clientKey(c.req.raw.headers, `upload:${auth.user.id}`), 20, 60 * 60_000);
  const body = await parseJson(c, uploadSchema);
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(body.dataBase64);
  } catch {
    throw new ValidationError("Upload content is not valid base64");
  }
  if (bytes.length === 0 || bytes.length > deps.config.maxUploadBytes) {
    throw new ValidationError(`Upload must be between 1 byte and ${deps.config.maxUploadBytes} bytes`);
  }
  const detected = detectType(bytes);
  if (!detected || !ALLOWED_TYPES.has(detected) || detected !== body.declaredType) {
    throw new ValidationError("Upload type is not permitted or does not match the detected file signature", {
      declaredType: body.declaredType,
      detectedType: detected ?? "unknown",
    });
  }
  const sha256 = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  const digest = [...new Uint8Array(sha256)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const id = crypto.randomUUID();
  const objectKey = `${auth.activeTenant!.id}/${id}`;
  const result = await withStaffActor(c, async (tx) => {
    await tx`
      insert into uploads (id, tenant_id, owner_user_id, filename, declared_type, detected_type, size_bytes, sha256, object_key, scan_status, status)
      values (${id}, ${auth.activeTenant!.id}, ${auth.user.id}, ${body.filename}, ${body.declaredType}, ${detected}, ${bytes.length}, ${digest}, ${objectKey}, 'quarantined', 'pending')
    `;
    await writeAudit(tx, deps.config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "upload.quarantine",
      resourceType: "Upload",
      resourceId: id,
      ...auditMeta(c),
      metadata: { sha256: digest, sizeBytes: bytes.length, detectedType: detected },
    });
    return { id, objectKey, digest };
  });
  try {
    await deps.storage.put(result.objectKey, bytes);
  } catch (error) {
    await deps.sql`update uploads set scan_status = 'rejected', status = 'rejected', scan_detail = ${`storage-failure: ${(error as Error).message}`} where id = ${id}`;
    throw error;
  }
  await withStaffActor(c, async (tx) => {
    await tx`
      update uploads set scan_status = 'clean', status = 'available', available_at = now(),
        scan_detail = 'Local signature check passed. This is not a malware scan; production scanning must be configured before release.'
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} and scan_status = 'quarantined'
    `;
    await writeAudit(tx, deps.config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      action: "upload.scan.local",
      resourceType: "Upload",
      resourceId: id,
      ...auditMeta(c),
      metadata: { result: "clean-signature-check", productionMalwareScan: false },
    });
  });
  return c.json({
    ok: true,
    upload: { id, filename: body.filename, detectedType: detected, sizeBytes: bytes.length, status: "available" },
    note: "Local development scanner verified file signatures only. A production malware scanner is not configured.",
  }, 201);
});

credentialRoutes.get("/uploads/:id/content", async (c) => {
  const auth = requireAuth(c);
  const deps = c.get("deps");
  const id = uuidSchema.parse(c.req.param("id"));
  const upload = (await deps.sql`select id, tenant_id, owner_user_id, filename, detected_type, object_key, scan_status, status, size_bytes from uploads where id = ${id} limit 1`)[0];
  if (!upload) throw new NotFoundError("Document not found");
  const reviewer = auth.platformRoles.includes("credential_reviewer");
  const sameTenant = auth.activeTenant?.id === upload.tenantId;
  if (!reviewer && !sameTenant && auth.user.id !== upload.ownerUserId) throw new NotFoundError("Document not found");
  if (upload.scanStatus !== "clean" || upload.status !== "available") throw new NotFoundError("Document is not available");
  const bytes = await deps.storage.get(String(upload.objectKey));
  await withActor(c, async (tx) => {
    await writeAudit(tx, deps.config, {
      tenantId: String(upload.tenantId),
      actorKind: auth.activeTenant ? "staff" : "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant?.roles ?? [],
      action: "upload.content.read",
      resourceType: "Upload",
      resourceId: id,
      purpose: reviewer ? "credential-review" : "owner-access",
      ...auditMeta(c),
    });
  });
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "content-type": upload.detectedType as string,
      "content-disposition": `attachment; filename="${String(upload.filename).replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
      "cache-control": "no-store, private",
      "x-content-type-options": "nosniff",
    },
  });
});

credentialRoutes.post("/credentials", async (c) => {
  const auth = requireStaff(c);
  const deps = c.get("deps");
  const body = await parseJson(c, credentialSchema);
  if (body.subjectType === "practitioner" && body.subjectUserId !== auth.user.id) {
    throw new ForbiddenError("A practitioner may only submit their own credential evidence");
  }
  if (body.subjectType === "facility") {
    if (!canManageTenant(actor(c))) throw new ForbiddenError("Facility administrator permission is required");
    if (body.subjectTenantId !== auth.activeTenant!.id) throw new ForbiddenError("Facility subject must match the active facility");
  }
  if (new Date(body.expiresOn).getTime() <= Date.now()) throw new ValidationError("Credential is already expired");
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const upload = await tx`select id from uploads where id = ${body.evidenceUploadId} and tenant_id = ${auth.activeTenant!.id} and scan_status = 'clean' and status = 'available'`;
    if (!upload.length) throw new ValidationError("Evidence must be a clean, available private upload");
    await tx`
      insert into credentials (id, subject_type, subject_user_id, subject_tenant_id, submitted_by, credential_type, issuer, jurisdiction,
        credential_number, scope, issued_on, expires_on, status)
      values (${id}, ${body.subjectType}, ${body.subjectType === "practitioner" ? auth.user.id : null},
        ${body.subjectType === "facility" ? auth.activeTenant!.id : null}, ${auth.user.id}, ${body.credentialType}, ${body.issuer},
        ${body.jurisdiction}, ${body.credentialNumber}, ${body.scope || null}, ${body.issuedOn}, ${body.expiresOn}, 'pending')
    `;
    await tx`insert into credential_documents (credential_id, upload_id) values (${id}, ${body.evidenceUploadId})`;
    await writeAudit(tx, deps.config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "credential.submit",
      resourceType: "Credential",
      resourceId: id,
      ...auditMeta(c),
      metadata: { subjectType: body.subjectType, credentialType: body.credentialType, jurisdiction: body.jurisdiction },
    });
    await writeOutbox(tx, {
      tenantId: auth.activeTenant!.id,
      eventType: "credential.submitted",
      aggregateId: id,
      payload: { credentialId: id },
      idempotencyKey: `credential-submitted-${id}`,
    });
  });
  return c.json({ ok: true, credentialId: id, status: "pending", verificationClaim: false }, 201);
});

credentialRoutes.get("/credentials/mine", async (c) => {
  const auth = requireStaff(c);
  const rows = await withStaffActor(c, async (tx) => tx`
    select c.id, c.subject_type, c.credential_type, c.issuer, c.jurisdiction, c.scope, c.issued_on, c.expires_on,
           c.status, c.reviewed_at, c.decision_reason, c.created_at,
           case when c.status = 'verified' and c.expires_on < current_date then 'expired' else c.status end as effective_status
      from credentials c
     where c.submitted_by = ${auth.user.id} or c.subject_user_id = ${auth.user.id}
     order by c.created_at desc limit 50
  `);
  return c.json({ credentials: rows });
});

credentialRoutes.get("/credentials/facility", async (c) => {
  const auth = requireStaff(c);
  if (!canManageTenant(actor(c))) throw new ForbiddenError("Facility administrator permission is required");
  const rows = await withStaffActor(c, async (tx) => tx`
    select c.id, c.subject_type, c.credential_type, c.issuer, c.jurisdiction, c.scope, c.issued_on, c.expires_on,
           c.status, c.reviewed_at, c.decision_reason, c.created_at,
           case when c.status = 'verified' and c.expires_on < current_date then 'expired' else c.status end as effective_status
      from credentials c where c.subject_tenant_id = ${auth.activeTenant!.id}
     order by c.created_at desc limit 100
  `);
  return c.json({ credentials: rows });
});

credentialRoutes.get("/credentials/queue", async (c) => {
  const auth = requirePlatformReviewer(c);
  const rows = await withActor(c, async (tx) => tx`
    select c.id, c.subject_type, c.subject_user_id, c.subject_tenant_id, c.credential_type, c.issuer, c.jurisdiction,
           c.credential_number, c.scope, c.issued_on, c.expires_on, c.status, c.created_at, c.submitted_by,
           su.display_name as submitter_name, su.email as submitter_email,
           pu.display_name as subject_user_name, pt.name as subject_facility_name,
           (select array_agg(upload_id) from credential_documents cd where cd.credential_id = c.id) as evidence_upload_ids
      from credentials c
      left join users su on su.id = c.submitted_by
      left join users pu on pu.id = c.subject_user_id
      left join tenants pt on pt.id = c.subject_tenant_id
     where c.status in ('submitted','quarantined','pending')
     order by c.created_at
  `);
  return c.json({ queue: rows, reviewerId: auth.user.id, independenceRule: "A submitter or credential subject cannot verify their own evidence" });
});

credentialRoutes.post("/credentials/:id/decision", async (c) => {
  const auth = requirePlatformReviewer(c);
  const deps = c.get("deps");
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, credentialDecisionSchema);
  await withActor(c, async (tx) => {
    const rows = await tx`select id, submitted_by, subject_user_id, subject_tenant_id, expires_on from credentials where id = ${id} for update`;
    const credential = rows[0];
    if (!credential) throw new NotFoundError("Credential not found");
    if (String(credential.submittedBy) === auth.user.id || String(credential.subjectUserId) === auth.user.id) {
      throw new ForbiddenError("Self-verification is not permitted");
    }
    if (body.decision === "verified") {
      const expiry = body.expiresOn ?? credential.expiresOn;
      if (new Date(String(expiry)).getTime() <= Date.now()) throw new ValidationError("A verified credential must have a future expiry date");
    }
    await tx`
      update credentials set status = ${body.decision}, reviewer_id = ${auth.user.id}, reviewed_at = now(),
        decision_reason = ${body.reason}, checks_performed = ${body.checksPerformed},
        expires_on = coalesce(${body.expiresOn ?? null}, expires_on), updated_at = now()
       where id = ${id}
    `;
    await writeAudit(tx, deps.config, {
      tenantId: credential.subjectTenantId ? String(credential.subjectTenantId) : null,
      actorKind: "staff",
      actorUserId: auth.user.id,
      action: "credential.decision",
      resourceType: "Credential",
      resourceId: id,
      ...auditMeta(c),
      metadata: {
        decision: body.decision,
        reason: body.reason,
        checksPerformed: body.checksPerformed,
        subjectType: credential.subjectUserId ? "practitioner" : "facility",
        publicClaim: body.decision === "verified" ? "License verified as of review date" : "Credential not verified",
      },
    });
    await writeOutbox(tx, {
      eventType: "credential.decision",
      aggregateId: id,
      payload: { credentialId: id, decision: body.decision },
      idempotencyKey: `credential-decision-${id}-${body.decision}`,
    });
  });
  return c.json({ ok: true, status: body.decision, publicClaim: body.decision === "verified" ? "License verified as of review date" : "Credential not verified" });
});
