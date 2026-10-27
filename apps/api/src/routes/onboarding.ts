import { Hono } from "hono";
import {
  customTitleDecisionSchema,
  customTitleRequestSchema,
  facilityCredentialPolicySchema,
  onboardingCatalogueDraftPublishSchema,
  onboardingCataloguePublishSchema,
  proxyDecisionSchema,
  proxyRequestSchema,
  uuidSchema,
} from "@medveris/contracts";
import {
  DEFAULT_PRIVILEGES,
  ONBOARDING_ACCOUNT_TYPES,
  UGANDA_ONBOARDING_CATALOGUE,
  catalogueIntegrityIssues,
  contentDigest,
  groupCatalogueTitles,
  parseOnboardingCatalogue,
  searchCatalogue,
  type OnboardingCatalogue,
} from "@medveris/domain";
import { ROLES, type Role } from "@medveris/authz";
import { requireAuth, requirePatient, requireStaff, withActor, withPlatformActor, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { parseJson } from "../lib/http.js";
import { writeAudit } from "../lib/audit.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

export const onboardingRoutes = new Hono<AppEnv>();

interface CatalogueRow {
  country_code: string;
  version: number;
  content: OnboardingCatalogue;
  notice: string;
  published_at: Date | null;
}

function bundledCatalogue(countryCode: string): OnboardingCatalogue {
  if (countryCode !== "UG") throw new ValidationError("Only the Uganda catalogue is bundled in this build");
  return UGANDA_ONBOARDING_CATALOGUE;
}

function hasRole(c: Parameters<typeof requireStaff>[0], ...roles: Role[]): boolean {
  return requestActor(c).roles.some((role) => roles.includes(role));
}

function requireReviewRole(c: Parameters<typeof requireStaff>[0]): void {
  if (!hasRole(c, "facility_admin", "hr")) {
    throw new ForbiddenError("Facility administration or human resources permission is required");
  }
}

async function catalogueForRequest(
  tx: Parameters<Parameters<typeof withStaffActor>[1]>[0],
): Promise<{ catalogue: OnboardingCatalogue; version: number }> {
  const published = await tx`
    select version, content from onboarding_catalogues
     where country_code = 'UG' and status = 'published' order by version desc limit 1
  `;
  return {
    catalogue: (published[0]?.content as OnboardingCatalogue | undefined) ?? UGANDA_ONBOARDING_CATALOGUE,
    version: Number(published[0]?.version ?? UGANDA_ONBOARDING_CATALOGUE.version),
  };
}

onboardingRoutes.get("/onboarding/catalogue", async (c) => {
  requireAuth(c);
  const countryCode = (c.req.query("country") ?? "UG").toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) throw new ValidationError("country must be a two-letter code");
  const requestedVersion = c.req.query("version") ? Number.parseInt(c.req.query("version")!, 10) : null;
  if (requestedVersion !== null && (!Number.isInteger(requestedVersion) || requestedVersion < 1)) {
    throw new ValidationError("version must be a positive integer");
  }
  const published = await withActor(c, async (tx) => {
    const rows = await tx`
      select country_code, version, content, notice, published_at
        from onboarding_catalogues
       where country_code = ${countryCode}
         and status = 'published'
         ${requestedVersion === null ? tx`` : tx`and version = ${requestedVersion}`}
       order by version desc limit 1
    `;
    return rows[0] as CatalogueRow | undefined;
  });
  const catalogue = published?.content ?? bundledCatalogue(countryCode);
  const filter = {
    q: c.req.query("q"),
    cadreCode: c.req.query("cadreCode") || undefined,
    departmentCode: c.req.query("departmentCode") || undefined,
    titleCode: c.req.query("titleCode") || undefined,
  };
  const result = searchCatalogue(catalogue, filter);
  const titleGroups = groupCatalogueTitles(catalogue, filter);
  return c.json({
    source: published ? "published" : "bundled-unpublished",
    countryCode,
    version: published?.version ?? catalogue.version,
    notice: published?.notice ?? catalogue.notice,
    publishedAt: published?.published_at ?? null,
    catalogue,
    accountTypes: ONBOARDING_ACCOUNT_TYPES,
    titleGroups,
    ...result,
  });
});

