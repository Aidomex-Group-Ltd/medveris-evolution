import { Hono, type Context } from "hono";
import { z } from "zod";
import { randomToken, sha256Hex } from "@medveris/auth";
import {
  inventoryModeProposalSchema,
  organizationDetailsSchema,
  organizationInvitationAcceptSchema,
  organizationInvitationCreateSchema,
  organizationJoinCodeCreateSchema,
  organizationLinkDecisionSchema,
  organizationLinkEndSchema,
  organizationReportQuerySchema,
  organizationSiteSchema,
  uuidSchema,
} from "@medveris/contracts";
import { withContext, type Tx } from "@medveris/db";
import { describeLevel, rollUpLevel, type LevelStatus, type ResolvedLevel } from "@medveris/domain";
import { requireAuth } from "../auth/middleware.js";
import { auditMeta, parseJson, parseQuery } from "../lib/http.js";
import { writeAudit } from "../lib/audit.js";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { enforceRateLimit } from "../lib/rate-limit.js";
import { createWorkspace, recordLinkEvent } from "../services/workspaces.js";
import { csvCell } from "./reports.js";
import type { AppEnv, AuthContext } from "../types.js";

export const organizationsRoutes = new Hono<AppEnv>();

type C = Context<AppEnv>;
type OrganizationRole = "organization_owner" | "organization_admin" | "organization_reporting";

const ADMIN_ROLES: readonly OrganizationRole[] = ["organization_owner", "organization_admin"];
const INVITATION_TTL_MS = 7 * 86_400_000;

/** Organization work needs a signed-in staff account with verified MFA; no facility context is required. */
function requireOrganizationActor(c: C): AuthContext {
  const auth = requireAuth(c);
  if (!auth.user.mfaEnrolledAt || !auth.mfaVerified) throw new ForbiddenError("MFA verification is required for organization access");
  return auth;
}

function withOrganizationActor<T>(c: C, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const auth = requireOrganizationActor(c);
  return withContext(c.get("deps").sql, { userId: auth.user.id, actorKind: "staff", tenantId: null, roles: [] }, fn);
}

async function organizationRole(tx: Tx, organizationId: string): Promise<OrganizationRole | null> {
  const [row] = await tx`select app.organization_role(${organizationId}) as role`;
  return (row?.role as OrganizationRole | null) ?? null;
}

async function requireRole(tx: Tx, organizationId: string, roles: readonly OrganizationRole[]): Promise<OrganizationRole> {
  const role = await organizationRole(tx, organizationId);
  if (!role) throw new NotFoundError("Organization not found");
  if (!roles.includes(role)) throw new ForbiddenError("Organization administrator permission is required");
  return role;
}

function audit(c: C, action: string, input: { organizationId: string; tenantId?: string | null; resourceType: string; resourceId: string | null; metadata?: Record<string, unknown> }) {
  const auth = c.get("auth")!;
  return {
    tenantId: input.tenantId ?? null,
    actorKind: "staff" as const,
    actorUserId: auth.user.id,
    actorRoles: [],
    action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    ...auditMeta(c),
    metadata: { organizationId: input.organizationId, ...(input.metadata ?? {}) },
  };
}

function levelOf(row: Record<string, unknown>): ResolvedLevel {
  return {
    levelStatus: row.levelStatus as LevelStatus,
    officialLevel: (row.officialLevel as ResolvedLevel["officialLevel"]) ?? null,
    officialLevelSource: (row.officialLevelSource as ResolvedLevel["officialLevelSource"]) ?? null,
    officialLevelReference: (row.officialLevelReference as string | null) ?? null,
    equivalentLevel: (row.equivalentLevel as ResolvedLevel["equivalentLevel"]) ?? null,
    equivalentJustification: null,
  };
}

