import type { MatrixEntry } from "../types/index.js";
import { ORGANIZATION_ACTIONS } from "./organization.js";
import { TENANT_ACTIONS } from "./tenant.js";
import { PATIENT_ACTIONS } from "./patient.js";
import { CLINICAL_ACTIONS } from "./clinical.js";
import { PHARMACY_ACTIONS } from "./pharmacy.js";
import { DIAGNOSTICS_ACTIONS } from "./diagnostics.js";
import { RADIOLOGY_ACTIONS } from "./radiology.js";
import { FINANCE_ACTIONS } from "./finance.js";
import { BILLING_ACTIONS } from "./billing.js";
import { INVENTORY_ACTIONS } from "./inventory.js";
import { WORKFORCE_ACTIONS } from "./workforce.js";
import { CONTENT_ACTIONS } from "./content.js";
import { DIRECTORY_ACTIONS } from "./directory.js";
import { INTEGRATION_ACTIONS } from "./integration.js";
import { PLATFORM_ACTIONS } from "./platform.js";
import { AUDIT_ACTIONS } from "./audit.js";
import { OPERATIONS_ACTIONS } from "./operations.js";

/**
 * Canonical authorization matrix, assembled from domain-focused modules.
 *
 * This is the single ordered aggregation of every protected action. Keys are stable
 * and must never be reused for a different action. Add entries to the matching
 * domain module, never inline here.
 */
export const AUTHORIZATION_MATRIX: readonly MatrixEntry[] = [
  ...ORGANIZATION_ACTIONS,
  ...TENANT_ACTIONS,
  ...PATIENT_ACTIONS,
  ...CLINICAL_ACTIONS,
  ...PHARMACY_ACTIONS,
  ...DIAGNOSTICS_ACTIONS,
  ...RADIOLOGY_ACTIONS,
  ...FINANCE_ACTIONS,
  ...BILLING_ACTIONS,
  ...INVENTORY_ACTIONS,
  ...WORKFORCE_ACTIONS,
  ...CONTENT_ACTIONS,
  ...DIRECTORY_ACTIONS,
  ...INTEGRATION_ACTIONS,
  ...PLATFORM_ACTIONS,
  ...AUDIT_ACTIONS,
  ...OPERATIONS_ACTIONS,
];