onboardingRoutes.get("/onboarding/facilities", async (c) => {
  const auth = requireAuth(c);
  const rows = await withActor(c, async (tx) => tx`
    select t.id, t.name, t.slug, t.facility_type, t.city, t.country
      from tenants t
     where t.status = 'active'
     order by t.name limit 200
  `);
  return c.json({
    facilities: rows.map((row) => ({
      ...row,
      isCurrent: auth.activeTenant?.id === row.id,
    })),
    notice: "A facility affiliation is approved independently by each facility. Selecting a facility never grants access to its records.",
  });
});

onboardingRoutes.get("/onboarding/catalogue/versions", async (c) => {
  requireAuth(c);
  if (!c.get("auth")!.platformRoles.includes("platform_operator")) {
    throw new ForbiddenError("Platform operator permission is required");
  }
  const rows = await withPlatformActor(c, async (tx) => tx`
    select id, country_code, version, status, content_digest, created_at, published_at, retired_at
      from onboarding_catalogues order by country_code, version desc limit 100
  `);
  return c.json({ versions: rows });
});

function validateCatalogue(catalogue: OnboardingCatalogue): void {
  const issues = catalogueIntegrityIssues(catalogue, {
    knownPrivilegeCodes: DEFAULT_PRIVILEGES.map((item) => item.code),
    knownSystemRoles: ROLES,
  });
  if (issues.length) throw new ValidationError("The catalogue failed integrity checks", issues);
}

onboardingRoutes.post("/onboarding/catalogue/publish", async (c) => {
  requireAuth(c);
  if (!c.get("auth")!.platformRoles.includes("platform_operator")) {
    throw new ForbiddenError("Platform operator permission is required");
  }
  const body = await parseJson(c, onboardingCataloguePublishSchema);
  const base = bundledCatalogue(body.countryCode);
  let catalogue: OnboardingCatalogue;
  try {
    catalogue = body.content === undefined ? base : parseOnboardingCatalogue(body.content);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : "Catalogue content is invalid");
  }
  if (catalogue.countryCode !== body.countryCode) {
    throw new ValidationError("The catalogue country code does not match the request");
  }
  catalogue = {
    ...catalogue,
    version: body.version,
    notice: body.notice ?? catalogue.notice,
  };
  validateCatalogue(catalogue);
  const digest = await contentDigest(catalogue);
  const id = crypto.randomUUID();
  const published = body.status === "published";
  await withPlatformActor(c, async (tx) => {
    const existing = await tx`
      select id from onboarding_catalogues where country_code = ${body.countryCode} and version = ${body.version} limit 1
    `;
    if (existing[0]) throw new ConflictError("That catalogue version already exists");
    const latest = await tx`
      select max(version)::int as version from onboarding_catalogues where country_code = ${body.countryCode}
    `;
    if (Number(latest[0]?.version ?? 0) >= body.version) {
      throw new ConflictError(`Version ${body.version} is older than the latest recorded version`);
    }
    if (published) {
      await tx`
        update onboarding_catalogues set status = 'retired', retired_by = ${c.get("auth")!.user.id}, retired_at = now()
         where country_code = ${body.countryCode} and status = 'published'
      `;
    }
    await tx`
      insert into onboarding_catalogues (id, country_code, version, status, notice, content, content_digest, created_by, published_by, published_at)
      values (${id}, ${body.countryCode}, ${body.version}, ${published ? "published" : "draft"}, ${catalogue.notice},
        ${tx.json(catalogue as never)}, ${digest}, ${c.get("auth")!.user.id},
        ${published ? c.get("auth")!.user.id : null}, ${published ? new Date() : null})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, published ? "onboarding.catalogue.publish" : "onboarding.catalogue.draft", {
      resourceType: "OnboardingCatalogue",
      resourceId: id,
      metadata: { countryCode: body.countryCode, version: body.version, digest },
    }));
  });
  return c.json({ ok: true, catalogue: { id, countryCode: body.countryCode, version: body.version, digest, status: published ? "published" : "draft" } }, 201);
});

onboardingRoutes.post("/onboarding/catalogue/:id/publish", async (c) => {
  requireAuth(c);
  if (!c.get("auth")!.platformRoles.includes("platform_operator")) {
    throw new ForbiddenError("Platform operator permission is required");
  }
  const id = uuidSchema.parse(c.req.param("id"));
  await parseJson(c, onboardingCatalogueDraftPublishSchema);
  await withPlatformActor(c, async (tx) => {
    const draft = await requireRows(await tx`
      select id, country_code, version, status, content from onboarding_catalogues where id = ${id} for update
    `, "Catalogue draft not found");
    if (draft.status !== "draft") throw new ConflictError("Only a draft catalogue can be published");
    const catalogue = draft.content as OnboardingCatalogue;
    validateCatalogue(catalogue);
    await tx`
      update onboarding_catalogues set status = 'retired', retired_by = ${c.get("auth")!.user.id}, retired_at = now()
       where country_code = ${String(draft.countryCode)} and status = 'published'
    `;
    await tx`
      update onboarding_catalogues set status = 'published', published_by = ${c.get("auth")!.user.id}, published_at = now()
       where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "onboarding.catalogue.publish", {
      resourceType: "OnboardingCatalogue",
      resourceId: id,
      metadata: { countryCode: draft.countryCode, version: draft.version, source: "draft" },
    }));
  });
  return c.json({ ok: true });
});

