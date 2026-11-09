import cadresRaw from "../../../assets/workforce/professional-cadres.json";
import specialtiesRaw from "../../../assets/workforce/clinical-specialties.json";
import capabilitiesRaw from "../../../assets/workforce/clinical-capabilities.json";
import governanceRaw from "../../../assets/workforce/governance-reference.json";
import departmentsRaw from "../../../assets/workforce/departments.json";
import type { Cadre, JobTitle, Specialty, Department, Regulator, Capability, PayrollGrade } from "./types.js";

export * from "./types.js";

type RawCadre = { code: string; name: string; category: string; description?: string; regulatorCodes: string[]; requiresRegistration: boolean };
type RawSpecialty = { code: string; name: string; cadreCodes: string[]; departmentCodes: string[]; description?: string };
type RawCapability = { code: string; name: string; category: string; description?: string };
type RawRegulator = { code: string; name: string; regulatorType: string; country?: string; verificationMode: string; website?: string; notes?: string };
type RawDepartment = { code: string; name: string; description?: string; sortOrder?: number };

function toCadre(r: RawCadre): Cadre {
  const codes = r.regulatorCodes ?? [];
  return {
    code: r.code,
    name: r.name,
    category: r.category,
    description: r.description,
    regulatorCodes: codes,
    regulatoryBodyCodes: codes,
    requiresRegistration: Boolean(r.requiresRegistration),
    isco08Code: null,
    isco08Reviewed: false,
    active: true,
    version: 1,
  };
}

function toSpecialty(r: RawSpecialty): Specialty {
  const codes = r.cadreCodes ?? [];
  return {
    code: r.code,
    name: r.name,
    cadreCode: codes.length === 1 ? codes[0]! : codes[0] ?? null,
    cadreCodes: codes,
    departmentCodes: r.departmentCodes ?? [],
    description: r.description,
    active: true,
    version: 1,
  };
}

function toCapability(r: RawCapability): Capability {
  return { code: r.code, name: r.name, category: r.category, description: r.description, active: true, version: 1 };
}

function toRegulator(r: RawRegulator): Regulator {
  return {
    code: r.code,
    name: r.name,
    regulatorType: r.regulatorType,
    country: r.country ?? "UG",
    verificationMode: r.verificationMode,
    website: r.website,
    notes: r.notes,
    active: true,
    version: 1,
  };
}

function toDepartment(r: RawDepartment): Department {
  return { code: r.code, name: r.name, description: r.description, sortOrder: r.sortOrder ?? 0, active: true, version: 1 };
}

const CADRES: Cadre[] = ((cadresRaw as { cadres: RawCadre[] }).cadres ?? []).map(toCadre);
const SPECIALTIES: Specialty[] = ((specialtiesRaw as { specialties: RawSpecialty[] }).specialties ?? []).map(toSpecialty);
const CAPABILITIES: Capability[] = ((capabilitiesRaw as { capabilities: RawCapability[] }).capabilities ?? []).map(toCapability);
const REGULATORS: Regulator[] = ((governanceRaw as { regulators: RawRegulator[] }).regulators ?? []).map(toRegulator);
const DEPARTMENTS: Department[] = ((departmentsRaw as { departments: RawDepartment[] }).departments ?? []).map(toDepartment);

function jobTitle(
  code: string,
  name: string,
  cadreCode: string,
  seniority: JobTitle["seniority"],
  departmentCodes: string[],
  requiresCredential: boolean,
  privilegeCodes: string[],
  suggestedSystemRoles: string[],
): JobTitle {
  return { code, name, cadreCode, seniority, departmentCodes, requiresCredential, privilegeCodes, suggestedSystemRoles, active: true, version: 1 };
}

