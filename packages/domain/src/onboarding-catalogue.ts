/**
 * Uganda onboarding catalogue (v1).
 *
 * This is an editable engineering seed, not an exhaustive or definitive legal
 * register. It deliberately keeps department, professional cadre, job title,
 * seniority, specialty and system permissions separate. A job title never
 * grants a clinical privilege or a server-side permission by itself.
 *
 * Regulatory bodies, registration categories and licence rules vary. Entries
 * below are sample governance metadata for manual verification; they do not
 * claim that a self-declaration or uploaded document proves a licence.
 */

import { DomainError } from "./errors.js";

export const UGANDA_CATALOGUE_VERSION = 1;
export const UGANDA_CATALOGUE_COUNTRY = "UG";
export const UGANDA_CATALOGUE_NOTICE =
  "Demonstration catalogue for Uganda. Not an exhaustive or definitive legal register. Verify regulators, scopes and licence requirements with the facility and the competent authority.";

export interface OnboardingCatalogueRegulator {
  code: string;
  name: string;
  regulatorType: string;
  country: string;
  verificationMode: "manual" | "official-api";
  website?: string;
  notes?: string;
}

export interface OnboardingCatalogueDepartment {
  code: string;
  name: string;
  description?: string;
  sortOrder: number;
}

export interface OnboardingCatalogueCadre {
  code: string;
  name: string;
  category: string;
  description?: string;
  regulatorCodes: string[];
  requiresRegistration: boolean;
}

export interface OnboardingCatalogueJobTitle {
  code: string;
  name: string;
  cadreCode: string;
  seniority: "entry" | "standard" | "senior" | "lead" | "consultant";
  description?: string;
  departmentCodes: string[];
  requiresCredential: boolean;
  privilegeCodes: string[];
  suggestedSystemRoles: string[];
}

export interface OnboardingCatalogueSpecialty {
  code: string;
  name: string;
  cadreCodes: string[];
  departmentCodes: string[];
  description?: string;
}

export interface OnboardingCatalogue {
  countryCode: string;
  version: number;
  notice: string;
  regulators: OnboardingCatalogueRegulator[];
  departments: OnboardingCatalogueDepartment[];
  cadres: OnboardingCatalogueCadre[];
  jobTitles: OnboardingCatalogueJobTitle[];
  specialties: OnboardingCatalogueSpecialty[];
}

export const UGANDA_REGULATORS: OnboardingCatalogueRegulator[] = [
  { code: "UMDPC", name: "Uganda Medical and Dental Practitioners Council", regulatorType: "medical-dental", country: "UG", verificationMode: "manual", notes: "Sample manual verification route for medical and dental practitioners." },
  { code: "UNMC", name: "Uganda Nurses and Midwives Council", regulatorType: "nursing-midwifery", country: "UG", verificationMode: "manual", notes: "Sample manual verification route for nurses and midwives." },
  { code: "NDA", name: "National Drug Authority", regulatorType: "pharmacy", country: "UG", verificationMode: "manual", notes: "Sample pharmacy licensing reference; confirm current requirements with the authority." },
  { code: "UAHC", name: "Uganda Allied Health Professionals Council", regulatorType: "allied-health", country: "UG", verificationMode: "manual", notes: "Sample route for allied health cadres where registration applies." },
  { code: "UMLSC", name: "Uganda Medical Laboratory Practitioners Council", regulatorType: "laboratory", country: "UG", verificationMode: "manual", notes: "Sample laboratory practitioner registration reference." },
  { code: "UCPC", name: "Uganda Counselling and Psychotherapy Council", regulatorType: "mental-health", country: "UG", verificationMode: "manual", notes: "Sample counselling/psychotherapy reference." },
  { code: "UHRC", name: "Uganda Human Rights Commission", regulatorType: "governance", country: "UG", verificationMode: "manual", notes: "Not a clinical regulator; included only to show mixed governance metadata." },
  { code: "NONE", name: "No statutory regulator recorded", regulatorType: "none", country: "UG", verificationMode: "manual", notes: "Used for non-clinical, support and administrative roles." },
];

export const UGANDA_DEPARTMENTS: OnboardingCatalogueDepartment[] = [
  { code: "GOV", name: "Governance and executive administration", description: "Executive, medical and nursing administration.", sortOrder: 1 },
  { code: "ACCESS", name: "Patient access and health information", description: "Registration, appointments and medical records.", sortOrder: 2 },
  { code: "OPD", name: "Outpatient and specialist clinics", description: "General and specialist ambulatory care.", sortOrder: 3 },
  { code: "OUTPATIENT", name: "Outpatient services", description: "Alias for OPD - Outpatient and specialist clinics.", sortOrder: 3 },
  { code: "EMERG", name: "Emergency and ambulance services", description: "Triage, resuscitation, observation and ambulance coordination.", sortOrder: 4 },
  { code: "WARD", name: "Inpatient medical and surgical services", description: "Adult inpatient wards and isolation.", sortOrder: 5 },
  { code: "MAT", name: "Maternity and reproductive health", description: "Antenatal, labour, postnatal, family planning and gynaecology.", sortOrder: 6 },
  { code: "PED", name: "Pediatrics and neonatal services", description: "Pediatric clinics, wards, newborn and NICU care.", sortOrder: 7 },
  { code: "CRIT", name: "Critical care", description: "ICU, high-dependency and critical-care coordination.", sortOrder: 8 },
  { code: "THEATRE", name: "Surgery, theatre, anaesthesia and recovery", description: "Preoperative, theatre, anaesthesia and recovery.", sortOrder: 9 },
  { code: "LAB", name: "Laboratory and pathology", description: "Specimen collection, haematology, chemistry, microbiology and histopathology.", sortOrder: 10 },
  { code: "BLOOD", name: "Blood bank and transfusion services", description: "Donor services, testing, compatibility and issue.", sortOrder: 11 },
  { code: "RAD", name: "Radiology and medical imaging", description: "Radiography, ultrasound, CT and imaging reporting.", sortOrder: 12 },
  { code: "PHARM", name: "Pharmacy and medicines management", description: "Dispensing, clinical pharmacy, stores and medication safety.", sortOrder: 13 },
  { code: "RENAL", name: "Renal and dialysis services", description: "Where configured by the facility.", sortOrder: 14 },
  { code: "MH", name: "Mental health and psychosocial services", description: "Mental health, counselling and psychosocial support.", sortOrder: 15 },
  { code: "REHAB", name: "Rehabilitation and allied health", description: "Physiotherapy, occupational therapy and related services.", sortOrder: 16 },
  { code: "NUTR", name: "Nutrition and dietetics", description: "Nutrition assessment, counselling and therapeutic diets.", sortOrder: 17 },
  { code: "DENTAL", name: "Dentistry and oral health", description: "Dental clinics and oral health services.", sortOrder: 18 },
  { code: "EYEENT", name: "Eye, ear, nose and throat services", description: "Ophthalmology, optometry and ENT services.", sortOrder: 19 },
  { code: "PRIMARY", name: "Public and community health", description: "Primary care, outreach, immunisation and community health.", sortOrder: 20 },
  { code: "PALLIATIVE", name: "Hospice and palliative care", description: "Palliative care and chronic disease support.", sortOrder: 21 },
  { code: "IPC", name: "Infection prevention, quality and patient safety", description: "Infection control, quality improvement and clinical governance.", sortOrder: 22 },
  { code: "CSSD", name: "Sterile services (CSSD)", description: "Decontamination and sterile-supply services.", sortOrder: 23 },
  { code: "MORT", name: "Mortuary services", description: "Mortuary custody and release.", sortOrder: 24 },
  { code: "HOUSE", name: "Housekeeping and environmental services", description: "Cleaning, linen and waste support.", sortOrder: 25 },
  { code: "PORTER", name: "Portering and patient movement", description: "Patient transport within the facility.", sortOrder: 26 },
  { code: "ENG", name: "Biomedical engineering and facilities", description: "Medical equipment, maintenance and facilities.", sortOrder: 27 },
  { code: "CATER", name: "Catering and food services", description: "Kitchen and ward meal distribution.", sortOrder: 28 },
  { code: "SEC", name: "Security and safety", description: "Access control, patrol and fire safety.", sortOrder: 29 },
  { code: "FIN", name: "Finance, revenue and insurance", description: "Billing, cashiering, claims and revenue.", sortOrder: 30 },
  { code: "HR", name: "Human resources, research and education", description: "HR operations, credentialing, training and research.", sortOrder: 31 },
  { code: "PROC", name: "Procurement, stores and assets", description: "Procurement, stores and asset management.", sortOrder: 32 },
  { code: "IT", name: "Digital health, ICT and data governance", description: "IT operations, integration, data and privacy.", sortOrder: 33 },
  { code: "OTHER", name: "Other or unlisted service", description: "Facility-defined service area pending review.", sortOrder: 99 },
];

