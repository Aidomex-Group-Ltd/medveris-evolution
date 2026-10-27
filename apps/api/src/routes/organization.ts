import { Hono } from "hono";
import {
  assignmentSchema,
  cadreSchema,
  departmentSchema,
  jobTitleSchema,
  locationSchema,
  onboardingDecisionSchema,
  onboardingStartSchema,
  onboardingUpdateSchema,
  privilegeDecisionSchema,
  privilegeRequestSchema,
  trainingRecordSchema,
  unitSchema,
  uuidSchema,
} from "@medveris/contracts";
import {
  DEFAULT_DEPARTMENTS,
  DEFAULT_PRIVILEGES,
  UGANDA_CADRES,
  UGANDA_ONBOARDING_CATALOGUE,
  canAdvanceOnboarding,
  catalogueCodeForDefaultDepartment,
  randomStaffReference,
  resolveCatalogueTitle,
  type OnboardingCatalogue,
  type OnboardingCatalogueJobTitle,
  type OnboardingStatus,
} from "@medveris/domain";
import { assertWorkforceAccess } from "@medveris/authz";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { parseJson } from "../lib/http.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

export const organizationRoutes = new Hono<AppEnv>();

function hasRole(c: Parameters<typeof requireStaff>[0], ...roles: string[]): boolean {
  return requestActor(c).roles.some((role) => roles.includes(role));
}


async function ensureCatalogueJobTitle(
  tx: Parameters<Parameters<typeof withStaffActor>[1]>[0],
  tenantId: string,
  title: OnboardingCatalogueJobTitle,
): Promise<string> {
  const cadre = await tx`
    select id from cadres
     where tenant_id = ${tenantId} and (catalogue_code = ${title.cadreCode} or code = ${title.cadreCode})
     limit 1
  `;
  let cadreId = cadre[0]?.id as string | undefined;
  if (!cadreId) {
    cadreId = crypto.randomUUID();
    const catalogueCadre = UGANDA_CADRES.find((item) => item.code === title.cadreCode);
    await tx`
      insert into cadres (id, tenant_id, code, name, category, catalogue_code, regulator_codes, requires_registration)
      values (${cadreId}, ${tenantId}, ${title.cadreCode}, ${catalogueCadre?.name ?? title.cadreCode},
        ${catalogueCadre?.category ?? "catalogue"}, ${title.cadreCode},
        ${catalogueCadre?.regulatorCodes ?? []}, ${catalogueCadre?.requiresRegistration ?? false})
      on conflict (tenant_id, code) do update set catalogue_code = excluded.catalogue_code,
        regulator_codes = excluded.regulator_codes, requires_registration = excluded.requires_registration
    `;
    const created = await tx`select id from cadres where tenant_id = ${tenantId} and code = ${title.cadreCode}`;
    cadreId = String(created[0]!.id);
  }
  const existing = await tx`
    select id from job_titles
     where tenant_id = ${tenantId}
       and (code = ${title.code} or catalogue_code = ${title.code} or name = ${title.name})
     limit 1
  `;
  if (existing[0]) {
    const id = String(existing[0].id);
    await tx`
      update job_titles set cadre_id = ${cadreId}, code = ${title.code}, catalogue_code = ${title.code},
        seniority = ${title.seniority}, requires_credential = ${title.requiresCredential},
        privilege_codes = ${title.privilegeCodes}, suggested_system_roles = ${title.suggestedSystemRoles}
       where id = ${id} and tenant_id = ${tenantId}
    `;
    return id;
  }
  const id = crypto.randomUUID();
  await tx`
    insert into job_titles (id, tenant_id, name, cadre_id, code, catalogue_code, seniority,
      requires_credential, privilege_codes, suggested_system_roles)
    values (${id}, ${tenantId}, ${title.name}, ${cadreId}, ${title.code}, ${title.code}, ${title.seniority},
      ${title.requiresCredential}, ${title.privilegeCodes}, ${title.suggestedSystemRoles})
  `;
  return id;
}

async function uniqueStaffReference(tx: Parameters<Parameters<typeof withStaffActor>[1]>[0]): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = randomStaffReference();
    const existing = await tx`select 1 from staff_persons where staff_ref = ${candidate}`;
    if (!existing[0]) return candidate;
  }
  throw new ConflictError("Unable to allocate a unique staff reference");
}