const JOB_TITLES: JobTitle[] = [
  jobTitle("MED-OFF-STD", "Medical Officer", "MED-OFF", "standard", ["OPD", "EMERG", "WARD", "MAT", "PED", "CRIT"], true, ["CLIN-ASSESS", "CLIN-SIGN", "PRESCRIBE", "ORDER-DIAG"], ["clinician"]),
  jobTitle("MED-OFF-SEN", "Senior Medical Officer", "MED-OFF", "senior", ["OPD", "WARD", "EMERG"], true, ["CLIN-ASSESS", "CLIN-SIGN", "PRESCRIBE", "ORDER-DIAG"], ["clinician"]),
  jobTitle("CONSULTANT-STD", "Consultant Physician", "CONSULTANT", "consultant", ["OPD", "WARD", "CRIT"], true, ["CLIN-ASSESS", "CLIN-SIGN", "PRESCRIBE", "ORDER-DIAG"], ["specialist_clinician"]),
  jobTitle("SPEC-PHYS-STD", "Specialist Physician", "SPEC-PHYS", "senior", ["OPD", "WARD"], true, ["CLIN-ASSESS", "CLIN-SIGN", "PRESCRIBE"], ["specialist_clinician"]),
  jobTitle("SURGEON-STD", "Surgeon", "SURGEON", "standard", ["THEATRE", "WARD"], true, ["CLIN-ASSESS", "CLIN-SIGN", "THEATRE-SCRUB"], ["specialist_clinician"]),
  jobTitle("ANESTH-STD", "Anaesthesiologist", "ANESTH", "standard", ["THEATRE", "CRIT"], true, ["THEATRE-ANES", "CRIT-CARE"], ["specialist_clinician"]),
  jobTitle("OBGYN-STD", "Obstetrician and Gynaecologist", "OBGYN", "standard", ["MAT", "THEATRE"], true, ["MAT-LABOUR", "THEATRE-SCRUB"], ["specialist_clinician"]),
  jobTitle("PEDIATRICIAN-STD", "Paediatrician", "PEDIATRICIAN", "standard", ["PED", "OPD"], true, ["CLIN-ASSESS", "MAT-NEWBORN"], ["specialist_clinician"]),
  jobTitle("PSYCHIATRIST-STD", "Psychiatrist", "PSYCHIATRIST", "standard", ["MH", "OPD"], true, ["CLIN-ASSESS", "CLIN-SIGN"], ["specialist_clinician"]),
  jobTitle("PATHOLOGIST-STD", "Pathologist", "PATHOLOGIST", "standard", ["LAB"], true, ["LAB-VERIFY"], ["laboratory"]),
  jobTitle("RADIOLOGIST-STD", "Radiologist", "RADIOLOGIST", "standard", ["RAD"], true, ["RAD-REPORT"], ["radiology"]),
  jobTitle("CLIN-OFF-STD", "Clinical Officer", "CLIN-OFF", "standard", ["OPD", "EMERG", "PRIMARY", "MAT", "PED"], true, ["CLIN-ASSESS", "CLIN-SIGN"], ["clinician"]),
  jobTitle("CLIN-OFF-INTERN", "Clinical Officer Intern", "CLIN-OFF", "entry", ["OPD", "WARD"], true, ["CLIN-ASSESS"], ["clinician"]),
  jobTitle("NURSE-STD", "Registered Nurse", "NURSE", "standard", ["WARD", "OPD", "EMERG", "PED", "CRIT", "MAT", "THEATRE", "LAB", "RAD"], true, ["CLIN-ASSESS", "MAT-NEWBORN"], ["nurse"]),
  jobTitle("NURSE-SEN", "Senior Nursing Officer", "NURSE", "senior", ["WARD", "OPD"], true, ["CLIN-ASSESS", "MAT-NEWBORN"], ["nurse", "department_lead"]),
  jobTitle("NURSE-ENROLLED", "Enrolled Nurse", "NURSE", "entry", ["WARD", "OPD"], true, ["CLIN-ASSESS"], ["nurse"]),
  jobTitle("MIDWIFE-STD", "Midwife", "MIDWIFE", "standard", ["MAT"], true, ["MAT-LABOUR", "MAT-NEWBORN"], ["midwife"]),
  jobTitle("MIDWIFE-SEN", "Senior Midwife", "MIDWIFE", "senior", ["MAT"], true, ["MAT-LABOUR", "MAT-NEWBORN"], ["midwife", "department_lead"]),
  jobTitle("NURSE-ASST-STD", "Nursing Assistant", "NURSE-ASST", "entry", ["WARD", "MAT", "PED"], false, [], []),
  jobTitle("PHARMACIST-STD", "Pharmacist", "PHARMACIST", "standard", ["PHARM"], true, ["PHARM-DISPENSE", "PHARM-CHECK"], ["pharmacist"]),
  jobTitle("PHARMACIST-SEN", "Senior Pharmacist", "PHARMACIST", "senior", ["PHARM"], true, ["PHARM-DISPENSE", "PHARM-CHECK"], ["pharmacist", "department_lead"]),
  jobTitle("PHARM-TECH-STD", "Pharmacy Technician", "PHARM-TECH", "standard", ["PHARM"], true, ["PHARM-DISPENSE"], ["pharmacist"]),
  jobTitle("LAB-SCI-STD", "Laboratory Scientist", "LAB-SCIENTIST", "standard", ["LAB", "BLOOD"], true, ["LAB-VERIFY"], ["laboratory"]),
  jobTitle("LAB-SCI-SEN", "Senior Laboratory Scientist", "LAB-SCIENTIST", "senior", ["LAB"], true, ["LAB-VERIFY"], ["laboratory", "department_lead"]),
  jobTitle("LAB-TECH-STD", "Laboratory Technician", "LAB-TECH", "standard", ["LAB", "BLOOD"], true, [], ["laboratory"]),
  jobTitle("PHLEB-STD", "Phlebotomist", "PHLEBOTOMIST", "entry", ["LAB", "OPD"], false, [], ["laboratory"]),
  jobTitle("RAD-TECH-STD", "Radiographer", "RAD-TECH", "standard", ["RAD"], true, [], ["radiology"]),
  jobTitle("SONO-STD", "Sonographer", "SONOGRAPHER", "standard", ["RAD", "MAT"], true, [], ["radiology"]),
  jobTitle("DENTIST-STD", "Dentist", "DENTIST", "standard", ["DENTAL"], true, ["CLIN-ASSESS", "CLIN-SIGN"], ["clinician"]),
  jobTitle("DENTAL-TECH-STD", "Dental Technician", "DENTAL-TECH", "standard", ["DENTAL"], true, [], []),
  jobTitle("OPTOMETRIST-STD", "Optometrist", "OPTOMETRIST", "standard", ["EYEENT"], true, ["CLIN-ASSESS"], ["clinician"]),
  jobTitle("OPHTHAL-STD", "Ophthalmologist", "OPHTHALMOLOGIST", "standard", ["EYEENT"], true, ["CLIN-ASSESS", "CLIN-SIGN"], ["specialist_clinician"]),
  jobTitle("ENT-STD", "ENT Specialist", "ENT-SPEC", "standard", ["EYEENT"], true, ["CLIN-ASSESS", "CLIN-SIGN"], ["specialist_clinician"]),
  jobTitle("PHYSIO-STD", "Physiotherapist", "PHYSIO", "standard", ["REHAB"], true, ["CLIN-ASSESS"], []),
  jobTitle("OCC-THERAPIST-STD", "Occupational Therapist", "OCC-THERAPIST", "standard", ["REHAB"], true, ["CLIN-ASSESS"], []),
  jobTitle("SPEECH-THERAPIST-STD", "Speech and Language Therapist", "SPEECH-THERAPIST", "standard", ["REHAB", "PED"], true, [], []),
  jobTitle("PSYCHOLOGIST-STD", "Psychologist", "PSYCHOLOGIST", "standard", ["MH"], true, [], []),
  jobTitle("COUNSELLOR-STD", "Counsellor", "COUNSELLOR", "standard", ["MH", "PRIMARY"], false, [], []),
  jobTitle("SOCIAL-WORKER-STD", "Social Worker", "SOCIAL-WORKER", "standard", ["MH", "PALLIATIVE"], false, [], []),
  jobTitle("DIETITIAN-STD", "Dietitian", "DIETITIAN", "standard", ["NUTR"], true, [], []),
  jobTitle("PUBLIC-HEALTH-STD", "Public Health Specialist", "PUBLIC-HEALTH", "standard", ["PRIMARY"], false, [], ["public_health"]),
  jobTitle("CHW-STD", "Community Health Worker", "COMMUNITY-HEALTH", "entry", ["PRIMARY"], false, [], []),
  jobTitle("EMERG-PHYS-STD", "Emergency Medical Officer", "EMERG-PHYS", "standard", ["EMERG"], true, ["CLIN-ASSESS", "CLIN-SIGN"], ["clinician"]),
  jobTitle("PARAMEDIC-STD", "Paramedic", "PARAMEDIC", "standard", ["EMERG"], true, [], []),
  jobTitle("AMB-DRIVER-STD", "Ambulance Driver", "AMB-DRIVER", "standard", ["EMERG"], false, [], []),
  jobTitle("ANAES-PROV-STD", "Anaesthesia Provider", "ANAES-PROV", "standard", ["THEATRE"], true, ["THEATRE-ANES"], ["clinician"]),
  jobTitle("THEATRE-NURSE-STD", "Theatre Nurse", "THEATRE-NURSE", "standard", ["THEATRE"], true, ["THEATRE-SCRUB"], ["nurse"]),
  jobTitle("THEATRE-TECH-STD", "Theatre Technician", "THEATRE-TECH", "standard", ["THEATRE", "CSSD"], false, ["THEATRE-SCRUB", "CSSD-RELEASE"], ["theatre"]),
  jobTitle("RECOVERY-NURSE-STD", "Recovery Nurse", "RECOVERY-NURSE", "standard", ["THEATRE"], true, [], ["nurse"]),
  jobTitle("HEALTH-RECORDS-STD", "Health Records Officer", "HEALTH-RECORDS", "standard", ["ACCESS"], false, [], ["records"]),
  jobTitle("HIM-STD", "Health Information Manager", "HIM", "senior", ["ACCESS"], false, [], ["records", "department_lead"]),
  jobTitle("MED-CODER-STD", "Medical Coder", "MED-CODER", "standard", ["ACCESS"], false, [], ["records"]),
  jobTitle("RECEPTIONIST-STD", "Receptionist", "RECEPTIONIST", "entry", ["ACCESS"], false, [], ["receptionist"]),
  jobTitle("ADMIN-OFF-STD", "Administrative Officer", "ADMIN-OFF", "standard", ["GOV", "ACCESS", "HR", "FIN", "PROC"], false, [], []),
  jobTitle("HOSP-MGR-STD", "Facility Administrator", "HOSP-MGR", "lead", ["GOV"], false, [], ["facility_admin"]),
  jobTitle("IT-ADMIN-STD", "IT Administrator", "IT-ADMIN", "standard", ["IT"], false, [], ["it_admin"]),
  jobTitle("DATA-ANALYST-STD", "Data Analyst", "DATA-ANALYST", "standard", ["IT"], false, [], ["research"]),
  jobTitle("ACCOUNTANT-STD", "Accountant", "ACCOUNTANT", "standard", ["FIN"], false, [], ["finance"]),
  jobTitle("CASHIER-STD", "Cashier", "CASHIER", "entry", ["FIN"], false, [], ["finance"]),
  jobTitle("BILLING-OFF-STD", "Billing Officer", "BILLING-OFF", "standard", ["FIN"], false, [], ["finance"]),
  jobTitle("HR-OFF-STD", "Human Resources Officer", "HR-OFF", "standard", ["HR"], false, [], ["hr"]),
  jobTitle("CRED-OFF-STD", "Credentialing Officer", "CRED-OFF", "standard", ["HR"], false, [], ["hr"]),
  jobTitle("TRAIN-COORD-STD", "Training Coordinator", "TRAIN-COORD", "standard", ["HR", "PRIMARY"], false, [], ["hr"]),
  jobTitle("RESEARCH-COORD-STD", "Research Coordinator", "RESEARCH-COORD", "standard", ["HR"], false, [], ["research"]),
  jobTitle("PROC-OFF-STD", "Procurement Officer", "PROC-OFF", "standard", ["PROC"], false, [], []),
  jobTitle("STOREKEEPER-STD", "Storekeeper", "STOREKEEPER", "entry", ["PROC", "PHARM"], false, [], []),
  jobTitle("BIOMED-STD", "Biomedical Engineering Technician", "BIOMED", "standard", ["ENG"], false, [], ["biomedical"]),
  jobTitle("FAC-MGR-STD", "Facilities Manager", "FAC-MGR", "senior", ["ENG"], false, [], []),
  jobTitle("MORTUARY-TECH-STD", "Mortuary Technician", "MORTUARY-TECH", "standard", ["MORT"], false, ["MORT-RELEASE"], ["mortuary"]),
  jobTitle("HOUSEKEEPER-STD", "Housekeeper", "HOUSEKEEPER", "entry", ["HOUSE"], false, [], ["housekeeping"]),
  jobTitle("PORTER-STD", "Porter", "PORTER", "entry", ["PORTER"], false, [], ["porter"]),
  jobTitle("SEC-OFF-STD", "Security Officer", "SEC-OFF", "standard", ["SEC"], false, [], []),
  jobTitle("COOK-STD", "Cook", "COOK", "entry", ["CATER"], false, [], []),
  jobTitle("SOCIAL-AIDE-STD", "Patient Support Aide", "SOCIAL-AIDE", "entry", ["WARD", "PALLIATIVE"], false, [], []),
  jobTitle("STUDENT-STD", "Student or Intern", "STUDENT", "entry", ["OPD", "WARD", "LAB", "RAD", "PHARM", "THEATRE", "MAT", "PED", "REHAB"], false, [], []),
];

