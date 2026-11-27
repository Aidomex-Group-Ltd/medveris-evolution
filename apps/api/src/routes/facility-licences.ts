import { Hono } from "hono";
import { facilityLicenceDecisionSchema, uuidSchema } from "@medveris/contracts";
import { requirePlatformOperator } from "../lib/authorization.js";
import { withPlatformActor } from "../auth/middleware.js";
import { writeAudit } from "../lib/audit.js";
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors.js";
import { auditMeta } from "../lib/http.js";
import { parseJson } from "../lib/http.js";
import type { AppEnv } from "../types.js";

/**
 * Platform review of a facility's optional licence documentation.
 *
 * Access to MedVeris never depends on this queue: a facility qualifies for its interface as soon
 * as it records a service type, with or without a licence. What a reviewer decides here is only
 * whether the recorded details have been checked, which matters for regulated medicine sales and
 * for the facility's own honest display of its status. A reviewer cannot verify a facility they
 * belong to, cannot verify an expired licence, and cannot edit the details the facility supplied.
 */
export const facilityLicenceRoutes = new Hono<AppEnv>();

const DECIDABLE = new Set(["recorded", "rejected"]);

facilityLicenceRoutes.get("/facility-licences/queue", async (c) => {
  requirePlatformOperator(c);
  const rows = await withPlatformActor(c, async (tx) => tx`
    select r.id, r.tenant_id, t.name as facility_name, t.service_category, r.kind, r.issuer, r.identifier,
           to_char(r.valid_from, 'YYYY-MM-DD') as valid_from,
           to_char(r.valid_until, 'YYYY-MM-DD') as valid_until,
           r.document_reference, r.status, r.verification_notes,
           r.verified_at, r.created_at, r.updated_at
      from facility_registrations r join tenants t on t.id = r.tenant_id
     where r.status in ('recorded', 'rejected')
     order by r.updated_at, r.created_at
     limit 200
  `);
  return c.json({
    queue: rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenantId),
      facilityName: String(row.facilityName),
      serviceCategory: (row.serviceCategory as string | null) ?? null,
      kind: String(row.kind),
      issuer: (row.issuer as string | null) ?? null,
      identifier: String(row.identifier),
      validFrom: (row.validFrom as string | null) ?? null,
      validUntil: (row.validUntil as string | null) ?? null,
      documentReference: (row.documentReference as string | null) ?? null,
      status: String(row.status),
      verificationNotes: (row.verificationNotes as string | null) ?? null,
      verifiedAt: (row.verifiedAt as Date | null)?.toISOString() ?? null,
      createdAt: (row.createdAt as Date).toISOString(),
      updatedAt: (row.updatedAt as Date).toISOString(),
    })),
    rule: "A licence is optional documentation. Verification records that the submitted details were checked; it never grants or removes platform access, and an expired licence cannot be verified.",
  });
});

facilityLicenceRoutes.post("/facility-licences/:id/decision", async (c) => {
  requirePlatformOperator(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, facilityLicenceDecisionSchema);
  const auth = c.get("auth")!;
  const config = c.get("deps").config;

  const result = await withPlatformActor(c, async (tx) => {
    const [record] = await tx`
      select r.id, r.tenant_id, r.kind, r.status, to_char(r.valid_until, 'YYYY-MM-DD') as valid_until
        from facility_registrations r
       where r.id = ${id}
       for update`;
    if (!record) throw new NotFoundError("Licence record not found");
    if (!DECIDABLE.has(String(record.status))) {
      throw new ConflictError(
        String(record.status) === "verified"
          ? "This licence is already verified"
          : "This licence is no longer awaiting review",
      );
    }
    // Independence: a reviewer with a membership in the facility cannot decide its licence.
    const [own] = await tx`
      select id from memberships where user_id = ${auth.user.id} and tenant_id = ${record.tenantId} limit 1`;
    if (own) throw new ValidationError("A reviewer cannot verify a facility they belong to");

    const validUntil = (record.validUntil as string | null) ?? null;
    if (body.decision === "verified" && validUntil && validUntil < new Date().toISOString().slice(0, 10)) {
      throw new ValidationError("An expired licence cannot be verified; the facility must record current details first");
    }

    const status = body.decision === "verified" ? "verified" : "rejected";
    await tx`
      update facility_registrations
         set status = ${status},
             verified_by = ${auth.user.id},
             verified_at = now(),
             verification_notes = ${body.notes},
             updated_at = now()
       where id = ${id}`;

    await writeAudit(tx, config, {
      tenantId: String(record.tenantId),
      actorUserId: auth.user.id,
      actorKind: "staff",
      actorRoles: auth.activeTenant?.roles ?? [],
      action: "facility.licence.review",
      resourceType: "FacilityRegistration",
      resourceId: id,
      ...auditMeta(c),
      metadata: { decision: body.decision, kind: String(record.kind), previousStatus: String(record.status) },
    });

    return { status, tenantId: String(record.tenantId) };
  });

  return c.json({ ok: true, ...result });
});