organizationRoutes.get("/organization/departments", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select d.id, d.code, d.name, d.department_type, d.parent_department_id, d.description, d.enabled, d.sort_order, d.catalogue_code,
      (select count(*)::int from units u where u.department_id = d.id) as unit_count,
      (select count(*)::int from department_assignments a where a.department_id = d.id and a.ends_on is null) as staff_count
      from departments d where d.tenant_id = ${auth.activeTenant!.id}
     order by d.sort_order, d.name
  `);
  return c.json({ departments: rows });
});

organizationRoutes.post("/organization/departments", async (c) => {
  requireStaff(c);
  assertWorkforceAccess(requestActor(c));
  const auth = c.get("auth")!;
  const body = await parseJson(c, departmentSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    if (body.parentDepartmentId) {
      const parent = await tx`select id from departments where id = ${body.parentDepartmentId} and tenant_id = ${auth.activeTenant!.id}`;
      if (!parent[0]) throw new ValidationError("The parent department does not exist in this facility");
    }
    await tx`
      insert into departments (id, tenant_id, code, name, department_type, parent_department_id, description, enabled, created_by)
      values (${id}, ${auth.activeTenant!.id}, ${body.code}, ${body.name}, ${body.departmentType},
        ${body.parentDepartmentId ?? null}, ${body.description || null}, ${body.enabled}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "department.create", {
      resourceType: "Department", resourceId: id, metadata: { code: body.code, type: body.departmentType },
    }));
  });
  return c.json({ ok: true, department: { id } }, 201);
});

organizationRoutes.patch("/organization/departments/:id", async (c) => {
  requireStaff(c);
  assertWorkforceAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, departmentSchema.partial());
  await withStaffActor(c, async (tx) => {
    const current = await requireRows(await tx`
      select id, enabled from departments where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Department not found");
    await tx`
      update departments set
        code = coalesce(${body.code ?? null}, code),
        name = coalesce(${body.name ?? null}, name),
        description = ${body.description === undefined ? tx`description` : (body.description || null)},
        enabled = coalesce(${body.enabled ?? null}, enabled),
        updated_at = now()
       where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "department.update", {
      resourceType: "Department", resourceId: id, metadata: { enabled: body.enabled ?? current.enabled },
    }));
  });
  return c.json({ ok: true });
});

organizationRoutes.post("/organization/catalogue", async (c) => {
  requireStaff(c);
  assertWorkforceAccess(requestActor(c));
  const auth = c.get("auth")!;
  const result = await withStaffActor(c, async (tx) => {
    let departments = 0;
    let units = 0;
    let cadres = 0;
    let privileges = 0;
    for (const [index, department] of DEFAULT_DEPARTMENTS.entries()) {
      const existing = await tx`
        select id from departments where tenant_id = ${auth.activeTenant!.id} and code = ${department.code}
      `;
      let departmentId = existing[0]?.id as string | undefined;
      if (!departmentId) {
        departmentId = crypto.randomUUID();
        await tx`
          insert into departments (id, tenant_id, code, name, department_type, sort_order, created_by, catalogue_code)
          values (${departmentId}, ${auth.activeTenant!.id}, ${department.code}, ${department.name}, ${department.type},
            ${index}, ${auth.user.id}, ${catalogueCodeForDefaultDepartment(department.code)})
        `;
        departments += 1;
      } else {
        await tx`
          update departments set catalogue_code = ${catalogueCodeForDefaultDepartment(department.code)}
           where id = ${departmentId} and catalogue_code is null
        `;
      }
      for (const unit of department.units) {
        const found = await tx`
          select id from units where tenant_id = ${auth.activeTenant!.id} and department_id = ${departmentId} and code = ${unit.code}
        `;
        if (!found[0]) {
          await tx`
            insert into units (id, tenant_id, department_id, code, name, unit_type)
            values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${departmentId}, ${unit.code}, ${unit.name}, ${unit.type ?? "general"})
          `;
          units += 1;
        }
      }
      for (const cadre of department.cadres) {
        const found = await tx`
          select id from cadres where tenant_id = ${auth.activeTenant!.id} and code = ${cadre.code}
        `;
        const catalogueCadre = UGANDA_CADRES.find((item) => item.code === cadre.code);
        if (!found[0]) {
          await tx`
            insert into cadres (id, tenant_id, code, name, category, catalogue_code, regulator_codes, requires_registration)
            values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${cadre.code}, ${cadre.name}, ${cadre.category},
              ${catalogueCadre ? cadre.code : null}, ${catalogueCadre?.regulatorCodes ?? []}, ${catalogueCadre?.requiresRegistration ?? false})
          `;
          cadres += 1;
        } else if (catalogueCadre) {
          await tx`
            update cadres set catalogue_code = ${cadre.code}, regulator_codes = ${catalogueCadre.regulatorCodes},
              requires_registration = ${catalogueCadre.requiresRegistration}
             where id = ${found[0].id} and catalogue_code is null
          `;
        }
      }
    }
    for (const privilege of DEFAULT_PRIVILEGES) {
      const found = await tx`
        select id from privilege_catalog where tenant_id = ${auth.activeTenant!.id} and code = ${privilege.code}
      `;
      if (!found[0]) {
        await tx`
          insert into privilege_catalog (id, tenant_id, code, name, category, requires_credential)
          values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${privilege.code}, ${privilege.name}, ${privilege.category}, ${privilege.requiresCredential})
        `;
        privileges += 1;
      }
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "organization.catalogue.apply", {
      resourceType: "Organization", metadata: { departments, units, cadres, privileges },
    }));
    return { departments, units, cadres, privileges };
  });
  return c.json({ ok: true, applied: result });
});

