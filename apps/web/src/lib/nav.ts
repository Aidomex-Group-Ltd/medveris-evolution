import type { MeResponse, Role } from "./types";
import { CASHIER_ROLES, DEPARTMENT_QUEUE_ROLES, INVENTORY_ROLES, PROCUREMENT_ROLES, VISIT_ROLES } from "./roles";
import { DEPARTMENT_MODULES, hasModule, workspaceProfile } from "./workspace";

/**
 * One source of truth for the sidebar. Items keep the existing route guards:
 * this module only decides what is worth showing, never what is allowed.
 */
export interface NavItem {
  to: string;
  label: string;
  roles?: readonly Role[];
  patientOnly?: boolean;
  staffOnly?: boolean;
  /** Members of an organization, or administrators of a workspace linked to one. */
  organization?: boolean;
  /** Shown only when the active workspace has one of these modules enabled. */
  modules?: readonly string[];
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

const WORKSPACE_NAV: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { to: "/", label: "Overview" },
      { to: "/patients", label: "Patients", roles: ["receptionist", "nurse", "clinician", "facility_admin"] },
      { to: "/visits", label: "Visits", roles: VISIT_ROLES },
      { to: "/queues", label: "Queues", roles: ["receptionist", "nurse", "clinician", "facility_admin"], modules: ["reception", "outpatient"] },
      { to: "/appointments", label: "Appointments", roles: ["receptionist", "nurse", "clinician", "facility_admin"], modules: ["reception", "outpatient"] },
      { to: "/worklist", label: "Clinical worklist", roles: ["nurse", "clinician"], modules: ["outpatient", "emergency", "inpatient"] },
      { to: "/care", label: "Follow-ups and referrals", roles: ["nurse", "clinician"], modules: ["outpatient", "programmes"] },
      { to: "/emergency", label: "Emergency", roles: ["nurse", "clinician"], modules: ["emergency"] },
      { to: "/exchange", label: "Record exchange", roles: ["nurse", "clinician"], modules: ["outpatient", "emergency", "inpatient"] },
      { to: "/wards", label: "Wards and beds", roles: ["nurse", "clinician", "ward_manager", "facility_admin"], modules: ["inpatient"] },
      { to: "/maternity", label: "Maternity", roles: ["nurse", "clinician", "facility_admin"], modules: ["maternity"] },
      { to: "/operations", label: "Hospital operations", roles: ["nurse", "clinician", "facility_admin", "housekeeping", "porter", "mortuary", "cssd", "biomedical", "auditor"], modules: ["inpatient"] },
      { to: "/inventory", label: "Inventory and assets", roles: INVENTORY_ROLES, modules: ["inventory"] },
      { to: "/procurement", label: "Purchasing", roles: PROCUREMENT_ROLES, modules: ["inventory"] },
      { to: "/theatre", label: "Theatre", roles: ["nurse", "clinician", "facility_admin"], modules: ["theatre"] },
      { to: "/diagnostics", label: "Diagnostics", roles: ["nurse", "clinician", "laboratory", "lab_validator", "radiology", "radiographer", "radiologist"], modules: ["laboratory", "radiology"] },
      { to: "/radiology", label: "Radiology reporting", roles: ["nurse", "clinician", "radiology", "radiographer", "radiologist"], modules: ["radiology"] },
      { to: "/pharmacy", label: "Pharmacy", roles: ["nurse", "clinician", "pharmacist", "facility_admin"], modules: ["pharmacy"] },
      { to: "/pharmacy-pos", label: "Pharmacy POS", roles: ["pharmacist", "finance", "facility_admin", "owner", "clinician", "specialist_clinician"], modules: ["pharmacy"] },
      { to: "/programmes", label: "Care programmes", roles: ["nurse", "clinician"], modules: ["programmes"] },
      { to: "/telehealth", label: "Telehealth", roles: ["nurse", "clinician"], modules: ["outpatient"] },
      { to: "/devices", label: "Devices", roles: ["nurse", "clinician", "facility_admin"], modules: ["inpatient", "emergency", "outpatient"] },
      { to: "/ai", label: "Assistive AI", roles: ["nurse", "clinician"], modules: ["outpatient", "radiology"] },
      { to: "/content", label: "Health library", staffOnly: true },
      { to: "/onboarding-workflow", label: "Onboarding" },
      { to: "/finance", label: "Finance", roles: ["finance", "facility_admin"], modules: ["finance"] },
      { to: "/public-health", label: "Public health", roles: ["public_health", "facility_admin"], modules: ["public-health"] },
      { to: "/ehmis", label: "eHMIS reporting", roles: ["public_health", "facility_admin"], modules: ["public-health"] },
      { to: "/provider-directory", label: "Provider directory", roles: ["facility_admin"] },
      { to: "/promotions", label: "Sponsorship", roles: ["facility_admin"] },
    ],
  },
  {
    label: "Departments",
    items: [
      { to: "/work-queues/laboratory", label: "Laboratory queue", roles: [...DEPARTMENT_QUEUE_ROLES.laboratory, "clinician"], modules: DEPARTMENT_MODULES.laboratory },
      { to: "/work-queues/imaging", label: "Imaging queue", roles: [...DEPARTMENT_QUEUE_ROLES.imaging, "clinician"], modules: DEPARTMENT_MODULES.imaging },
      { to: "/work-queues/theatre", label: "Theatre queue", roles: DEPARTMENT_QUEUE_ROLES.theatre, modules: DEPARTMENT_MODULES.theatre },
      { to: "/work-queues/pharmacy", label: "Pharmacy queue", roles: [...DEPARTMENT_QUEUE_ROLES.pharmacy, "clinician"], modules: DEPARTMENT_MODULES.pharmacy },
      { to: "/work-queues/procedure", label: "Procedure room", roles: DEPARTMENT_QUEUE_ROLES.procedure, modules: DEPARTMENT_MODULES.procedure },
    ],
  },
  {
    label: "Billing",
    items: [
      { to: "/pos", label: "Point of sale", roles: CASHIER_ROLES, modules: ["finance"] },
      { to: "/price-list", label: "Price list", roles: CASHIER_ROLES, modules: ["finance"] },
      { to: "/subscription", label: "Subscription and usage" },
    ],
  },
  {
    label: "Patient portal",
    items: [
      { to: "/portal", label: "My health record", patientOnly: true },
      { to: "/portal/consents", label: "Consent and sharing", patientOnly: true },
      { to: "/portal/access", label: "Access history", patientOnly: true },
      { to: "/caregivers", label: "Caregivers", patientOnly: true },
      { to: "/content", label: "Health library", patientOnly: true },
    ],
  },
  {
    label: "Governance",
    items: [
      { to: "/credentials", label: "Credentials", staffOnly: true },
      { to: "/documents", label: "Documentation", roles: ["clinician", "nurse", "records", "receptionist", "facility_admin", "hr", "quality"] },
      { to: "/workforce", label: "Workforce", roles: ["hr", "facility_admin"] },
      { to: "/caregiver-requests", label: "Caregiver requests", roles: ["facility_admin", "records"] },
      { to: "/workspace", label: "Workspace profile", staffOnly: true },
      { to: "/organizations", label: "Organizations", organization: true },
      { to: "/admin", label: "Facility administration", roles: ["facility_admin", "department_admin"] },
      { to: "/patient-merges", label: "Patient merges", roles: ["facility_admin", "records"] },
      { to: "/reports", label: "Reports" },
      { to: "/catalogue-editor", label: "Catalogue editor", roles: ["facility_admin"] },
      { to: "/security", label: "Session security", staffOnly: true },
    ],
  },
];