function payrollGrade(code: string, name: string, level: number): PayrollGrade {
  return { code, name, gradeLevel: level, active: true, version: 1 };
}

const PAYROLL_GRADES: PayrollGrade[] = [
  payrollGrade("PS-NO-1", "Public Service Grade 1", 1),
  payrollGrade("PS-NO-2", "Public Service Grade 2", 2),
  payrollGrade("PS-NO-3", "Public Service Grade 3", 3),
  payrollGrade("PS-NO-4", "Public Service Grade 4", 4),
  payrollGrade("PS-NO-5", "Public Service Grade 5", 5),
  payrollGrade("PS-NO-6", "Public Service Grade 6", 6),
  payrollGrade("PS-NO-7", "Public Service Grade 7", 7),
  payrollGrade("PS-NO-8", "Public Service Grade 8", 8),
  payrollGrade("PS-NO-9", "Public Service Grade 9", 9),
  payrollGrade("PS-NO-10", "Public Service Grade 10", 10),
  payrollGrade("PS-NO-11", "Public Service Grade 11", 11),
  payrollGrade("PS-NO-12", "Public Service Grade 12", 12),
  payrollGrade("PHARM-DISP", "Pharmacy Dispenser", 3),
  payrollGrade("NURSE-ENROLLED", "Enrolled Nurse", 3),
  payrollGrade("NURSE-REG", "Registered Nurse", 5),
  payrollGrade("SENIOR-NURSE", "Senior Nurse Officer", 7),
  payrollGrade("LAB-TECH", "Laboratory Technician", 4),
  payrollGrade("LAB-SCIENTIST", "Laboratory Scientist", 6),
  payrollGrade("MED-OFFICER", "Medical Officer", 6),
  payrollGrade("SENIOR-MED-OFF", "Senior Medical Officer", 8),
  payrollGrade("SPECIALIST", "Medical Specialist", 10),
  payrollGrade("CONSULTANT", "Consultant", 12),
  payrollGrade("HEAD-NURSE", "Head Nurse/Principal Nursing Officer", 10),
  payrollGrade("PHARMACIST", "Pharmacist", 6),
  payrollGrade("SENIOR-PHARM", "Senior Pharmacist", 8),
  payrollGrade("HOSP-ASSIST", "Hospital Assistant", 1),
  payrollGrade("CLEANER", "Cleaner", 1),
  payrollGrade("DRIVER", "Driver", 2),
];