onboardingRoutes.get("/onboarding/credential-requirements", async (c) => {
  const auth = requireStaff(c);
  const titleCode = c.req.query("titleCode") || undefined;
  const requestedCadre = c.req.query("cadreCode") || undefined;
  const data = await withStaffActor(c, async (tx) => {
    const { catalogue, version } = await catalogueForRequest(tx);
    let cadreCode = requestedCadre;
    if (titleCode) {
      const title = catalogue.jobTitles.find((item) => item.code === titleCode);
      if (!title) throw new ValidationError("Unknown catalogue job title");
      if (cadreCode && cadreCode !== title.cadreCode) {
        throw new ValidationError("The selected cadre does not match the catalogue job title");
      }
      cadreCode = title.cadreCode;
    }
    if (!cadreCode) throw new ValidationError("A cadreCode or titleCode is required");
    const cadre = catalogue.cadres.find((item) => item.code === cadreCode);
    if (!cadre) throw new ValidationError("Unknown professional cadre");
    const policies = await tx`
      select id, cadre_code, credential_type, regulator_code, requires_document, requires_licence,
             review_required, active, notes
        from facility_credential_policies
       where tenant_id = ${auth.activeTenant!.id}
         and active
         and (cadre_code = ${cadre.code} or cadre_code is null)
       order by cadre_code nulls last, credential_type
    `;
    return { catalogue, version, cadre, policies };
  });
  const clinical = !["support", "administrative", "administration", "finance", "data", "education", "research", "governance", "quality"].includes(data.cadre.category);
  const requiredFields = [
    ...(data.cadre.requiresRegistration ? ["regulatorCode", "registrationNumber"] : []),
    ...(clinical ? ["licenceNumber", "licenceExpiry", "qualifications"] : []),
  ];
  const policyDocumentsRequired = data.policies.length
    ? data.policies.some((row) => Boolean(row.requiresDocument))
    : clinical;
  return c.json({
    catalogue: { countryCode: data.catalogue.countryCode, version: data.version },
    cadreCode: data.cadre.code,
    cadreName: data.cadre.name,
    category: data.cadre.category,
    regulatorCodes: data.cadre.regulatorCodes,
    requiresRegistration: data.cadre.requiresRegistration,
    requiredFields,
    optionalFields: ["specialtyCredentials", "scope"],
    documentsRequired: policyDocumentsRequired,
    facilityPolicies: data.policies,
    verification: {
      mode: "manual",
      officialIntegrationAvailable: false,
      claim: "A document upload or self-declaration does not prove that a licence is valid. A reviewer must check the authority or an approved source.",
    },
  });
});