/** Platform operations live in their own area, never mixed into facility governance. */
const PLATFORM_NAV: NavItem[] = [
  { to: "/directory-governance", label: "Directory governance" },
  { to: "/platform-integrations", label: "Integrations" },
  { to: "/reviewer", label: "Credential review" },
  { to: "/platform-billing", label: "Platform billing" },
  { to: "/platform-observability", label: "Observability" },
  { to: "/security", label: "Session security" },
];

export function canSeeNavItem(item: NavItem, me: MeResponse): boolean {
  const roles = me.activeTenant?.roles ?? [];
  const profile = workspaceProfile(me.activeTenant);
  if (item.patientOnly) return Boolean(me.patientId);
  if (item.modules && me.activeTenant && !hasModule(profile, ...item.modules)) return false;
  if (item.staffOnly) return Boolean(me.activeTenant);
  // An independent workspace never needs organization screens; it can still ask to join from its workspace profile.
  if (item.organization) return Boolean(me.organizations?.length) || (roles.includes("facility_admin") && !profile.independent);
  if (item.roles) return item.roles.some((role) => roles.includes(role));
  return true;
}

export function navFor(me: MeResponse): { workspace: NavGroup[]; platform: NavItem[] } {
  const workspace = WORKSPACE_NAV
    .map((group) => ({ label: group.label, items: group.items.filter((item) => canSeeNavItem(item, me)) }))
    .filter((group) => group.items.length > 0);
  // Platform operators may have no facility workspace, so the platform area
  // depends only on the platform roles themselves.
  const platform = me.platformRoles.length > 0 ? PLATFORM_NAV : [];
  return { workspace, platform };
}