organizationsRoutes.get("/organizations", async (c) => {
  const auth = requireAuth(c);
  const rows = await withContext(c.get("deps").sql, { userId: auth.user.id, actorKind: "staff" }, async (tx) => tx`
    select o.id, o.name, o.kind, o.ownership, o.status, m.role,
           (select count(*)::int from organization_links l where l.organization_id = o.id and l.status = 'active') as active_sites,
           (select count(*)::int from organization_links l where l.organization_id = o.id and l.status = 'pending') as pending_links
      from organization_memberships m join organizations o on o.id = m.organization_id
     where m.user_id = ${auth.user.id} and m.status = 'active'
     order by o.name`);
  return c.json({ organizations: rows });
});

const createOrganizationSchema = organizationDetailsSchema.extend({
  /** Link the caller's active workspace as the first site; the caller must administer it. */
  linkActiveWorkspace: z.boolean().default(false),
  historyVisibility: z.enum(["from-link-date", "full-history"]).default("from-link-date"),
});

organizationsRoutes.post("/organizations", async (c) => {
  const auth = requireOrganizationActor(c);
  const body = await parseJson(c, createOrganizationSchema);
  const config = c.get("deps").config;
  const active = auth.activeTenant;
  if (body.linkActiveWorkspace && !active?.roles.includes("facility_admin")) {
    throw new ForbiddenError("Only the administrator of the active workspace can link it to a new organization");
  }
  const organizationId = crypto.randomUUID();
  await withOrganizationActor(c, async (tx) => {
    await tx`
      insert into organizations (id, name, legal_name, registration_ref, country, kind, ownership, contact_email, created_by)
      values (${organizationId}, ${body.name}, ${body.legalName || null}, ${body.registrationRef || null}, 'Uganda', ${body.kind},
        ${body.ownership}, ${body.contactEmail || auth.user.email}, ${auth.user.id})`;
    await tx`
      insert into organization_memberships (id, organization_id, user_id, role)
      values (${crypto.randomUUID()}, ${organizationId}, ${auth.user.id}, 'organization_owner')`;
    if (body.linkActiveWorkspace && active) {
      const full = body.historyVisibility === "full-history";
      const linkId = crypto.randomUUID();
      await tx`
        insert into organization_links (id, organization_id, tenant_id, status, origin, requested_by, decided_by, decided_at,
          history_visibility, history_granted_by, history_granted_at, visible_from)
        values (${linkId}, ${organizationId}, ${active.id}, 'active', 'join-request', ${auth.user.id}, ${auth.user.id}, now(),
          ${full ? "full-history" : "from-link-date"}, ${full ? auth.user.id : null}, ${full ? new Date() : null}, ${full ? null : new Date()})`;
      await tx`update tenants set organization_id = ${organizationId} where id = ${active.id}`;
      await recordLinkEvent(tx, { linkId, organizationId, tenantId: active.id, event: "approved", actorUserId: auth.user.id, detail: { selfLinked: true, historyVisibility: body.historyVisibility } });
    }
    await writeAudit(tx, config, audit(c, "organization.create", { organizationId, resourceType: "Organization", resourceId: organizationId, metadata: { kind: body.kind, linkedWorkspace: body.linkActiveWorkspace ? active?.id : null } }));
  }).catch((error: unknown) => {
    if ((error as { constraint_name?: string }).constraint_name === "organization_links_one_live") {
      throw new ConflictError("The active workspace already has a pending or active organization link");
    }
    throw error;
  });
  return c.json({ ok: true, organization: { id: organizationId, name: body.name } }, 201);
});

