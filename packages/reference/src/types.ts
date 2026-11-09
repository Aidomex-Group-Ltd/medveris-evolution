export interface Cadre {
  code: string;
  name: string;
  category: string;
  description?: string;
  regulatorCodes: string[];
  regulatoryBodyCodes: string[];
  requiresRegistration: boolean;
  isco08Code: string | null;
  isco08Reviewed: boolean;
  active: boolean;
  version: number;
}

export interface JobTitle {
  code: string;
  name: string;
  cadreCode: string;
  seniority: "entry" | "standard" | "senior" | "lead" | "consultant";
  description?: string;
  departmentCodes: string[];
  requiresCredential: boolean;
  privilegeCodes: string[];
  suggestedSystemRoles: string[];
  active: boolean;
  version: number;
}

export interface Specialty {
  code: string;
  name: string;
  cadreCode: string | null;
  cadreCodes: string[];
  departmentCodes: string[];
  description?: string;
  active: boolean;
  version: number;
}

export interface Department {
  code: string;
  name: string;
  description?: string;
  sortOrder: number;
  active: boolean;
  version: number;
}

export interface Regulator {
  code: string;
  name: string;
  regulatorType: string;
  country: string;
  verificationMode: "manual" | "official-api" | string;
  website?: string;
  notes?: string;
  active: boolean;
  version: number;
}

export interface Capability {
  code: string;
  name: string;
  category: string;
  description?: string;
  active: boolean;
  version: number;
}

export interface PayrollGrade {
  code: string;
  name: string;
  gradeLevel: number;
  description?: string;
  active: boolean;
  version: number;
}

export const CADRE_GROUPS: Record<string, string[]> = {
  medical: ["MED-OFF", "SPEC-PHYS", "CONSULTANT", "SURGEON", "ANESTH", "OBGYN", "PEDIATRICIAN", "PSYCHIATRIST", "INTENSIVIST", "PATHOLOGIST", "RADIOLOGIST"],
  clinical: ["CLIN-OFF"],
  nursing: ["NURSE"],
  midwifery: ["MIDWIFE"],
  pharmacy: ["PHARMACIST", "PHARM-TECH"],
  laboratory: ["LAB-SCIENTIST", "LAB-TECH", "PHLEBOTOMIST"],
  radiology: ["RAD-TECH", "SONOGRAPHER"],
  dental: ["DENTIST", "DENTAL-TECH"],
  "eye-ent": ["OPTOMETRIST", "OPHTHALMOLOGIST", "ENT-SPEC"],
  rehabilitation: ["PHYSIO", "OCC-THERAPIST", "SPEECH-THERAPIST"],
  "mental-health": ["PSYCHOLOGIST", "COUNSELLOR", "SOCIAL-WORKER"],
  nutrition: ["DIETITIAN"],
  "public-health": ["PUBLIC-HEALTH", "COMMUNITY-HEALTH"],
  emergency: ["EMERG-PHYS", "PARAMEDIC", "AMB-DRIVER"],
  anaesthesia: ["ANAES-PROV"],
  "health-information": ["HEALTH-RECORDS", "HIM", "MED-CODER"],
  administration: ["RECEPTIONIST", "ADMIN-OFF", "HOSP-MGR", "IT-ADMIN", "DATA-ANALYST"],
  finance: ["ACCOUNTANT", "CASHIER", "BILLING-OFF"],
  technical: ["BIOMED", "FAC-MGR", "THEATRE-TECH"],
  support: ["NURSE-ASST", "MORTUARY-TECH", "HOUSEKEEPER", "PORTER", "SEC-OFF", "COOK", "SOCIAL-AIDE", "STUDENT", "THEATRE-NURSE"],
};
