import { Hono } from "hono";
import {
  credentialDecisionSchema,
  credentialSchema,
  facilityCredentialDecisionSchema,
  uploadSchema,
  uuidSchema,
} from "@medveris/contracts";
import { canManageTenant, type ActorContext } from "@medveris/authz";
import { requireAuth, requirePlatformReviewer, requireStaff, withActor, withReviewerActor, withStaffActor } from "../auth/middleware.js";
import { auditMeta, parseJson } from "../lib/http.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
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
    await withStaffActor(c, async (tx) => tx`
      update uploads set scan_status = 'rejected', status = 'rejected', scan_detail = ${`storage-failure: ${(error as Error).message}`}
       where id = ${id} and tenant_id = ${auth.activeTenant!.id}
    `);
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
  const reviewer = auth.platformRoles.includes("credential_reviewer");
  const readContext = reviewer ? withReviewerActor : withActor;
  const upload = (await readContext(c, async (tx) => tx`
    select id, tenant_id, owner_user_id, filename, detected_type, object_key, scan_status, status, size_bytes from uploads where id = ${id} limit 1
  `))[0];
  if (!upload) throw new NotFoundError("Document not found");
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
  const managesTenant = canManageTenant(actor(c));
  const subjectUserId = body.subjectUserId ?? auth.user.id;
  if (body.subjectType === "practitioner" && subjectUserId !== auth.user.id) {
    if (!managesTenant) throw new ForbiddenError("A practitioner may only submit their own credential evidence");
    const staff = await withStaffActor(c, async (tx) => tx`
      select id from staff_persons where tenant_id = ${auth.activeTenant!.id} and user_id = ${subjectUserId} limit 1
    `);
    if (!staff.length) throw new ForbiddenError("The credential subject is not a staff person at this facility");
  }
  if (body.subjectType === "facility") {
    if (!managesTenant) throw new ForbiddenError("Facility administrator permission is required");
    if (body.subjectTenantId !== auth.activeTenant!.id) throw new ForbiddenError("Facility subject must match the active facility");
  }
  if (new Date(body.expiresOn).getTime() <= Date.now()) throw new ValidationError("Credential is already expired");
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    if (body.onboardingCaseId) {
      const onboarding = await tx`
        select id from onboarding_cases where id = ${body.onboardingCaseId} and tenant_id = ${auth.activeTenant!.id} limit 1
      `;
      if (!onboarding.length) throw new ValidationError("Onboarding case not found at this facility");
    }
    if (body.evidenceUploadId) {
      const upload = await tx`select id from uploads where id = ${body.evidenceUploadId} and tenant_id = ${auth.activeTenant!.id} and scan_status = 'clean' and status = 'available'`;
      if (!upload.length) throw new ValidationError("Evidence must be a clean, available private upload");
    }
    await tx`
      insert into credentials (id, subject_type, subject_user_id, subject_tenant_id, submitted_by, credential_type, issuer, jurisdiction,
        credential_number, scope, issued_on, expires_on, status, onboarding_case_id, regulator_code, registration_number,
        licence_number, qualifications, specialty_credentials, verification_method, verification_source)
      values (${id}, ${body.subjectType}, ${body.subjectType === "practitioner" ? subjectUserId : null},
        ${body.subjectType === "facility" ? auth.activeTenant!.id : null}, ${auth.user.id}, ${body.credentialType}, ${body.issuer},
        ${body.jurisdiction}, ${body.credentialNumber}, ${body.scope || null}, ${body.issuedOn}, ${body.expiresOn}, 'pending',
        ${body.onboardingCaseId ?? null}, ${body.regulatorCode || null}, ${body.registrationNumber || null},
        ${body.licenceNumber || null}, ${body.qualifications || null}, ${body.specialtyCredentials},
        'manual', 'self-declared')
    `;
    if (body.evidenceUploadId) {
      await tx`insert into credential_documents (credential_id, upload_id) values (${id}, ${body.evidenceUploadId})`;
    }
    await writeAudit(tx, deps.config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "credential.submit",
      resourceType: "Credential",
      resourceId: id,
      ...auditMeta(c),
      metadata: {
        subjectType: body.subjectType,
        credentialType: body.credentialType,
        jurisdiction: body.jurisdiction,
        onboardingCaseId: body.onboardingCaseId ?? null,
        supportingDocumentAttached: Boolean(body.evidenceUploadId),
        verificationClaim: false,
      },
    });
    await writeOutbox(tx, {
      tenantId: auth.activeTenant!.id,
      eventType: "credential.submitted",
      aggregateId: id,
      payload: { credentialId: id },
      idempotencyKey: `credential-submitted-${id}`,
    });
  });
  return c.json({
    ok: true,
    credentialId: id,
    status: "pending",
    verificationClaim: false,
    notice: body.evidenceUploadId
      ? "The uploaded document is evidence for review only. It does not prove a licence is valid."
      : "No supporting document was attached. A reviewer must verify the licence with the authority before any verified status.",
  }, 201);
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
  const rows = await withReviewerActor(c, async (tx) => tx`
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

credentialRoutes.get("/credentials/facility/queue", async (c) => {
  const auth = requireStaff(c);
  const roles = auth.activeTenant!.roles;
  if (!roles.includes("facility_admin") && !roles.includes("hr")) {
    throw new ForbiddenError("Facility administration or human resources permission is required");
  }
  const rows = await withStaffActor(c, async (tx) => tx`
    select c.id, c.credential_type, c.issuer, c.jurisdiction, c.regulator_code, c.registration_number,
           c.licence_number, c.credential_number, c.qualifications, c.specialty_credentials, c.scope,
           c.issued_on, c.expires_on, c.status, c.verification_method, c.verification_source, c.created_at,
           c.onboarding_case_id, c.subject_user_id, u.display_name as subject_name, u.email as subject_email,
           o.path as onboarding_path,
           (select array_agg(upload_id) from credential_documents cd where cd.credential_id = c.id) as evidence_upload_ids
      from credentials c
      left join users u on u.id = c.subject_user_id
      left join onboarding_cases o on o.id = c.onboarding_case_id
     where c.onboarding_case_id is not null
       and c.status in ('pending','submitted','quarantined')
       and o.tenant_id = ${auth.activeTenant!.id}
     order by c.created_at limit 100
  `);
  return c.json({
    queue: rows,
    verification: {
      mode: "manual",
      officialIntegrationAvailable: false,
      independenceRule: "A submitter cannot verify their own credential evidence.",
    },
  });
});

credentialRoutes.post("/credentials/:id/facility-decision", async (c) => {
  const auth = requireStaff(c);
  const deps = c.get("deps");
  const roles = auth.activeTenant!.roles;
  if (!roles.includes("facility_admin") && !roles.includes("hr")) {
    throw new ForbiddenError("Facility administration or human resources permission is required");
  }
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, facilityCredentialDecisionSchema);
  const outcome = await withStaffActor(c, async (tx) => {
    const rows = await tx`
      select c.id, c.submitted_by, c.subject_user_id, c.subject_tenant_id, c.expires_on, c.status,
             c.onboarding_case_id,
             (select count(*)::int from credential_documents cd where cd.credential_id = c.id) as credentials_document_count
        from credentials c
       where c.id = ${id} for update
    `;
    const credential = rows[0];
    if (!credential) throw new NotFoundError("Credential not found");
    if (!credential.onboardingCaseId) throw new ForbiddenError("Only onboarding credentials can be reviewed by a facility");
    const onboarding = await tx`
      select id, tenant_id from onboarding_cases
       where id = ${credential.onboardingCaseId} and tenant_id = ${auth.activeTenant!.id} limit 1
    `;
    if (!onboarding.length) throw new NotFoundError("Credential not found");
    if (String(credential.submittedBy) === auth.user.id || String(credential.subjectUserId) === auth.user.id) {
      throw new ForbiddenError("Self-verification is not permitted");
    }
    if (credential.status === "verified" && body.decision === "verified") {
      throw new ConflictError("This credential is already verified");
    }
    if (body.decision === "verified") {
      const expiry = body.expiresOn ?? credential.expiresOn;
      if (new Date(String(expiry)).getTime() <= Date.now()) {
        throw new ValidationError("A verified credential must have a future expiry date");
      }
      if (Number(credential.credentialsDocumentCount) === 0) {
        throw new ValidationError("Manual verification requires at least one supporting document attached to the credential");
      }
      if (!body.checksPerformed || body.checksPerformed.length < 5) {
        throw new ValidationError("Record the checks performed against the regulator or an approved source");
      }
    }
    await tx`
      update credentials set status = ${body.decision}, reviewer_id = ${auth.user.id}, reviewed_at = now(),
        decision_reason = ${body.reason}, checks_performed = ${body.checksPerformed || null},
        verification_method = 'manual', verification_source = ${body.checksPerformed || null},
        expires_on = coalesce(${body.expiresOn ?? null}, expires_on), updated_at = now()
       where id = ${id}
    `;
    await tx`
      insert into credential_review_events (id, tenant_id, credential_id, reviewer_id, previous_status, decision,
        new_status, reason, verification_method, checks_performed)
      values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${id}, ${auth.user.id}, ${credential.status},
        ${body.decision}, ${body.decision}, ${body.reason}, 'manual', ${body.checksPerformed || null})
    `;
    await writeAudit(tx, deps.config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      action: "credential.facility_decision",
      resourceType: "Credential",
      resourceId: id,
      ...auditMeta(c),
      metadata: {
        decision: body.decision,
        reason: body.reason,
        checksPerformed: body.checksPerformed || null,
        onboardingCaseId: credential.onboardingCaseId,
        officialIntegration: false,
        publicClaim: body.decision === "verified" ? "Checked manually against an approved source as of review date" : "Credential not verified",
      },
    });
    await writeOutbox(tx, {
      tenantId: auth.activeTenant!.id,
      eventType: "credential.facility_decision",
      aggregateId: id,
      payload: { credentialId: id, decision: body.decision },
      idempotencyKey: `credential-facility-decision-${id}-${body.decision}-${Date.now()}`,
    });
    return { previousStatus: credential.status };
  });
  return c.json({
    ok: true,
    status: body.decision,
    previousStatus: outcome.previousStatus,
    publicClaim: body.decision === "verified"
      ? "Checked manually against an approved source as of review date"
      : "Credential not verified",
    notice: "This is a manual facility review. It does not confirm that a regulator integration validated the licence.",
  });
});

credentialRoutes.get("/credentials/:id/history", async (c) => {
  requireAuth(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const events = await withActor(c, async (tx) => {
    const credential = await tx`select id from credentials where id = ${id} limit 1`;
    if (!credential.length) throw new NotFoundError("Credential not found");
    return tx`
      select e.id, e.previous_status, e.decision, e.new_status, e.reason, e.verification_method,
             e.checks_performed, e.decided_at, u.display_name as reviewer_name
        from credential_review_events e
        left join users u on u.id = e.reviewer_id
       where e.credential_id = ${id}
       order by e.decided_at desc
    `;
  });
  return c.json({ events, appendOnly: true });
});

credentialRoutes.post("/credentials/:id/decision", async (c) => {
  const auth = requirePlatformReviewer(c);
  const deps = c.get("deps");
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, credentialDecisionSchema);
  await withReviewerActor(c, async (tx) => {
    const rows = await tx`select id, submitted_by, subject_user_id, subject_tenant_id, expires_on, status from credentials where id = ${id} for update`;
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
        verification_method = 'manual', verification_source = ${body.checksPerformed},
        expires_on = coalesce(${body.expiresOn ?? null}, expires_on), updated_at = now()
       where id = ${id}
    `;
    await tx`
      insert into credential_review_events (id, tenant_id, credential_id, reviewer_id, previous_status, decision,
        new_status, reason, verification_method, checks_performed)
      values (${crypto.randomUUID()}, ${credential.subjectTenantId ? String(credential.subjectTenantId) : null}, ${id},
        ${auth.user.id}, ${credential.status}, ${body.decision}, ${body.decision}, ${body.reason}, 'manual', ${body.checksPerformed})
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
        officialIntegration: false,
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