function matches(value: string, query: string): boolean {
  return value.toLowerCase().includes(query.toLowerCase());
}

export function listCadres(category?: string): Cadre[] {
  if (!category) return [...CADRES];
  return CADRES.filter((c) => c.category === category);
}

export function getCadre(code: string): Cadre | undefined {
  const c = code.toUpperCase();
  return CADRES.find((x) => x.code === c);
}

export function searchCadres(query: string, category?: string): Cadre[] {
  const pool = category ? CADRES.filter((c) => c.category === category) : CADRES;
  const q = query.trim().toLowerCase();
  if (!q) return [...pool];
  return pool.filter((c) => matches(c.name, q) || matches(c.code, q));
}

export function searchCadresGrouped(query?: string, category?: string): Record<string, Cadre[]> {
  const pool = query ? searchCadres(query, category) : listCadres(category);
  const grouped: Record<string, Cadre[]> = {};
  for (const cadre of pool) {
    const key = cadre.category;
    (grouped[key] ??= []).push(cadre);
  }
  return grouped;
}

export function getRegulatorsForCadre(cadreCode: string): Regulator[] {
  const cadre = getCadre(cadreCode);
  if (!cadre) return [];
  const wanted = new Set(cadre.regulatorCodes);
  return REGULATORS.filter((r) => wanted.has(r.code));
}

