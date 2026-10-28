import { Hono } from "hono";
import {
  careTeamAssignmentSchema,
  contentCreateSchema,
  contentDecisionSchema,
  contentFeedIngestSchema,
  contentPreferencesSchema,
  contentReportSchema,
  contentSourceSchema,
  contentUpdateSchema,
  importedWithdrawSchema,
  opportunityCreateSchema,
  opportunityDecisionSchema,
  opportunityUpdateSchema,
  roleGrantDecisionSchema,
  roleGrantRequestSchema,
  uuidSchema,
} from "@medveris/contracts";
import { permissionsForRoles, type Permission } from "@medveris/authz";
import { isPlatformOperator, requireAuth, requireStaff, withActor, withPlatformActor } from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { ensureMatch, parseJson } from "../lib/http.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

export const contentRoutes = new Hono<AppEnv>();

type Tx = Parameters<Parameters<typeof withActor>[1]>[0];

function requirePermission(c: Parameters<typeof requireStaff>[0], permission: Permission): void {
  const actor = requestActor(c);
  if (!permissionsForRoles(actor.roles).has(permission)) {
    throw new ForbiddenError(`Permission ${permission} is required for this operation`);
  }
}

function limitFrom(c: Parameters<typeof requireAuth>[0]): number {
  const raw = Number.parseInt(c.req.query("limit") ?? "20", 10);
  return Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 50) : 20;
}

function offsetFrom(c: Parameters<typeof requireAuth>[0]): number {
  const raw = Number.parseInt(c.req.query("offset") ?? "0", 10);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 5000) : 0;
}

async function actorContext(tx: Tx, auth: NonNullable<ReturnType<typeof requireAuth>["user"]> | any) {
  const tenantId: string | null = auth.activeTenant?.id ?? null;
  const roles: string[] = auth.activeTenant?.roles ?? (auth.patientId ? ["patient"] : []);
  if (!tenantId) return { tenantId, departments: [] as string[], tags: roles.map((role) => role.toLowerCase()) };
  const staff = await tx`select id from staff_persons where user_id = ${auth.user.id} limit 1`;
  const staffPersonId = staff[0]?.id as string | undefined;
  if (!staffPersonId) return { tenantId, departments: [] as string[], tags: roles.map((role) => role.toLowerCase()) };
  const departments = await tx`
    select distinct a.department_id
      from department_assignments a join engagements e on e.id = a.engagement_id
     where e.staff_person_id = ${staffPersonId} and a.starts_on <= current_date
       and (a.ends_on is null or a.ends_on >= current_date)
  `;
  const cadres = await tx`
    select c.code, c.name
      from engagements e
      left join job_titles j on j.id = e.job_title_id
      left join cadres c on c.id = j.cadre_id
     where e.staff_person_id = ${staffPersonId} and e.status = 'active'
       and e.start_date <= current_date and (e.end_date is null or e.end_date >= current_date)
  `;
  const tags = [
    ...roles,
    ...cadres.flatMap((row) => [row.code, row.name].filter(Boolean) as string[]),
  ].map((value) => String(value).toLowerCase());
  return { tenantId, departments: departments.map((row) => String(row.departmentId)), tags };
}

async function feedRows(
  c: Parameters<typeof requireAuth>[0],
  tx: Tx,
  options: { limit: number; offset: number; contentType?: string | null; search?: string | null },
) {
  const auth = requireAuth(c);
  const patientAudience = !auth.activeTenant;
  const scope = await actorContext(tx, auth);
  const tenantAccess = patientAudience
    ? tx`(ci.tenant_id is null or ci.tenant_id in (select l.tenant_id from tenant_patient_links l where l.patient_id = ${auth.patientId ?? "00000000-0000-0000-0000-000000000000"}))`
    : tx`(ci.tenant_id is null or ci.tenant_id = ${scope.tenantId})`;
  const departmentFilter = scope.departments.length ? scope.departments : ["__none__"];
  const tagFilter = scope.tags.length ? scope.tags : ["__none__"];
  const rows = await tx`
    select ci.id, ci.content_type, ci.slug, ci.title, ci.summary, ci.source_organization, ci.source_url,
           ci.publication_date, ci.language, ci.geography, ci.audience, ci.specialty_tags, ci.visibility_scope,
           ci.attribution, ci.sponsorship_disclosure, ci.study_type, ci.peer_review_status, ci.correction_status,
           ci.correction_note, ci.clinical_reviewed, ci.status, ci.version, ci.published_at, ci.review_due_on,
           ci.imported_at, cs.name as source_name
      from content_items ci left join content_sources cs on cs.id = ci.source_id
     where ci.status = 'published'
       and ${tenantAccess}
       and (ci.visibility_scope <> 'specialty' or ci.specialty_tags && ${tagFilter}::text[])
       and (ci.visibility_scope <> 'department' or ci.visibility_values && ${departmentFilter}::text[])
       ${patientAudience
         ? tx`and ci.visibility_scope in ('public','authenticated','patient') and ci.audience in ('general','patient')`
         : tx`and ci.visibility_scope <> 'patient' and ci.audience <> 'patient'`}
       ${options.contentType ? tx`and ci.content_type = ${options.contentType}` : tx``}
       ${options.search ? tx`and (ci.title ilike ${`%${options.search}%`} or ci.summary ilike ${`%${options.search}%`})` : tx``}
     order by ci.editorial_priority desc, ci.publication_date desc nulls last, ci.published_at desc
     limit ${options.limit} offset ${options.offset}
  `;
  const count = await tx`
    select count(*)::int as total
      from content_items ci
     where ci.status = 'published'
       and ${tenantAccess}
       and (ci.visibility_scope <> 'specialty' or ci.specialty_tags && ${tagFilter}::text[])
       and (ci.visibility_scope <> 'department' or ci.visibility_values && ${departmentFilter}::text[])
       ${patientAudience
         ? tx`and ci.visibility_scope in ('public','authenticated','patient') and ci.audience in ('general','patient')`
         : tx`and ci.visibility_scope <> 'patient' and ci.audience <> 'patient'`}
       ${options.contentType ? tx`and ci.content_type = ${options.contentType}` : tx``}
       ${options.search ? tx`and (ci.title ilike ${`%${options.search}%`} or ci.summary ilike ${`%${options.search}%`})` : tx``}
  `;
  return { rows, total: Number(count[0]?.total ?? 0), patientAudience };
}