onboardingRoutes.get("/onboarding/credential-policies", async (c) => {
  requireStaff(c);
  requireReviewRole(c);
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select id, cadre_code, credential_type, regulator_code, requires_document, requires_licence,
           review_required, active, notes, updated_at
      from facility_credential_policies
     where tenant_id = ${auth.activeTenant!.id}
     order by cadre_code nulls first, credential_type
  `);
  return c.json({ policies: rows });
});

onboardingRoutes.post("/onboarding/credential-policies", async (c) => {
  requireStaff(c);
  requireReviewRole(c);
  const auth = c.get("auth")!;
  const body = await parseJson(c, facilityCredentialPolicySchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    await tx`
      insert into facility_credential_policies (id, tenant_id, cadre_code, credential_type, regulator_code,
        requires_document, requires_licence, review_required, active, notes, updated_by)
      values (${id}, ${auth.activeTenant!.id}, ${body.cadreCode || null}, ${body.credentialType},
        ${body.regulatorCode || null}, ${body.requiresDocument}, ${body.requiresLicence}, ${body.reviewRequired},
        ${body.active}, ${body.notes || null}, ${auth.user.id})
      on conflict (tenant_id, coalesce(cadre_code, ''), credential_type) do update set
        regulator_code = excluded.regulator_code,
        requires_document = excluded.requires_document,
        requires_licence = excluded.requires_licence,
        review_required = excluded.review_required,
        active = excluded.active,
        notes = excluded.notes,
        updated_by = excluded.updated_by,
        updated_at = now()
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "onboarding.credential_policy.update", {
      resourceType: "FacilityCredentialPolicy",
      metadata: { cadreCode: body.cadreCode || null, credentialType: body.credentialType, active: body.active },
    }));
  });
  return c.json({ ok: true, policy: { id } }, 201);
});

onboardingRoutes.get("/onboarding/affiliations/mine", async (c) => {
  const auth = requireAuth(c);
  if (!auth.activeTenant && !auth.patientId) {
    return c.json({ affiliations: [], multipleAffiliations: false });
  }
  const rows = await withActor(c, async (tx) => tx`
    select e.id as engagement_id, e.tenant_id, t.name as facility_name, e.engagement_type, e.status,
           e.start_date, e.end_date, e.job_title_id, j.name as job_title,
           (select string_agg(d.name, ', ' order by d.name)
              from department_assignments a join departments d on d.id = a.department_id
             where a.engagement_id = e.id and a.ends_on is null) as departments,
           o.status as onboarding_status, o.path as onboarding_path
      from staff_persons s
      join engagements e on e.staff_person_id = s.id
      join tenants t on t.id = e.tenant_id
      left join job_titles j on j.id = e.job_title_id
      left join lateral (
        select status, path from onboarding_cases x
         where x.engagement_id = e.id order by x.created_at desc limit 1
      ) o on true
     where s.user_id = ${auth.user.id}
     order by e.start_date desc, t.name
  `);
  return c.json({ affiliations: rows, multipleAffiliations: rows.length > 1 });
});

