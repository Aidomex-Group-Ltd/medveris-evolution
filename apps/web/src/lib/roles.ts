import type { Role } from "./types";

export const INVENTORY_ROLES: readonly Role[] = [
  "nurse", "midwife", "clinician", "specialist_clinician", "diagnostic_practitioner", "department_lead", "laboratory", "lab_validator",
  "radiology", "radiographer", "radiologist", "ward_manager", "pharmacist", "theatre", "facility_admin", "hr", "records", "quality",
  "finance", "auditor", "housekeeping", "porter", "mortuary", "cssd", "biomedical", "department_admin", "unit_lead", "staff", "report_viewer",
];

export const PROCUREMENT_ROLES: readonly Role[] = ["facility_admin", "pharmacist", "department_admin", "unit_lead", "finance", "auditor", "report_viewer"];