async function opportunityRows(
  c: Parameters<typeof requireAuth>[0],
  tx: Tx,
  options: { limit: number; offset: number; type?: string | null; importedOnly?: boolean },
) {
  const auth = requireAuth(c);
  const patientAudience = !auth.activeTenant;
  const scope = await actorContext(tx, auth);
  const tagFilter = scope.tags.length ? scope.tags : ["__none__"];
  const rows = await tx`
    select o.id, o.opportunity_type, o.title, o.description, o.organization, o.audience, o.specialty_tags,
           o.eligibility, o.location, o.remote, o.application_url, o.contact_route, o.opens_on, o.closes_on,
           o.compensation, o.cpd_details, o.verification_status, o.verified_checks, o.sponsorship_status,
           o.moderation_state, o.version, o.published_at, o.imported_at, cs.name as source_name
      from opportunities o left join content_sources cs on cs.id = o.source_id
     where o.moderation_state = 'published'
       and (o.closes_on is null or o.closes_on >= current_date)
       and (o.tenant_id is null or o.tenant_id = ${scope.tenantId})
       and (cardinality(o.specialty_tags) = 0 or o.specialty_tags && ${tagFilter}::text[])
       ${patientAudience ? tx`and o.audience in ('patient','both')` : tx`and o.audience in ('professional','both')`}
       ${options.type ? tx`and o.opportunity_type = ${options.type}` : tx``}
       ${options.importedOnly ? tx`and o.imported_at is not null` : tx``}
     order by o.published_at desc
     limit ${options.limit} offset ${options.offset}
  `;
  const count = await tx`
    select count(*)::int as total from opportunities o
     where o.moderation_state = 'published'
       and (o.closes_on is null or o.closes_on >= current_date)
       and (o.tenant_id is null or o.tenant_id = ${scope.tenantId})
       and (cardinality(o.specialty_tags) = 0 or o.specialty_tags && ${tagFilter}::text[])
       ${patientAudience ? tx`and o.audience in ('patient','both')` : tx`and o.audience in ('professional','both')`}
       ${options.type ? tx`and o.opportunity_type = ${options.type}` : tx``}
       ${options.importedOnly ? tx`and o.imported_at is not null` : tx``}
  `;
  return { rows, total: Number(count[0]?.total ?? 0) };
}

contentRoutes.get("/access/summary", async (c) => {
  const auth = requireAuth(c);
  const roles = auth.activeTenant?.roles ?? (auth.patientId ? ["patient"] : []);
  const data = await withActor(c, async (tx) => {
    const departments = auth.activeTenant
      ? await tx`
          select distinct a.department_id, d.name
            from department_assignments a join departments d on d.id = a.department_id
            join engagements e on e.id = a.engagement_id join staff_persons s on s.id = e.staff_person_id
           where s.user_id = ${auth.user.id} and a.starts_on <= current_date
             and (a.ends_on is null or a.ends_on >= current_date)
        `
      : [];
    const careTeam = auth.activeTenant
      ? await tx`
          select count(*)::int as total from care_team_members
           where tenant_id = ${auth.activeTenant.id} and status = 'active'
             and (user_id = ${auth.user.id} or staff_person_id in (select id from staff_persons where user_id = ${auth.user.id}))
             and starts_at <= now() and (ends_at is null or ends_at > now())
        `
      : [{ total: 0 }];
    const grants = auth.activeTenant
      ? await tx`
          select id, role, department_id, status, starts_at, expires_at
            from role_grants where tenant_id = ${auth.activeTenant.id} and user_id = ${auth.user.id}
           order by created_at desc limit 20
        `
      : [];
    return {
      roles,
      permissions: [...permissionsForRoles(roles)],
      departments,
      activeCareRelationships: Number(careTeam[0]?.total ?? 0),
      roleGrants: grants,
      tenantId: auth.activeTenant?.id ?? null,
      patientContext: Boolean(auth.patientId),
    };
  });
  return c.json(data);
});

contentRoutes.get("/dashboards/patient", async (c) => {
  const auth = requireAuth(c);
  if (!auth.patientId) throw new ForbiddenError("A patient workspace requires a verified patient account");
  requirePermission(c, "dashboard.patient.read");
  const data = await withActor(c, async (tx) => {
    const feed = await feedRows(c, tx, { limit: 8, offset: 0 });
    const appointments = await tx`
      select a.id, a.start_at, a.duration_minutes, a.reason, a.status, t.name as facility_name
        from appointments a join tenants t on t.id = a.tenant_id
       where a.patient_id = ${auth.patientId} and a.start_at >= now()
       order by a.start_at limit 5
    `;
    const released = await tx`
      select count(*)::int as total from tenant_patient_links l
       where l.patient_id = ${auth.patientId} and l.release_signed_records = true
    `;
    const followUps = await tx`
      select id, due_date, instructions, status from follow_ups
       where patient_id = ${auth.patientId} and status = 'pending' order by due_date limit 5
    `;
    const consents = await tx`select count(*)::int as total from exchange_grants where patient_id = ${auth.patientId} and revoked_at is null`;
    return {
      content: feed.rows,
      contentTotal: feed.total,
      appointments,
      followUps,
      releases: { facilities: Number(released[0]?.total ?? 0) },
      activeConsents: Number(consents[0]?.total ?? 0),
    };
  });
  return c.json(data);
});