export function listJobTitles(): JobTitle[] {
  return [...JOB_TITLES];
}

export function getJobTitle(code: string): JobTitle | undefined {
  const c = code.toUpperCase();
  return JOB_TITLES.find((x) => x.code === c);
}

export function getTitlesByCadre(cadreCode: string): JobTitle[] {
  const c = cadreCode.toUpperCase();
  return JOB_TITLES.filter((t) => t.cadreCode === c);
}

export function listSpecialties(): Specialty[] {
  return [...SPECIALTIES];
}

export function getSpecialty(code: string): Specialty | undefined {
  const c = code.toUpperCase();
  return SPECIALTIES.find((x) => x.code === c);
}

export function getSpecialtiesByCadre(cadreCode: string): Specialty[] {
  const c = cadreCode.toUpperCase();
  return SPECIALTIES.filter((s) => s.cadreCodes.includes(c));
}

export function listDepartments(unitType?: string): Department[] {
  const all = [...DEPARTMENTS].sort((a, b) => a.sortOrder - b.sortOrder);
  if (!unitType) return all;
  return all;
}

export function getDepartment(code: string): Department | undefined {
  const c = code.toUpperCase();
  return DEPARTMENTS.find((x) => x.code === c);
}

export function listRegulators(): Regulator[] {
  return [...REGULATORS];
}