onboardingRoutes.post("/onboarding/custom-titles", async (c) => {
  const auth = requireStaff(c);
  const body = await parseJson(c, customTitleRequestSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const { catalogue } = await catalogueForRequest(tx);
    if (body.cadreCode && !catalogue.cadres.some((cadre) => cadre.code === body.cadreCode)) {
      throw new ValidationError("Unknown professional cadre");
    }
    const unknownDepartments = body.departmentCodes.filter((code) => !catalogue.departments.some((department) => department.code === code));
    if (unknownDepartments.length) throw new ValidationError("Unknown catalogue department", { unknownDepartments });
    const unknownSpecialties = body.specialtyCodes.filter((code) => !catalogue.specialties.some((specialty) => specialty.code === code));
    if (unknownSpecialties.length) throw new ValidationError("Unknown catalogue specialty", { unknownSpecialties });
    if (body.onboardingCaseId) {
      const onboarding = await requireRows(await tx`
        select o.id, o.tenant_id, s.user_id from onboarding_cases o
          join staff_persons s on s.id = o.staff_person_id
         where o.id = ${body.onboardingCaseId} and o.tenant_id = ${auth.activeTenant!.id}
      `, "Onboarding case not found");
      const canManage = hasRole(c, "hr", "facility_admin");
      if (!canManage && String(onboarding.userId ?? "") !== auth.user.id) {
        throw new ForbiddenError("You may only request a title for your own onboarding case");
      }
    }
    await tx`
      insert into job_title_requests (id, tenant_id, requested_by, onboarding_case_id, proposed_name, cadre_code,
        department_codes, specialty_codes, explanation)
      values (${id}, ${auth.activeTenant!.id}, ${auth.user.id}, ${body.onboardingCaseId ?? null},
        ${body.proposedName}, ${body.cadreCode || null}, ${body.departmentCodes}, ${body.specialtyCodes}, ${body.explanation})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "onboarding.custom_title.request", {
      resourceType: "JobTitleRequest", resourceId: id,
      metadata: {
        proposedName: body.proposedName, cadreCode: body.cadreCode || null,
        departmentCodes: body.departmentCodes, onboardingCaseId: body.onboardingCaseId ?? null,
      },
    }));
  });
  return c.json({
    ok: true,
    request: { id, status: "pending" },
    grantsNothing: true,
    notice: "A custom title request stays pending. It does not grant a system role, clinical privilege or facility access.",
  }, 201);
});

onboardingRoutes.get("/onboarding/custom-titles/mine", async (c) => {
  const auth = requireAuth(c);
  const rows = await withActor(c, async (tx) => tx`
    select id, proposed_name, cadre_code, department_codes, specialty_codes, explanation, status,
           reviewer_id, reviewed_at, decision_reason, approved_job_title_id, created_at
      from job_title_requests
     where requested_by = ${auth.user.id}
     order by created_at desc limit 100
  `);
  return c.json({ requests: rows });
});

onboardingRoutes.get("/onboarding/custom-titles/queue", async (c) => {
  const auth = requireStaff(c);
  requireReviewRole(c);
  const rows = await withStaffActor(c, async (tx) => tx`
    select r.id, r.proposed_name, r.cadre_code, r.department_codes, r.specialty_codes, r.explanation,
           r.status, r.created_at, r.onboarding_case_id, u.display_name as requested_by_name,
           u.email as requested_by_email
      from job_title_requests r join users u on u.id = r.requested_by
     where r.tenant_id = ${auth.activeTenant!.id} and r.status = 'pending'
     order by r.created_at limit 100
  `);
  return c.json({ requests: rows });
});

onboardingRoutes.post("/onboarding/custom-titles/:id/decision", async (c) => {
  const auth = requireStaff(c);
  requireReviewRole(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, customTitleDecisionSchema);
  const result = await withStaffActor(c, async (tx) => {
    const request = await requireRows(await tx`
      select id, tenant_id, requested_by, proposed_name, cadre_code, department_codes, specialty_codes, status
        from job_title_requests
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Custom title request not found");
    if (request.status !== "pending") throw new ConflictError("Only a pending custom title request can be decided");
    if (String(request.requestedBy) === auth.user.id) {
      throw new ForbiddenError("A requester cannot approve or reject their own custom title request");
    }
    if (body.decision === "reject") {
      await tx`
        update job_title_requests set status = 'rejected', reviewer_id = ${auth.user.id}, reviewed_at = now(),
          decision_reason = ${body.reason}, updated_at = now()
         where id = ${id}
      `;
      await writeAudit(tx, c.get("deps").config, requestAudit(c, "onboarding.custom_title.reject", {
        resourceType: "JobTitleRequest", resourceId: id,
        metadata: { reason: body.reason, proposedName: String(request.proposedName) },
      }));
      return { status: "rejected", approvedJobTitleId: null };
    }
    const name = (body.approvedName ?? String(request.proposedName)).trim();
    const existing = await tx`
      select id from job_titles where tenant_id = ${auth.activeTenant!.id} and lower(name) = lower(${name}) limit 1
    `;
    let jobTitleId = existing[0]?.id as string | undefined;
    if (!jobTitleId) {
      jobTitleId = crypto.randomUUID();
      const cadreCode = request.cadreCode ? String(request.cadreCode) : null;
      const cadre = cadreCode
        ? await tx`select id from cadres where tenant_id = ${auth.activeTenant!.id} and (catalogue_code = ${cadreCode} or code = ${cadreCode}) limit 1`
        : [];
      const code = `CUSTOM-${id.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
      await tx`
        insert into job_titles (id, tenant_id, name, cadre_id, code, catalogue_code, seniority,
          requires_credential, privilege_codes, suggested_system_roles)
        values (${jobTitleId}, ${auth.activeTenant!.id}, ${name}, ${cadre[0]?.id ?? null}, ${code}, null, null,
          false, ${[] as string[]}, ${[] as string[]})
      `;
    }
    await tx`
      update job_title_requests set status = 'approved', reviewer_id = ${auth.user.id}, reviewed_at = now(),
        decision_reason = ${body.reason}, approved_job_title_id = ${jobTitleId}, updated_at = now()
       where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "onboarding.custom_title.approve", {
      resourceType: "JobTitleRequest", resourceId: id,
      metadata: { reason: body.reason, proposedName: name, approvedJobTitleId: jobTitleId, grantsPrivileges: false },
    }));
    return { status: "approved", approvedJobTitleId: jobTitleId };
  });
  return c.json({ ok: true, ...result, notice: "Approving a custom title does not grant a system role or clinical privilege." });
});