contentRoutes.get("/dashboards/clinician", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  requirePermission(c, "dashboard.clinician.read");
  const data = await withActor(c, async (tx) => {
    const feed = await feedRows(c, tx, { limit: 8, offset: 0 });
    const opportunities = await opportunityRows(c, tx, { limit: 4, offset: 0 });
    const appointments = await tx`
      select a.id, a.start_at, a.duration_minutes, a.reason, a.status, p.public_id, p.given_name, p.family_name
        from appointments a join patients p on p.id = a.patient_id
       where a.tenant_id = ${auth.activeTenant!.id} and a.clinician_user_id = ${auth.user.id}
         and a.start_at >= now() - interval '2 hours' and a.start_at < now() + interval '1 day'
       order by a.start_at limit 20
    `;
    const worklist = await tx`
      select e.id, e.state, e.type, e.opened_at, p.public_id, p.given_name, p.family_name
        from encounters e join patients p on p.id = e.patient_id
       where e.tenant_id = ${auth.activeTenant!.id} and e.state in ('arrived','triaged','in-progress')
       order by e.opened_at limit 20
    `;
    const results = await tx`
      select count(*)::int as total from lab_results r
       where r.tenant_id = ${auth.activeTenant!.id} and r.status = 'final'
         and r.verified_at >= now() - interval '7 days'
    `;
    const followUps = await tx`
      select count(*)::int as total from follow_ups
       where tenant_id = ${auth.activeTenant!.id} and status = 'pending' and due_date <= current_date + 7
    `;
    const referrals = await tx`
      select count(*)::int as total from referrals
       where tenant_id = ${auth.activeTenant!.id} and status = 'pending'
    `;
    return {
      content: feed.rows,
      contentTotal: feed.total,
      opportunities: opportunities.rows,
      appointments,
      worklist,
      counts: {
        resultsAwaitingReview: Number(results[0]?.total ?? 0),
        pendingFollowUps: Number(followUps[0]?.total ?? 0),
        outstandingReferrals: Number(referrals[0]?.total ?? 0),
      },
    };
  });
  return c.json(data);
});

contentRoutes.get("/dashboards/specialist", async (c) => {
  requireStaff(c);
  requirePermission(c, "dashboard.specialist.read");
  const auth = c.get("auth")!;
  const data = await withActor(c, async (tx) => {
    const feed = await feedRows(c, tx, { limit: 8, offset: 0 });
    const opportunities = await opportunityRows(c, tx, { limit: 4, offset: 0 });
    const worklist = await tx`
      select i.id, i.name, i.status, i.created_at, o.priority, o.order_type,
             p.public_id, p.given_name, p.family_name
        from service_order_items i join service_orders o on o.id = i.order_id
        join patients p on p.id = o.patient_id
       where i.tenant_id = ${auth.activeTenant!.id} and i.status in ('collected','in-progress')
       order by case o.priority when 'emergency' then 0 when 'urgent' then 1 else 2 end, i.created_at
       limit 20
    `;
    const referrals = await tx`
      select r.id, r.reason, r.priority, r.status, r.to_facility, r.created_at, p.public_id, p.given_name, p.family_name
        from referrals r join patients p on p.id = r.patient_id
       where r.tenant_id = ${auth.activeTenant!.id} and r.status = 'pending'
       order by r.created_at limit 20
    `;
    return {
      content: feed.rows,
      contentTotal: feed.total,
      opportunities: opportunities.rows,
      diagnosticWorklist: worklist,
      specialtyReferrals: referrals,
      specialties: requestActor(c).roles,
    };
  });
  return c.json(data);
});

contentRoutes.get("/content", async (c) => {
  requireAuth(c);
  requirePermission(c, "content.read");
  const contentType = c.req.query("type") ?? null;
  const search = c.req.query("q")?.trim() || null;
  const data = await withActor(c, async (tx) => feedRows(c, tx, {
    limit: limitFrom(c), offset: offsetFrom(c), contentType, search,
  }));
  return c.json({ items: data.rows, total: data.total, page: { limit: limitFrom(c), offset: offsetFrom(c) } });
});

contentRoutes.get("/content/:id", async (c) => {
  requireAuth(c);
  requirePermission(c, "content.read");
  const id = uuidSchema.parse(c.req.param("id"));
  const auth = c.get("auth")!;
  const data = await withActor(c, async (tx) => {
    const rows = await tx`
      select ci.*, cs.name as source_name
        from content_items ci left join content_sources cs on cs.id = ci.source_id
       where ci.id = ${id} and ci.status = 'published'
         and ${auth.activeTenant
           ? tx`(ci.tenant_id is null or ci.tenant_id = ${auth.activeTenant.id})`
           : tx`(ci.tenant_id is null or ci.tenant_id in (select l.tenant_id from tenant_patient_links l where l.patient_id = ${auth.patientId ?? "00000000-0000-0000-0000-000000000000"}))`}
    `;
    const item = await requireRows(rows, "Content is not available");
    const bookmark = await tx`select id from content_bookmarks where user_id = ${c.get("auth")!.user.id} and content_item_id = ${id}`;
    return { item, bookmarked: Boolean(bookmark[0]) };
  });
  return c.json(data);
});

contentRoutes.post("/content/:id/bookmark", async (c) => {
  const auth = requireAuth(c);
  const id = uuidSchema.parse(c.req.param("id"));
  await withActor(c, async (tx) => {
    const exists = await tx`
      select id from content_items where id = ${id} and status = 'published'
        and ${auth.activeTenant
          ? tx`(tenant_id is null or tenant_id = ${auth.activeTenant.id})`
          : tx`(tenant_id is null or tenant_id in (select l.tenant_id from tenant_patient_links l where l.patient_id = ${auth.patientId ?? "00000000-0000-0000-0000-000000000000"}))`}
    `;
    if (!exists[0]) throw new NotFoundError("Published content not found");
    await tx`
      insert into content_bookmarks (id, user_id, content_item_id)
      values (${crypto.randomUUID()}, ${auth.user.id}, ${id})
      on conflict do nothing
    `;
  });
  return c.json({ ok: true });
});

contentRoutes.delete("/content/:id/bookmark", async (c) => {
  const auth = requireAuth(c);
  const id = uuidSchema.parse(c.req.param("id"));
  await withActor(c, async (tx) => {
    await tx`delete from content_bookmarks where user_id = ${auth.user.id} and content_item_id = ${id}`;
  });
  return c.json({ ok: true });
});

contentRoutes.get("/content/bookmarks/mine", async (c) => {
  const auth = requireAuth(c);
  const rows = await withActor(c, async (tx) => tx`
    select ci.id, ci.title, ci.summary, ci.content_type, ci.publication_date, ci.source_organization
      from content_bookmarks b join content_items ci on ci.id = b.content_item_id
     where b.user_id = ${auth.user.id} and ci.status = 'published'
     order by b.created_at desc limit 100
  `);
  return c.json({ items: rows });
});