export const UGANDA_CADRES: OnboardingCatalogueCadre[] = [
  { code: "MED-OFF", name: "Medical officer", category: "medical", regulatorCodes: ["UMDPC"], requiresRegistration: true, description: "Registered medical practitioner." },
  { code: "SPEC-PHYS", name: "Specialist physician", category: "medical", regulatorCodes: ["UMDPC"], requiresRegistration: true },
  { code: "CONSULTANT", name: "Consultant", category: "medical", regulatorCodes: ["UMDPC"], requiresRegistration: true },
  { code: "SURGEON", name: "Surgeon", category: "medical", regulatorCodes: ["UMDPC"], requiresRegistration: true },
  { code: "ANESTH", name: "Anaesthesiologist", category: "medical", regulatorCodes: ["UMDPC"], requiresRegistration: true },
  { code: "OBGYN", name: "Obstetrician or gynaecologist", category: "medical", regulatorCodes: ["UMDPC"], requiresRegistration: true },
  { code: "PEDIATRICIAN", name: "Paediatrician", category: "medical", regulatorCodes: ["UMDPC"], requiresRegistration: true },
  { code: "PSYCHIATRIST", name: "Psychiatrist", category: "medical", regulatorCodes: ["UMDPC"], requiresRegistration: true },
  { code: "INTENSIVIST", name: "Intensivist", category: "medical", regulatorCodes: ["UMDPC"], requiresRegistration: true },
  { code: "PATHOLOGIST", name: "Pathologist", category: "medical", regulatorCodes: ["UMDPC", "UMLSC"], requiresRegistration: true },
  { code: "RADIOLOGIST", name: "Radiologist", category: "medical", regulatorCodes: ["UMDPC"], requiresRegistration: true },
  { code: "CLIN-OFF", name: "Clinical officer", category: "clinical", regulatorCodes: ["UAHC"], requiresRegistration: true, description: "Clinical officer or associate clinician." },
  { code: "NURSE", name: "Registered or enrolled nurse", category: "nursing", regulatorCodes: ["UNMC"], requiresRegistration: true },
  { code: "MIDWIFE", name: "Midwife", category: "midwifery", regulatorCodes: ["UNMC"], requiresRegistration: true },
  { code: "NURSE-ASST", name: "Nursing assistant", category: "support", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "PHARMACIST", name: "Pharmacist", category: "pharmacy", regulatorCodes: ["NDA"], requiresRegistration: true },
  { code: "PHARM-TECH", name: "Pharmacy technician", category: "pharmacy", regulatorCodes: ["NDA"], requiresRegistration: true },
  { code: "LAB-SCIENTIST", name: "Laboratory scientist", category: "laboratory", regulatorCodes: ["UMLSC"], requiresRegistration: true },
  { code: "LAB-TECH", name: "Laboratory technician", category: "laboratory", regulatorCodes: ["UMLSC"], requiresRegistration: true },
  { code: "PHLEBOTOMIST", name: "Phlebotomist", category: "laboratory", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "RAD-TECH", name: "Radiographer or imaging technologist", category: "radiology", regulatorCodes: ["UAHC"], requiresRegistration: true },
  { code: "SONOGRAPHER", name: "Sonographer", category: "radiology", regulatorCodes: ["UAHC"], requiresRegistration: true },
  { code: "DENTIST", name: "Dentist", category: "dental", regulatorCodes: ["UMDPC"], requiresRegistration: true },
  { code: "DENTAL-TECH", name: "Dental technician or therapist", category: "dental", regulatorCodes: ["UAHC"], requiresRegistration: true },
  { code: "OPTOMETRIST", name: "Optometrist", category: "eye-ent", regulatorCodes: ["UAHC"], requiresRegistration: true },
  { code: "OPHTHALMOLOGIST", name: "Ophthalmologist", category: "medical", regulatorCodes: ["UMDPC"], requiresRegistration: true },
  { code: "ENT-SPEC", name: "Ear, nose and throat specialist", category: "medical", regulatorCodes: ["UMDPC"], requiresRegistration: true },
  { code: "PHYSIO", name: "Physiotherapist", category: "rehabilitation", regulatorCodes: ["UAHC"], requiresRegistration: true },
  { code: "OCC-THERAPIST", name: "Occupational therapist", category: "rehabilitation", regulatorCodes: ["UAHC"], requiresRegistration: true },
  { code: "SPEECH-THERAPIST", name: "Speech and language therapist", category: "rehabilitation", regulatorCodes: ["UAHC"], requiresRegistration: true },
  { code: "PSYCHOLOGIST", name: "Psychologist", category: "mental-health", regulatorCodes: ["UCPC"], requiresRegistration: true },
  { code: "COUNSELLOR", name: "Counsellor", category: "mental-health", regulatorCodes: ["UCPC"], requiresRegistration: false },
  { code: "SOCIAL-WORKER", name: "Social worker", category: "mental-health", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "DIETITIAN", name: "Dietitian or nutritionist", category: "nutrition", regulatorCodes: ["UAHC"], requiresRegistration: true },
  { code: "PUBLIC-HEALTH", name: "Public health specialist", category: "public-health", regulatorCodes: ["UAHC"], requiresRegistration: false },
  { code: "COMMUNITY-HEALTH", name: "Community health worker", category: "public-health", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "EMERG-PHYS", name: "Emergency physician or medical officer", category: "emergency", regulatorCodes: ["UMDPC"], requiresRegistration: true },
  { code: "PARAMEDIC", name: "Paramedic or emergency medical technician", category: "emergency", regulatorCodes: ["UAHC"], requiresRegistration: true },
  { code: "AMB-DRIVER", name: "Ambulance driver", category: "support", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "ANAES-PROV", name: "Authorised anaesthesia provider", category: "anaesthesia", regulatorCodes: ["UMDPC", "UNMC"], requiresRegistration: true },
  { code: "THEATRE-NURSE", name: "Theatre nurse", category: "nursing", regulatorCodes: ["UNMC"], requiresRegistration: true },
  { code: "THEATRE-TECH", name: "Theatre technician", category: "technical", regulatorCodes: ["UAHC"], requiresRegistration: false },
  { code: "RECOVERY-NURSE", name: "Recovery nurse", category: "nursing", regulatorCodes: ["UNMC"], requiresRegistration: true },
  { code: "HEALTH-RECORDS", name: "Health records officer", category: "health-information", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "HIM", name: "Health information manager", category: "health-information", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "MED-CODER", name: "Medical coder", category: "health-information", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "RECEPTIONIST", name: "Receptionist", category: "administrative", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "ADMIN-OFF", name: "Administrative officer", category: "administrative", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "HOSP-MGR", name: "Hospital or facility manager", category: "administration", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "IT-ADMIN", name: "IT administrator", category: "technical", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "DATA-ANALYST", name: "Data analyst", category: "data", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "ACCOUNTANT", name: "Accountant", category: "finance", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "CASHIER", name: "Cashier", category: "finance", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "BILLING-OFF", name: "Billing officer", category: "finance", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "HR-OFF", name: "Human resources officer", category: "administration", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "CRED-OFF", name: "Credentialing officer", category: "administration", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "TRAIN-COORD", name: "Training coordinator", category: "education", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "RESEARCH-COORD", name: "Research coordinator", category: "research", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "PROC-OFF", name: "Procurement officer", category: "administration", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "STOREKEEPER", name: "Storekeeper", category: "support", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "BIOMED", name: "Biomedical engineer or technician", category: "technical", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "FAC-MGR", name: "Facilities manager", category: "administration", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "MORTUARY-TECH", name: "Mortuary technician or attendant", category: "support", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "HOUSEKEEPER", name: "Housekeeper", category: "support", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "PORTER", name: "Porter", category: "support", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "SEC-OFF", name: "Security officer", category: "support", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "COOK", name: "Cook or catering officer", category: "support", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "SOCIAL-AIDE", name: "Patient support aide", category: "support", regulatorCodes: ["NONE"], requiresRegistration: false },
  { code: "STUDENT", name: "Student or intern", category: "trainee", regulatorCodes: ["NONE"], requiresRegistration: false, description: "Supervised, limited access only." },
];