organizationsRoutes.get("/organizations/:id", async (c) => {
  requireOrganizationActor(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const data = await withOrganizationActor(c, async (tx) => {
    const role = await requireRole(tx, id, ["organization_owner", "organization_admin", "organization_reporting"]);
    const [organization] = await tx`select id, name, legal_name, registration_ref, kind, ownership, status, contact_email, created_at from organizations where id = ${id}`;
    const sites = await tx`select * from app.organization_sites(${id})`;
    const admin = ADMIN_ROLES.includes(role);
    const members = admin ? await tx`
      select m.id, m.role, m.status, m.created_at, u.display_name, u.email
        from organization_memberships m join users u on u.id = m.user_id
       where m.organization_id = ${id} and m.status = 'active' order by m.created_at` : [];
    const invitations = admin ? await tx`
      select id, email, role, expires_at, accepted_at, revoked_at, created_at from organization_invitations
       where organization_id = ${id} order by created_at desc limit 50` : [];
    const joinCodes = admin ? await tx`
      select id, label, max_uses, uses, expires_at, revoked_at, created_at from organization_join_codes
       where organization_id = ${id} order by created_at desc limit 50` : [];
    const events = await tx`
      select e.event, e.detail, e.occurred_at, e.tenant_id, t.name as site_name, u.display_name as actor_name
        from organization_link_events e join tenants t on t.id = e.tenant_id left join users u on u.id = e.actor_user_id
       where e.organization_id = ${id} order by e.occurred_at desc limit 50`;
    return { role, organization, sites, members, invitations, joinCodes, events };
  });
  const byId = new Map(data.sites.map((site) => [String(site.tenantId), site]));
  return c.json({
    ...data,
    sites: data.sites.map((site) => {
      const host = site.hostTenantId ? byId.get(String(site.hostTenantId)) : null;
      return {
        ...site,
        level: describeLevel(levelOf(site)),
        rollUpLevel: host ? { hostName: host.name, ...rollUpLevel(levelOf(host)) } : null,
      };
    }),
    permissions: { manage: ADMIN_ROLES.includes(data.role) },
  });
});

organizationsRoutes.post("/organizations/:id/sites", async (c) => {
  const auth = requireOrganizationActor(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, organizationSiteSchema);
  const config = c.get("deps").config;
  const tenantId = await withOrganizationActor(c, async (tx) => {
    await requireRole(tx, id, ADMIN_ROLES);
    if (body.hostTenantId) {
      const [host] = await tx`select 1 from organization_links where organization_id = ${id} and tenant_id = ${body.hostTenantId} and status = 'active'`;
      if (!host) throw new ValidationError("The host facility must be an active site of this organization");
    }
    const created = await createWorkspace(tx, config, { details: body, ownerUserId: auth.user.id, hostTenantId: body.hostTenantId ?? null, actorKind: "staff", meta: auditMeta(c) });
    const linkId = crypto.randomUUID();
    await tx`
      insert into organization_links (id, organization_id, tenant_id, status, origin, requested_by, decided_by, decided_at, history_visibility, visible_from)
      values (${linkId}, ${id}, ${created.tenantId}, 'active', 'created-by-organization', ${auth.user.id}, ${auth.user.id}, now(), 'full-history', null)`;
    await tx`update tenants set organization_id = ${id} where id = ${created.tenantId}`;
    await recordLinkEvent(tx, { linkId, organizationId: id, tenantId: created.tenantId, event: "site-created", actorUserId: auth.user.id });
    await writeAudit(tx, config, audit(c, "organization.site.create", { organizationId: id, tenantId: created.tenantId, resourceType: "Organization", resourceId: created.tenantId }));
    return created.tenantId;
  });
  return c.json({ ok: true, site: { id: tenantId, name: body.name } }, 201);
});

organizationsRoutes.post("/organizations/:id/join-codes", async (c) => {
  const auth = requireOrganizationActor(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, organizationJoinCodeCreateSchema);
  const code = randomToken(18);
  const codeId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + body.expiresInDays * 86_400_000);
  await withOrganizationActor(c, async (tx) => {
    await requireRole(tx, id, ADMIN_ROLES);
    await tx`
      insert into organization_join_codes (id, organization_id, code_hash, label, max_uses, expires_at, created_by)
      values (${codeId}, ${id}, ${await sha256Hex(`org-join:${code}`)}, ${body.label}, ${body.maxUses}, ${expiresAt}, ${auth.user.id})`;
    await writeAudit(tx, c.get("deps").config, audit(c, "organization.join-code.create", { organizationId: id, resourceType: "OrganizationJoinCode", resourceId: codeId, metadata: { maxUses: body.maxUses } }));
  });
  return c.json({ ok: true, joinCode: { id: codeId, code, expiresAt, notice: "Shown once. Give it only to the administrator of the workspace that should join." } }, 201);
});