contentRoutes.get("/content/preferences/mine", async (c) => {
  const auth = requireAuth(c);
  const rows = await withActor(c, async (tx) => tx`select * from content_preferences where user_id = ${auth.user.id}`);
  return c.json({
    preferences: rows[0] ?? {
      language: "en", geography: null, specialtyTags: [], interests: [],
      hidePatientOpportunities: false, hideProfessionalOpportunities: false,
    },
  });
});

contentRoutes.put("/content/preferences/mine", async (c) => {
  const auth = requireAuth(c);
  const body = await parseJson(c, contentPreferencesSchema);
  await withActor(c, async (tx) => {
    await tx`
      insert into content_preferences (user_id, language, geography, specialty_tags, interests,
        hide_patient_opportunities, hide_professional_opportunities)
      values (${auth.user.id}, ${body.language}, ${body.geography || null}, ${body.specialtyTags}, ${body.interests},
        ${body.hidePatientOpportunities}, ${body.hideProfessionalOpportunities})
      on conflict (user_id) do update set language = excluded.language, geography = excluded.geography,
        specialty_tags = excluded.specialty_tags, interests = excluded.interests,
        hide_patient_opportunities = excluded.hide_patient_opportunities,
        hide_professional_opportunities = excluded.hide_professional_opportunities, updated_at = now()
    `;
  });
  return c.json({ ok: true });
});

contentRoutes.post("/content/:id/report", async (c) => {
  const auth = requireAuth(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, contentReportSchema);
  await withActor(c, async (tx) => {
    const exists = await tx`
      select id, tenant_id from content_items where id = ${id} and status = 'published'
        and ${auth.activeTenant
          ? tx`(tenant_id is null or tenant_id = ${auth.activeTenant.id})`
          : tx`(tenant_id is null or tenant_id in (select l.tenant_id from tenant_patient_links l where l.patient_id = ${auth.patientId ?? "00000000-0000-0000-0000-000000000000"}))`}
    `;
    if (!exists[0]) throw new NotFoundError("Content not found");
    await tx`
      insert into content_reports (id, tenant_id, reporter_user_id, content_item_id, reason, detail)
      values (${crypto.randomUUID()}, ${(exists[0].tenantId as string | null) ?? auth.activeTenant?.id ?? null},
        ${auth.user.id}, ${id}, ${body.reason}, ${body.detail || null})
    `;
  });
  return c.json({ ok: true }, 201);
});

contentRoutes.get("/opportunities", async (c) => {
  requireAuth(c);
  const type = c.req.query("type") ?? null;
  const importedOnly = c.req.query("imported") === "true";
  const data = await withActor(c, async (tx) => opportunityRows(c, tx, { limit: limitFrom(c), offset: offsetFrom(c), type, importedOnly }));
  return c.json({ opportunities: data.rows, total: data.total });
});

contentRoutes.post("/opportunities/:id/bookmark", async (c) => {
  const auth = requireAuth(c);
  const id = uuidSchema.parse(c.req.param("id"));
  await withActor(c, async (tx) => {
    const exists = await tx`select id from opportunities where id = ${id} and moderation_state = 'published'`;
    if (!exists[0]) throw new NotFoundError("Published opportunity not found");
    await tx`
      insert into content_bookmarks (id, user_id, opportunity_id)
      values (${crypto.randomUUID()}, ${auth.user.id}, ${id}) on conflict do nothing
    `;
  });
  return c.json({ ok: true });
});

contentRoutes.post("/opportunities/:id/report", async (c) => {
  const auth = requireAuth(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, contentReportSchema);
  await withActor(c, async (tx) => {
    const exists = await tx`select id, tenant_id from opportunities where id = ${id}`;
    if (!exists[0]) throw new NotFoundError("Opportunity not found");
    await tx`
      insert into content_reports (id, tenant_id, reporter_user_id, opportunity_id, reason, detail)
      values (${crypto.randomUUID()}, ${(exists[0].tenantId as string | null) ?? auth.activeTenant?.id ?? null},
        ${auth.user.id}, ${id}, ${body.reason}, ${body.detail || null})
    `;
    await tx`update opportunities set report_count = report_count + 1 where id = ${id}`;
  });
  return c.json({ ok: true }, 201);
});

// Editorial workspace ---------------------------------------------------------
contentRoutes.get("/content/editorial/items", async (c) => {
  requireStaff(c);
  requirePermission(c, "content.review");
  const auth = c.get("auth")!;
  const rows = await withActor(c, async (tx) => tx`
    select ci.id, ci.content_type, ci.slug, ci.title, ci.status, ci.version, ci.visibility_scope,
           ci.publication_date, ci.review_due_on, ci.updated_at, u.display_name as author_name
      from content_items ci join users u on u.id = ci.author_user_id
     where ci.tenant_id = ${auth.activeTenant!.id}
     order by ci.updated_at desc limit 200
  `);
  return c.json({ items: rows });
});

