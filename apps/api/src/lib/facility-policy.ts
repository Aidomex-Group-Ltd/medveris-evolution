import type { Context } from "hono";
import { resolveFacilityExperience, type FacilityExperienceResolution, type FacilityRegistrationLike } from "@medveris/domain";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import type { AppEnv } from "../types.js";

/**
 * The active facility's experience and licence state, resolved from the authenticated session's
 * own facility — never from a request parameter. Every dispensing path calls this so a direct API
 * call cannot sidestep the licence or classification rules the interface shows.
 */
export async function facilityDispensingPolicy(c: Context<AppEnv>): Promise<FacilityExperienceResolution> {
  const auth = requireStaff(c);
  const tenantId = auth.activeTenant!.id;
  const loaded = await withStaffActor(c, async (tx) => {
    const tenant = await tx`select service_category from tenants where id = ${tenantId}`;
    const registrations = await tx`
      select kind, identifier, status, valid_until from facility_registrations where tenant_id = ${tenantId}
    `;
    return { serviceCategory: (tenant[0]?.serviceCategory as string | null) ?? null, registrations };
  });
  const rows: FacilityRegistrationLike[] = loaded.registrations.map((row) => ({
    kind: String(row.kind),
    identifier: String(row.identifier),
    status: String(row.status),
    validUntil: (row.validUntil as string | null) ?? null,
  }));
  return resolveFacilityExperience({ serviceCategory: loaded.serviceCategory, registrations: rows });
}
