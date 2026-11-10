import { Hono } from "hono";
import {
  listCadres,
  getCadre,
  searchCadres,
  searchCadresGrouped,
  getRegulatorsForCadre,
  listJobTitles,
  getJobTitle,
  getTitlesByCadre,
  listSpecialties,
  getSpecialty,
  getSpecialtiesByCadre,
  listDepartments,
  getDepartment,
  listRegulators,
  getRegulator,
  listCapabilities,
  getCapability,
  getCapabilitiesByCategory,
  suggestCapabilities,
  listPayrollGrades,
  getPayrollGrade,
} from "@medveris/reference";
import { isPlatformOperator, requireAuth } from "../auth/middleware.js";
import { requestActor } from "../lib/actor.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

export const workforceReferenceRoutes = new Hono<AppEnv>();

// ============================================================================
// CADRES
// ============================================================================

workforceReferenceRoutes.get("/reference/cadres", async (c) => {
  requireAuth(c);
  const query = c.req.query("q") || undefined;
  const group = c.req.query("group") === "true";
  const category = c.req.query("category") || undefined;

  if (group) {
    const grouped = searchCadresGrouped(query, category);
    return c.json({ cadres: grouped, count: Object.values(grouped).flat().length });
  }

  const cadres = query
    ? searchCadres(query, category)
    : listCadres(category);
  return c.json({ cadres, count: cadres.length });
});

workforceReferenceRoutes.get("/reference/cadres/:code", async (c) => {
  requireAuth(c);
  const code = c.req.param("code").toUpperCase();
  const cadre = getCadre(code);
  if (!cadre) throw new NotFoundError("Professional cadre not found");
  const regulators = getRegulatorsForCadre(code);
  const jobTitles = getTitlesByCadre(code);
  const specialties = getSpecialtiesByCadre(code);
  return c.json({ cadre, regulators, jobTitles, specialties });
});

// ============================================================================
// JOB TITLES
// ============================================================================

workforceReferenceRoutes.get("/reference/job-titles", async (c) => {
  requireAuth(c);
  const query = c.req.query("q") || undefined;
  const cadreCode = c.req.query("cadreCode") || undefined;

  if (cadreCode) {
    const titles = getTitlesByCadre(cadreCode);
    if (query) {
      const lower = query.toLowerCase();
      return c.json({ jobTitles: titles.filter((t) => t.name.toLowerCase().includes(lower) || t.code.toLowerCase().includes(lower)) });
    }
    return c.json({ jobTitles: titles });
  }

  const titles = query
    ? listJobTitles().filter(
        (t) => t.name.toLowerCase().includes(query.toLowerCase()) || t.code.toLowerCase().includes(query.toLowerCase())
      )
    : listJobTitles();
  return c.json({ jobTitles: titles, count: titles.length });
});

workforceReferenceRoutes.get("/reference/job-titles/:code", async (c) => {
  requireAuth(c);
  const code = c.req.param("code").toUpperCase();
  const title = getJobTitle(code);
  if (!title) throw new NotFoundError("Job title not found");
  return c.json({ jobTitle: title });
});

// ============================================================================
// SPECIALTIES
// ============================================================================

workforceReferenceRoutes.get("/reference/specialties", async (c) => {
  requireAuth(c);
  const query = c.req.query("q") || undefined;
  const cadreCode = c.req.query("cadreCode") || undefined;

  if (cadreCode) {
    const specialties = getSpecialtiesByCadre(cadreCode);
    if (query) {
      const lower = query.toLowerCase();
      return c.json({ specialties: specialties.filter((s) => s.name.toLowerCase().includes(lower) || s.code.toLowerCase().includes(lower)) });
    }
    return c.json({ specialties });
  }

  const specialties = query
    ? listSpecialties().filter(
        (s) => s.name.toLowerCase().includes(query.toLowerCase()) || s.code.toLowerCase().includes(query.toLowerCase())
      )
    : listSpecialties();
  return c.json({ specialties, count: specialties.length });
});

workforceReferenceRoutes.get("/reference/specialties/:code", async (c) => {
  requireAuth(c);
  const code = c.req.param("code").toUpperCase();
  const specialty = getSpecialty(code);
  if (!specialty) throw new NotFoundError("Specialty not found");
  return c.json({ specialty });
});

// ============================================================================
// DEPARTMENTS
// ============================================================================

workforceReferenceRoutes.get("/reference/departments", async (c) => {
  requireAuth(c);
  const query = c.req.query("q") || undefined;
  const unitType = c.req.query("unitType") || undefined;

  const departments = query
    ? listDepartments(unitType).filter(
        (d) => d.name.toLowerCase().includes(query.toLowerCase()) || d.code.toLowerCase().includes(query.toLowerCase())
      )
    : listDepartments(unitType);
  return c.json({ departments, count: departments.length });
});

workforceReferenceRoutes.get("/reference/departments/:code", async (c) => {
  requireAuth(c);
  const code = c.req.param("code").toUpperCase();
  const department = getDepartment(code);
  if (!department) throw new NotFoundError("Department not found");
  return c.json({ department });
});

// ============================================================================
// REGULATORS
// ============================================================================

workforceReferenceRoutes.get("/reference/regulators", async (c) => {
  requireAuth(c);
  const query = c.req.query("q") || undefined;
  const regulators = query
    ? listRegulators().filter(
        (r) => r.name.toLowerCase().includes(query.toLowerCase()) || r.code.toLowerCase().includes(query.toLowerCase())
      )
    : listRegulators();
  return c.json({ regulators, count: regulators.length });
});