organizationsRoutes.post("/organizations/:id/join-codes/:codeId/revoke", async (c) => {
  requireOrganizationActor(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const codeId = uuidSchema.parse(c.req.param("codeId"));
  await withOrganizationActor(c, async (tx) => {
    await requireRole(tx, id, ADMIN_ROLES);
    const rows = await tx`update organization_join_codes set revoked_at = now() where id = ${codeId} and organization_id = ${id} and revoked_at is null returning id`;
    if (!rows[0]) throw new NotFoundError("Join code not found");
    await writeAudit(tx, c.get("deps").config, audit(c, "organization.join-code.revoke", { organizationId: id, resourceType: "OrganizationJoinCode", resourceId: codeId }));
  });
  return c.json({ ok: true });
});

async function lockLink(tx: Tx, organizationId: string, linkId: string) {
  const [link] = await tx`select * from organization_links where id = ${linkId} and organization_id = ${organizationId} for update`;
  if (!link) throw new NotFoundError("Organization link not found");
  return link;
}

const linkApprovalSchema = organizationLinkDecisionSchema.extend({ hostTenantId: uuidSchema.nullable().optional() });

/**
 * Approving links the workspace without moving any record. Roll-ups include its activity from today unless
 * the workspace administrator chose to share earlier history; patient-level records never become visible.
 */
organizationsRoutes.post("/organizations/:id/links/:linkId/decision", async (c) => {
  const auth = requireOrganizationActor(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const linkId = uuidSchema.parse(c.req.param("linkId"));
  const body = await parseJson(c, linkApprovalSchema);
  const status = await withOrganizationActor(c, async (tx) => {
    await requireRole(tx, id, ADMIN_ROLES);
    const link = await lockLink(tx, id, linkId);
    if (link.status !== "pending") throw new ConflictError(`This link is ${link.status}`);
    const findings = (link.duplicateFindings as unknown[]) ?? [];
    if (body.decision === "approve" && findings.length && !body.duplicateResolution) {
      throw new ValidationError("Possible duplicate sites were found; record how you confirmed this is a different workspace before approving", { findings });
    }
    if (body.decision === "approve" && body.hostTenantId) {
      const [host] = await tx`select 1 from organization_links where organization_id = ${id} and tenant_id = ${body.hostTenantId} and status = 'active'`;
      if (!host || body.hostTenantId === link.tenantId) throw new ValidationError("The host facility must be another active site of this organization");
    }
    const next = body.decision === "approve" ? "active" : "rejected";
    const full = link.historyVisibility === "full-history";
    await tx`
      update organization_links set status = ${next}, decided_by = ${auth.user.id}, decided_at = now(), decision_note = ${body.note},
        duplicate_resolution = ${body.duplicateResolution ?? null}, visible_from = ${next === "active" && !full ? new Date() : null}, updated_at = now()
       where id = ${linkId}`;
    if (next === "active") {
      await tx`update tenants set organization_id = ${id}, host_tenant_id = ${body.hostTenantId ?? null}, updated_at = now() where id = ${link.tenantId}`;
    }
    await recordLinkEvent(tx, { linkId, organizationId: id, tenantId: String(link.tenantId), event: next === "active" ? "approved" : "rejected", actorUserId: auth.user.id, detail: { note: body.note, duplicates: findings.length } });
    await writeAudit(tx, c.get("deps").config, audit(c, `organization.link.${body.decision}`, {
      organizationId: id, tenantId: String(link.tenantId), resourceType: "OrganizationLink", resourceId: linkId,
      metadata: { duplicates: findings.length, historyVisibility: link.historyVisibility, hostTenantId: body.hostTenantId ?? null },
    }));
    return next;
  });
  return c.json({ ok: true, status });
});

organizationsRoutes.post("/organizations/:id/links/:linkId/inventory-mode", async (c) => {
  const auth = requireOrganizationActor(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const linkId = uuidSchema.parse(c.req.param("linkId"));
  const body = await parseJson(c, inventoryModeProposalSchema);
  const result = await withOrganizationActor(c, async (tx) => {
    await requireRole(tx, id, ADMIN_ROLES);
    const link = await lockLink(tx, id, linkId);
    if (link.status !== "active") throw new ConflictError("Inventory sharing applies to active sites only");
    if (body.mode === "independent") {
      const open = await tx`select count(*)::int as n from organization_stock_transfers where organization_id = ${id} and status = 'dispatched'
        and (source_tenant_id = ${link.tenantId} or destination_tenant_id = ${link.tenantId})`;
      if (Number(open[0]?.n ?? 0) > 0) throw new ConflictError("This site has inter-site transfers in transit");
      await tx`update organization_links set inventory_mode = 'independent', inventory_mode_proposed = null, inventory_mode_changed_at = now(), updated_at = now() where id = ${linkId}`;
      await recordLinkEvent(tx, { linkId, organizationId: id, tenantId: String(link.tenantId), event: "inventory-mode-accepted", actorUserId: auth.user.id, detail: { mode: "independent", note: body.note } });
      return { inventoryMode: "independent", pending: false };
    }
    // Shared supply changes who can move stock into and out of the site, so the site administrator must accept it.
    await tx`update organization_links set inventory_mode_proposed = 'shared-supply', inventory_mode_proposed_by = ${auth.user.id}, updated_at = now() where id = ${linkId}`;
    await recordLinkEvent(tx, { linkId, organizationId: id, tenantId: String(link.tenantId), event: "inventory-mode-proposed", actorUserId: auth.user.id, detail: { mode: "shared-supply", note: body.note } });
    return { inventoryMode: String(link.inventoryMode), pending: true };
  });
  await withOrganizationActor(c, async (tx) => writeAudit(tx, c.get("deps").config, audit(c, "organization.link.inventory-mode", {
    organizationId: id, resourceType: "OrganizationLink", resourceId: linkId, metadata: { mode: body.mode },
  })));
  return c.json({ ok: true, ...result });
});

organizationsRoutes.post("/organizations/:id/links/:linkId/end", async (c) => {
  const auth = requireOrganizationActor(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const linkId = uuidSchema.parse(c.req.param("linkId"));
  const body = await parseJson(c, organizationLinkEndSchema);
  await withOrganizationActor(c, async (tx) => {
    await requireRole(tx, id, ADMIN_ROLES);
    const link = await lockLink(tx, id, linkId);
    if (link.status !== "active") throw new ConflictError(`This link is ${link.status}`);
    const open = await tx`select count(*)::int as n from organization_stock_transfers where organization_id = ${id} and status = 'dispatched'
      and (source_tenant_id = ${link.tenantId} or destination_tenant_id = ${link.tenantId})`;
    if (Number(open[0]?.n ?? 0) > 0) throw new ConflictError("This site has inter-site transfers in transit");
    await tx`update organization_links set status = 'ended', ended_by = ${auth.user.id}, ended_at = now(), end_reason = ${body.reason}, inventory_mode = 'independent', updated_at = now() where id = ${linkId}`;
    await tx`update tenants set organization_id = null, host_tenant_id = null, updated_at = now() where id = ${link.tenantId}`;
    await tx`update tenants set host_tenant_id = null where host_tenant_id = ${link.tenantId} and organization_id = ${id}`;
    await recordLinkEvent(tx, { linkId, organizationId: id, tenantId: String(link.tenantId), event: "ended", actorUserId: auth.user.id, detail: { reason: body.reason, by: "organization" } });
    await writeAudit(tx, c.get("deps").config, audit(c, "organization.link.end", { organizationId: id, tenantId: String(link.tenantId), resourceType: "OrganizationLink", resourceId: linkId }));
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- members

organizationsRoutes.post("/organizations/:id/invitations", async (c) => {
  const auth = requireOrganizationActor(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, organizationInvitationCreateSchema);
  const deps = c.get("deps");
  const token = randomToken(32);
  const invitationId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const name = await withOrganizationActor(c, async (tx) => {
    await requireRole(tx, id, ADMIN_ROLES);
    const [organization] = await tx`select name from organizations where id = ${id}`;
    await tx`update organization_invitations set revoked_at = now() where organization_id = ${id} and lower(email) = ${body.email} and accepted_at is null and revoked_at is null`;
    await tx`
      insert into organization_invitations (id, organization_id, email, role, token_hash, invited_by, expires_at)
      values (${invitationId}, ${id}, ${body.email}, ${body.role}, ${await sha256Hex(token)}, ${auth.user.id}, ${expiresAt})`;
    await writeAudit(tx, deps.config, audit(c, "organization.member.invite", { organizationId: id, resourceType: "OrganizationInvitation", resourceId: invitationId, metadata: { role: body.role, emailDomain: body.email.split("@")[1] } }));
    return String(organization!.name);
  });
  const delivery = await deps.email.send({
    to: body.email,
    subject: `Join ${name} on Medveris`,
    text: `You have been invited to ${name} on Medveris as ${body.role.replace("organization_", "organization ")}. Sign in with this email address and open ${deps.config.origin}/organizations?invitation=${token} to accept. The link expires on ${expiresAt.toUTCString()}. Organization access shows aggregate reports for linked sites only; it never opens patient records.`,
  });
  return c.json({ ok: true, invitationId, delivery: { delivered: delivery.delivered, detail: delivery.detail } }, 201);
});

organizationsRoutes.post("/organizations/invitations/accept", async (c) => {
  const auth = requireOrganizationActor(c);
  const body = await parseJson(c, organizationInvitationAcceptSchema);
  const tokenHash = await sha256Hex(body.token);
  const result = await withOrganizationActor(c, async (tx) => {
    await tx`select set_config('app.invitation_token_hash', ${tokenHash}, true)`;
    const [invitation] = await tx`select * from organization_invitations where token_hash = ${tokenHash} for update`;
    if (!invitation || invitation.revokedAt || invitation.acceptedAt || (invitation.expiresAt as Date).getTime() <= Date.now()) {
      throw new AppError(410, "invitation_unavailable", "This organization invitation is no longer valid");
    }
    if (String(invitation.email).toLowerCase() !== auth.user.email.toLowerCase()) {
      throw new AppError(403, "invitation_recipient_mismatch", "This invitation was sent to a different email address");
    }
    const [existing] = await tx`select id, role from organization_memberships where organization_id = ${invitation.organizationId} and user_id = ${auth.user.id}`;
    if (existing) {
      await tx`update organization_invitations set accepted_at = now(), accepted_by = ${auth.user.id} where id = ${invitation.id}`;
      return { organizationId: String(invitation.organizationId), role: String(existing.role) };
    }
    await tx`
      insert into organization_memberships (id, organization_id, user_id, role, invited_by)
      values (${crypto.randomUUID()}, ${invitation.organizationId}, ${auth.user.id}, ${invitation.role}, ${invitation.invitedBy})`;
    await tx`update organization_invitations set accepted_at = now(), accepted_by = ${auth.user.id} where id = ${invitation.id}`;
    await writeAudit(tx, c.get("deps").config, audit(c, "organization.member.accept", { organizationId: String(invitation.organizationId), resourceType: "OrganizationInvitation", resourceId: String(invitation.id), metadata: { role: invitation.role } }));
    return { organizationId: String(invitation.organizationId), role: String(invitation.role) };
  });
  return c.json({ ok: true, ...result });
});

organizationsRoutes.post("/organizations/:id/members/:memberId/remove", async (c) => {
  const auth = requireOrganizationActor(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const memberId = uuidSchema.parse(c.req.param("memberId"));
  await withOrganizationActor(c, async (tx) => {
    const role = await requireRole(tx, id, ADMIN_ROLES);
    const [member] = await tx`select id, user_id, role from organization_memberships where id = ${memberId} and organization_id = ${id} and status = 'active' for update`;
    if (!member) throw new NotFoundError("Member not found");
    if (member.userId === auth.user.id) throw new ValidationError("You cannot remove your own organization membership");
    if (member.role === "organization_owner") {
      if (role !== "organization_owner") throw new ForbiddenError("Only an owner can remove another owner");
      const [owners] = await tx`select count(*)::int as n from organization_memberships where organization_id = ${id} and role = 'organization_owner' and status = 'active'`;
      if (Number(owners?.n ?? 0) <= 1) throw new ValidationError("The organization must keep at least one owner");
    }
    await tx`update organization_memberships set status = 'removed', updated_at = now() where id = ${memberId}`;
    await writeAudit(tx, c.get("deps").config, audit(c, "organization.member.remove", { organizationId: id, resourceType: "OrganizationMembership", resourceId: memberId }));
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- consolidated reports

const METRICS: ReadonlyArray<{ key: string; label: string; definition: string; money?: boolean }> = [
  { key: "registrations", label: "New patient registrations", definition: "Patients newly linked to the site." },
  { key: "encounters-opened", label: "Encounters opened", definition: "Encounters opened, attributed to the department recorded on the encounter where present." },
  { key: "encounters-completed", label: "Encounters completed", definition: "Encounters closed as completed." },
  { key: "admissions", label: "Admissions", definition: "Admissions, excluding cancelled ones." },
  { key: "inpatient-deaths", label: "Inpatient deaths", definition: "Admissions closed as deceased." },
  { key: "deliveries", label: "Deliveries", definition: "Maternity episodes with a recorded delivery." },
  { key: "laboratory-orders", label: "Laboratory orders", definition: "Laboratory orders placed, excluding cancelled ones." },
  { key: "imaging-orders", label: "Imaging orders", definition: "Imaging orders placed, excluding cancelled ones." },
  { key: "amount-billed", label: "Amount billed", definition: "Sum of invoice lines on non-void invoices.", money: true },
  { key: "amount-received", label: "Amount received", definition: "Payments received and not reversed.", money: true },
  { key: "stock-movements", label: "Stock movements", definition: "Inventory movements posted, attributed to the department that owns the location." },
  { key: "low-stock-lines", label: "Lines below minimum (now)", definition: "Location/item policies whose available stock is below the minimum; current, not period-bound." },
  { key: "lots-expiring-90-days", label: "Lots expiring within 90 days (now)", definition: "Available lots with stock that expire within 90 days; current, not period-bound." },
];

organizationsRoutes.get("/organizations/:id/reports/summary", async (c) => {
  const auth = requireOrganizationActor(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const query = parseQuery(c, organizationReportQuerySchema);
  const days = (Date.parse(query.to) - Date.parse(query.from)) / 86_400_000;
  if (days < 0) throw new ValidationError("The start date must be on or before the end date");
  if (days >= 366) throw new ValidationError("Reports cover at most 366 days");
  await enforceRateLimit(c, "reports.run", auth.user.id);
  const requestedSites = (query.sites ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  for (const site of requestedSites) uuidSchema.parse(site);
  const data = await withOrganizationActor(c, async (tx) => {
    const role = await requireRole(tx, id, ["organization_owner", "organization_admin", "organization_reporting"]);
    const [range] = await tx`
      select ((${query.from}::date)::timestamp at time zone ${query.timeZone}) as start_at,
             ((${query.to}::date + 1)::timestamp at time zone ${query.timeZone}) as end_at`;
    const [organization] = await tx`select name from organizations where id = ${id}`;
    const sites = await tx`select tenant_id, name, host_tenant_id, status, visible_from, history_visibility from app.organization_sites(${id}) where status = 'active'`;
    const metrics = await tx`select tenant_id, department_id, department_name, metric, value from app.organization_site_metrics(${id}, ${range!.startAt}, ${range!.endAt})`;
    await writeAudit(tx, c.get("deps").config, audit(c, query.format === "csv" ? "organization.report.export" : "organization.report.view", {
      organizationId: id, resourceType: "Report", resourceId: null,
      metadata: { from: query.from, to: query.to, sites: requestedSites.length || "all", role },
    }));
    return { organization, sites, metrics };
  });
  const departmentNames = new Map(data.metrics.filter((row) => row.departmentId).map((row) => [String(row.departmentId), String(row.departmentName ?? "Department")]));
  const chosen = data.sites.filter((site) => !requestedSites.length || requestedSites.includes(String(site.tenantId)));
  const perSite = chosen.map((site) => {
    const values: Record<string, number> = Object.fromEntries(METRICS.map((metric) => [metric.key, 0]));
    const byDepartment = new Map<string, Record<string, number>>();
    for (const row of data.metrics) {
      if (String(row.tenantId) !== String(site.tenantId)) continue;
      const value = Number(row.value);
      values[String(row.metric)] = (values[String(row.metric)] ?? 0) + value;
      if (row.departmentId) {
        const key = String(row.departmentId);
        const entry = byDepartment.get(key) ?? {};
        entry[String(row.metric)] = (entry[String(row.metric)] ?? 0) + value;
        byDepartment.set(key, entry);
      }
    }
    return {
      tenantId: String(site.tenantId), name: String(site.name), hostTenantId: (site.hostTenantId as string | null) ?? null,
      visibleFrom: site.visibleFrom, historyVisibility: site.historyVisibility, values,
      departments: [...byDepartment.entries()].map(([departmentId, entry]) => ({ departmentId, name: departmentNames.get(departmentId) ?? "Department", values: entry })),
    };
  });
  const totals: Record<string, number> = Object.fromEntries(METRICS.map((metric) => [metric.key, perSite.reduce((sum, site) => sum + (site.values[metric.key] ?? 0), 0)]));
  // Department and service-unit workspaces hosted inside a facility roll up into that facility.
  const rollUps = perSite.filter((site) => !site.hostTenantId || !perSite.some((other) => other.tenantId === site.hostTenantId)).map((facility) => {
    const members = perSite.filter((site) => site.tenantId === facility.tenantId || site.hostTenantId === facility.tenantId);
    return {
      tenantId: facility.tenantId, name: facility.name, includes: members.map((site) => site.name),
      values: Object.fromEntries(METRICS.map((metric) => [metric.key, members.reduce((sum, site) => sum + (site.values[metric.key] ?? 0), 0)])),
    };
  });
  const notes = [
    "Aggregate counts and amounts only. Organization access never opens patient-level records.",
    "A site's activity before its visible-from date is excluded unless its administrator shared earlier history.",
    "Each site keeps its own inventory; stock figures are per site and are not merged.",
  ];
  if (query.format === "csv") {
    const lines = [
      [`# Consolidated summary`, String(data.organization?.name ?? ""), `${query.from} to ${query.to} (${query.timeZone})`, `generated ${new Date().toISOString()} by ${auth.user.displayName}`].map(csvCell).join(","),
      ["Site", "Visible from", ...METRICS.map((metric) => metric.label)].map(csvCell).join(","),
      ...perSite.map((site) => [site.name, site.visibleFrom ? new Date(site.visibleFrom as string).toISOString().slice(0, 10) : "full history", ...METRICS.map((metric) => site.values[metric.key])].map(csvCell).join(",")),
      ["All selected sites", "", ...METRICS.map((metric) => totals[metric.key])].map(csvCell).join(","),
    ];
    return new Response(`${lines.join("\r\n")}\r\n`, {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="organization-summary-${query.from}-${query.to}.csv"`, "cache-control": "no-store, private" },
    });
  }
  return c.json({
    metadata: { organization: data.organization?.name, from: query.from, to: query.to, timeZone: query.timeZone, generatedAt: new Date().toISOString() },
    metrics: METRICS, sites: perSite, totals, rollUps, notes,
  });
});
