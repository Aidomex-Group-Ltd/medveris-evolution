import type { Role } from "./types";

export const INVENTORY_ROLES: readonly Role[] = [
  "nurse", "midwife", "clinician", "specialist_clinician", "diagnostic_practitioner", "department_lead", "laboratory", "lab_validator",
  "radiology", "radiographer", "radiologist", "ward_manager", "pharmacist", "theatre", "facility_admin", "hr", "records", "quality",
  "finance", "auditor", "housekeeping", "porter", "mortuary", "cssd", "biomedical", "department_admin", "unit_lead", "staff", "report_viewer",
];

export const PROCUREMENT_ROLES: readonly Role[] = ["facility_admin", "pharmacist", "department_admin", "unit_lead", "finance", "auditor", "report_viewer"];

/** Roles that take part in a patient visit: front desk, clinicians, departments and the till. */
export const VISIT_ROLES: readonly Role[] = [
  "receptionist", "nurse", "clinician", "specialist_clinician", "facility_admin", "finance", "laboratory", "radiology", "pharmacist", "theatre",
];

export const RECOMMENDING_ROLES: readonly Role[] = ["clinician", "specialist_clinician"];

/** Mirrors the API: who works each department's queue. */
export const DEPARTMENT_QUEUE_ROLES = {
  laboratory: ["laboratory"],
  imaging: ["radiology"],
  theatre: ["theatre", "nurse"],
  pharmacy: ["pharmacist"],
  procedure: ["nurse", "clinician"],
  other: ["nurse", "clinician"],
} as const satisfies Record<string, readonly Role[]>;

export const CASHIER_ROLES: readonly Role[] = ["finance", "facility_admin"];