export const UGANDA_JOB_TITLES: OnboardingCatalogueJobTitle[] = [
  { code: "MED-OFF-STD", name: "Medical Officer", cadreCode: "MED-OFF", seniority: "standard", departmentCodes: ["OPD", "EMERG", "WARD", "MAT", "PED", "CRIT"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "CLIN-SIGN", "PRESCRIBE", "ORDER-DIAG"], suggestedSystemRoles: ["clinician"] },
  { code: "MED-OFF-SEN", name: "Senior Medical Officer", cadreCode: "MED-OFF", seniority: "senior", departmentCodes: ["OPD", "WARD", "EMERG"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "CLIN-SIGN", "PRESCRIBE", "ORDER-DIAG"], suggestedSystemRoles: ["clinician"] },
  { code: "CONSULTANT-STD", name: "Consultant Physician", cadreCode: "CONSULTANT", seniority: "consultant", departmentCodes: ["OPD", "WARD", "CRIT"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "CLIN-SIGN", "PRESCRIBE", "ORDER-DIAG"], suggestedSystemRoles: ["specialist_clinician"] },
  { code: "SPEC-PHYS-STD", name: "Specialist Physician", cadreCode: "SPEC-PHYS", seniority: "senior", departmentCodes: ["OPD", "WARD"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "CLIN-SIGN", "PRESCRIBE"], suggestedSystemRoles: ["specialist_clinician"] },
  { code: "SURGEON-STD", name: "Surgeon", cadreCode: "SURGEON", seniority: "standard", departmentCodes: ["THEATRE", "WARD"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "CLIN-SIGN", "THEATRE-SCRUB"], suggestedSystemRoles: ["specialist_clinician"] },
  { code: "ANESTH-STD", name: "Anaesthesiologist", cadreCode: "ANESTH", seniority: "standard", departmentCodes: ["THEATRE", "CRIT"], requiresCredential: true, privilegeCodes: ["THEATRE-ANES", "CRIT-CARE"], suggestedSystemRoles: ["specialist_clinician"] },
  { code: "OBGYN-STD", name: "Obstetrician and Gynaecologist", cadreCode: "OBGYN", seniority: "standard", departmentCodes: ["MAT", "THEATRE"], requiresCredential: true, privilegeCodes: ["MAT-LABOUR", "THEATRE-SCRUB"], suggestedSystemRoles: ["specialist_clinician"] },
  { code: "PEDIATRICIAN-STD", name: "Paediatrician", cadreCode: "PEDIATRICIAN", seniority: "standard", departmentCodes: ["PED", "OPD"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "MAT-NEWBORN"], suggestedSystemRoles: ["specialist_clinician"] },
  { code: "PSYCHIATRIST-STD", name: "Psychiatrist", cadreCode: "PSYCHIATRIST", seniority: "standard", departmentCodes: ["MH", "OPD"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "CLIN-SIGN"], suggestedSystemRoles: ["specialist_clinician"] },
  { code: "PATHOLOGIST-STD", name: "Pathologist", cadreCode: "PATHOLOGIST", seniority: "standard", departmentCodes: ["LAB"], requiresCredential: true, privilegeCodes: ["LAB-VERIFY"], suggestedSystemRoles: ["laboratory"] },
  { code: "RADIOLOGIST-STD", name: "Radiologist", cadreCode: "RADIOLOGIST", seniority: "standard", departmentCodes: ["RAD"], requiresCredential: true, privilegeCodes: ["RAD-REPORT"], suggestedSystemRoles: ["radiology"] },
  { code: "CLIN-OFF-STD", name: "Clinical Officer", cadreCode: "CLIN-OFF", seniority: "standard", departmentCodes: ["OPD", "EMERG", "PRIMARY", "MAT", "PED"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "CLIN-SIGN"], suggestedSystemRoles: ["clinician"] },
  { code: "CLIN-OFF-INTERN", name: "Clinical Officer Intern", cadreCode: "CLIN-OFF", seniority: "entry", departmentCodes: ["OPD", "WARD"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS"], suggestedSystemRoles: ["clinician"] },
  { code: "NURSE-STD", name: "Registered Nurse", cadreCode: "NURSE", seniority: "standard", departmentCodes: ["WARD", "OPD", "EMERG", "PED", "CRIT", "MAT", "THEATRE", "LAB", "RAD"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "MAT-NEWBORN"], suggestedSystemRoles: ["nurse"] },
  { code: "NURSE-SEN", name: "Senior Nursing Officer", cadreCode: "NURSE", seniority: "senior", departmentCodes: ["WARD", "OPD"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "MAT-NEWBORN"], suggestedSystemRoles: ["nurse", "department_lead"] },
  { code: "NURSE-ENROLLED", name: "Enrolled Nurse", cadreCode: "NURSE", seniority: "entry", departmentCodes: ["WARD", "OPD"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS"], suggestedSystemRoles: ["nurse"] },
  { code: "MIDWIFE-STD", name: "Midwife", cadreCode: "MIDWIFE", seniority: "standard", departmentCodes: ["MAT"], requiresCredential: true, privilegeCodes: ["MAT-LABOUR", "MAT-NEWBORN"], suggestedSystemRoles: ["midwife"] },
  { code: "MIDWIFE-SEN", name: "Senior Midwife", cadreCode: "MIDWIFE", seniority: "senior", departmentCodes: ["MAT"], requiresCredential: true, privilegeCodes: ["MAT-LABOUR", "MAT-NEWBORN"], suggestedSystemRoles: ["midwife", "department_lead"] },
  { code: "NURSE-ASST-STD", name: "Nursing Assistant", cadreCode: "NURSE-ASST", seniority: "entry", departmentCodes: ["WARD", "MAT", "PED"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: [] },
  { code: "PHARMACIST-STD", name: "Pharmacist", cadreCode: "PHARMACIST", seniority: "standard", departmentCodes: ["PHARM"], requiresCredential: true, privilegeCodes: ["PHARM-DISPENSE", "PHARM-CHECK"], suggestedSystemRoles: ["pharmacist"] },
  { code: "PHARMACIST-SEN", name: "Senior Pharmacist", cadreCode: "PHARMACIST", seniority: "senior", departmentCodes: ["PHARM"], requiresCredential: true, privilegeCodes: ["PHARM-DISPENSE", "PHARM-CHECK"], suggestedSystemRoles: ["pharmacist", "department_lead"] },
  { code: "PHARM-TECH-STD", name: "Pharmacy Technician", cadreCode: "PHARM-TECH", seniority: "standard", departmentCodes: ["PHARM"], requiresCredential: true, privilegeCodes: ["PHARM-DISPENSE"], suggestedSystemRoles: ["pharmacist"] },
  { code: "LAB-SCI-STD", name: "Laboratory Scientist", cadreCode: "LAB-SCIENTIST", seniority: "standard", departmentCodes: ["LAB", "BLOOD"], requiresCredential: true, privilegeCodes: ["LAB-VERIFY"], suggestedSystemRoles: ["laboratory"] },
  { code: "LAB-SCI-SEN", name: "Senior Laboratory Scientist", cadreCode: "LAB-SCIENTIST", seniority: "senior", departmentCodes: ["LAB"], requiresCredential: true, privilegeCodes: ["LAB-VERIFY"], suggestedSystemRoles: ["laboratory", "department_lead"] },
  { code: "LAB-TECH-STD", name: "Laboratory Technician", cadreCode: "LAB-TECH", seniority: "standard", departmentCodes: ["LAB", "BLOOD"], requiresCredential: true, privilegeCodes: [], suggestedSystemRoles: ["laboratory"] },
  { code: "PHLEB-STD", name: "Phlebotomist", cadreCode: "PHLEBOTOMIST", seniority: "entry", departmentCodes: ["LAB", "OPD"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["laboratory"] },
  { code: "RAD-TECH-STD", name: "Radiographer", cadreCode: "RAD-TECH", seniority: "standard", departmentCodes: ["RAD"], requiresCredential: true, privilegeCodes: [], suggestedSystemRoles: ["radiology"] },
  { code: "SONO-STD", name: "Sonographer", cadreCode: "SONOGRAPHER", seniority: "standard", departmentCodes: ["RAD", "MAT"], requiresCredential: true, privilegeCodes: [], suggestedSystemRoles: ["radiology"] },
  { code: "DENTIST-STD", name: "Dentist", cadreCode: "DENTIST", seniority: "standard", departmentCodes: ["DENTAL"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "CLIN-SIGN"], suggestedSystemRoles: ["clinician"] },
  { code: "DENTAL-TECH-STD", name: "Dental Technician", cadreCode: "DENTAL-TECH", seniority: "standard", departmentCodes: ["DENTAL"], requiresCredential: true, privilegeCodes: [], suggestedSystemRoles: [] },
  { code: "OPTOMETRIST-STD", name: "Optometrist", cadreCode: "OPTOMETRIST", seniority: "standard", departmentCodes: ["EYEENT"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS"], suggestedSystemRoles: ["clinician"] },
  { code: "OPHTHAL-STD", name: "Ophthalmologist", cadreCode: "OPHTHALMOLOGIST", seniority: "standard", departmentCodes: ["EYEENT"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "CLIN-SIGN"], suggestedSystemRoles: ["specialist_clinician"] },
  { code: "ENT-STD", name: "ENT Specialist", cadreCode: "ENT-SPEC", seniority: "standard", departmentCodes: ["EYEENT"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "CLIN-SIGN"], suggestedSystemRoles: ["specialist_clinician"] },
  { code: "PHYSIO-STD", name: "Physiotherapist", cadreCode: "PHYSIO", seniority: "standard", departmentCodes: ["REHAB"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS"], suggestedSystemRoles: [] },
  { code: "OCC-THERAPIST-STD", name: "Occupational Therapist", cadreCode: "OCC-THERAPIST", seniority: "standard", departmentCodes: ["REHAB"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS"], suggestedSystemRoles: [] },
  { code: "SPEECH-THERAPIST-STD", name: "Speech and Language Therapist", cadreCode: "SPEECH-THERAPIST", seniority: "standard", departmentCodes: ["REHAB", "PED"], requiresCredential: true, privilegeCodes: [], suggestedSystemRoles: [] },
  { code: "PSYCHOLOGIST-STD", name: "Psychologist", cadreCode: "PSYCHOLOGIST", seniority: "standard", departmentCodes: ["MH"], requiresCredential: true, privilegeCodes: [], suggestedSystemRoles: [] },
  { code: "COUNSELLOR-STD", name: "Counsellor", cadreCode: "COUNSELLOR", seniority: "standard", departmentCodes: ["MH", "PRIMARY"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: [] },
  { code: "SOCIAL-WORKER-STD", name: "Social Worker", cadreCode: "SOCIAL-WORKER", seniority: "standard", departmentCodes: ["MH", "PALLIATIVE"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: [] },
  { code: "DIETITIAN-STD", name: "Dietitian", cadreCode: "DIETITIAN", seniority: "standard", departmentCodes: ["NUTR"], requiresCredential: true, privilegeCodes: [], suggestedSystemRoles: [] },
  { code: "PUBLIC-HEALTH-STD", name: "Public Health Specialist", cadreCode: "PUBLIC-HEALTH", seniority: "standard", departmentCodes: ["PRIMARY"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["public_health"] },
  { code: "CHW-STD", name: "Community Health Worker", cadreCode: "COMMUNITY-HEALTH", seniority: "entry", departmentCodes: ["PRIMARY"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: [] },
  { code: "EMERG-PHYS-STD", name: "Emergency Medical Officer", cadreCode: "EMERG-PHYS", seniority: "standard", departmentCodes: ["EMERG"], requiresCredential: true, privilegeCodes: ["CLIN-ASSESS", "CLIN-SIGN"], suggestedSystemRoles: ["clinician"] },
  { code: "PARAMEDIC-STD", name: "Paramedic", cadreCode: "PARAMEDIC", seniority: "standard", departmentCodes: ["EMERG"], requiresCredential: true, privilegeCodes: [], suggestedSystemRoles: [] },
  { code: "AMB-DRIVER-STD", name: "Ambulance Driver", cadreCode: "AMB-DRIVER", seniority: "standard", departmentCodes: ["EMERG"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: [] },
  { code: "ANAES-PROV-STD", name: "Anaesthesia Provider", cadreCode: "ANAES-PROV", seniority: "standard", departmentCodes: ["THEATRE"], requiresCredential: true, privilegeCodes: ["THEATRE-ANES"], suggestedSystemRoles: ["clinician"] },
  { code: "THEATRE-NURSE-STD", name: "Theatre Nurse", cadreCode: "THEATRE-NURSE", seniority: "standard", departmentCodes: ["THEATRE"], requiresCredential: true, privilegeCodes: ["THEATRE-SCRUB"], suggestedSystemRoles: ["nurse"] },
  { code: "THEATRE-TECH-STD", name: "Theatre Technician", cadreCode: "THEATRE-TECH", seniority: "standard", departmentCodes: ["THEATRE", "CSSD"], requiresCredential: false, privilegeCodes: ["THEATRE-SCRUB", "CSSD-RELEASE"], suggestedSystemRoles: ["theatre"] },
  { code: "RECOVERY-NURSE-STD", name: "Recovery Nurse", cadreCode: "RECOVERY-NURSE", seniority: "standard", departmentCodes: ["THEATRE"], requiresCredential: true, privilegeCodes: [], suggestedSystemRoles: ["nurse"] },
  { code: "HEALTH-RECORDS-STD", name: "Health Records Officer", cadreCode: "HEALTH-RECORDS", seniority: "standard", departmentCodes: ["ACCESS"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["records"] },
  { code: "HIM-STD", name: "Health Information Manager", cadreCode: "HIM", seniority: "senior", departmentCodes: ["ACCESS"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["records", "department_lead"] },
  { code: "MED-CODER-STD", name: "Medical Coder", cadreCode: "MED-CODER", seniority: "standard", departmentCodes: ["ACCESS"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["records"] },
  { code: "RECEPTIONIST-STD", name: "Receptionist", cadreCode: "RECEPTIONIST", seniority: "entry", departmentCodes: ["ACCESS"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["receptionist"] },
  { code: "ADMIN-OFF-STD", name: "Administrative Officer", cadreCode: "ADMIN-OFF", seniority: "standard", departmentCodes: ["GOV", "ACCESS", "HR", "FIN", "PROC"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: [] },
  { code: "HOSP-MGR-STD", name: "Facility Administrator", cadreCode: "HOSP-MGR", seniority: "lead", departmentCodes: ["GOV"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["facility_admin"] },
  { code: "IT-ADMIN-STD", name: "IT Administrator", cadreCode: "IT-ADMIN", seniority: "standard", departmentCodes: ["IT"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["it_admin"] },
  { code: "DATA-ANALYST-STD", name: "Data Analyst", cadreCode: "DATA-ANALYST", seniority: "standard", departmentCodes: ["IT"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["research"] },
  { code: "ACCOUNTANT-STD", name: "Accountant", cadreCode: "ACCOUNTANT", seniority: "standard", departmentCodes: ["FIN"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["finance"] },
  { code: "CASHIER-STD", name: "Cashier", cadreCode: "CASHIER", seniority: "entry", departmentCodes: ["FIN"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["finance"] },
  { code: "BILLING-OFF-STD", name: "Billing Officer", cadreCode: "BILLING-OFF", seniority: "standard", departmentCodes: ["FIN"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["finance"] },
  { code: "HR-OFF-STD", name: "Human Resources Officer", cadreCode: "HR-OFF", seniority: "standard", departmentCodes: ["HR"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["hr"] },
  { code: "CRED-OFF-STD", name: "Credentialing Officer", cadreCode: "CRED-OFF", seniority: "standard", departmentCodes: ["HR"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["hr"] },
  { code: "TRAIN-COORD-STD", name: "Training Coordinator", cadreCode: "TRAIN-COORD", seniority: "standard", departmentCodes: ["HR", "PRIMARY"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["hr"] },
  { code: "RESEARCH-COORD-STD", name: "Research Coordinator", cadreCode: "RESEARCH-COORD", seniority: "standard", departmentCodes: ["HR"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["research"] },
  { code: "PROC-OFF-STD", name: "Procurement Officer", cadreCode: "PROC-OFF", seniority: "standard", departmentCodes: ["PROC"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: [] },
  { code: "STOREKEEPER-STD", name: "Storekeeper", cadreCode: "STOREKEEPER", seniority: "entry", departmentCodes: ["PROC", "PHARM"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: [] },
  { code: "BIOMED-STD", name: "Biomedical Engineering Technician", cadreCode: "BIOMED", seniority: "standard", departmentCodes: ["ENG"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["biomedical"] },
  { code: "FAC-MGR-STD", name: "Facilities Manager", cadreCode: "FAC-MGR", seniority: "senior", departmentCodes: ["ENG"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: [] },
  { code: "MORTUARY-TECH-STD", name: "Mortuary Technician", cadreCode: "MORTUARY-TECH", seniority: "standard", departmentCodes: ["MORT"], requiresCredential: false, privilegeCodes: ["MORT-RELEASE"], suggestedSystemRoles: ["mortuary"] },
  { code: "HOUSEKEEPER-STD", name: "Housekeeper", cadreCode: "HOUSEKEEPER", seniority: "entry", departmentCodes: ["HOUSE"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["housekeeping"] },
  { code: "PORTER-STD", name: "Porter", cadreCode: "PORTER", seniority: "entry", departmentCodes: ["PORTER"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: ["porter"] },
  { code: "SEC-OFF-STD", name: "Security Officer", cadreCode: "SEC-OFF", seniority: "standard", departmentCodes: ["SEC"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: [] },
  { code: "COOK-STD", name: "Cook", cadreCode: "COOK", seniority: "entry", departmentCodes: ["CATER"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: [] },
  { code: "SOCIAL-AIDE-STD", name: "Patient Support Aide", cadreCode: "SOCIAL-AIDE", seniority: "entry", departmentCodes: ["WARD", "PALLIATIVE"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: [] },
  { code: "STUDENT-STD", name: "Student or Intern", cadreCode: "STUDENT", seniority: "entry", departmentCodes: ["OPD", "WARD", "LAB", "RAD", "PHARM", "THEATRE", "MAT", "PED", "REHAB"], requiresCredential: false, privilegeCodes: [], suggestedSystemRoles: [] },
];

export const UGANDA_SPECIALTIES: OnboardingCatalogueSpecialty[] = [
  { code: "INTERNAL-MED", name: "Internal medicine", cadreCodes: ["SPEC-PHYS", "CONSULTANT", "MED-OFF"], departmentCodes: ["OPD", "WARD"] },
  { code: "PAEDIATRICS", name: "Paediatrics", cadreCodes: ["PEDIATRICIAN", "MED-OFF"], departmentCodes: ["PED", "OPD"] },
  { code: "NEONATOLOGY", name: "Neonatology", cadreCodes: ["PEDIATRICIAN", "NURSE", "MIDWIFE"], departmentCodes: ["PED"] },
  { code: "OBSTETRICS", name: "Obstetrics", cadreCodes: ["OBGYN", "MIDWIFE", "MED-OFF"], departmentCodes: ["MAT"] },
  { code: "GYNAECOLOGY", name: "Gynaecology", cadreCodes: ["OBGYN", "MED-OFF"], departmentCodes: ["MAT", "THEATRE"] },
  { code: "GENERAL-SURGERY", name: "General surgery", cadreCodes: ["SURGEON", "MED-OFF"], departmentCodes: ["THEATRE", "WARD"] },
  { code: "ORTHOPAEDICS", name: "Orthopaedics", cadreCodes: ["SURGEON"], departmentCodes: ["THEATRE", "WARD"] },
  { code: "ANAESTHESIA", name: "Anaesthesia", cadreCodes: ["ANESTH", "ANAES-PROV"], departmentCodes: ["THEATRE", "CRIT"] },
  { code: "CRITICAL-CARE", name: "Critical care", cadreCodes: ["ANESTH", "INTENSIVIST", "NURSE"], departmentCodes: ["CRIT"] },
  { code: "EMERGENCY-MED", name: "Emergency medicine", cadreCodes: ["EMERG-PHYS", "MED-OFF", "CLIN-OFF"], departmentCodes: ["EMERG"] },
  { code: "HAEMATOLOGY", name: "Haematology", cadreCodes: ["PATHOLOGIST", "LAB-SCIENTIST"], departmentCodes: ["LAB", "BLOOD"] },
  { code: "CHEMICAL-PATH", name: "Chemical pathology", cadreCodes: ["PATHOLOGIST", "LAB-SCIENTIST"], departmentCodes: ["LAB"] },
  { code: "MICROBIOLOGY", name: "Microbiology", cadreCodes: ["PATHOLOGIST", "LAB-SCIENTIST"], departmentCodes: ["LAB"] },
  { code: "HISTOPATHOLOGY", name: "Histopathology", cadreCodes: ["PATHOLOGIST", "LAB-SCIENTIST"], departmentCodes: ["LAB"] },
  { code: "TRANSFUSION", name: "Transfusion medicine", cadreCodes: ["PATHOLOGIST", "LAB-SCIENTIST", "NURSE"], departmentCodes: ["BLOOD"] },
  { code: "DIAGNOSTIC-RAD", name: "Diagnostic radiology", cadreCodes: ["RADIOLOGIST", "RAD-TECH"], departmentCodes: ["RAD"] },
  { code: "ULTRASOUND", name: "Ultrasound", cadreCodes: ["RADIOLOGIST", "SONOGRAPHER"], departmentCodes: ["RAD", "MAT"] },
  { code: "CLINICAL-PHARM", name: "Clinical pharmacy", cadreCodes: ["PHARMACIST"], departmentCodes: ["PHARM", "CRIT"] },
  { code: "DENTAL-SURGERY", name: "Dental surgery", cadreCodes: ["DENTIST"], departmentCodes: ["DENTAL"] },
  { code: "OPHTHALMOLOGY", name: "Ophthalmology", cadreCodes: ["OPHTHALMOLOGIST", "OPTOMETRIST"], departmentCodes: ["EYEENT"] },
  { code: "ENT", name: "Otorhinolaryngology (ENT)", cadreCodes: ["ENT-SPEC"], departmentCodes: ["EYEENT"] },
  { code: "MENTAL-HEALTH", name: "Mental health", cadreCodes: ["PSYCHIATRIST", "PSYCHOLOGIST", "COUNSELLOR"], departmentCodes: ["MH"] },
  { code: "PHYSIOTHERAPY", name: "Physiotherapy", cadreCodes: ["PHYSIO"], departmentCodes: ["REHAB"] },
  { code: "OCCUPATIONAL-THERAPY", name: "Occupational therapy", cadreCodes: ["OCC-THERAPIST"], departmentCodes: ["REHAB"] },
  { code: "NUTRITION", name: "Clinical nutrition", cadreCodes: ["DIETITIAN"], departmentCodes: ["NUTR"] },
  { code: "PUBLIC-HEALTH", name: "Public and community health", cadreCodes: ["PUBLIC-HEALTH", "COMMUNITY-HEALTH"], departmentCodes: ["PRIMARY"] },
  { code: "PALLIATIVE", name: "Palliative care", cadreCodes: ["MED-OFF", "NURSE", "SOCIAL-WORKER"], departmentCodes: ["PALLIATIVE"] },
  { code: "IPC", name: "Infection prevention and control", cadreCodes: ["NURSE", "PUBLIC-HEALTH"], departmentCodes: ["IPC"] },
  { code: "QUALITY", name: "Quality and patient safety", cadreCodes: ["NURSE", "PUBLIC-HEALTH"], departmentCodes: ["IPC"] },
  { code: "RENAL", name: "Nephrology and dialysis", cadreCodes: ["MED-OFF", "SPEC-PHYS"], departmentCodes: ["RENAL"] },
];

export const UGANDA_ONBOARDING_CATALOGUE: OnboardingCatalogue = {
  countryCode: UGANDA_CATALOGUE_COUNTRY,
  version: UGANDA_CATALOGUE_VERSION,
  notice: UGANDA_CATALOGUE_NOTICE,
  regulators: UGANDA_REGULATORS,
  departments: UGANDA_DEPARTMENTS,
  cadres: UGANDA_CADRES,
  jobTitles: UGANDA_JOB_TITLES,
  specialties: UGANDA_SPECIALTIES,
};

export interface OnboardingCatalogueFilter {
  q?: string;
  cadreCode?: string;
  departmentCode?: string;
  titleCode?: string;
}

export function searchCatalogue(catalogue: OnboardingCatalogue, filter: OnboardingCatalogueFilter = {}) {
  const q = filter.q?.trim().toLowerCase();
  const departmentByTitle = new Map<string, string[]>();
  for (const title of catalogue.jobTitles) departmentByTitle.set(title.code, title.departmentCodes);
  const matches = (value: string | undefined) => !q || Boolean(value?.toLowerCase().includes(q));
  const titles = catalogue.jobTitles.filter((title) => {
    if (filter.cadreCode && title.cadreCode !== filter.cadreCode) return false;
    if (filter.departmentCode && !title.departmentCodes.includes(filter.departmentCode)) return false;
    if (filter.titleCode && title.code !== filter.titleCode) return false;
    if (!q) return true;
    const cadre = catalogue.cadres.find((item) => item.code === title.cadreCode);
    return matches(title.name) || matches(title.code) || matches(title.description) || matches(cadre?.name);
  });
  const cadres = catalogue.cadres.filter((cadre) => {
    if (filter.cadreCode && cadre.code !== filter.cadreCode) return false;
    if (filter.departmentCode && !catalogue.jobTitles.some((title) => title.cadreCode === cadre.code && title.departmentCodes.includes(filter.departmentCode!))) return false;
    if (!q) return true;
    return matches(cadre.name) || matches(cadre.code) || matches(cadre.description);
  });
  const departments = catalogue.departments.filter((department) => {
    if (filter.departmentCode && department.code !== filter.departmentCode) return false;
    if (filter.cadreCode && !catalogue.jobTitles.some((title) => title.cadreCode === filter.cadreCode && title.departmentCodes.includes(department.code))) return false;
    if (!q) return true;
    return matches(department.name) || matches(department.code);
  });
  const specialties = catalogue.specialties.filter((specialty) => {
    if (filter.cadreCode && !specialty.cadreCodes.includes(filter.cadreCode)) return false;
    if (filter.departmentCode && !specialty.departmentCodes.includes(filter.departmentCode)) return false;
    if (!q) return true;
    return matches(specialty.name) || matches(specialty.code);
  });
  return { titles, cadres, departments, specialties, departmentByTitle };
}

export function titleDepartmentCodes(catalogue: OnboardingCatalogue, titleCode: string): string[] {
  return catalogue.jobTitles.find((title) => title.code === titleCode)?.departmentCodes ?? [];
}

export function regulatorCodesForCadre(catalogue: OnboardingCatalogue, cadreCode: string): string[] {
  return catalogue.cadres.find((cadre) => cadre.code === cadreCode)?.regulatorCodes ?? [];
}

export function isClinicalCadre(catalogue: OnboardingCatalogue, cadreCode: string): boolean {
  const category = catalogue.cadres.find((cadre) => cadre.code === cadreCode)?.category;
  return ["medical", "clinical", "nursing", "midwifery", "pharmacy", "laboratory", "radiology", "dental", "eye-ent", "anaesthesia", "emergency", "mental-health", "rehabilitation", "nutrition"].includes(category ?? "");
}

export const ONBOARDING_PATHS = [
  "patient",
  "proxy",
  "clinician",
  "nurse",
  "allied_health",
  "support",
  "administrative",
  "trainee",
  "facility_admin",
] as const;
export type OnboardingPath = (typeof ONBOARDING_PATHS)[number];

const CLINICAL_CATEGORIES = new Set([
  "medical",
  "clinical",
  "dental",
  "eye-ent",
  "emergency",
  "anaesthesia",
]);
const NURSING_CATEGORIES = new Set(["nursing", "midwifery"]);
const ALLIED_CATEGORIES = new Set([
  "laboratory",
  "radiology",
  "pharmacy",
  "rehabilitation",
  "nutrition",
  "mental-health",
  "public-health",
  "health-information",
]);
const SUPPORT_CATEGORIES = new Set(["support", "technical", "mortuary", "security"]);
const ADMIN_CATEGORIES = new Set([
  "administrative",
  "administration",
  "finance",
  "data",
  "education",
  "research",
  "governance",
  "quality",
]);

export function onboardingPathForTitle(
  catalogue: OnboardingCatalogue,
  title: OnboardingCatalogueJobTitle,
): OnboardingPath {
  if (title.suggestedSystemRoles.includes("facility_admin")) return "facility_admin";
  const category = title.cadreCode ? categoryForCadreCode(catalogue, title.cadreCode) : null;
  if (category && CLINICAL_CATEGORIES.has(category)) return "clinician";
  if (category && NURSING_CATEGORIES.has(category)) return "nurse";
  if (category && ALLIED_CATEGORIES.has(category)) return "allied_health";
  if (category === "trainee" || title.seniority === "entry" && title.name.toLowerCase().includes("intern")) return "trainee";
  if (category && SUPPORT_CATEGORIES.has(category)) return "support";
  if (category && ADMIN_CATEGORIES.has(category)) return "administrative";
  return "administrative";
}

export function categoryForCadreCode(catalogue: OnboardingCatalogue, cadreCode: string): string | null {
  return catalogue.cadres.find((cadre) => cadre.code === cadreCode)?.category ?? null;
}

export function jobTitleByCode(
  catalogue: OnboardingCatalogue,
  titleCode: string,
): OnboardingCatalogueJobTitle | null {
  return catalogue.jobTitles.find((title) => title.code === titleCode) ?? null;
}

export interface CatalogueIntegrityOptions {
  knownPrivilegeCodes?: readonly string[];
  knownSystemRoles?: readonly string[];
}

/**
 * Returns human-readable integrity problems for an editable catalogue. This is
 * a wiring check, not a legal review: it only proves that codes referenced by
 * titles and specialties exist inside the same catalogue.
 */
export function catalogueIntegrityIssues(
  catalogue: OnboardingCatalogue,
  options: CatalogueIntegrityOptions = {},
): string[] {
  const issues: string[] = [];
  const regulators = new Set<string>();
  const departments = new Set<string>();
  const cadres = new Set<string>();
  const titles = new Set<string>();
  const specialties = new Set<string>();

  const collect = (kind: string, codes: readonly string[], target: Set<string>) => {
    for (const code of codes) {
      if (!code.trim()) issues.push(`${kind} contains an empty code`);
      else if (target.has(code)) issues.push(`${kind} contains duplicate code ${code}`);
      target.add(code);
    }
  };
  collect("regulators", catalogue.regulators.map((item) => item.code), regulators);
  collect("departments", catalogue.departments.map((item) => item.code), departments);
  collect("cadres", catalogue.cadres.map((item) => item.code), cadres);
  collect("job titles", catalogue.jobTitles.map((item) => item.code), titles);
  collect("specialties", catalogue.specialties.map((item) => item.code), specialties);

  for (const cadre of catalogue.cadres) {
    for (const regulator of cadre.regulatorCodes) {
      if (!regulators.has(regulator)) issues.push(`cadre ${cadre.code} references unknown regulator ${regulator}`);
    }
  }
  for (const title of catalogue.jobTitles) {
    if (!cadres.has(title.cadreCode)) issues.push(`job title ${title.code} references unknown cadre ${title.cadreCode}`);
    for (const department of title.departmentCodes) {
      if (!departments.has(department)) issues.push(`job title ${title.code} references unknown department ${department}`);
    }
    if (options.knownPrivilegeCodes) {
      const known = new Set(options.knownPrivilegeCodes);
      for (const privilege of title.privilegeCodes) {
        if (!known.has(privilege)) issues.push(`job title ${title.code} references unknown privilege ${privilege}`);
      }
    }
    if (options.knownSystemRoles) {
      const known = new Set(options.knownSystemRoles);
      for (const role of title.suggestedSystemRoles) {
        if (!known.has(role)) issues.push(`job title ${title.code} suggests unknown system role ${role}`);
      }
    }
  }
  for (const specialty of catalogue.specialties) {
    for (const cadre of specialty.cadreCodes) {
      if (!cadres.has(cadre)) issues.push(`specialty ${specialty.code} references unknown cadre ${cadre}`);
    }
    for (const department of specialty.departmentCodes) {
      if (!departments.has(department)) issues.push(`specialty ${specialty.code} references unknown department ${department}`);
    }
  }
  return issues;
}

export interface CatalogueSelection {
  title: OnboardingCatalogueJobTitle;
  path: OnboardingPath;
  cadreCode: string;
  regulatorCodes: string[];
  departmentCodes: string[];
  credentialRequired: boolean;
  requestedSystemRoles: string[];
}

/**
 * Resolve a title and optional cadre into a snapshot suitable for an
 * onboarding case. A mismatch or unknown code is rejected rather than silently
 * falling back to a broader title.
 */
export function resolveCatalogueTitle(
  catalogue: OnboardingCatalogue,
  titleCode: string,
  cadreCode?: string | null,
): CatalogueSelection {
  const title = jobTitleByCode(catalogue, titleCode);
  if (!title) throw new DomainError(`Unknown catalogue job title: ${titleCode}`);
  if (cadreCode && cadreCode !== title.cadreCode) {
    throw new DomainError("The selected cadre does not match the catalogue job title");
  }
  return {
    title,
    path: onboardingPathForTitle(catalogue, title),
    cadreCode: title.cadreCode,
    regulatorCodes: regulatorCodesForCadre(catalogue, title.cadreCode),
    departmentCodes: titleDepartmentCodes(catalogue, title.code),
    credentialRequired: title.requiresCredential,
    requestedSystemRoles: [...title.suggestedSystemRoles],
  };
}

const DEFAULT_TO_CATALOGUE_DEPARTMENT: Record<string, string> = {
  NUT: "NUTR",
  COMM: "PRIMARY",
  PALL: "PALLIATIVE",
  ENV: "HOUSE",
  PORT: "PORTER",
};

/** Maps legacy bootstrap department codes onto Uganda catalogue codes. */
export function catalogueCodeForDefaultDepartment(code: string): string {
  return DEFAULT_TO_CATALOGUE_DEPARTMENT[code] ?? code;
}

export const ONBOARDING_ACCOUNT_TYPES: { code: OnboardingPath; label: string; description: string }[] = [
  { code: "clinician", label: "Medical or dental practitioner", description: "Medical officers, specialists, dentists and clinical officers." },
  { code: "nurse", label: "Nurse or midwife", description: "Nursing, midwifery, theatre and recovery staff." },
  { code: "allied_health", label: "Allied health professional", description: "Pharmacy, laboratory, imaging, rehabilitation, nutrition and mental health." },
  { code: "trainee", label: "Student or intern", description: "Supervised, limited access only." },
  { code: "support", label: "Support and technical staff", description: "Housekeeping, portering, mortuary, security, catering, biomedical and facilities." },
  { code: "administrative", label: "Administrative staff", description: "Records, finance, HR, procurement, ICT and general administration." },
  { code: "facility_admin", label: "Facility administrator", description: "Facility onboarding and permitted governance workflows." },
];

export interface CatalogueTitleGroups {
  suggested: OnboardingCatalogueJobTitle[];
  other: OnboardingCatalogueJobTitle[];
}

/**
 * Suggested titles match both the selected cadre and department (when
 * supplied). Other titles still match the free-text query so a person can find
 * a relevant cross-department title without the UI becoming the authorization
 * boundary. The server repeats every check.
 */
export function groupCatalogueTitles(
  catalogue: OnboardingCatalogue,
  filter: OnboardingCatalogueFilter = {},
): CatalogueTitleGroups {
  const q = filter.q?.trim().toLowerCase();
  const textMatches = (title: OnboardingCatalogueJobTitle) => {
    if (!q) return true;
    const cadre = catalogue.cadres.find((item) => item.code === title.cadreCode);
    return [title.name, title.code, title.description, cadre?.name]
      .some((value) => Boolean(value?.toLowerCase().includes(q)));
  };
  const suggested = catalogue.jobTitles.filter((title) => {
    if (!textMatches(title)) return false;
    if (filter.cadreCode && title.cadreCode !== filter.cadreCode) return false;
    if (filter.departmentCode && !title.departmentCodes.includes(filter.departmentCode)) return false;
    return true;
  });
  const suggestedCodes = new Set(suggested.map((title) => title.code));
  const other = catalogue.jobTitles.filter((title) => !suggestedCodes.has(title.code) && textMatches(title));
  return { suggested, other };
}

/**
 * Validate an editable catalogue payload before it is stored or published.
 * This proves internal wiring, not legal correctness.
 */
export function parseOnboardingCatalogue(value: unknown): OnboardingCatalogue {
  if (!value || typeof value !== "object") throw new DomainError("Catalogue content must be an object");
  const candidate = value as Partial<OnboardingCatalogue>;
  if (!/^[A-Z]{2}$/.test(String(candidate.countryCode ?? ""))) {
    throw new DomainError("Catalogue countryCode must be a two-letter uppercase code");
  }
  if (!Number.isInteger(candidate.version) || Number(candidate.version) < 1) {
    throw new DomainError("Catalogue version must be a positive integer");
  }
  if (typeof candidate.notice !== "string" || !candidate.notice.trim()) {
    throw new DomainError("Catalogue notice is required");
  }
  for (const key of ["regulators", "departments", "cadres", "jobTitles", "specialties"] as const) {
    if (!Array.isArray(candidate[key])) throw new DomainError(`Catalogue ${key} must be an array`);
  }
  const catalogue = candidate as OnboardingCatalogue;
  const issues = catalogueIntegrityIssues(catalogue);
  if (issues.length) throw new DomainError(`Catalogue integrity check failed: ${issues.join("; ")}`);
  return catalogue;
}