contentRoutes.post("/content/editorial/items", async (c) => {
  requireStaff(c);
  requirePermission(c, "content.draft");
  const auth = c.get("auth")!;
  const body = await parseJson(c, contentCreateSchema);
  const id = crypto.randomUUID();
  await withActor(c, async (tx) => {
    if (body.sourceId) {
      const source = await tx`
        select id from content_sources where id = ${body.sourceId}
          and (tenant_id = ${auth.activeTenant!.id} or tenant_id is null)
      `;
      if (!source[0]) throw new ValidationError("The selected content source is not available");
    }
    await tx`
      insert into content_items (id, tenant_id, content_type, slug, title, summary, body, source_id,
        source_organization, source_url, publication_date, language, geography, audience, specialty_tags,
        visibility_scope, visibility_values, attribution, reuse_terms, sponsorship_disclosure, study_type,
        population, findings_summary, limitations, peer_review_status, editorial_priority, review_due_on,
        status, version, author_user_id)
      values (${id}, ${auth.activeTenant!.id}, ${body.contentType}, ${body.slug}, ${body.title}, ${body.summary},
        ${body.body || null}, ${body.sourceId ?? null}, ${body.sourceOrganization || null}, ${body.sourceUrl ?? null},
        ${body.publicationDate ?? null}, ${body.language}, ${body.geography || null}, ${body.audience},
        ${body.specialtyTags}, ${body.visibilityScope}, ${body.visibilityValues}, ${body.attribution || null},
        ${body.reuseTerms || null}, ${body.sponsorshipDisclosure || null}, ${body.studyType || null},
        ${body.population || null}, ${body.findingsSummary || null}, ${body.limitations || null},
        ${body.peerReviewStatus ?? null}, ${body.editorialPriority}, ${body.reviewDueOn ?? null},
        'draft', 1, ${auth.user.id})
    `;
    await tx`
      insert into content_item_versions (id, content_item_id, tenant_id, version, snapshot, change_note, author_user_id)
      values (${crypto.randomUUID()}, ${id}, ${auth.activeTenant!.id}, 1, ${tx.json(body as never)}, 'Initial draft', ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "content.draft.create", {
      resourceType: "ContentItem", resourceId: id, metadata: { contentType: body.contentType, visibilityScope: body.visibilityScope },
    }));
  });
  return c.json({ ok: true, item: { id } }, 201);
});

contentRoutes.patch("/content/editorial/items/:id", async (c) => {
  requireStaff(c);
  requirePermission(c, "content.draft");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, contentUpdateSchema);
  await withActor(c, async (tx) => {
    const item = await requireRows(await tx`
      select id, status, version, author_user_id from content_items
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Content item not found");
    if (!["draft", "in-review"].includes(String(item.status))) throw new ConflictError("Only draft or in-review content can be edited");
    if (String(item.authorUserId) !== auth.user.id && !requestActor(c).roles.some((role) => ["facility_admin", "content_reviewer"].includes(role))) {
      throw new ForbiddenError("Only the author or a reviewer may edit this draft");
    }
    ensureMatch(body.expectedVersion, Number(item.version));
    const next = Number(item.version) + 1;
    await tx`
      update content_items set title = ${body.title ?? tx`title`}, summary = ${body.summary ?? tx`summary`},
        body = ${body.body === undefined ? tx`body` : (body.body || null)},
        source_url = ${body.sourceUrl === undefined ? tx`source_url` : body.sourceUrl},
        audience = ${body.audience ?? tx`audience`}, specialty_tags = ${body.specialtyTags ?? tx`specialty_tags`},
        visibility_scope = ${body.visibilityScope ?? tx`visibility_scope`},
        visibility_values = ${body.visibilityValues ?? tx`visibility_values`},
        editorial_priority = ${body.editorialPriority ?? tx`editorial_priority`},
        review_due_on = ${body.reviewDueOn === undefined ? tx`review_due_on` : body.reviewDueOn},
        version = ${next}, updated_at = now()
       where id = ${id}
    `;
    await tx`
      insert into content_item_versions (id, content_item_id, tenant_id, version, snapshot, change_note, author_user_id)
      values (${crypto.randomUUID()}, ${id}, ${auth.activeTenant!.id}, ${next},
        ${tx.json({ ...body, expectedVersion: undefined } as never)}, ${body.changeNote}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "content.draft.update", {
      resourceType: "ContentItem", resourceId: id, metadata: { version: next, changeNote: body.changeNote },
    }));
  });
  return c.json({ ok: true });
});

contentRoutes.post("/content/editorial/items/:id/review", async (c) => {
  requireStaff(c);
  requirePermission(c, "content.review");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, contentDecisionSchema);
  await withActor(c, async (tx) => {
    const item = await requireRows(await tx`
      select id, status, version, author_user_id from content_items
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Content item not found");
    ensureMatch(body.expectedVersion, Number(item.version));
    if (String(item.authorUserId) === auth.user.id) throw new ForbiddenError("Independent review is required; authors cannot review their own content");
    if (!["draft", "in-review"].includes(String(item.status))) throw new ConflictError("Only draft or in-review content can be reviewed");
    await tx`
      update content_items set status = 'in-review', reviewer_user_id = ${auth.user.id}, reviewed_at = now(),
        review_due_on = ${body.reviewDueOn ?? tx`review_due_on`}, updated_at = now() where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "content.review", {
      resourceType: "ContentItem", resourceId: id, metadata: { note: body.note },
    }));
  });
  return c.json({ ok: true });
});

contentRoutes.post("/content/editorial/items/:id/publish", async (c) => {
  requireStaff(c);
  requirePermission(c, "content.publish");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, contentDecisionSchema);
  await withActor(c, async (tx) => {
    const item = await requireRows(await tx`
      select id, status, version, author_user_id from content_items
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Content item not found");
    ensureMatch(body.expectedVersion, Number(item.version));
    if (String(item.authorUserId) === auth.user.id && !requestActor(c).roles.includes("facility_admin")) {
      throw new ForbiddenError("Separate editorial approval is required before publication");
    }
    if (String(item.status) !== "in-review") throw new ConflictError("Only reviewed content can be published");
    await tx`
      update content_items set status = 'published', reviewer_user_id = ${auth.user.id}, reviewed_at = now(),
        published_at = now(), editorial_priority = editorial_priority, review_due_on = ${body.reviewDueOn ?? tx`review_due_on`},
        updated_at = now() where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "content.publish", {
      resourceType: "ContentItem", resourceId: id, metadata: { note: body.note, reviewDueOn: body.reviewDueOn ?? null },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "content.published", aggregateId: id });
  });
  return c.json({ ok: true });
});

contentRoutes.post("/content/editorial/items/:id/archive", async (c) => {
  requireStaff(c);
  requirePermission(c, "content.archive");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, contentDecisionSchema);
  await withActor(c, async (tx) => {
    const item = await requireRows(await tx`
      select id, status, version from content_items where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Content item not found");
    ensureMatch(body.expectedVersion, Number(item.version));
    await tx`update content_items set status = 'archived', archived_at = now(), updated_at = now() where id = ${id}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "content.archive", {
      resourceType: "ContentItem", resourceId: id, metadata: { note: body.note },
    }));
  });
  return c.json({ ok: true });
});

contentRoutes.get("/content/sources", async (c) => {
  requireStaff(c);
  requirePermission(c, "content.source.manage");
  const auth = c.get("auth")!;
  const rows = await withActor(c, async (tx) => tx`
    select id, name, source_kind, base_url, rss_url, status, last_checked_at, last_error, terms_note
      from content_sources where tenant_id = ${auth.activeTenant!.id} or tenant_id is null
     order by name
  `);
  return c.json({ sources: rows });
});

contentRoutes.post("/content/sources", async (c) => {
  requireStaff(c);
  requirePermission(c, "content.source.manage");
  const auth = c.get("auth")!;
  const body = await parseJson(c, contentSourceSchema);
  const id = crypto.randomUUID();
  await withActor(c, async (tx) => {
    await tx`
      insert into content_sources (id, tenant_id, name, source_kind, base_url, rss_url, terms_note)
      values (${id}, ${body.tenantScoped ? auth.activeTenant!.id : null}, ${body.name}, ${body.sourceKind},
        ${body.baseUrl ?? null}, ${body.rssUrl ?? null}, ${body.termsNote || null})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "content.source.create", {
      resourceType: "ContentSource", resourceId: id, metadata: { name: body.name, kind: body.sourceKind },
    }));
  });
  return c.json({ ok: true, source: { id } }, 201);
});