organizationRoutes.get("/organization/units", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const departmentId = c.req.query("departmentId");
  const rows = await withStaffActor(c, async (tx) => tx`
    select u.id, u.department_id, u.code, u.name, u.unit_type, u.description, u.enabled, d.name as department_name
      from units u join departments d on d.id = u.department_id
     where u.tenant_id = ${auth.activeTenant!.id}
       ${departmentId ? tx`and u.department_id = ${departmentId}` : tx``}
     order by d.name, u.name
  `);
  return c.json({ units: rows });
});

organizationRoutes.post("/organization/departments/:id/units", async (c) => {
  requireStaff(c);
  assertWorkforceAccess(requestActor(c));
  const auth = c.get("auth")!;
  const departmentId = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, unitSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const department = await tx`select id from departments where id = ${departmentId} and tenant_id = ${auth.activeTenant!.id}`;
    if (!department[0]) throw new NotFoundError("Department not found");
    await tx`
      insert into units (id, tenant_id, department_id, code, name, unit_type, description, enabled)
      values (${id}, ${auth.activeTenant!.id}, ${departmentId}, ${body.code}, ${body.name}, ${body.unitType}, ${body.description || null}, ${body.enabled})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "unit.create", {
      resourceType: "Unit", resourceId: id, metadata: { departmentId, code: body.code },
    }));
  });
  return c.json({ ok: true, unit: { id } }, 201);
});

organizationRoutes.get("/organization/locations", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const unitId = c.req.query("unitId");
  const rows = await withStaffActor(c, async (tx) => tx`
    select l.id, l.unit_id, l.code, l.name, l.location_type, l.status, l.description, u.name as unit_name
      from locations l join units u on u.id = l.unit_id
     where l.tenant_id = ${auth.activeTenant!.id}
       ${unitId ? tx`and l.unit_id = ${unitId}` : tx``}
     order by u.name, l.name
  `);
  return c.json({ locations: rows });
});

organizationRoutes.post("/organization/units/:id/locations", async (c) => {
  requireStaff(c);
  assertWorkforceAccess(requestActor(c));
  const auth = c.get("auth")!;
  const unitId = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, locationSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const unit = await tx`select id from units where id = ${unitId} and tenant_id = ${auth.activeTenant!.id}`;
    if (!unit[0]) throw new NotFoundError("Unit not found");
    await tx`
      insert into locations (id, tenant_id, unit_id, code, name, location_type, description)
      values (${id}, ${auth.activeTenant!.id}, ${unitId}, ${body.code}, ${body.name}, ${body.locationType}, ${body.description || null})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "location.create", {
      resourceType: "Location", resourceId: id, metadata: { unitId, code: body.code },
    }));
  });
  return c.json({ ok: true, location: { id } }, 201);
});

organizationRoutes.get("/organization/cadres", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select id, code, name, category, isco08_code, isco08_reviewed, description, active
      from cadres where tenant_id = ${auth.activeTenant!.id} order by name
  `);
  return c.json({ cadres: rows });
});

organizationRoutes.post("/organization/cadres", async (c) => {
  requireStaff(c);
  assertWorkforceAccess(requestActor(c));
  const auth = c.get("auth")!;
  const body = await parseJson(c, cadreSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    await tx`
      insert into cadres (id, tenant_id, code, name, category, isco08_code, isco08_reviewed, description)
      values (${id}, ${auth.activeTenant!.id}, ${body.code}, ${body.name}, ${body.category},
        ${body.isco08Code || null}, ${body.isco08Reviewed}, ${body.description || null})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "cadre.create", {
      resourceType: "Cadre", resourceId: id, metadata: { code: body.code },
    }));
  });
  return c.json({ ok: true, cadre: { id } }, 201);
});

organizationRoutes.get("/organization/job-titles", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select j.id, j.name, j.grade, j.active, j.cadre_id, c.name as cadre_name
      from job_titles j left join cadres c on c.id = j.cadre_id
     where j.tenant_id = ${auth.activeTenant!.id} order by j.name
  `);
  return c.json({ jobTitles: rows });
});

organizationRoutes.post("/organization/job-titles", async (c) => {
  requireStaff(c);
  assertWorkforceAccess(requestActor(c));
  const auth = c.get("auth")!;
  const body = await parseJson(c, jobTitleSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    if (body.cadreId) {
      const cadre = await tx`select id from cadres where id = ${body.cadreId} and tenant_id = ${auth.activeTenant!.id}`;
      if (!cadre[0]) throw new ValidationError("The selected cadre does not exist");
    }
    await tx`
      insert into job_titles (id, tenant_id, name, cadre_id, grade)
      values (${id}, ${auth.activeTenant!.id}, ${body.name}, ${body.cadreId ?? null}, ${body.grade || null})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "job-title.create", {
      resourceType: "JobTitle", resourceId: id, metadata: { name: body.name },
    }));
  });
  return c.json({ ok: true, jobTitle: { id } }, 201);
});

