import type { z } from "zod";
import { randomToken } from "@medveris/auth";
import type { facilityRegistrationSchema, workspaceDetailsSchema } from "@medveris/contracts";
import { setLocalContext, type Tx } from "@medveris/db";
import { describeLevel, recommendModules, resolveLevel, serviceCategory, type ResolvedLevel } from "@medveris/domain";
import type { Role } from "@medveris/authz";
import type { AppConfig } from "../config.js";
import { writeAudit } from "../lib/audit.js";
import { ConflictError } from "../lib/errors.js";
import type { AuditMeta } from "./invitations.js";

export type WorkspaceDetails = z.infer<typeof workspaceDetailsSchema>;
export type RegistrationInput = z.infer<typeof facilityRegistrationSchema>;

/** Roles of the person who creates a workspace: its primary owner, who can run it alone. */
export const OWNER_ROLES = ["owner", "facility_admin"] as const;

/**
 * An owner who registers a standalone unit also runs its front desk, till and the unit's own bench, so the
 * unit works from the first sign-in. Prescribing, signing and reporting roles are never granted this way;
 * they need a credentialed assignment from the workspace administrator.
 */
const UNIT_OPERATIONAL_ROLES: Readonly<Record<string, readonly Role[]>> = Object.freeze({
  laboratory: ["laboratory"],
  imaging: ["radiology", "radiographer"],
  pharmacy: ["pharmacist"],
  "drug-shop": ["pharmacist"],
});

export function unitOwnerRoles(serviceCategory: string): Role[] {
  return [...OWNER_ROLES, "receptionist", "finance", ...(UNIT_OPERATIONAL_ROLES[serviceCategory] ?? [])];
}

export function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return `${base || "workspace"}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5)}`;
}

export function levelFrom(details: Pick<WorkspaceDetails, "serviceCategory" | "serviceSubtype" | "levelStatus" | "officialLevel"
  | "officialLevelSource" | "officialLevelReference" | "equivalentLevel" | "equivalentJustification">): ResolvedLevel {
  return resolveLevel({
    serviceCategory: details.serviceCategory,
    serviceSubtype: details.serviceSubtype ?? null,
    levelStatus: details.levelStatus,
    officialLevel: details.officialLevel ?? null,
    officialLevelSource: details.officialLevelSource ?? null,
    officialLevelReference: details.officialLevelReference ?? null,
    equivalentLevel: details.equivalentLevel ?? null,
    equivalentJustification: details.equivalentJustification ?? null,
  });
}

export async function recordLevelHistory(tx: Tx, tenantId: string, category: string, subtype: string | null, level: ResolvedLevel, userId: string | null, reason: string | null): Promise<void> {
  await tx`
    insert into tenant_level_history (id, tenant_id, service_category, service_subtype, level_status, official_level, official_level_source,
      official_level_reference, equivalent_level, equivalent_justification, reason, recorded_by)
    values (${crypto.randomUUID()}, ${tenantId}, ${category}, ${subtype}, ${level.levelStatus}, ${level.officialLevel}, ${level.officialLevelSource},
      ${level.officialLevelReference}, ${level.equivalentLevel}, ${level.equivalentJustification}, ${reason}, ${userId})
  `;
}

export async function insertRegistration(tx: Tx, tenantId: string, registration: RegistrationInput, userId: string | null): Promise<string> {
  const id = crypto.randomUUID();
  try {
    await tx`savepoint registration_insert`;
    await tx`
      insert into facility_registrations (id, tenant_id, kind, issuer, identifier, valid_from, valid_until, recorded_by)
      values (${id}, ${tenantId}, ${registration.kind}, ${registration.issuer || null}, ${registration.identifier},
        ${registration.validFrom || null}, ${registration.validUntil || null}, ${userId})
    `;
    await tx`release savepoint registration_insert`;
  } catch (error) {
    await tx`rollback to savepoint registration_insert`;
    if ((error as { code?: string }).code === "23505") {
      throw new ConflictError("This NHFR ID is already recorded for another Medveris workspace. Join that workspace or its organization instead of creating a duplicate.");
    }
    throw error;
  }
  return id;
}

export interface CreatedWorkspace {
  tenantId: string;
  slug: string;
}