// Automatically imported public content ---------------------------------------
contentRoutes.get("/content-feeds", async (c) => {
  requireAuth(c);
  const operator = isPlatformOperator(c);
  if (!operator) requirePermission(c, "content.read");
  const rows = await withActor(c, async (tx) => tx`
    select id, name, source_kind, base_url, ingest_adapter, ingest_enabled, status, fetch_interval_minutes,
           last_checked_at, last_success_at, last_item_count, last_error, terms_note
      from content_sources
     where tenant_id is null and ingest_adapter is not null
     order by name
  `);
  return c.json({
    canManage: operator,
    sources: rows.map((row) => (operator ? row : { ...row, lastError: row.lastError ? "The last fetch failed" : null })),
  });
});

contentRoutes.post("/content-feeds/:id/ingest", async (c) => {
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, contentFeedIngestSchema);
  await withPlatformActor(c, async (tx) => {
    await requireRows(await tx`
      update content_sources set ingest_enabled = ${body.enabled}, status = ${body.enabled ? "configured" : "disabled"}, updated_at = now()
       where id = ${id} and tenant_id is null and ingest_adapter is not null
      returning id
    `, "Content source not found");
    await writeAudit(tx, c.get("deps").config, requestAudit(c, body.enabled ? "content.feed.resume" : "content.feed.pause", {
      resourceType: "ContentSource", resourceId: id, metadata: { note: body.note },
    }));
  });
  return c.json({ ok: true });
});

contentRoutes.post("/content-feeds/items/:id/withdraw", async (c) => {
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, importedWithdrawSchema);
  await withPlatformActor(c, async (tx) => {
    const item = await requireRows(await tx`
      select id, status from content_items where id = ${id} and imported_at is not null for update
    `, "Imported content not found");
    if (item.status !== "published") throw new ConflictError("Only published imported content can be withdrawn");
    await tx`update content_items set status = 'withdrawn', archived_at = now(), updated_at = now() where id = ${id}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "content.imported.withdraw", {
      resourceType: "ContentItem", resourceId: id, metadata: { note: body.note },
    }));
  });
  return c.json({ ok: true });
});

contentRoutes.post("/content-feeds/opportunities/:id/withdraw", async (c) => {
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, importedWithdrawSchema);
  await withPlatformActor(c, async (tx) => {
    const item = await requireRows(await tx`
      select id, moderation_state from opportunities where id = ${id} and imported_at is not null for update
    `, "Imported opportunity not found");
    if (item.moderationState !== "published") throw new ConflictError("Only published imported opportunities can be withdrawn");
    await tx`update opportunities set moderation_state = 'withdrawn', updated_at = now() where id = ${id}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "opportunity.imported.withdraw", {
      resourceType: "Opportunity", resourceId: id, metadata: { note: body.note },
    }));
  });
  return c.json({ ok: true });
});

// Opportunity moderation ------------------------------------------------------
contentRoutes.get("/opportunities/moderation", async (c) => {
  requireStaff(c);
  requirePermission(c, "content.opportunity.moderate");
  const auth = c.get("auth")!;
  const rows = await withActor(c, async (tx) => tx`
    select o.id, o.opportunity_type, o.title, o.organization, o.audience, o.moderation_state, o.version,
           o.verification_status, o.closes_on, o.report_count, o.updated_at, u.display_name as author_name
      from opportunities o join users u on u.id = o.author_user_id
     where o.tenant_id = ${auth.activeTenant!.id}
     order by o.updated_at desc limit 200
  `);
  return c.json({ opportunities: rows });
});

