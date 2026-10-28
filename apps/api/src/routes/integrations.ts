import { Hono } from "hono";
import type { Context } from "hono";
import { randomToken, sha256Hex } from "@medveris/auth";
import {
  apiProductSchema,
  integrationApplicationSchema,
  integrationClientDecisionSchema,
  integrationTokenSchema,
  partnerPatientLinkSchema,
  partnerPatientMatchSchema,
  partnerPatientUnlinkSchema,
} from "@medveris/contracts";
import {
  isPlatformOperator,
  requireAuth,
  requireStaff,
  withPlatformActor,
  withStaffActor,
} from "../auth/middleware.js";
import { requireIntegration, withIntegrationContext } from "../auth/integration.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { parseJson } from "../lib/http.js";
import { writeAudit } from "../lib/audit.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { enforceRateLimit, requestAddress } from "../lib/rate-limit.js";
import { withAnonymous, withContext } from "@medveris/db";
import type { AppEnv } from "../types.js";

export const integrationRoutes = new Hono<AppEnv>();

function requirePlatform(c: Context<AppEnv>): void {
  if (!isPlatformOperator(c)) throw new ForbiddenError("Platform operator permission is required");
}

function stringList(value: string | undefined): string[] {
  return (value ?? "").split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

integrationRoutes.get("/public/integrations/products", async (c) => {
  const sql = c.get("deps").sql;
  const products = await withAnonymous(sql, async (tx) => tx`
    select code, name, description, service_family, data_classification, required_scopes,
           rate_limit_per_minute, daily_quota, support_level, sandbox_available, commercial_status
      from api_products where enabled order by service_family, name
  `);
  return c.json({
    products,
    oauthProfiles: ["oauth2-client-credentials", "smart-backend-services"],
    tokenEndpoint: "/api/v1/public/integrations/oauth/token",
    security: {
      transport: "TLS 1.2+ required in production",
      tokenFormat: "Opaque bearer token; only a SHA-256 hash is stored",
      defaultTokenTtlMinutes: 15,
      secrets: "Client secrets are returned once at application approval or rotation and never stored in plaintext.",
      audit: "Patient matching and record-link changes are audited; integration status never changes clinical access rights.",
    },
  });
});

integrationRoutes.post("/integrations/applications", async (c) => {
  const platform = isPlatformOperator(c);
  const auth = platform ? requireAuth(c) : requireStaff(c);
  const actor = requestActor(c);
  if (!platform && ![...actor.roles].includes("facility_admin") && !actor.roles.includes("it_admin")) {
    throw new ForbiddenError("A facility administrator or IT administrator is required to apply for integration access");
  }
  const body = await parseJson(c, integrationApplicationSchema);
  const tenantId = platform ? (body.tenantId ?? auth.activeTenant?.id ?? null) : auth.activeTenant!.id;
  if (!tenantId) throw new ValidationError("A facility organization is required for a clinical integration application");
  if (!platform && body.tenantId && body.tenantId !== tenantId) {
    throw new ForbiddenError("You can only apply for your active facility organization");
  }
  const products = await (platform ? withPlatformActor(c, async (tx) => tx`
    select code, required_scopes from api_products where enabled and code = any(${body.products}::text[])
  `) : withStaffActor(c, async (tx) => tx`
    select code, required_scopes from api_products where enabled and code = any(${body.products}::text[])
  `));
  const found = new Set(products.map((product) => product.code as string));
  const missing = body.products.filter((code) => !found.has(code));
  if (missing.length > 0) throw new ValidationError(`Unknown or disabled API products: ${missing.join(", ")}`);
  const scopes = [...new Set(products.flatMap((product) => product.requiredScopes as string[]))].sort();
  const clientId = `mvc_${randomToken(12)}`;
  const clientSecret = `mvs_${randomToken(24)}`;
  const id = crypto.randomUUID();
  const secretHash = await sha256Hex(clientSecret);
  const insert = async (tx: Parameters<Parameters<typeof withStaffActor>[1]>[0]) => {
    await tx`
      insert into integration_clients (
        id, client_id, client_secret_hash, name, organization, tenant_id, environment,
        status, scopes, products, callback_url, technical_contact, privacy_contact, incident_contact,
        existing_vendor, intended_use, patient_populations, processing_locations, supported_standards,
        legal_basis, data_sharing_notes, created_by
      ) values (
        ${id}, ${clientId}, ${secretHash}, ${body.name}, ${body.organization}, ${tenantId}, 'sandbox',
        'pending', ${scopes}, ${body.products}, ${body.callbackUrl || null}, ${body.technicalContact},
        ${body.privacyContact || null}, ${body.incidentContact || null}, ${body.existingVendor || null},
        ${body.intendedUse}, ${body.patientPopulations}, ${body.processingLocations}, ${body.supportedStandards},
        ${body.legalBasis || null}, ${body.dataSharingNotes || null}, ${auth.user.id}
      )
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "integration.application.submit", {
      resourceType: "IntegrationClient", resourceId: id,
      metadata: { products: body.products, environment: "sandbox", tenantId },
    }));
  };
  if (platform) await withPlatformActor(c, insert);
  else await withStaffActor(c, insert);
  return c.json({
    ok: true,
    client: { id, clientId, environment: "sandbox", status: "pending", scopes, products: body.products },
    clientSecret,
    warning: "Store the client secret now. It cannot be retrieved again; it can only be rotated.",
  }, 201);
});

integrationRoutes.get("/integrations/clients", async (c) => {
  const auth = requireAuth(c);
  const platform = isPlatformOperator(c);
  if (!platform && !auth.activeTenant) throw new ForbiddenError("An active facility context is required");
  const rows = platform
    ? await withPlatformActor(c, async (tx) => tx`
        select id, client_id, name, organization, tenant_id, environment, status, scopes, products,
               technical_contact, approved_at, last_used_at, version, created_at
          from integration_clients order by created_at desc limit 500
      `)
    : await withStaffActor(c, async (tx) => tx`
        select id, client_id, name, organization, tenant_id, environment, status, scopes, products,
               technical_contact, approved_at, last_used_at, version, created_at
          from integration_clients where tenant_id = ${auth.activeTenant!.id}
         order by created_at desc limit 200
      `);
  return c.json({ clients: rows });
});

integrationRoutes.post("/integrations/clients/:id/decision", async (c) => {
  requirePlatform(c);
  const body = await parseJson(c, integrationClientDecisionSchema);
  const id = c.req.param("id");
  await withPlatformActor(c, async (tx) => {
    const client = await requireRows(await tx`select * from integration_clients where id = ${id} for update`, "Integration client not found");
    const status = body.decision === "activate" ? "active" : body.decision === "suspend" ? "suspended" : "revoked";
    if (body.decision === "activate" && client.status === "revoked") throw new ConflictError("A revoked client cannot be reactivated; create a new application");
    await tx`
      update integration_clients set status = ${status}, approved_by = ${c.get("auth")!.user.id},
        approved_at = coalesce(approved_at, now()), version = version + 1, updated_at = now()
       where id = ${id}
    `;
    if (status === "revoked" || status === "suspended") {
      await tx`update integration_tokens set revoked_at = coalesce(revoked_at, now()) where client_id = ${id}`;
    }
    await writeAudit(tx, c.get("deps").config, {
      actorUserId: c.get("auth")!.user.id,
      actorKind: "staff",
      action: `integration.client.${body.decision}`,
      resourceType: "IntegrationClient",
      resourceId: id,
      metadata: { reason: body.reason, previousStatus: client.status },
    });
  });
  return c.json({ ok: true });
});

integrationRoutes.post("/integrations/clients/:id/rotate-secret", async (c) => {
  requirePlatform(c);
  const id = c.req.param("id");
  const secret = `mvs_${randomToken(24)}`;
  const hash = await sha256Hex(secret);
  await withPlatformActor(c, async (tx) => {
    const client = await requireRows(await tx`select id, status from integration_clients where id = ${id} for update`, "Integration client not found");
    if (client.status === "revoked") throw new ConflictError("A revoked client cannot be rotated");
    await tx`
      update integration_clients set client_secret_hash = ${hash}, secret_rotated_at = now(),
        version = version + 1, updated_at = now()
       where id = ${id}
    `;
    await tx`update integration_tokens set revoked_at = coalesce(revoked_at, now()) where client_id = ${id}`;
    await writeAudit(tx, c.get("deps").config, {
      actorUserId: c.get("auth")!.user.id, actorKind: "staff", action: "integration.client.rotate-secret",
      resourceType: "IntegrationClient", resourceId: id,
    });
  });
  return c.json({ ok: true, clientSecret: secret, warning: "Existing tokens were revoked. Store the new secret now." });
});

integrationRoutes.post("/integrations/clients/:id/revoke-tokens", async (c) => {
  requirePlatform(c);
  const id = c.req.param("id");
  await withPlatformActor(c, async (tx) => {
    await tx`update integration_tokens set revoked_at = coalesce(revoked_at, now()) where client_id = ${id} and revoked_at is null`;
  });
  return c.json({ ok: true });
});

integrationRoutes.post("/public/integrations/oauth/token", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  let raw: unknown;
  try {
    raw = contentType.includes("application/json") ? await c.req.json() : await c.req.parseBody();
  } catch {
    throw new ValidationError("Token request must be valid JSON or form data");
  }
  const parsed = integrationTokenSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "invalid_request", error_description: "grant_type, client_id and client_secret are required" }, 400);
  }
  const body = parsed.data;
  await enforceRateLimit(c, "integration.token", requestAddress(c), body.client_id.slice(0, 120));
  const sql = c.get("deps").sql;
  const client = await withContext(sql, { actorKind: "system", platformRole: "platform_operator" }, async (tx) => {
    const rows = await tx`
      select id, client_id, client_secret_hash, environment, status, scopes, products, tenant_id
        from integration_clients where client_id = ${body.client_id} limit 1
    `;
    return rows[0] ?? null;
  });
  const suppliedHash = await sha256Hex(body.client_secret);
  if (!client || client.status !== "active" || suppliedHash !== client.clientSecretHash) {
    return c.json({ error: "invalid_client", error_description: "Client authentication failed" }, 401);
  }
  const allowed = client.scopes as string[];
  const requested = stringList(body.scope);
  const scopes = requested.length > 0 ? requested : allowed;
  const invalid = scopes.filter((scope) => !allowed.includes(scope));
  if (invalid.length > 0) {
    return c.json({ error: "invalid_scope", error_description: `Scopes not granted: ${invalid.join(", ")}` }, 400);
  }
  const ttlSeconds = c.get("deps").config.integrations.tokenTtlMinutes * 60;
  const accessToken = `mvi_${randomToken(32)}`;
  const tokenHash = await sha256Hex(accessToken);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await withContext(sql, { actorKind: "system", platformRole: "platform_operator" }, async (tx) => {
    await tx`
      insert into integration_tokens (id, client_id, token_hash, scopes, audience, expires_at)
      values (${crypto.randomUUID()}, ${client.id}, ${tokenHash}, ${scopes}, 'medveris-api', ${expiresAt})
    `;
  });
  c.header("cache-control", "no-store");
  return c.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ttlSeconds,
    scope: scopes.join(" "),
    environment: client.environment,
  });
});

integrationRoutes.get("/integrations/directory/facilities", async (c) => {
  const client = await requireIntegration(c, "integration.directory.read");
  const limit = Math.min(Math.max(Number.parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 200);
  const facilities = await withIntegrationContext(c, client, async (tx) => tx`
    select f.public_id, f.name, f.facility_type, f.country, f.region, f.district, f.locality,
           f.public_phone, f.website, f.medveris_participation, f.credential_status,
           b.latitude, b.longitude, b.location_status
      from directory_facilities f
      left join lateral (
        select * from directory_branches b where b.facility_id = f.id and b.status = 'active'
         order by b.is_primary desc, b.name limit 1
      ) b on true
     where f.publication_status = 'published' and f.status = 'active'
     order by f.name limit ${limit}
  `);
  return c.json({ facilities, attribution: c.get("deps").config.map.attribution });
});

integrationRoutes.post("/integrations/patients/match", async (c) => {
  const client = await requireIntegration(c, "integration.patient.match");
  const body = await parseJson(c, partnerPatientMatchSchema);
  const result = await withIntegrationContext(c, client, async (tx) => {
    if (body.externalSystem && body.externalIdentifier) {
      const linked = await tx`
        select l.id, l.patient_id, p.public_id, p.given_name, p.family_name, p.date_of_birth
          from partner_patient_links l join patients p on p.id = l.patient_id
         where l.client_id = ${client.id} and l.tenant_id = ${client.tenantId}
           and l.external_system = ${body.externalSystem} and l.external_identifier = ${body.externalIdentifier}
           and l.status = 'active'
      `;
      if (linked[0]) {
        return { linked: true, linkId: linked[0].id, candidates: [] };
      }
    }
    const rows = await tx`
      select p.id, p.public_id, p.given_name, p.family_name, p.date_of_birth, p.sex,
             (lower(p.given_name) = lower(${body.givenName}) and lower(p.family_name) = lower(${body.familyName})) as name_match,
             (p.date_of_birth = ${body.dateOfBirth}::date) as dob_match,
             (${body.publicId || null}::text is not null and p.public_id = ${body.publicId || ""}) as public_id_match
        from patients p
       where p.merged_into is null
         and (
           (${body.publicId || null}::text is not null and p.public_id = ${body.publicId || ""})
           or (lower(p.given_name) = lower(${body.givenName}) and lower(p.family_name) = lower(${body.familyName}))
         )
       order by public_id_match desc, name_match desc, dob_match desc, p.family_name, p.given_name
       limit 10
    `;
    const existingLinks = await tx`
      select external_system, external_identifier, patient_id from partner_patient_links
       where client_id = ${client.id} and tenant_id = ${client.tenantId} and status = 'active'
         and patient_id = any(${rows.map((row) => row.id)}::uuid[])
    `;
    const linkedByPatient = new Map(existingLinks.map((link) => [link.patientId, link]));
    const candidates = rows.map((row) => {
      const score = row.publicIdMatch ? 100 : row.nameMatch && row.dobMatch ? 90 : row.nameMatch ? 60 : 40;
      return {
        patientId: row.id,
        publicId: row.publicId,
        givenName: row.givenName,
        familyName: row.familyName,
        dateOfBirth: row.dateOfBirth,
        sex: row.sex,
        confidence: score >= 90 ? "high" : score >= 60 ? "medium" : "low",
        matchReasons: [
          ...(row.publicIdMatch ? ["public identifier matches"] : []),
          ...(row.nameMatch ? ["name matches"] : []),
          ...(row.dobMatch ? ["date of birth matches"] : []),
        ],
        alreadyLinked: linkedByPatient.has(row.id),
      };
    });
    await writeAudit(tx, c.get("deps").config, {
      tenantId: client.tenantId,
      actorKind: "system",
      action: "integration.patient.match",
      resourceType: "IntegrationClient",
      resourceId: client.id,
      metadata: { candidateCount: candidates.length, usedPublicId: Boolean(body.publicId) },
    });
    return { linked: false, candidates };
  });
  return c.json({
    ...result,
    guidance: "No record is linked automatically. Review candidates and link only after confirming identity with the patient or an authoritative workflow.",
  });
});

integrationRoutes.post("/integrations/patients/links", async (c) => {
  const client = await requireIntegration(c, "integration.patient.link");
  const body = await parseJson(c, partnerPatientLinkSchema);
  const linkId = crypto.randomUUID();
  await withIntegrationContext(c, client, async (tx) => {
    const patient = await tx`select id from patients where id = ${body.patientId} and merged_into is null`;
    if (!patient[0]) throw new NotFoundError("Patient not found in this facility scope");
    const existing = await tx`
      select id from partner_patient_links
       where client_id = ${client.id} and external_system = ${body.externalSystem}
         and external_identifier = ${body.externalIdentifier} and status = 'active'
    `;
    if (existing[0]) throw new ConflictError("This external identifier is already linked");
    await tx`
      insert into partner_patient_links (id, tenant_id, patient_id, client_id, external_system, external_identifier, source_version, provenance)
      values (${linkId}, ${client.tenantId}, ${body.patientId}, ${client.id}, ${body.externalSystem},
        ${body.externalIdentifier}, ${body.sourceVersion || null},
        ${tx.json({ source: "integration-api", environment: client.environment } as never)})
    `;
    await writeAudit(tx, c.get("deps").config, {
      tenantId: client.tenantId,
      actorKind: "system",
      action: "integration.patient.link",
      resourceType: "PartnerPatientLink",
      resourceId: linkId,
      subjectPatientId: body.patientId,
      metadata: { clientId: client.clientId, externalSystem: body.externalSystem },
    });
  });
  return c.json({ ok: true, link: { id: linkId, status: "active" } }, 201);
});

integrationRoutes.get("/integrations/patients/links", async (c) => {
  const client = await requireIntegration(c, "integration.patient.link");
  const links = await withIntegrationContext(c, client, async (tx) => tx`
    select l.id, l.patient_id, l.external_system, l.external_identifier, l.source_version,
           l.status, l.linked_at, l.unlinked_at, p.public_id
      from partner_patient_links l join patients p on p.id = l.patient_id
     where l.client_id = ${client.id} and l.tenant_id = ${client.tenantId}
     order by l.linked_at desc limit 500
  `);
  return c.json({ links });
});

integrationRoutes.delete("/integrations/patients/links/:id", async (c) => {
  const client = await requireIntegration(c, "integration.patient.link");
  const body = await parseJson(c, partnerPatientUnlinkSchema);
  const id = c.req.param("id");
  await withIntegrationContext(c, client, async (tx) => {
    const link = await requireRows(await tx`
      select * from partner_patient_links
       where id = ${id} and client_id = ${client.id} and tenant_id = ${client.tenantId} and status = 'active'
       for update
    `, "Active patient link not found");
    await tx`
      update partner_patient_links set status = 'unlinked', unlinked_at = now(), unlink_reason = ${body.reason}
       where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, {
      tenantId: client.tenantId,
      actorKind: "system",
      action: "integration.patient.unlink",
      resourceType: "PartnerPatientLink",
      resourceId: id,
      subjectPatientId: link.patientId,
      metadata: { clientId: client.clientId, reason: body.reason },
    });
  });
  return c.json({ ok: true });
});

// API product catalogue administration ----------------------------------------

integrationRoutes.get("/integrations/products", async (c) => {
  requirePlatform(c);
  const rows = await withPlatformActor(c, async (tx) => tx`select * from api_products order by service_family, name`);
  return c.json({ products: rows });
});

integrationRoutes.post("/integrations/products", async (c) => {
  requirePlatform(c);
  const body = await parseJson(c, apiProductSchema);
  const id = crypto.randomUUID();
  await withPlatformActor(c, async (tx) => {
    await tx`
      insert into api_products (
        id, code, name, description, service_family, data_classification, required_scopes,
        rate_limit_per_minute, daily_quota, support_level, sandbox_available, commercial_status, enabled
      ) values (
        ${id}, ${body.code}, ${body.name}, ${body.description || null}, ${body.serviceFamily},
        ${body.dataClassification}, ${body.requiredScopes}, ${body.rateLimitPerMinute}, ${body.dailyQuota},
        ${body.supportLevel}, ${body.sandboxAvailable}, ${body.commercialStatus}, ${body.enabled}
      )
    `;
  });
  return c.json({ ok: true, product: { id } }, 201);
});