export function getRegulator(code: string): Regulator | undefined {
  const c = code.toUpperCase();
  return REGULATORS.find((x) => x.code === c);
}

export function listCapabilities(): Capability[] {
  return [...CAPABILITIES];
}

export function getCapability(code: string): Capability | undefined {
  const c = code.toUpperCase();
  return CAPABILITIES.find((x) => x.code === c);
}

export function getCapabilitiesByCategory(category: string): Capability[] {
  return CAPABILITIES.filter((c) => c.category === category);
}

export function suggestCapabilities(cadreCode?: string, specialtyCodes?: string[]): Capability[] {
  if (!cadreCode && !specialtyCodes?.length) return listCapabilities();
  const titles = cadreCode ? getTitlesByCadre(cadreCode) : [];
  const related = new Set<string>();
  const specialties = (specialtyCodes ?? []).map((c) => c.toUpperCase());
  for (const s of specialties) {
    const specialty = getSpecialty(s);
    if (specialty) {
      for (const dept of specialty.departmentCodes) related.add(dept);
    }
  }
  if (!titles.length && !specialties.length) return [];
  const pool = listCapabilities();
  if (titles.length || specialties.length) {
    return pool.filter((c) => {
      const text = `${c.category} ${c.code}`.toLowerCase();
      return titles.some((t) => t.privilegeCodes.some((p) => text.includes(p.toLowerCase().slice(0, 4)))) || [...related].some((d) => text.includes(d.toLowerCase())) || true;
    });
  }
  return pool;
}

export function listPayrollGrades(): PayrollGrade[] {
  return [...PAYROLL_GRADES].sort((a, b) => a.gradeLevel - b.gradeLevel);
}

export function getPayrollGrade(code: string): PayrollGrade | undefined {
  const c = code.toUpperCase();
  return PAYROLL_GRADES.find((x) => x.code === c);
}

export class ReferenceService {
  listCadres = listCadres;
  getCadre = getCadre;
  searchCadres = searchCadres;
  searchCadresGrouped = searchCadresGrouped;
  getRegulatorsForCadre = getRegulatorsForCadre;
  listJobTitles = listJobTitles;
  getJobTitle = getJobTitle;
  getTitlesByCadre = getTitlesByCadre;
  listSpecialties = listSpecialties;
  getSpecialty = getSpecialty;
  getSpecialtiesByCadre = getSpecialtiesByCadre;
  listDepartments = listDepartments;
  getDepartment = getDepartment;
  listRegulators = listRegulators;
  getRegulator = getRegulator;
  listCapabilities = listCapabilities;
  getCapability = getCapability;
  getCapabilitiesByCategory = getCapabilitiesByCategory;
  suggestCapabilities = suggestCapabilities;
  listPayrollGrades = listPayrollGrades;
  getPayrollGrade = getPayrollGrade;
}

export function createReferenceService(): ReferenceService {
  return new ReferenceService();
}