function rolePath(roles: string[]): string {
  if (roles.includes("facility_admin")) return "facility_admin";
  if (roles.includes("clinician") || roles.includes("specialist_clinician")) return "clinician";
  if (roles.includes("nurse") || roles.includes("midwife")) return "nurse";
  if (roles.some((role) => ["pharmacist", "laboratory", "radiology", "public_health"].includes(role))) return "allied_health";
  if (roles.some((role) => ["housekeeping", "porter", "mortuary", "cssd", "biomedical"].includes(role))) return "support";
  return "administrative";
}

onboardingRoutes.get("/onboarding/me", async (c) => {
  const auth = requireAuth(c);
  if (auth.patientId) {
    const data = await withActor(c, async (tx) => {
      const account = await requireRows(await tx`
        select p.id, p.public_id, p.given_name, p.family_name, p.email, p.phone, pa.verified_at,
               (select count(*)::int from patient_proxies x where x.patient_id = p.id and x.status = 'active') as active_proxies,
               (select count(*)::int from patient_proxies x where x.patient_id = p.id and x.status = 'requested') as requested_proxies
          from patients p join patient_accounts pa on pa.patient_id = p.id
         where p.id = ${auth.patientId}
      `, "Patient account not found");
      return account;
    });
    const steps = [
      { key: "email-verified", label: "Verify your email address", done: Boolean(auth.user.emailVerifiedAt) },
      { key: "profile", label: "Complete your contact details", done: Boolean(data.phone || data.email) },
      { key: "privacy", label: "Review how your record is shared", done: true },
      { key: "caregiver", label: "Invite a caregiver (optional)", done: Number(data.activeProxies) > 0, optional: true },
    ];
    return c.json({
      path: "patient",
      identity: { userId: auth.user.id, displayName: auth.user.displayName, email: auth.user.email },
      patient: data,
      steps,
      notice: "Patient onboarding is a self-service path. A caregiver only receives the scopes you explicitly grant.",
    });
  }

  const staff = await withActor(c, async (tx) => {
    const person = await tx`
      select s.id, s.staff_ref, s.given_name, s.family_name, s.identity_verified_at, s.status,
             o.id as case_id, o.status as case_status, o.path, o.catalogue_title_code, o.catalogue_cadre_code,
             coalesce(o.regulator_codes, '{}') as regulator_codes, o.credential_required,
             coalesce(o.requested_system_roles, '{}') as requested_system_roles,
             coalesce(o.approved_system_roles, '{}') as approved_system_roles
        from staff_persons s
        left join lateral (
          select * from onboarding_cases x where x.staff_person_id = s.id order by x.created_at desc limit 1
        ) o on true
       where s.user_id = ${auth.user.id} limit 1
    `;
    const credential = await tx`
      select count(*)::int as total,
             count(*) filter (where status = 'verified')::int as verified
        from credentials where subject_user_id = ${auth.user.id} or submitted_by = ${auth.user.id}
    `;
    const proxies = await tx`
      select p.id, p.patient_id, pa.given_name, pa.family_name, p.relationship, p.scopes, p.status, p.expires_at
        from patient_proxies p join patients pa on pa.id = p.patient_id
       where p.proxy_user_id = ${auth.user.id}
       order by p.created_at desc limit 20
    `;
    const facility = auth.activeTenant
      ? await requireRows(await tx`
          select t.id, t.name, t.facility_type,
                 (select count(*)::int from departments d where d.tenant_id = t.id and d.enabled) as enabled_departments,
                 (select count(*)::int from memberships m where m.tenant_id = t.id and m.status = 'active') as active_members,
                 (select count(*)::int from onboarding_cases o where o.tenant_id = t.id and o.status not in ('active','rejected','withdrawn')) as open_onboarding,
                 (select count(*)::int from onboarding_catalogues c where c.country_code = 'UG' and c.status = 'published') as published_catalogues
            from tenants t where t.id = ${auth.activeTenant.id}
        `, "Facility not found")
      : null;
    return { person: person[0] ?? null, credential: credential[0], proxies, facility };
  });

  const path = staff.person?.path ? String(staff.person.path) : rolePath(auth.activeTenant?.roles ?? []);
  const caseStatus = staff.person ? String(staff.person.caseStatus ?? "invited") : null;
  const steps = path === "facility_admin"
    ? [
        { key: "facility", label: "Confirm facility profile and contact details", done: Boolean(staff.facility) },
        { key: "departments", label: "Enable the departments your facility operates", done: Number(staff.facility?.enabledDepartments ?? 0) > 0 },
        { key: "team", label: "Invite or onboard your team", done: Number(staff.facility?.activeMembers ?? 0) > 1 },
        { key: "credentials", label: "Submit facility registration evidence", done: false, optional: true },
        { key: "catalogue", label: "Review the onboarding catalogue", done: Number(staff.facility?.publishedCatalogues ?? 0) > 0 },
      ]
    : [
        { key: "identity", label: "Verify your identity", done: Boolean(staff.person?.identityVerifiedAt) },
        { key: "employment", label: "Record your engagement and department", done: Boolean(staff.person?.caseId) },
        { key: "professional", label: "Confirm cadre, title and regulator", done: Boolean(staff.person?.catalogueTitleCode || staff.person?.catalogueCadreCode) },
        { key: "credentials", label: "Submit required credential evidence", done: Number(staff.credential?.verified ?? 0) > 0, optional: !staff.person?.credentialRequired },
        { key: "privileges", label: "Request only the privileges you need", done: caseStatus === "active" || caseStatus === "access" },
        { key: "review", label: "Await independent review", done: caseStatus === "active" },
        { key: "mfa", label: "Enrol multi-factor authentication", done: Boolean(auth.user.mfaEnrolledAt) },
      ];

  return c.json({
    path,
    identity: { userId: auth.user.id, displayName: auth.user.displayName, email: auth.user.email },
    staff: staff.person,
    credential: staff.credential,
    facility: staff.facility,
    proxyLinks: staff.proxies,
    steps,
    notice: "Onboarding does not grant clinical privileges. A title or catalogue selection never replaces a reviewed privilege or role grant.",
  });
});