/**
 * Creates a workspace (tenant) with its classification, registrations and primary owner. Leaves the
 * transaction scoped to the new workspace as its owner. The parent organization is optional; a link is
 * created separately so its approval and history visibility stay explicit.
 */
export async function createWorkspace(tx: Tx, config: AppConfig, input: {
  details: WorkspaceDetails;
  ownerUserId: string;
  /** Defaults to OWNER_ROLES; always includes them. */
  ownerRoles?: readonly Role[];
  hostTenantId?: string | null;
  actorKind: "registration" | "staff";
  meta: AuditMeta;
}): Promise<CreatedWorkspace> {
  const { details } = input;
  const ownerRoles = [...new Set<Role>([...OWNER_ROLES, ...(input.ownerRoles ?? [])])];
  const category = serviceCategory(details.serviceCategory);
  const level = levelFrom(details);
  const modules = details.modules ?? recommendModules(details.serviceCategory, level).modules;
  const tenantId = crypto.randomUUID();
  const slug = slugify(details.name);
  await tx`
    insert into tenants (id, name, slug, facility_type, city, country, email, workspace_kind, service_category, service_subtype, ownership,
      level_status, official_level, official_level_source, official_level_reference, equivalent_level, equivalent_justification,
      level_updated_by, level_updated_at, district, region, address, host_tenant_id, enabled_modules, created_by)
    values (${tenantId}, ${details.name}, ${slug}, ${category.label}, ${details.city || null}, ${details.country}, null,
      ${details.workspaceKind}, ${details.serviceCategory}, ${details.serviceSubtype ?? null}, ${details.ownership},
      ${level.levelStatus}, ${level.officialLevel}, ${level.officialLevelSource}, ${level.officialLevelReference},
      ${level.equivalentLevel}, ${level.equivalentJustification}, ${input.ownerUserId}, now(),
      ${details.district || null}, ${details.region || null}, ${details.address || null}, ${input.hostTenantId ?? null},
      ${modules}, ${input.ownerUserId})
  `;
  await setLocalContext(tx, { actorKind: input.actorKind, tenantId, userId: input.ownerUserId, roles: [...OWNER_ROLES] });
  await tx`
    insert into memberships (id, tenant_id, user_id, roles) values (${crypto.randomUUID()}, ${tenantId}, ${input.ownerUserId}, ${ownerRoles})
  `;
  await recordLevelHistory(tx, tenantId, details.serviceCategory, details.serviceSubtype ?? null, level, input.ownerUserId, "Recorded at onboarding");
  for (const registration of details.registrations) await insertRegistration(tx, tenantId, registration, input.ownerUserId);
  await writeAudit(tx, config, {
    tenantId,
    actorKind: input.actorKind,
    actorUserId: input.ownerUserId,
    actorRoles: [...OWNER_ROLES],
    action: "workspace.create",
    resourceType: "Organization",
    resourceId: tenantId,
    ...input.meta,
    metadata: {
      workspaceKind: details.workspaceKind, serviceCategory: details.serviceCategory, levelStatus: level.levelStatus,
      level: describeLevel(level).label, registrations: details.registrations.map((registration) => registration.kind), modules,
    },
  });
  return { tenantId, slug };
}

export interface DuplicateFinding {
  tenantId: string;
  name: string;
  reason: string;
}

export async function duplicateFindings(tx: Tx, organizationId: string, tenantId: string): Promise<DuplicateFinding[]> {
  const rows = await tx`select tenant_id, name, reason from app.organization_duplicate_candidates(${organizationId}, ${tenantId})`;
  return rows.map((row) => ({ tenantId: String(row.tenantId), name: String(row.name), reason: String(row.reason) }));
}

export async function recordLinkEvent(tx: Tx, input: { linkId: string; organizationId: string; tenantId: string; event: string; actorUserId: string | null; detail?: Record<string, unknown> }): Promise<void> {
  await tx`
    insert into organization_link_events (id, link_id, organization_id, tenant_id, event, actor_user_id, detail)
    values (${crypto.randomUUID()}, ${input.linkId}, ${input.organizationId}, ${input.tenantId}, ${input.event}, ${input.actorUserId},
      ${tx.json((input.detail ?? {}) as never)})
  `;
}
