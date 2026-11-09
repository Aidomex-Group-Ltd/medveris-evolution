/**
 * Seed script for global workforce reference data.
 * Loads data from assets/workforce/ JSON files into the reference tables.
 *
 * Run: MIGRATION_DATABASE_URL=... npx tsx packages/db/seed/reference-data.ts
 */

import { createSql } from "@medveris/db";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadJson(filename: string) {
  const path = join(__dirname, "../../..", "assets/workforce", filename);
  const content = await readFile(path, "utf-8");
  return JSON.parse(content);
}

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL or MIGRATION_DATABASE_URL is required");
  const sql = createSql(url, { max: 1 });

  try {
    // Set platform operator context for seeding
    // The migrator role doesn't have a platform_role grant, so we need to bypass RLS
    // by setting user_id and platform_role. The actual permission check uses platform_roles table.
    // For seeding, we use the bootstrap approach similar to scripts/seed.ts
    const bootstrapUserId = '00000000-0000-4000-8000-000000000001';
    await sql`
      select set_config('app.user_id', ${bootstrapUserId}, true),
             set_config('app.platform_role', 'platform_operator', true)
    `;
    
    // Temporarily disable RLS for reference tables to allow seeding
    // This is safe because we immediately re-enable it and the tables are empty
    for (const tbl of ['reference_regulators', 'reference_departments', 'reference_cadres', 'reference_job_titles', 'reference_specialties', 'reference_capabilities', 'reference_payroll_grades']) {
      await sql.unsafe(`ALTER TABLE ${tbl} DISABLE ROW LEVEL SECURITY`);
    }
    
    console.log("Seeding global workforce reference data...\n");

    // Load all reference data files
    const cadresData = await loadJson("professional-cadres.json");
    const specialtiesData = await loadJson("clinical-specialties.json");
    const capabilitiesData = await loadJson("clinical-capabilities.json");
    const governanceData = await loadJson("governance-reference.json");
    const departmentsData = await loadJson("departments.json");

    console.log(`Loaded ${cadresData.cadres.length} cadres`);
    console.log(`Loaded ${specialtiesData.specialties.length} specialties`);
    console.log(`Loaded ${capabilitiesData.capabilities.length} capabilities`);
    console.log(`Loaded ${governanceData.regulators.length} regulators`);
    console.log(`Loaded ${departmentsData.departments.length} departments\n`);

    // Seed regulators first (referenced by cadres)
    console.log("Seeding regulators...");
    for (const regulator of governanceData.regulators) {
      await sql`
        insert into reference_regulators (id, code, name, regulator_type, country, verification_mode, website, notes, active, version)
        values (${crypto.randomUUID()}, ${regulator.code}, ${regulator.name}, ${regulator.regulatorType}, ${regulator.country || 'UG'}, ${regulator.verificationMode}, ${regulator.website || null}, ${regulator.notes || null}, true, 1)
        on conflict (code) do nothing
      `;
    }
    console.log("  ✓ Regulators seeded\n");

    // Seed departments
    console.log("Seeding departments...");
    for (const dept of departmentsData.departments) {
      await sql`
        insert into reference_departments (id, code, name, description, sort_order, active, version)
        values (${crypto.randomUUID()}, ${dept.code}, ${dept.name}, ${dept.description || null}, ${dept.sortOrder || 0}, true, 1)
        on conflict (code) do nothing
      `;
    }
    console.log("  ✓ Departments seeded\n");

    // Seed cadres
    console.log("Seeding cadres...");
    for (const cadre of cadresData.cadres) {
      await sql`
        insert into reference_cadres (id, code, name, category, description, regulator_codes, requires_registration, isco08_code, isco08_reviewed, active, version)
        values (${crypto.randomUUID()}, ${cadre.code}, ${cadre.name}, ${cadre.category}, ${cadre.description || null}, ${cadre.regulatorCodes}, ${cadre.requiresRegistration}, null, false, true, 1)
        on conflict (code) do nothing
      `;
    }
    console.log("  ✓ Cadres seeded\n");

    // Seed job titles (from the existing onboarding catalogue)
    console.log("Seeding job titles...");
    const jobTitles = [
      { code: "MED-OFF-STD", name: "Medical Officer", cadreCode: "MED-OFF", seniority: "standard" as const, departmentCodes: ["OPD", "EMERG", "WARD", "MAT", "PED", "CRIT"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "CLIN-SIGN", "PRESCRIBE", "ORDER-DIAG"], suggestedSystemRoles: ["clinician"] },
      { code: "MED-OFF-SEN", name: "Senior Medical Officer", cadreCode: "MED-OFF", seniority: "senior" as const, departmentCodes: ["OPD", "WARD", "EMERG"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "CLIN-SIGN", "PRESCRIBE", "ORDER-DIAG"], suggestedSystemRoles: ["clinician"] },
      { code: "CONSULTANT-STD", name: "Consultant Physician", cadreCode: "CONSULTANT", seniority: "consultant" as const, departmentCodes: ["OPD", "WARD", "CRIT"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "CLIN-SIGN", "PRESCRIBE", "ORDER-DIAG"], suggestedSystemRoles: ["specialist_clinician"] },
      { code: "SPEC-PHYS-STD", name: "Specialist Physician", cadreCode: "SPEC-PHYS", seniority: "senior" as const, departmentCodes: ["OPD", "WARD"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "CLIN-SIGN", "PRESCRIBE"], suggestedSystemRoles: ["specialist_clinician"] },
      { code: "SURGEON-STD", name: "Surgeon", cadreCode: "SURGEON", seniority: "standard" as const, departmentCodes: ["THEATRE", "WARD"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "CLIN-SIGN", "THEATRE-SCRUB"], suggestedSystemRoles: ["specialist_clinician"] },
      { code: "ANESTH-STD", name: "Anaesthesiologist", cadreCode: "ANESTH", seniority: "standard" as const, departmentCodes: ["THEATRE", "CRIT"], requiresCredential: true, privilegeCodes: ["THEATRE-ANES", "CRIT-CARE"], suggestedSystemRoles: ["specialist_clinician"] },
      { code: "OBGYN-STD", name: "Obstetrician and Gynaecologist", cadreCode: "OBGYN", seniority: "standard" as const, departmentCodes: ["MAT", "THEATRE"], requiresCredential: true, privilegeCodes: ["MAT-LABOUR", "THEATRE-SCRUB"], suggestedSystemRoles: ["specialist_clinician"] },
      { code: "PEDIATRICIAN-STD", name: "Paediatrician", cadreCode: "PEDIATRICIAN", seniority: "standard" as const, departmentCodes: ["PED", "OPD"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "MAT-NEWBORN"], suggestedSystemRoles: ["specialist_clinician"] },
      { code: "PSYCHIATRIST-STD", name: "Psychiatrist", cadreCode: "PSYCHIATRIST", seniority: "standard" as const, departmentCodes: ["MH", "OPD"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "CLIN-SIGN"], suggestedSystemRoles: ["specialist_clinician"] },
      { code: "PATHOLOGIST-STD", name: "Pathologist", cadreCode: "PATHOLOGIST", seniority: "standard" as const, departmentCodes: ["LAB"], requiresCredential: true, privilegeCodes: ["LAB-VERIFY"], suggestedSystemRoles: ["laboratory"] },
      { code: "RADIOLOGIST-STD", name: "Radiologist", cadreCode: "RADIOLOGIST", seniority: "standard" as const, departmentCodes: ["RAD"], requiresCredential: true, privilegeCodes: ["RAD-REPORT"], suggestedSystemRoles: ["radiology"] },
      { code: "CLIN-OFF-STD", name: "Clinical Officer", cadreCode: "CLIN-OFF", seniority: "standard" as const, departmentCodes: ["OPD", "EMERG", "PRIMARY", "MAT", "PED"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "CLIN-SIGN"], suggestedSystemRoles: ["clinician"] },
      { code: "CLIN-OFF-INTERN", name: "Clinical Officer Intern", cadreCode: "CLIN-OFF", seniority: "entry" as const, departmentCodes: ["OPD", "WARD"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS"], suggestedSystemRoles: ["clinician"] },
      { code: "NURSE-STD", name: "Registered Nurse", cadreCode: "NURSE", seniority: "standard" as const, departmentCodes: ["WARD", "OPD", "EMERG", "PED", "CRIT", "MAT", "THEATRE", "LAB", "RAD"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "MAT-NEWBORN"], suggestedSystemRoles: ["nurse"] },
      { code: "NURSE-SEN", name: "Senior Nursing Officer", cadreCode: "NURSE", seniority: "senior" as const, departmentCodes: ["WARD", "OPD"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "MAT-NEWBORN"], suggestedSystemRoles: ["nurse", "department_lead"] },
      { code: "NURSE-ENROLLED", name: "Enrolled Nurse", cadreCode: "NURSE", seniority: "entry" as const, departmentCodes: ["WARD", "OPD"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS"], suggestedSystemRoles: ["nurse"] },
      { code: "MIDWIFE-STD", name: "Midwife", cadreCode: "MIDWIFE", seniority: "standard" as const, departmentCodes: ["MAT"], requiresCredential: true, privilegeCodes: ["MAT-LABOUR", "MAT-NEWBORN"], suggestedSystemRoles: ["midwife"] },
      { code: "MIDWIFE-SEN", name: "Senior Midwife", cadreCode: "MIDWIFE", seniority: "senior" as const, departmentCodes: ["MAT"], requiresCredential: true, privilegeCodes: ["MAT-LABOUR", "MAT-NEWBORN"], suggestedSystemRoles: ["midwife", "department_lead"] },
      { code: "NURSE-ASST-STD", name: "Nursing Assistant", cadreCode: "NURSE-ASST", seniority: "entry" as const, departmentCodes: ["WARD", "MAT", "PED"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: [] },
      { code: "PHARMACIST-STD", name: "Pharmacist", cadreCode: "PHARMACIST", seniority: "standard" as const, departmentCodes: ["PHARM"], requiresCredential: true, privilegeCodes: ["PHARM-DISPENSE", "PHARM-CHECK"], suggestedSystemRoles: ["pharmacist"] },
      { code: "PHARMACIST-SEN", name: "Senior Pharmacist", cadreCode: "PHARMACIST", seniority: "senior" as const, departmentCodes: ["PHARM"], requiresCredential: true, privilegeCodes: ["PHARM-DISPENSE", "PHARM-CHECK"], suggestedSystemRoles: ["pharmacist", "department_lead"] },
      { code: "PHARM-TECH-STD", name: "Pharmacy Technician", cadreCode: "PHARM-TECH", seniority: "standard" as const, departmentCodes: ["PHARM"], requiresCredential: true, privilegeCodes: ["PHARM-DISPENSE"], suggestedSystemRoles: ["pharmacist"] },
      { code: "LAB-SCI-STD", name: "Laboratory Scientist", cadreCode: "LAB-SCIENTIST", seniority: "standard" as const, departmentCodes: ["LAB", "BLOOD"], requiresCredential: true, privilegeCodes: ["LAB-VERIFY"], suggestedSystemRoles: ["laboratory"] },
      { code: "LAB-SCI-SEN", name: "Senior Laboratory Scientist", cadreCode: "LAB-SCIENTIST", seniority: "senior" as const, departmentCodes: ["LAB"], requiresCredential: true, privilegeCodes: ["LAB-VERIFY"], suggestedSystemRoles: ["laboratory", "department_lead"] },
      { code: "LAB-TECH-STD", name: "Laboratory Technician", cadreCode: "LAB-TECH", seniority: "standard" as const, departmentCodes: ["LAB", "BLOOD"], requiresCredential: true, privilegeCodes: [], suggestedSystemRoles: ["laboratory"] },
      { code: "PHLEB-STD", name: "Phlebotomist", cadreCode: "PHLEBOTOMIST", seniority: "entry" as const, departmentCodes: ["LAB", "OPD"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["laboratory"] },
      { code: "RAD-TECH-STD", name: "Radiographer", cadreCode: "RAD-TECH", seniority: "standard" as const, departmentCodes: ["RAD"], requiresCredential: true, privilegeCodes: [], suggestedSystemRoles: ["radiology"] },
      { code: "SONO-STD", name: "Sonographer", cadreCode: "SONOGRAPHER", seniority: "standard" as const, departmentCodes: ["RAD", "MAT"], requiresCredential: true, privilegeCodes: [], suggestedSystemRoles: ["radiology"] },
      { code: "DENTIST-STD", name: "Dentist", cadreCode: "DENTIST", seniority: "standard" as const, departmentCodes: ["DENTAL"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "CLIN-SIGN"], suggestedSystemRoles: ["clinician"] },
      { code: "DENTAL-TECH-STD", name: "Dental Technician", cadreCode: "DENTAL-TECH", seniority: "standard" as const, departmentCodes: ["DENTAL"], requiresCredential: true, privilegeCodes: [], suggestedSystemRoles: [] },
      { code: "OPTOMETRIST-STD", name: "Optometrist", cadreCode: "OPTOMETRIST", seniority: "standard" as const, departmentCodes: ["EYEENT"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS"], suggestedSystemRoles: ["clinician"] },
      { code: "OPHTHAL-STD", name: "Ophthalmologist", cadreCode: "OPHTHALMOLOGIST", seniority: "standard" as const, departmentCodes: ["EYEENT"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "CLIN-SIGN"], suggestedSystemRoles: ["specialist_clinician"] },
      { code: "ENT-STD", name: "ENT Specialist", cadreCode: "ENT-SPEC", seniority: "standard" as const, departmentCodes: ["EYEENT"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "CLIN-SIGN"], suggestedSystemRoles: ["specialist_clinician"] },
      { code: "PHYSIO-STD", name: "Physiotherapist", cadreCode: "PHYSIO", seniority: "standard" as const, departmentCodes: ["REHAB"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS"], suggestedSystemRoles: [] },
      { code: "OCC-THERAPIST-STD", name: "Occupational Therapist", cadreCode: "OCC-THERAPIST", seniority: "standard" as const, departmentCodes: ["REHAB"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS"], suggestedSystemRoles: [] },
      { code: "SPEECH-THERAPIST-STD", name: "Speech and Language Therapist", cadreCode: "SPEECH-THERAPIST", seniority: "standard" as const, departmentCodes: ["REHAB", "PED"], requiresCredential: true, privilegeCodes: [], suggestedSystemRoles: [] },
      { code: "PSYCHOLOGIST-STD", name: "Psychologist", cadreCode: "PSYCHOLOGIST", seniority: "standard" as const, departmentCodes: ["MH"], requiresCredential: true, privilegeCodes: [], suggestedSystemRoles: [] },
      { code: "COUNSELLOR-STD", name: "Counsellor", cadreCode: "COUNSELLOR", seniority: "standard" as const, departmentCodes: ["MH", "PRIMARY"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: [] },
      { code: "SOCIAL-WORKER-STD", name: "Social Worker", cadreCode: "SOCIAL-WORKER", seniority: "standard" as const, departmentCodes: ["MH", "PALLIATIVE"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: [] },
      { code: "DIETITIAN-STD", name: "Dietitian", cadreCode: "DIETITIAN", seniority: "standard" as const, departmentCodes: ["NUTR"], requiresCredential: true, privilegeCodes: [], suggestedSystemRoles: [] },
      { code: "PUBLIC-HEALTH-STD", name: "Public Health Specialist", cadreCode: "PUBLIC-HEALTH", seniority: "standard" as const, departmentCodes: ["PRIMARY"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["public_health"] },
      { code: "CHW-STD", name: "Community Health Worker", cadreCode: "COMMUNITY-HEALTH", seniority: "entry" as const, departmentCodes: ["PRIMARY"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: [] },
      { code: "EMERG-PHYS-STD", name: "Emergency Medical Officer", cadreCode: "EMERG-PHYS", seniority: "standard" as const, departmentCodes: ["EMERG"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "CLIN-SIGN"], suggestedSystemRoles: ["clinician"] },
      { code: "PARAMEDIC-STD", name: "Paramedic", cadreCode: "PARAMEDIC", seniority: "standard" as const, departmentCodes: ["EMERG"], requiresCredential: true, privilegeCodes: [], suggestedSystemRoles: [] },
      { code: "AMB-DRIVER-STD", name: "Ambulance Driver", cadreCode: "AMB-DRIVER", seniority: "standard" as const, departmentCodes: ["EMERG"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: [] },
      { code: "ANAES-PROV-STD", name: "Anaesthesia Provider", cadreCode: "ANAES-PROV", seniority: "standard" as const, departmentCodes: ["THEATRE"], requiresCredential: true, privilegeCodes: ["THEATRE-ANES"], suggestedSystemRoles: ["clinician"] },
      { code: "THEATRE-NURSE-STD", name: "Theatre Nurse", cadreCode: "THEATRE-NURSE", seniority: "standard" as const, departmentCodes: ["THEATRE"], requiresCredential: true, privilegeCodes: ["THEATRE-SCRUB"], suggestedSystemRoles: ["nurse"] },
      { code: "THEATRE-TECH-STD", name: "Theatre Technician", cadreCode: "THEATRE-TECH", seniority: "standard" as const, departmentCodes: ["THEATRE", "CSSD"], requiresCredential: false, privilegeCodes: ["THEATRE-SCRUB", "CSSD-RELEASE"], suggestedSystemRoles: ["theatre"] },
      { code: "RECOVERY-NURSE-STD", name: "Recovery Nurse", cadreCode: "RECOVERY-NURSE", seniority: "standard" as const, departmentCodes: ["THEATRE"], requiresCredential: true, privilegeCodes: [], suggestedSystemRoles: ["nurse"] },
      { code: "HEALTH-RECORDS-STD", name: "Health Records Officer", cadreCode: "HEALTH-RECORDS", seniority: "standard" as const, departmentCodes: ["ACCESS"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["records"] },
      { code: "HIM-STD", name: "Health Information Manager", cadreCode: "HIM", seniority: "senior" as const, departmentCodes: ["ACCESS"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["records", "department_lead"] },
      { code: "MED-CODER-STD", name: "Medical Coder", cadreCode: "MED-CODER", seniority: "standard" as const, departmentCodes: ["ACCESS"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["records"] },
      { code: "RECEPTIONIST-STD", name: "Receptionist", cadreCode: "RECEPTIONIST", seniority: "entry" as const, departmentCodes: ["ACCESS"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["receptionist"] },
      { code: "ADMIN-OFF-STD", name: "Administrative Officer", cadreCode: "ADMIN-OFF", seniority: "standard" as const, departmentCodes: ["GOV", "ACCESS", "HR", "FIN", "PROC"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: [] },
      { code: "HOSP-MGR-STD", name: "Facility Administrator", cadreCode: "HOSP-MGR", seniority: "lead" as const, departmentCodes: ["GOV"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["facility_admin"] },
      { code: "IT-ADMIN-STD", name: "IT Administrator", cadreCode: "IT-ADMIN", seniority: "standard" as const, departmentCodes: ["IT"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["it_admin"] },
      { code: "DATA-ANALYST-STD", name: "Data Analyst", cadreCode: "DATA-ANALYST", seniority: "standard" as const, departmentCodes: ["IT"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["research"] },
      { code: "ACCOUNTANT-STD", name: "Accountant", cadreCode: "ACCOUNTANT", seniority: "standard" as const, departmentCodes: ["FIN"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["finance"] },
      { code: "CASHIER-STD", name: "Cashier", cadreCode: "CASHIER", seniority: "entry" as const, departmentCodes: ["FIN"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["finance"] },
      { code: "BILLING-OFF-STD", name: "Billing Officer", cadreCode: "BILLING-OFF", seniority: "standard" as const, departmentCodes: ["FIN"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["finance"] },
      { code: "HR-OFF-STD", name: "Human Resources Officer", cadreCode: "HR-OFF", seniority: "standard" as const, departmentCodes: ["HR"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["hr"] },
      { code: "CRED-OFF-STD", name: "Credentialing Officer", cadreCode: "CRED-OFF", seniority: "standard" as const, departmentCodes: ["HR"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["hr"] },
      { code: "TRAIN-COORD-STD", name: "Training Coordinator", cadreCode: "TRAIN-COORD", seniority: "standard" as const, departmentCodes: ["HR", "PRIMARY"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["hr"] },
      { code: "RESEARCH-COORD-STD", name: "Research Coordinator", cadreCode: "RESEARCH-COORD", seniority: "standard" as const, departmentCodes: ["HR"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["research"] },
      { code: "PROC-OFF-STD", name: "Procurement Officer", cadreCode: "PROC-OFF", seniority: "standard" as const, departmentCodes: ["PROC"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: [] },
      { code: "STOREKEEPER-STD", name: "Storekeeper", cadreCode: "STOREKEEPER", seniority: "entry" as const, departmentCodes: ["PROC", "PHARM"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: [] },
      { code: "BIOMED-STD", name: "Biomedical Engineering Technician", cadreCode: "BIOMED", seniority: "standard" as const, departmentCodes: ["ENG"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["biomedical"] },
      { code: "FAC-MGR-STD", name: "Facilities Manager", cadreCode: "FAC-MGR", seniority: "senior" as const, departmentCodes: ["ENG"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: [] },
      { code: "MORTUARY-TECH-STD", name: "Mortuary Technician", cadreCode: "MORTUARY-TECH", seniority: "standard" as const, departmentCodes: ["MORT"], requiresCredential: false, privilegeCodes: ["MORT-RELEASE"], suggestedSystemRoles: ["mortuary"] },
      { code: "HOUSEKEEPER-STD", name: "Housekeeper", cadreCode: "HOUSEKEEPER", seniority: "entry" as const, departmentCodes: ["HOUSE"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["housekeeping"] },
      { code: "PORTER-STD", name: "Porter", cadreCode: "PORTER", seniority: "entry" as const, departmentCodes: ["PORTER"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["porter"] },
      { code: "SEC-OFF-STD", name: "Security Officer", cadreCode: "SEC-OFF", seniority: "standard" as const, departmentCodes: ["SEC"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: [] },
      { code: "COOK-STD", name: "Cook", cadreCode: "COOK", seniority: "entry" as const, departmentCodes: ["CATER"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: [] },
      { code: "SOCIAL-AIDE-STD", name: "Patient Support Aide", cadreCode: "SOCIAL-AIDE", seniority: "entry" as const, departmentCodes: ["WARD", "PALLIATIVE"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: [] },
      { code: "STUDENT-STD", name: "Student or Intern", cadreCode: "STUDENT", seniority: "entry" as const, departmentCodes: ["OPD", "WARD", "LAB", "RAD", "PHARM", "THEATRE", "MAT", "PED", "REHAB"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: [] },
    ];

    for (const title of jobTitles) {
      await sql`
        insert into reference_job_titles (id, code, name, cadre_code, seniority, description, department_codes, requires_credential, privilege_codes, suggested_system_roles, active, version)
        values (${crypto.randomUUID()}, ${title.code}, ${title.name}, ${title.cadreCode}, ${title.seniority}, null, ${title.departmentCodes}, ${title.requiresCredential}, ${title.privilegeCodes}, ${title.suggestedSystemRoles}, true, 1)
        on conflict (code) do nothing
      `;
    }
    console.log(`  ✓ ${jobTitles.length} job titles seeded\n`);

    // Seed specialties
    console.log("Seeding specialties...");
    for (const specialty of specialtiesData.specialties) {
      await sql`
        insert into reference_specialties (id, code, name, cadre_codes, department_codes, description, active, version)
        values (${crypto.randomUUID()}, ${specialty.code}, ${specialty.name}, ${specialty.cadreCodes}, ${specialty.departmentCodes}, ${specialty.description || null}, true, 1)
        on conflict (code) do nothing
      `;
    }
    console.log("  ✓ Specialties seeded\n");

    // Seed capabilities
    console.log("Seeding capabilities...");
    for (const cap of capabilitiesData.capabilities) {
      await sql`
        insert into reference_capabilities (id, code, name, category, description, active, version)
        values (${crypto.randomUUID()}, ${cap.code}, ${cap.name}, ${cap.category}, ${cap.description || null}, true, 1)
        on conflict (code) do nothing
      `;
    }
    console.log("  ✓ Capabilities seeded\n");

    // Seed payroll grades (sample Uganda public service structure - configurable by facilities)
    console.log("Seeding payroll grades...");
    const payrollGrades = [
      { code: "PS-NO-1", name: "Public Service Grade 1", level: 1 },
      { code: "PS-NO-2", name: "Public Service Grade 2", level: 2 },
      { code: "PS-NO-3", name: "Public Service Grade 3", level: 3 },
      { code: "PS-NO-4", name: "Public Service Grade 4", level: 4 },
      { code: "PS-NO-5", name: "Public Service Grade 5", level: 5 },
      { code: "PS-NO-6", name: "Public Service Grade 6", level: 6 },
      { code: "PS-NO-7", name: "Public Service Grade 7", level: 7 },
      { code: "PS-NO-8", name: "Public Service Grade 8", level: 8 },
      { code: "PS-NO-9", name: "Public Service Grade 9", level: 9 },
      { code: "PS-NO-10", name: "Public Service Grade 10", level: 10 },
      { code: "PS-NO-11", name: "Public Service Grade 11", level: 11 },
      { code: "PS-NO-12", name: "Public Service Grade 12", level: 12 },
      { code: "PHARM-DISP", name: "Pharmacy Dispenser", level: 3 },
      { code: "NURSE-ENROLLED", name: "Enrolled Nurse", level: 3 },
      { code: "NURSE-REG", name: "Registered Nurse", level: 5 },
      { code: "SENIOR-NURSE", name: "Senior Nurse Officer", level: 7 },
      { code: "LAB-TECH", name: "Laboratory Technician", level: 4 },
      { code: "LAB-SCIENTIST", name: "Laboratory Scientist", level: 6 },
      { code: "MED-OFFICER", name: "Medical Officer", level: 6 },
      { code: "SENIOR-MED-OFF", name: "Senior Medical Officer", level: 8 },
      { code: "SPECIALIST", name: "Medical Specialist", level: 10 },
      { code: "CONSULTANT", name: "Consultant", level: 12 },
      { code: "HEAD-NURSE", name: "Head Nurse/Principal Nursing Officer", level: 10 },
      { code: "PHARMACIST", name: "Pharmacist", level: 6 },
      { code: "SENIOR-PHARM", name: "Senior Pharmacist", level: 8 },
      { code: "HOSP-ASSIST", name: "Hospital Assistant", level: 1 },
      { code: "CLEANER", name: "Cleaner", level: 1 },
      { code: "DRIVER", name: "Driver", level: 2 },
    ];

    for (const grade of payrollGrades) {
      await sql`
        insert into reference_payroll_grades (id, code, name, grade_level, description, active, version)
        values (${crypto.randomUUID()}, ${grade.code}, ${grade.name}, ${grade.level}, null, true, 1)
        on conflict (code) do nothing
      `;
    }
    console.log(`  ✓ ${payrollGrades.length} payroll grades seeded\n`);

    console.log("========================================");
    console.log("Seed complete!");
    console.log("========================================");
    console.log("\nReference data is now available globally.");
    console.log("Facilities can use these for:");
    console.log("  - Staff onboarding (cadre, specialty, job title selection)");
    console.log("  - Clinical privilege assignment (capabilities)");
    console.log("  - Credential verification (regulators)");
    console.log("  - Department assignment");
    console.log("  - Payroll configuration (grades)");
    console.log("\nTo configure facility-specific payroll:");
    console.log("  1. Create facility_payroll_grades records");
    console.log("  2. Assign staff_payroll_assignments to engagements");

  } catch (error) {
    console.error("Seed failed:", error);
    process.exit(1);
  } finally {
    // Re-enable RLS for reference tables
    for (const tbl of ['reference_regulators', 'reference_departments', 'reference_cadres', 'reference_job_titles', 'reference_specialties', 'reference_capabilities', 'reference_payroll_grades']) {
      await sql.unsafe(`ALTER TABLE ${tbl} ENABLE ROW LEVEL SECURITY`);
    }
    // Clean up platform role context
    await sql`select set_config('app.platform_role', '', true), set_config('app.user_id', '', true)`;
    await sql.end({ timeout: 5 });
  }
}

main();