onboardingRoutes.post("/onboarding/proxies/requests", async (c) => {
  const auth = requirePatient(c);
  const body = await parseJson(c, proxyRequestSchema);
  const proxyUserId = body.proxyUserId ?? (
    await (async () => {
      const rows = await withActor(c, async (tx) => tx`
        select id from users where lower(email) = ${body.proxyEmail!.toLowerCase()} and status = 'active' limit 1
      `);
      if (!rows[0]) throw new NotFoundError("No active Medveris account matches that caregiver email");
      return String(rows[0].id);
    })()
  );
  if (proxyUserId === auth.user.id) throw new ValidationError("You cannot nominate your own account as a caregiver");
  const id = crypto.randomUUID();
  await withActor(c, async (tx) => {
    const duplicate = await tx`
      select id from patient_proxies
       where patient_id = ${auth.patientId} and proxy_user_id = ${proxyUserId} and status in ('requested','active') limit 1
    `;
    if (duplicate[0]) throw new ConflictError("A caregiver request or active link already exists for this account");
    await tx`
      insert into patient_proxies (id, patient_id, proxy_user_id, relationship, scopes, status, starts_at, expires_at,
        requested_by, granted_via)
      values (${id}, ${auth.patientId}, ${proxyUserId}, ${body.relationship}, ${body.scopes},
        'requested', now(), ${body.expiresAt ? new Date(body.expiresAt) : null}, ${auth.user.id}, 'proxy-request')
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "patient.proxy.request", {
      subjectPatientId: auth.patientId,
      resourceType: "PatientProxy",
      resourceId: id,
      metadata: { relationship: body.relationship, scopes: body.scopes, expiresAt: body.expiresAt ?? null },
    }));
  });
  return c.json({ ok: true, proxy: { id, status: "requested", scopes: body.scopes } }, 201);
});

onboardingRoutes.get("/onboarding/proxies", async (c) => {
  const auth = requirePatient(c);
  const rows = await withActor(c, async (tx) => tx`
    select p.id, p.proxy_user_id, u.display_name as proxy_name, u.email as proxy_email, p.relationship,
           p.scopes, p.status, p.starts_at, p.expires_at, p.reviewed_at, p.decision_reason, p.created_at
      from patient_proxies p join users u on u.id = p.proxy_user_id
     where p.patient_id = ${auth.patientId}
     order by p.created_at desc limit 100
  `);
  return c.json({ proxies: rows });
});

onboardingRoutes.get("/onboarding/proxies/mine", async (c) => {
  const auth = requireAuth(c);
  const rows = await withActor(c, async (tx) => tx`
    select p.id, p.patient_id, pt.given_name, pt.family_name, pt.public_id, p.relationship,
           p.scopes, p.status, p.starts_at, p.expires_at, p.reviewed_at
      from patient_proxies p join patients pt on pt.id = p.patient_id
     where p.proxy_user_id = ${auth.user.id}
     order by p.created_at desc limit 100
  `);
  return c.json({ proxies: rows });
});

onboardingRoutes.get("/onboarding/proxies/queue", async (c) => {
  const auth = requireStaff(c);
  const roles = auth.activeTenant?.roles ?? [];
  if (!roles.some((role) => ["facility_admin", "records"].includes(role))) {
    throw new ForbiddenError("Facility administrator or records permission is required");
  }
  const rows = await withStaffActor(c, async (tx) => tx`
    select p.id, p.patient_id, pt.given_name, pt.family_name, pt.public_id, p.proxy_user_id,
           u.display_name as proxy_name, u.email as proxy_email, p.relationship, p.scopes, p.expires_at, p.created_at
      from patient_proxies p
      join patients pt on pt.id = p.patient_id
      join users u on u.id = p.proxy_user_id
      join tenant_patient_links l on l.patient_id = p.patient_id and l.tenant_id = ${auth.activeTenant!.id}
     where p.status = 'requested'
     order by p.created_at limit 100
  `);
  return c.json({ requests: rows });
});

onboardingRoutes.post("/onboarding/proxies/:id/decision", async (c) => {
  const auth = requireAuth(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, proxyDecisionSchema);
  const roles = auth.activeTenant?.roles ?? [];
  const staffReviewer = Boolean(auth.activeTenant) && roles.some((role) => ["facility_admin", "records"].includes(role));
  if (!auth.patientId && !staffReviewer) {
    throw new ForbiddenError("Only the patient or an authorised facility reviewer may decide a caregiver request");
  }
  const run = auth.patientId ? withActor : withStaffActor;
  await run(c, async (tx) => {
    const rows = await tx`
      select p.id, p.patient_id, p.proxy_user_id, p.status, p.expires_at
        from patient_proxies p
       where p.id = ${id}
         and (
           p.patient_id = ${auth.patientId}
           ${auth.activeTenant ? tx`or exists (
             select 1 from tenant_patient_links l
              where l.patient_id = p.patient_id and l.tenant_id = ${auth.activeTenant.id}
           )` : tx``}
         )
       for update
    `;
    const proxy = rows[0];
    if (!proxy) throw new NotFoundError("Caregiver request not found");
    if (proxy.status !== "requested") throw new ConflictError("Only a requested caregiver link can be decided");
    if (body.decision === "reject") {
      await tx`
        update patient_proxies set status = 'rejected', reviewed_by = ${auth.user.id}, reviewed_at = now(),
          decision_reason = ${body.reason}
         where id = ${id}
      `;
    } else {
      if (proxy.expiresAt && new Date(String(proxy.expiresAt)).getTime() <= Date.now()) {
        throw new ValidationError("This caregiver request has already expired");
      }
      await tx`
        update patient_proxies set status = 'active', granted_by = ${auth.user.id}, granted_via = ${
          auth.patientId ? "patient-delegation" : "facility-review"
        }, starts_at = now(), reviewed_by = ${auth.user.id}, reviewed_at = now(), decision_reason = ${body.reason}
         where id = ${id}
      `;
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, `patient.proxy.${body.decision}`, {
      subjectPatientId: String(proxy.patientId),
      resourceType: "PatientProxy",
      resourceId: id,
      metadata: { proxyUserId: String(proxy.proxyUserId), reason: body.reason },
    }));
  });
  return c.json({ ok: true, status: body.decision === "approve" ? "active" : "rejected" });
});