organizationRoutes.get("/workforce/staff", async (c) => {
  requireStaff(c);
  assertWorkforceAccess(requestActor(c));
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select s.id, s.staff_ref, s.given_name, s.family_name, s.professional_display_name, s.email, s.phone, s.status,
           e.id as engagement_id, e.engagement_type, e.status as engagement_status, e.start_date, e.end_date,
           j.name as job_title, c.name as cadre,
           (select d.name from department_assignments a join departments d on d.id = a.department_id
             where a.engagement_id = e.id and a.is_primary and a.ends_on is null limit 1) as primary_department,
           (select count(*)::int from privilege_grants g where g.engagement_id = e.id and g.status = 'approved') as approved_privileges
      from staff_persons s
      left join engagements e on e.staff_person_id = s.id and e.tenant_id = ${auth.activeTenant!.id} and e.status <> 'withdrawn'
      left join job_titles j on j.id = e.job_title_id
      left join cadres c on c.id = j.cadre_id
     where e.tenant_id = ${auth.activeTenant!.id} or s.user_id is not null
     order by s.family_name, s.given_name
  `);
  return c.json({ staff: rows });
});

organizationRoutes.get("/workforce/summary", async (c) => {
  requireStaff(c);
  assertWorkforceAccess(requestActor(c));
  const auth = c.get("auth")!;
  const [row] = await withStaffActor(c, async (tx) => tx`
    select
      (select count(*)::int from engagements where tenant_id = ${auth.activeTenant!.id} and status = 'active') as active_staff,
      (select count(*)::int from onboarding_cases where tenant_id = ${auth.activeTenant!.id} and status not in ('active','rejected','withdrawn')) as open_onboarding,
      (select count(*)::int from privilege_grants where tenant_id = ${auth.activeTenant!.id} and status = 'requested') as pending_privileges,
      (select count(*)::int from departments where tenant_id = ${auth.activeTenant!.id} and enabled) as enabled_departments,
      (select count(*)::int from training_records where tenant_id = ${auth.activeTenant!.id} and expires_on is not null and expires_on < current_date) as expired_training
  `);
  return c.json({ summary: row });
});

organizationRoutes.get("/workforce/onboarding", async (c) => {
  requireStaff(c);
  assertWorkforceAccess(requestActor(c));
  const auth = c.get("auth")!;
  const status = c.req.query("status");
  const rows = await withStaffActor(c, async (tx) => tx`
    select o.id, o.status, o.current_step, o.staff_person_id, o.engagement_id, o.created_at, o.submitted_at,
           s.staff_ref, s.given_name, s.family_name, s.professional_display_name,
           e.engagement_type, e.start_date,
           (select d.name from department_assignments a join departments d on d.id = a.department_id
             where a.engagement_id = o.engagement_id and a.is_primary and a.ends_on is null limit 1) as primary_department
      from onboarding_cases o
      join staff_persons s on s.id = o.staff_person_id
      left join engagements e on e.id = o.engagement_id
     where o.tenant_id = ${auth.activeTenant!.id}
       ${status ? tx`and o.status = ${status}` : tx``}
     order by o.created_at desc limit 200
  `);
  return c.json({ cases: rows });
});

organizationRoutes.post("/workforce/onboarding", async (c) => {
  requireStaff(c);
  assertWorkforceAccess(requestActor(c));
  const auth = c.get("auth")!;
  const body = await parseJson(c, onboardingStartSchema);
  const result = await withStaffActor(c, async (tx) => {
    const engagementId = crypto.randomUUID();
    const caseId = crypto.randomUUID();
    const published = await tx`
      select version, content from onboarding_catalogues
       where country_code = 'UG' and status = 'published' order by version desc limit 1
    `;
    const catalogue = (published[0]?.content as OnboardingCatalogue | undefined) ?? UGANDA_ONBOARDING_CATALOGUE;
    const catalogueVersion = Number(published[0]?.version ?? catalogue.version);
    const selection = body.catalogueTitleCode
      ? resolveCatalogueTitle(catalogue, body.catalogueTitleCode, body.catalogueCadreCode || null)
      : null;
    if (selection && body.requestedSystemRoles.length) {
      const allowed = new Set(selection.requestedSystemRoles);
      const unexpected = body.requestedSystemRoles.filter((role) => !allowed.has(role));
      if (unexpected.length) {
        throw new ValidationError("Requested system roles are not suggested by the selected catalogue title", { unexpected });
      }
    }
    const unknownSpecialties = body.specialtyCodes.filter((code) => !catalogue.specialties.some((specialty) => specialty.code === code));
    if (unknownSpecialties.length) throw new ValidationError("Unknown catalogue specialty", { unknownSpecialties });
    const departmentIds = [...new Set([body.primaryDepartmentId, ...body.additionalDepartmentIds].filter((id): id is string => Boolean(id)))];
    const departments = new Map<string, { id: string; code: string; catalogue_code: string | null }>();
    for (const departmentId of departmentIds) {
      const department = await requireRows(await tx`
        select id, code, catalogue_code from departments where id = ${departmentId} and tenant_id = ${auth.activeTenant!.id}
      `, "The selected department does not exist");
      if (selection) {
        const departmentCode = String(department.catalogueCode ?? department.code ?? "");
        if (department.catalogueCode && !selection.departmentCodes.includes(departmentCode)) {
          throw new ValidationError(`The selected department is not listed for ${selection.title.name}`, {
            allowedDepartmentCodes: selection.departmentCodes,
          });
        }
      }
      departments.set(departmentId, department as unknown as { id: string; code: string; catalogue_code: string | null });
    }
    let jobTitleId = body.jobTitleId ?? null;
    if (jobTitleId) {
      const title = await requireRows(await tx`
        select id, code, catalogue_code from job_titles where id = ${jobTitleId} and tenant_id = ${auth.activeTenant!.id}
      `, "The selected job title does not exist");
      if (selection) {
        const selectedCode = String(title.catalogueCode ?? title.code ?? "");
        if (selectedCode && selectedCode !== selection.title.code) {
          throw new ValidationError("The selected job title does not match the catalogue title");
        }
      }
      jobTitleId = String(title.id);
    } else if (selection) {
      jobTitleId = await ensureCatalogueJobTitle(tx, auth.activeTenant!.id, selection.title);
    }
    let customTitleRequest: { id: string; status: string; approvedJobTitleId: string | null } | null = null;
    if (body.customTitleRequestId) {
      const request = await requireRows(await tx`
        select id, status, approved_job_title_id from job_title_requests
         where id = ${body.customTitleRequestId} and tenant_id = ${auth.activeTenant!.id}
      `, "Custom title request not found");
      if (!["pending", "approved"].includes(String(request.status))) {
        throw new ValidationError("The custom title request has already been rejected");
      }
      customTitleRequest = {
        id: String(request.id),
        status: String(request.status),
        approvedJobTitleId: request.approvedJobTitleId ? String(request.approvedJobTitleId) : null,
      };
      if (selection) throw new ValidationError("A catalogue title and a custom title request cannot both be selected");
      if (customTitleRequest.approvedJobTitleId) jobTitleId = customTitleRequest.approvedJobTitleId;
    }
    const cadreCode = selection?.cadreCode ?? body.catalogueCadreCode ?? null;
    const policies = cadreCode
      ? await tx`
          select cadre_code, credential_type, regulator_code, requires_document, requires_licence, review_required
            from facility_credential_policies
           where tenant_id = ${auth.activeTenant!.id} and active and (cadre_code = ${cadreCode} or cadre_code is null)
        `
      : [];
    let staffId: string;
    let staffRef: string;
    let reusedStaffPerson = false;
    if (body.staffPersonId) {
      const staff = await requireRows(await tx`
        select id, staff_ref from staff_persons where id = ${body.staffPersonId}
      `, "The existing staff person was not found");
      staffId = String(staff.id);
      staffRef = String(staff.staffRef);
      reusedStaffPerson = true;
      const duplicate = await tx`
        select id from engagements
         where tenant_id = ${auth.activeTenant!.id} and staff_person_id = ${staffId}
           and status not in ('ended','terminated')
         limit 1
      `;
      if (duplicate.length) throw new ConflictError("This staff person already has an active or pending affiliation at this facility");
    } else {
      staffId = crypto.randomUUID();
      staffRef = await uniqueStaffReference(tx);
      await tx`
        insert into staff_persons (id, staff_ref, given_name, family_name, preferred_name, professional_display_name, email, phone, preferred_language)
        values (${staffId}, ${staffRef}, ${body.givenName}, ${body.familyName}, ${body.preferredName || null},
          ${body.professionalDisplayName || null}, ${body.email || null}, ${body.phone || null}, ${body.preferredLanguage})
      `;
    }
    await tx`
      insert into engagements (id, tenant_id, staff_person_id, employee_number, engagement_type, employer, start_date, end_date,
        job_title_id, grade, status)
      values (${engagementId}, ${auth.activeTenant!.id}, ${staffId}, ${body.employeeNumber || null}, ${body.engagementType},
        ${body.employer || null}, ${body.startDate}, ${body.endDate ?? null}, ${jobTitleId}, ${body.grade || null}, 'pending')
    `;
    for (const [index, departmentId] of departmentIds.entries()) {
      const isPrimary = departmentId === body.primaryDepartmentId;
      await tx`
        insert into department_assignments (id, tenant_id, engagement_id, department_id, unit_id, is_primary, appointment_title, starts_on, created_by)
        values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${engagementId}, ${departmentId},
          ${isPrimary ? body.primaryUnitId ?? null : null}, ${isPrimary || (index === 0 && !body.primaryDepartmentId)},
          ${body.appointmentTitle || null}, ${body.startDate}, ${auth.user.id})
      `;
    }
    const requestedSystemRoles = body.requestedSystemRoles.length
      ? body.requestedSystemRoles
      : selection?.requestedSystemRoles ?? [];
    await tx`
      insert into onboarding_cases (id, tenant_id, staff_person_id, engagement_id, status, current_step, data, created_by,
        path, catalogue_country_code, catalogue_version, catalogue_title_code, catalogue_cadre_code,
        regulator_codes, credential_required, requested_system_roles, specialty_codes, custom_title_request_id,
        credential_policy_snapshot)
      values (${caseId}, ${auth.activeTenant!.id}, ${staffId}, ${engagementId}, 'invited', 1,
        ${tx.json({
          cadreId: body.cadreId ?? null,
          source: "workforce-onboarding",
          staffPersonReused: reusedStaffPerson,
          additionalDepartmentIds: departmentIds.filter((id) => id !== body.primaryDepartmentId),
          catalogue: selection ? { countryCode: "UG", version: catalogueVersion, title: selection.title, path: selection.path } : null,
          customTitleRequest: customTitleRequest
            ? { id: customTitleRequest.id, status: customTitleRequest.status, grantsNothing: true }
            : null,
        } as never)}, ${auth.user.id}, ${selection?.path ?? "administrative"}, ${selection ? "UG" : null},
        ${selection ? catalogueVersion : null}, ${selection?.title.code ?? null}, ${cadreCode},
        ${selection?.regulatorCodes ?? []}, ${selection?.credentialRequired ?? false}, ${requestedSystemRoles},
        ${body.specialtyCodes}, ${body.customTitleRequestId ?? null},
        ${tx.json({ catalogueVersion, cadreCode, policies } as never)})
    `;
    if (customTitleRequest) {
      await tx`
        update job_title_requests set onboarding_case_id = ${caseId}, updated_at = now()
         where id = ${customTitleRequest.id} and requested_by = ${auth.user.id} and status = 'pending'
      `;
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "workforce.onboarding.start", {
      resourceType: "OnboardingCase", resourceId: caseId,
      metadata: {
        staffRef, engagementId, engagementType: body.engagementType,
        departmentId: body.primaryDepartmentId ?? null,
        additionalDepartmentIds: departmentIds.filter((id) => id !== body.primaryDepartmentId),
        reusedStaffPerson,
        path: selection?.path ?? "administrative",
        catalogueTitleCode: selection?.title.code ?? null,
        catalogueVersion: selection ? catalogueVersion : null,
        specialtyCodes: body.specialtyCodes,
        customTitleRequestId: body.customTitleRequestId ?? null,
        credentialPolicySnapshotRows: policies.length,
      },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "workforce.onboarding.started", aggregateId: caseId, payload: { staffRef } });
    return { caseId, staffId, engagementId, staffRef, path: selection?.path ?? "administrative", requestedSystemRoles };
  });
  return c.json({ ok: true, onboarding: result }, 201);
});

organizationRoutes.get("/workforce/onboarding/:id", async (c) => {
  requireStaff(c);
  assertWorkforceAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const data = await withStaffActor(c, async (tx) => {
    const rows = await tx`
      select o.*, s.staff_ref, s.given_name, s.family_name, s.email, s.phone,
             e.engagement_type, e.status as engagement_status, e.start_date, e.end_date
        from onboarding_cases o
        join staff_persons s on s.id = o.staff_person_id
        left join engagements e on e.id = o.engagement_id
       where o.id = ${id} and o.tenant_id = ${auth.activeTenant!.id}
    `;
    const record = await requireRows(rows, "Onboarding case not found");
    const assignments = await tx`
      select a.id, a.department_id, a.unit_id, a.is_primary, a.appointment_title, a.starts_on, a.ends_on,
             d.name as department_name, u.name as unit_name
        from department_assignments a
        left join departments d on d.id = a.department_id
        left join units u on u.id = a.unit_id
       where a.engagement_id = ${record.engagementId}
       order by a.starts_on desc
    `;
    const privileges = await tx`
      select g.id, g.status, g.scope, g.effective_from, g.expires_on, p.code, p.name
        from privilege_grants g join privilege_catalog p on p.id = g.privilege_id
       where g.engagement_id = ${record.engagementId}
       order by g.requested_at desc
    `;
    return { onboarding: record, assignments, privileges };
  });
  return c.json(data);
});

organizationRoutes.patch("/workforce/onboarding/:id", async (c) => {
  requireStaff(c);
  assertWorkforceAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, onboardingUpdateSchema);
  await withStaffActor(c, async (tx) => {
    const current = await requireRows(await tx`
      select id, status, current_step, data from onboarding_cases
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Onboarding case not found");
    const from = String(current.status) as OnboardingStatus;
    if (body.status && body.status !== from && !canAdvanceOnboarding(from, body.status)) {
      throw new ConflictError(`Cannot move onboarding from ${from} to ${body.status}`);
    }
    await tx`
      update onboarding_cases set
        status = ${body.status ?? from},
        current_step = ${body.currentStep ?? Number(current.currentStep)},
        data = ${body.data ? tx.json(body.data as never) : tx.json(current.data as never)},
        submitted_at = case when ${body.status === "review"} then now() else submitted_at end,
        submitted_by = case when ${body.status === "review"} then ${auth.user.id}::uuid else submitted_by end,
        updated_at = now()
       where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "workforce.onboarding.update", {
      resourceType: "OnboardingCase", resourceId: id, metadata: { from, to: body.status ?? from },
    }));
  });
  return c.json({ ok: true });
});

organizationRoutes.post("/workforce/onboarding/:id/decision", async (c) => {
  requireStaff(c);
  assertWorkforceAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, onboardingDecisionSchema);
  await withStaffActor(c, async (tx) => {
    const current = await requireRows(await tx`
      select id, status, staff_person_id, engagement_id from onboarding_cases
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Onboarding case not found");
    const from = String(current.status) as OnboardingStatus;
    if (!["review", "induction", "access"].includes(from)) {
      throw new ConflictError("Onboarding must reach review before a decision can be recorded");
    }
    if (body.decision === "approve") {
      if (!current.engagementId) throw new ConflictError("An engagement is required before approval");
      await tx`
        update engagements set status = 'active', approved_by = ${auth.user.id}, approved_at = now(), updated_at = now()
         where id = ${current.engagementId} and tenant_id = ${auth.activeTenant!.id}
      `;
      await tx`
        update onboarding_cases set status = 'active', reviewed_by = ${auth.user.id}, reviewed_at = now(),
          decision_reason = ${body.reason}, updated_at = now() where id = ${id}
      `;
    } else if (body.decision === "reject") {
      await tx`
        update engagements set status = 'withdrawn', updated_at = now()
         where id = ${current.engagementId} and tenant_id = ${auth.activeTenant!.id}
      `;
      await tx`
        update onboarding_cases set status = 'rejected', reviewed_by = ${auth.user.id}, reviewed_at = now(),
          decision_reason = ${body.reason}, updated_at = now() where id = ${id}
      `;
    } else {
      await tx`
        update onboarding_cases set status = 'credentials', reviewed_by = ${auth.user.id}, reviewed_at = now(),
          decision_reason = ${body.reason}, updated_at = now() where id = ${id}
      `;
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, `workforce.onboarding.${body.decision}`, {
      resourceType: "OnboardingCase", resourceId: id,
      metadata: { from, reason: body.reason, engagementId: current.engagementId ?? null },
    }));
    await writeOutbox(tx, {
      tenantId: auth.activeTenant!.id, eventType: `workforce.onboarding.${body.decision}`, aggregateId: id,
      payload: { staffPersonId: current.staffPersonId },
    });
  });
  return c.json({ ok: true });
});