contentRoutes.post("/opportunities", async (c) => {
  requireStaff(c);
  requirePermission(c, "content.opportunity.manage");
  const auth = c.get("auth")!;
  const body = await parseJson(c, opportunityCreateSchema);
  if (body.opensOn && body.closesOn && body.closesOn < body.opensOn) throw new ValidationError("The closing date cannot precede the opening date");
  const id = crypto.randomUUID();
  await withActor(c, async (tx) => {
    await tx`
      insert into opportunities (id, tenant_id, opportunity_type, title, description, organization, audience,
        specialty_tags, eligibility, location, remote, application_url, contact_route, opens_on, closes_on,
        compensation, cpd_details, source_evidence, sponsorship_status, moderation_state, author_user_id)
      values (${id}, ${auth.activeTenant!.id}, ${body.opportunityType}, ${body.title}, ${body.description},
        ${body.organization}, ${body.audience}, ${body.specialtyTags}, ${body.eligibility || null},
        ${body.location || null}, ${body.remote}, ${body.applicationUrl ?? null}, ${body.contactRoute || null},
        ${body.opensOn ?? null}, ${body.closesOn ?? null}, ${body.compensation || null}, ${body.cpdDetails || null},
        ${body.sourceEvidence || null}, ${body.sponsorshipStatus}, 'draft', ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "opportunity.create", {
      resourceType: "Opportunity", resourceId: id, metadata: { type: body.opportunityType, audience: body.audience },
    }));
  });
  return c.json({ ok: true, opportunity: { id } }, 201);
});

contentRoutes.patch("/opportunities/:id", async (c) => {
  requireStaff(c);
  requirePermission(c, "content.opportunity.manage");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, opportunityUpdateSchema);
  await withActor(c, async (tx) => {
    const item = await requireRows(await tx`
      select id, moderation_state, version, author_user_id from opportunities
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Opportunity not found");
    if (!["draft", "pending-review"].includes(String(item.moderationState))) throw new ConflictError("Published opportunities must be withdrawn before editing");
    if (body.expectedVersion) ensureMatch(body.expectedVersion, Number(item.version));
    await tx`
      update opportunities set title = ${body.title ?? tx`title`}, description = ${body.description ?? tx`description`},
        organization = ${body.organization ?? tx`organization`}, audience = ${body.audience ?? tx`audience`},
        specialty_tags = ${body.specialtyTags ?? tx`specialty_tags`}, eligibility = ${body.eligibility === undefined ? tx`eligibility` : (body.eligibility || null)},
        location = ${body.location === undefined ? tx`location` : (body.location || null)}, remote = ${body.remote ?? tx`remote`},
        application_url = ${body.applicationUrl === undefined ? tx`application_url` : body.applicationUrl},
        opens_on = ${body.opensOn === undefined ? tx`opens_on` : body.opensOn},
        closes_on = ${body.closesOn === undefined ? tx`closes_on` : body.closesOn},
        compensation = ${body.compensation === undefined ? tx`compensation` : (body.compensation || null)},
        cpd_details = ${body.cpdDetails === undefined ? tx`cpd_details` : (body.cpdDetails || null)},
        source_evidence = ${body.sourceEvidence === undefined ? tx`source_evidence` : (body.sourceEvidence || null)},
        sponsorship_status = ${body.sponsorshipStatus ?? tx`sponsorship_status`},
        version = version + 1, updated_at = now()
       where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "opportunity.update", {
      resourceType: "Opportunity", resourceId: id, metadata: { version: Number(item.version) + 1 },
    }));
  });
  return c.json({ ok: true });
});

contentRoutes.post("/opportunities/:id/submit", async (c) => {
  requireStaff(c);
  requirePermission(c, "content.opportunity.manage");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  await withActor(c, async (tx) => {
    const item = await requireRows(await tx`
      select id, moderation_state from opportunities where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Opportunity not found");
    if (item.moderationState !== "draft") throw new ConflictError("Only a draft opportunity can be submitted");
    await tx`update opportunities set moderation_state = 'pending-review', updated_at = now() where id = ${id}`;
  });
  return c.json({ ok: true });
});

contentRoutes.post("/opportunities/:id/moderate", async (c) => {
  requireStaff(c);
  requirePermission(c, "content.opportunity.moderate");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, opportunityDecisionSchema);
  await withActor(c, async (tx) => {
    const item = await requireRows(await tx`
      select id, moderation_state, version, author_user_id from opportunities
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Opportunity not found");
    if (String(item.authorUserId) === auth.user.id) throw new ForbiddenError("Independent moderation is required");
    if (body.decision === "publish" && item.moderationState !== "pending-review") throw new ConflictError("Only pending-review opportunities can be published");
    const state = body.decision === "publish" ? "published" : body.decision === "reject" ? "rejected" : "archived";
    await tx`
      update opportunities set moderation_state = ${state},
        reviewer_user_id = ${auth.user.id}, reviewed_at = now(),
        published_at = case when ${state === "published"} then now() else published_at end,
        verification_status = ${body.verificationStatus ?? tx`verification_status`},
        verified_checks = ${body.verifiedChecks === undefined ? tx`verified_checks` : (body.verifiedChecks || null)},
        version = version + 1, updated_at = now()
       where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, `opportunity.${body.decision}`, {
      resourceType: "Opportunity", resourceId: id, metadata: { note: body.note, verificationStatus: body.verificationStatus ?? null },
    }));
  });
  return c.json({ ok: true });
});

// Access governance -----------------------------------------------------------
contentRoutes.get("/admin/role-grants", async (c) => {
  requireStaff(c);
  requirePermission(c, "role_grant.request");
  const auth = c.get("auth")!;
  const rows = await withActor(c, async (tx) => tx`
    select g.id, g.user_id, u.display_name as user_name, u.email, g.role, g.department_id, d.name as department_name,
           g.status, g.scope_note, g.starts_at, g.expires_at, g.created_at, g.requested_by, g.approved_by,
           r.display_name as requested_by_name, a.display_name as approved_by_name
      from role_grants g join users u on u.id = g.user_id
      left join departments d on d.id = g.department_id
      left join users r on r.id = g.requested_by
      left join users a on a.id = g.approved_by
     where g.tenant_id = ${auth.activeTenant!.id}
     order by g.created_at desc limit 200
  `);
  return c.json({ grants: rows });
});