workforceReferenceRoutes.get("/reference/regulators/:code", async (c) => {
  requireAuth(c);
  const code = c.req.param("code").toUpperCase();
  const regulator = getRegulator(code);
  if (!regulator) throw new NotFoundError("Regulatory body not found");
  return c.json({ regulator });
});

// ============================================================================
// CAPABILITIES
// ============================================================================

workforceReferenceRoutes.get("/reference/capabilities", async (c) => {
  requireAuth(c);
  const query = c.req.query("q") || undefined;
  const category = c.req.query("category") || undefined;
  const cadreCode = c.req.query("cadreCode") || undefined;
  const specialtyCodes = c.req.query("specialtyCodes")?.split(",").filter(Boolean) || undefined;

  if (cadreCode || specialtyCodes?.length) {
    const capabilities = suggestCapabilities(cadreCode || undefined, specialtyCodes);
    if (query) {
      const lower = query.toLowerCase();
      return c.json({ capabilities: capabilities.filter((c) => c.name.toLowerCase().includes(lower) || c.code.toLowerCase().includes(lower)) });
    }
    return c.json({ capabilities });
  }

  const capabilities = category
    ? getCapabilitiesByCategory(category)
    : listCapabilities();

  if (query) {
    const lower = query.toLowerCase();
    return c.json({ capabilities: capabilities.filter((c) => c.name.toLowerCase().includes(lower) || c.code.toLowerCase().includes(lower)) });
  }

  return c.json({ capabilities, count: capabilities.length });
});

workforceReferenceRoutes.get("/reference/capabilities/:code", async (c) => {
  requireAuth(c);
  const code = c.req.param("code").toUpperCase();
  const capability = getCapability(code);
  if (!capability) throw new NotFoundError("Clinical capability not found");
  return c.json({ capability });
});

// ============================================================================
// PAYROLL GRADES
// ============================================================================

workforceReferenceRoutes.get("/reference/payroll-grades", async (c) => {
  requireAuth(c);
  const query = c.req.query("q") || undefined;
  const grades = query
    ? listPayrollGrades().filter(
        (g) => g.name.toLowerCase().includes(query.toLowerCase()) || g.code.toLowerCase().includes(query.toLowerCase())
      )
    : listPayrollGrades();
  return c.json({ payrollGrades: grades, count: grades.length });
});

workforceReferenceRoutes.get("/reference/payroll-grades/:code", async (c) => {
  requireAuth(c);
  const code = c.req.param("code").toUpperCase();
  const grade = getPayrollGrade(code);
  if (!grade) throw new NotFoundError("Payroll grade not found");
  return c.json({ payrollGrade: grade });
});

// ============================================================================
// PLATFORM GOVERNANCE - Reference Data Management
// ============================================================================

workforceReferenceRoutes.get("/reference/admin/catalogue", async (c) => {
  requireAuth(c);
  if (!isPlatformOperator(c)) throw new ForbiddenError("Platform operator permission is required");
  const auth = c.get("auth")!;
  requestActor(c);
  return c.json({
    catalogue: {
      cadres: { count: listCadres().length, active: listCadres().filter((c) => c.active).length },
      jobTitles: { count: listJobTitles().length, active: listJobTitles().filter((t) => t.active).length },
      specialties: { count: listSpecialties().length, active: listSpecialties().filter((s) => s.active).length },
      departments: { count: listDepartments().length, active: listDepartments().filter((d) => d.active).length },
      regulators: { count: listRegulators().length, active: listRegulators().filter((r) => r.active).length },
      capabilities: { count: listCapabilities().length, active: listCapabilities().filter((c) => c.active).length },
      payrollGrades: { count: listPayrollGrades().length, active: listPayrollGrades().filter((g) => g.active).length },
    },
    managedBy: { id: auth.user.id, displayName: auth.user.displayName },
    timestamp: new Date().toISOString(),
  });
});

// ============================================================================
// ONBOARDING HELPERS
// ============================================================================

workforceReferenceRoutes.get("/reference/onboarding/cadre-specialty", async (c) => {
  requireAuth(c);
  const cadreCode = c.req.query("cadreCode");
  if (!cadreCode) throw new ValidationError("cadreCode is required");

  const cadre = getCadre(cadreCode);
  if (!cadre) throw new NotFoundError("Professional cadre not found");

  const specialties = getSpecialtiesByCadre(cadreCode);
  const regulators = getRegulatorsForCadre(cadreCode);
  const jobTitles = getTitlesByCadre(cadreCode);

  return c.json({
    cadre,
    specialties,
    regulators,
    jobTitles,
    requiresRegistration: cadre.requiresRegistration,
    regulatoryBodyCodes: cadre.regulatoryBodyCodes,
  });
});

workforceReferenceRoutes.post("/reference/onboarding/validate-specialty", async (c) => {
  requireAuth(c);
  const body = await c.req.json();
  const { cadreCode, specialtyCode } = body as { cadreCode: string; specialtyCode: string };

  if (!cadreCode || !specialtyCode) {
    throw new ValidationError("cadreCode and specialtyCode are required");
  }

  const specialty = getSpecialty(specialtyCode);
  if (!specialty) throw new ValidationError("Specialty not found");

  if (!specialty.cadreCodes.includes(cadreCode.toUpperCase())) {
    throw new ValidationError("This specialty is not available for the selected cadre");
  }

  return c.json({ valid: true, specialty });
});