organizationRoutes.post("/workforce/engagements/:id/assignments", async (c) => {
  requireStaff(c);
  assertWorkforceAccess(requestActor(c));
  const auth = c.get("auth")!;
  const engagementId = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, assignmentSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const engagement = await tx`
      select id from engagements where id = ${engagementId} and tenant_id = ${auth.activeTenant!.id} and status <> 'withdrawn'
    `;
    if (!engagement[0]) throw new NotFoundError("Engagement not found");
    const department = await tx`select id from departments where id = ${body.departmentId} and tenant_id = ${auth.activeTenant!.id}`;
    if (!department[0]) throw new ValidationError("The selected department does not exist");
    if (body.unitId) {
      const unit = await tx`select id from units where id = ${body.unitId} and department_id = ${body.departmentId} and tenant_id = ${auth.activeTenant!.id}`;
      if (!unit[0]) throw new ValidationError("The selected unit does not belong to the department");
    }
    if (body.isPrimary) {
      const existing = await tx`
        select id from department_assignments where engagement_id = ${engagementId} and is_primary and ends_on is null
      `;
      if (existing[0]) throw new ConflictError("This engagement already has an active primary assignment");
    }
    await tx`
      insert into department_assignments (id, tenant_id, engagement_id, department_id, unit_id, location_id, is_primary,
        appointment_title, reporting_manager_staff_id, on_call_eligible, starts_on, ends_on, created_by)
      values (${id}, ${auth.activeTenant!.id}, ${engagementId}, ${body.departmentId}, ${body.unitId ?? null}, ${body.locationId ?? null},
        ${body.isPrimary}, ${body.appointmentTitle || null}, ${body.reportingManagerStaffId ?? null}, ${body.onCallEligible},
        ${body.startsOn}, ${body.endsOn ?? null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "workforce.assignment.create", {
      resourceType: "DepartmentAssignment", resourceId: id, metadata: { engagementId, departmentId: body.departmentId, isPrimary: body.isPrimary },
    }));
  });
  return c.json({ ok: true, assignment: { id } }, 201);
});

organizationRoutes.get("/workforce/privileges", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select id, code, name, category, requires_credential, description, active
      from privilege_catalog where tenant_id = ${auth.activeTenant!.id} order by category, name
  `);
  return c.json({ privileges: rows });
});