contentRoutes.post("/admin/role-grants", async (c) => {
  requireStaff(c);
  requirePermission(c, "role_grant.request");
  const auth = c.get("auth")!;
  const body = await parseJson(c, roleGrantRequestSchema);
  const id = crypto.randomUUID();
  await withActor(c, async (tx) => {
    const member = await tx`
      select id from memberships where tenant_id = ${auth.activeTenant!.id} and user_id = ${body.userId} and status = 'active'
    `;
    if (!member[0]) throw new ValidationError("The user is not an active facility member");
    if (body.departmentId) {
      const department = await tx`select id from departments where id = ${body.departmentId} and tenant_id = ${auth.activeTenant!.id}`;
      if (!department[0]) throw new ValidationError("The department does not exist in this facility");
    }
    await tx`
      insert into role_grants (id, tenant_id, user_id, role, department_id, scope_note, requested_by, starts_at, expires_at)
      values (${id}, ${auth.activeTenant!.id}, ${body.userId}, ${body.role}, ${body.departmentId ?? null},
        ${body.scopeNote || null}, ${auth.user.id}, ${body.startsAt ? new Date(body.startsAt) : new Date()},
        ${body.expiresAt ? new Date(body.expiresAt) : null})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "role_grant.request", {
      resourceType: "RoleGrant", resourceId: id, metadata: { userId: body.userId, role: body.role },
    }));
  });
  return c.json({ ok: true, grant: { id } }, 201);
});

contentRoutes.post("/admin/role-grants/:id/decision", async (c) => {
  requireStaff(c);
  requirePermission(c, "role_grant.approve");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, roleGrantDecisionSchema);
  await withActor(c, async (tx) => {
    const grant = await requireRows(await tx`
      select id, status, requested_by, approved_by, expires_at from role_grants
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Role grant not found");
    if (String(grant.requestedBy) === auth.user.id) throw new ForbiddenError("Separation of duties: you cannot approve your own role request");
    if (grant.status !== "requested" && body.decision !== "revoked") throw new ConflictError("Only requested grants can be decided");
    if (body.decision === "approved") {
      if (grant.expiresAt && new Date(grant.expiresAt as Date).getTime() <= Date.now()) throw new ConflictError("The grant already expired");
      await tx`
        update role_grants set status = 'approved', approved_by = ${auth.user.id}, decision_reason = ${body.reason} where id = ${id}
      `;
    } else if (body.decision === "rejected") {
      await tx`
        update role_grants set status = 'rejected', approved_by = ${auth.user.id}, decision_reason = ${body.reason} where id = ${id}
      `;
    } else {
      await tx`
        update role_grants set status = 'revoked', revoked_at = now(), decision_reason = ${body.reason} where id = ${id}
      `;
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, `role_grant.${body.decision}`, {
      resourceType: "RoleGrant", resourceId: id, metadata: { reason: body.reason },
    }));
  });
  return c.json({ ok: true });
});

contentRoutes.get("/admin/care-team", async (c) => {
  requireStaff(c);
  requirePermission(c, "care_team.read");
  const auth = c.get("auth")!;
  const patientId = c.req.query("patientId");
  const rows = await withActor(c, async (tx) => tx`
    select m.id, m.patient_id, p.public_id, p.given_name, p.family_name, m.user_id, u.display_name as user_name,
           m.relationship, m.department_id, d.name as department_name, m.status, m.starts_at, m.ends_at, m.created_at
      from care_team_members m join patients p on p.id = m.patient_id
      left join users u on u.id = m.user_id left join departments d on d.id = m.department_id
     where m.tenant_id = ${auth.activeTenant!.id}
       ${patientId ? tx`and m.patient_id = ${patientId}` : tx``}
     order by m.created_at desc limit 200
  `);
  return c.json({ assignments: rows });
});

contentRoutes.post("/admin/care-team", async (c) => {
  requireStaff(c);
  requirePermission(c, "clinical.care_team.manage");
  const auth = c.get("auth")!;
  const body = await parseJson(c, careTeamAssignmentSchema);
  const id = crypto.randomUUID();
  await withActor(c, async (tx) => {
    const linked = await tx`
      select 1 from tenant_patient_links where tenant_id = ${auth.activeTenant!.id} and patient_id = ${body.patientId}
    `;
    if (!linked[0]) throw new ValidationError("The patient is not linked to this facility");
    const targetUserId = body.userId ?? auth.user.id;
    const member = await tx`
      select 1 from memberships where tenant_id = ${auth.activeTenant!.id} and user_id = ${targetUserId} and status = 'active'
    `;
    if (!member[0]) throw new ValidationError("The care-team member is not an active facility member");
    if (body.departmentId) {
      const department = await tx`select id from departments where id = ${body.departmentId} and tenant_id = ${auth.activeTenant!.id}`;
      if (!department[0]) throw new ValidationError("The department does not exist in this facility");
    }
    const staff = await tx`select id from staff_persons where user_id = ${targetUserId} limit 1`;
    await tx`
      insert into care_team_members (id, tenant_id, patient_id, user_id, staff_person_id, relationship,
        department_id, purpose, ends_at, created_by)
      values (${id}, ${auth.activeTenant!.id}, ${body.patientId}, ${targetUserId}, ${staff[0]?.id ?? null},
        ${body.relationship}, ${body.departmentId ?? null}, ${body.purpose || null},
        ${body.endsAt ? new Date(body.endsAt) : null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "care_team.assign", {
      subjectPatientId: body.patientId, resourceType: "CareTeamMember", resourceId: id,
      metadata: { userId: targetUserId, relationship: body.relationship, departmentId: body.departmentId ?? null },
    }));
  });
  return c.json({ ok: true, assignment: { id } }, 201);
});

contentRoutes.post("/admin/care-team/:id/revoke", async (c) => {
  requireStaff(c);
  requirePermission(c, "clinical.care_team.manage");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  await withActor(c, async (tx) => {
    await requireRows(await tx`
      select id from care_team_members where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Care-team assignment not found");
    await tx`update care_team_members set status = 'revoked', ends_at = now() where id = ${id}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "care_team.revoke", {
      resourceType: "CareTeamMember", resourceId: id,
    }));
  });
  return c.json({ ok: true });
});

contentRoutes.get("/admin/access-review", async (c) => {
  requireStaff(c);
  requirePermission(c, "audit.read");
  const auth = c.get("auth")!;
  const data = await withActor(c, async (tx) => {
    const grants = await tx`
      select g.id, g.user_id, u.display_name as user_name, g.role, g.department_id, g.status, g.expires_at
        from role_grants g join users u on u.id = g.user_id where g.tenant_id = ${auth.activeTenant!.id}
       order by g.created_at desc limit 200
    `;
    const careTeam = await tx`
      select m.id, m.patient_id, m.user_id, m.relationship, m.status, m.ends_at
        from care_team_members m where m.tenant_id = ${auth.activeTenant!.id}
       order by m.created_at desc limit 200
    `;
    const credentials = await tx`
      select credential_type, status, expires_on, count(*)::int as total
        from credentials
       where subject_tenant_id = ${auth.activeTenant!.id}
          or subject_user_id in (
            select sp.user_id from staff_persons sp
              join engagements e on e.staff_person_id = sp.id
             where e.tenant_id = ${auth.activeTenant!.id} and sp.user_id is not null
          )
       group by credential_type, status, expires_on order by expires_on nulls last limit 100
    `;
    return { grants, careTeam, credentials };
  });
  return c.json(data);
});