organizationRoutes.post("/workforce/engagements/:id/privileges", async (c) => {
  requireStaff(c);
  assertWorkforceAccess(requestActor(c));
  const auth = c.get("auth")!;
  const engagementId = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, privilegeRequestSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const engagement = await tx`
      select id from engagements where id = ${engagementId} and tenant_id = ${auth.activeTenant!.id} and status <> 'withdrawn'
    `;
    if (!engagement[0]) throw new NotFoundError("Engagement not found");
    const privilege = await tx`
      select id from privilege_catalog where id = ${body.privilegeId} and tenant_id = ${auth.activeTenant!.id} and active
    `;
    if (!privilege[0]) throw new ValidationError("The selected privilege does not exist");
    const existing = await tx`
      select id from privilege_grants where engagement_id = ${engagementId} and privilege_id = ${body.privilegeId}
        and status in ('requested','approved')
    `;
    if (existing[0]) throw new ConflictError("An active request or grant already exists for this privilege");
    await tx`
      insert into privilege_grants (id, tenant_id, engagement_id, privilege_id, scope, requested_by, expires_on)
      values (${id}, ${auth.activeTenant!.id}, ${engagementId}, ${body.privilegeId}, ${body.scope || null}, ${auth.user.id}, ${body.expiresOn ?? null})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "workforce.privilege.request", {
      resourceType: "PrivilegeGrant", resourceId: id, metadata: { engagementId, privilegeId: body.privilegeId },
    }));
  });
  return c.json({ ok: true, grant: { id } }, 201);
});

organizationRoutes.get("/workforce/privilege-grants", async (c) => {
  requireStaff(c);
  assertWorkforceAccess(requestActor(c));
  const auth = c.get("auth")!;
  const status = c.req.query("status");
  const rows = await withStaffActor(c, async (tx) => tx`
    select g.id, g.status, g.scope, g.requested_at, g.reviewed_at, g.effective_from, g.expires_on, g.decision_reason,
           p.code as privilege_code, p.name as privilege_name, p.category, p.requires_credential,
           s.given_name, s.family_name, s.staff_ref, e.id as engagement_id
      from privilege_grants g
      join privilege_catalog p on p.id = g.privilege_id
      join engagements e on e.id = g.engagement_id
      join staff_persons s on s.id = e.staff_person_id
     where g.tenant_id = ${auth.activeTenant!.id}
       ${status ? tx`and g.status = ${status}` : tx``}
     order by g.requested_at desc limit 200
  `);
  return c.json({ grants: rows });
});

organizationRoutes.post("/workforce/privilege-grants/:id/decision", async (c) => {
  requireStaff(c);
  if (!hasRole(c, "clinician", "facility_admin")) throw new ForbiddenError("Privilege review requires a clinical reviewer or facility administrator");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, privilegeDecisionSchema);
  await withStaffActor(c, async (tx) => {
    const grant = await requireRows(await tx`
      select g.id, g.status, g.scope, p.requires_credential, p.name
        from privilege_grants g join privilege_catalog p on p.id = g.privilege_id
       where g.id = ${id} and g.tenant_id = ${auth.activeTenant!.id} for update
    `, "Privilege grant not found");
    if (grant.status !== "requested") throw new ConflictError("Only a requested privilege can be decided");
    const effectiveFrom = body.effectiveFrom ?? new Date().toISOString().slice(0, 10);
    await tx`
      update privilege_grants set status = ${body.decision}, scope = ${body.scope || grant.scope || null},
        reviewed_by = ${auth.user.id}, reviewed_at = now(), decision_reason = ${body.reason},
        effective_from = ${body.decision === "approved" ? effectiveFrom : null},
        expires_on = ${body.expiresOn ?? null}
       where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, `workforce.privilege.${body.decision}`, {
      resourceType: "PrivilegeGrant", resourceId: id,
      metadata: { privilege: grant.name, requiresCredential: grant.requiresCredential, reason: body.reason },
    }));
  });
  return c.json({ ok: true });
});

organizationRoutes.post("/workforce/engagements/:id/training", async (c) => {
  requireStaff(c);
  assertWorkforceAccess(requestActor(c));
  const auth = c.get("auth")!;
  const engagementId = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, trainingRecordSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const engagement = await tx`
      select id from engagements where id = ${engagementId} and tenant_id = ${auth.activeTenant!.id} and status <> 'withdrawn'
    `;
    if (!engagement[0]) throw new NotFoundError("Engagement not found");
    await tx`
      insert into training_records (id, tenant_id, engagement_id, training_type, completed_on, expires_on, notes, verified_by, verified_at)
      values (${id}, ${auth.activeTenant!.id}, ${engagementId}, ${body.trainingType}, ${body.completedOn ?? null},
        ${body.expiresOn ?? null}, ${body.notes || null}, ${auth.user.id}, now())
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "workforce.training.record", {
      resourceType: "TrainingRecord", resourceId: id, metadata: { engagementId, trainingType: body.trainingType },
    }));
  });
  return c.json({ ok: true, training: { id } }, 201);
});
