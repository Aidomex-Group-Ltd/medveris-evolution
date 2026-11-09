import type { MeResponse, Role } from "./types";
import { CASHIER_ROLES, DEPARTMENT_QUEUE_ROLES, INVENTORY_ROLES, PROCUREMENT_ROLES } from "./roles";
import { DEPARTMENT_MODULES, hasModule, workspaceProfile } from "./workspace";

/**
 * The one authoritative navigation model for the facility workspace.
 *
 * Desktop sections and the mobile bottom navigation both derive from NAV_DESTINATIONS.
 * This module only decides what is worth showing; it is never an authorization boundary.
 * Route guards and the API remain the authority for what a caller may access.
 */

export type NavSectionId =
  | "dashboard"
  | "reception"
  | "outpatient"
  | "inpatient"
  | "theatre"
  | "diagnostics"
  | "pharmacy"
  | "chronic"
  | "virtual"
  | "iot"
  | "facility"
  | "administration"
  | "intelligence"
  | "portal";

export type MobileTabId = "home" | "care" | "analytics" | "knowledge" | "more";

export type NavSectionGroupId = "operations" | "management" | "intelligence";

export type NavIconName =
  | "dashboard"
  | "reception"
  | "outpatient"
  | "inpatient"
  | "theatre"
  | "diagnostics"
  | "pharmacy"
  | "chronic"
  | "virtual"
  | "iot"
  | "facility"
  | "administration"
  | "intelligence"
  | "portal"
  | "patients"
  | "visits"
  | "queues"
  | "calendar"
  | "exchange"
  | "emergency"
  | "maternity"
  | "radiology"
  | "laboratory"
  | "imaging"
  | "inventory"
  | "procurement"
  | "organizations"
  | "credentials"
  | "documents"
  | "workforce"
  | "onboarding"
  | "finance"
  | "pos"
  | "price-list"
  | "subscription"
  | "security"
  | "reports"
  | "ai"
  | "content"
  | "devices"
  | "provider-directory"
  | "promotions"
  | "merge"
  | "caregivers"
  | "operations"
  | "store"
  | "search"
  | "bell"
  | "close"
  | "chevron"
  | "sparkles"
  | "menu"
  | "home"
  | "care"
  | "analytics"
  | "knowledge"
  | "more";

export interface NavDestination {
  /** Stable identifier; never reuse one for a different destination. */
  id: string;
  label: string;
  /** Canonical route. Existing route URLs are reused unchanged. */
  to: string;
  icon: NavIconName;
  /** Desktop primary area. */
  section: NavSectionId;
  /** Mobile bottom-navigation destination. */
  mobile: MobileTabId;
  roles?: readonly Role[];
  patientOnly?: boolean;
  staffOnly?: boolean;
  /** Members of an organization, or administrators of a workspace linked to one. */
  organization?: boolean;
  /** Shown only when the active workspace has one of these modules enabled. */
  modules?: readonly string[];
  /** Shown only for these existing service categories, where already configured. */
  serviceCategories?: readonly string[];
  /** Detail-page prefixes that should keep this destination active. */
  activePrefixes?: readonly string[];
  /** Short copy used by dashboard quick actions and workspace search. */
  description?: string;
  /** Offered in the dashboard quick-action strip when visible. */
  quickAction?: boolean;
}

export interface NavSection {
  id: NavSectionId;
  label: string;
  icon: NavIconName;
  /** Sidebar grouping; `null` renders above the first group (Dashboard). */
  group: NavSectionGroupId | null;
}

export interface NavGroup {
  id: NavSectionGroupId;
  label: string;
}

/** Sidebar groups in display order: operations, management, then intelligence. */
export const NAV_GROUPS: readonly NavGroup[] = Object.freeze([
  { id: "operations", label: "Facility Operations" },
  { id: "management", label: "Facility Management" },
  { id: "intelligence", label: "Intelligence & Engagement" },
]);

export interface VisibleNavSection extends NavSection {
  items: NavDestination[];
}

export interface MobileTab {
  id: MobileTabId;
  label: string;
  icon: NavIconName;
}

export interface PlatformNavItem {
  id: string;
  label: string;
  to: string;
  icon: NavIconName;
}

export interface VisibleMobileTab extends MobileTab {
  items: NavDestination[];
}

/** The fourteen desktop primary areas, in the approved order and labels. */
export const NAV_SECTIONS: readonly NavSection[] = Object.freeze([
  { id: "dashboard", label: "Dashboard", icon: "dashboard", group: null },
  { id: "reception", label: "Reception & Billing", icon: "reception", group: "operations" },
  { id: "outpatient", label: "OPD (Outpatient Care)", icon: "outpatient", group: "operations" },
  { id: "inpatient", label: "Inpatient Care", icon: "inpatient", group: "operations" },
  { id: "theatre", label: "Theatre & Procedures", icon: "theatre", group: "operations" },
  { id: "diagnostics", label: "Diagnostics", icon: "diagnostics", group: "operations" },
  { id: "pharmacy", label: "Pharmacy", icon: "pharmacy", group: "operations" },
  { id: "chronic", label: "Chronic & Community Care", icon: "chronic", group: "operations" },
  { id: "virtual", label: "Virtual Care", icon: "virtual", group: "operations" },
  { id: "iot", label: "IoT & Remote Monitoring", icon: "iot", group: "operations" },
  { id: "facility", label: "Facility & Location", icon: "facility", group: "management" },
  { id: "administration", label: "Administration", icon: "administration", group: "management" },
  { id: "intelligence", label: "Medveris Intelligence", icon: "intelligence", group: "intelligence" },
  { id: "portal", label: "Patient Portal", icon: "portal", group: "intelligence" },
]);

/** The five mobile bottom-navigation destinations. */
export const MOBILE_TABS: readonly MobileTab[] = Object.freeze([
  { id: "home", label: "Home", icon: "home" },
  { id: "care", label: "Care", icon: "care" },
  { id: "analytics", label: "Analytics", icon: "analytics" },
  { id: "knowledge", label: "Knowledge", icon: "knowledge" },
  { id: "more", label: "More", icon: "more" },
]);

export const NAV_DESTINATIONS: readonly NavDestination[] = Object.freeze([
  // Dashboard -----------------------------------------------------------------
  {
    id: "dashboard", label: "Dashboard", to: "/dashboard", icon: "dashboard", section: "dashboard", mobile: "home",
    description: "Facility overview, daily priorities and quick actions", quickAction: true,
  },

  // Reception & Billing ------------------------------------------------------
  {
    id: "patients", label: "Patients", to: "/patients", icon: "patients", section: "reception", mobile: "care",
    roles: ["receptionist", "nurse", "clinician", "facility_admin"],
    activePrefixes: ["/visits", "/queues"],
    description: "Register a patient or search existing records", quickAction: true,
  },
  {
    id: "appointments", label: "Appointments", to: "/appointments", icon: "calendar", section: "reception", mobile: "care",
    roles: ["receptionist", "nurse", "clinician", "facility_admin"], modules: ["reception", "outpatient"],
  },
  {
    id: "exchange", label: "Record exchange", to: "/exchange", icon: "exchange", section: "reception", mobile: "care",
    roles: ["nurse", "clinician"], modules: ["outpatient", "emergency", "inpatient"],
    description: "Patient-controlled exchange with other facilities",
  },

  // OPD (Outpatient Care) ----------------------------------------------------
  {
    id: "worklist", label: "Clinical worklist", to: "/worklist", icon: "outpatient", section: "outpatient", mobile: "care",
    roles: ["nurse", "clinician"], modules: ["outpatient", "emergency", "inpatient"],
    activePrefixes: ["/encounters"], description: "Arrived, triaged and in-progress encounters", quickAction: true,
  },
  {
    id: "emergency", label: "Emergency", to: "/emergency", icon: "emergency", section: "outpatient", mobile: "care",
    roles: ["nurse", "clinician"], modules: ["emergency"],
  },

  // Inpatient Care -------------------------------------------------------------
  {
    id: "wards", label: "Wards and beds", to: "/wards", icon: "inpatient", section: "inpatient", mobile: "care",
    roles: ["nurse", "clinician", "ward_manager", "facility_admin"], modules: ["inpatient"],
    description: "Inpatient occupancy, admissions and ward handover", quickAction: true,
  },
  {
    id: "maternity", label: "Maternity", to: "/maternity", icon: "maternity", section: "inpatient", mobile: "care",
    roles: ["nurse", "clinician", "facility_admin"], modules: ["maternity"],
  },

  // Theatre & Procedures -------------------------------------------------------
  {
    id: "theatre", label: "Theatre", to: "/theatre", icon: "theatre", section: "theatre", mobile: "care",
    roles: ["nurse", "clinician", "facility_admin"], modules: ["theatre"],
    description: "Theatre lists, bookings and procedure readiness", quickAction: true,
  },
  {
    id: "theatre-queue", label: "Theatre queue", to: "/work-queues/theatre", icon: "queues", section: "theatre", mobile: "care",
    roles: DEPARTMENT_QUEUE_ROLES.theatre, modules: DEPARTMENT_MODULES.theatre,
  },
  {
    id: "procedure-room", label: "Procedure room", to: "/work-queues/procedure", icon: "operations", section: "theatre", mobile: "care",
    roles: DEPARTMENT_QUEUE_ROLES.procedure, modules: DEPARTMENT_MODULES.procedure,
  },

  // Diagnostics ----------------------------------------------------------------
  {
    id: "diagnostics", label: "Diagnostics", to: "/diagnostics", icon: "diagnostics", section: "diagnostics", mobile: "care",
    roles: ["nurse", "clinician", "laboratory", "lab_validator", "radiology", "radiographer", "radiologist"],
    modules: ["laboratory", "radiology"],
    description: "Laboratory and imaging requests awaiting work", quickAction: true,
  },
  {
    id: "radiology", label: "Radiology reporting", to: "/radiology", icon: "radiology", section: "diagnostics", mobile: "care",
    roles: ["nurse", "clinician", "radiology", "radiographer", "radiologist"], modules: ["radiology"],
  },
  {
    id: "laboratory-queue", label: "Laboratory queue", to: "/work-queues/laboratory", icon: "laboratory", section: "diagnostics", mobile: "care",
    roles: [...DEPARTMENT_QUEUE_ROLES.laboratory, "clinician"], modules: DEPARTMENT_MODULES.laboratory,
  },
  {
    id: "imaging-queue", label: "Imaging queue", to: "/work-queues/imaging", icon: "imaging", section: "diagnostics", mobile: "care",
    roles: [...DEPARTMENT_QUEUE_ROLES.imaging, "clinician"], modules: DEPARTMENT_MODULES.imaging,
  },

  // Pharmacy -------------------------------------------------------------------
  {
    id: "pharmacy", label: "Pharmacy", to: "/pharmacy", icon: "pharmacy", section: "pharmacy", mobile: "care",
    roles: ["nurse", "clinician", "pharmacist", "facility_admin"], modules: ["pharmacy"],
    description: "Dispensing queue, stock and prescription review", quickAction: true,
  },
  {
    id: "pharmacy-pos", label: "Pharmacy POS", to: "/pharmacy-pos", icon: "store", section: "pharmacy", mobile: "care",
    roles: ["pharmacist", "finance", "facility_admin", "owner", "clinician", "specialist_clinician"], modules: ["pharmacy"],
  },
  {
    id: "pharmacy-queue", label: "Pharmacy queue", to: "/work-queues/pharmacy", icon: "queues", section: "pharmacy", mobile: "care",
    roles: [...DEPARTMENT_QUEUE_ROLES.pharmacy, "clinician"], modules: DEPARTMENT_MODULES.pharmacy,
  },

  // Chronic & Community Care ---------------------------------------------------
  {
    id: "care", label: "Follow-ups and referrals", to: "/care", icon: "chronic", section: "outpatient", mobile: "care",
    roles: ["nurse", "clinician"], modules: ["outpatient", "programmes"],
  },
  {
    id: "programmes", label: "Care programmes", to: "/programmes", icon: "chronic", section: "chronic", mobile: "care",
    roles: ["nurse", "clinician"], modules: ["programmes"],
  },
  {
    id: "public-health", label: "Public health", to: "/public-health", icon: "reports", section: "chronic", mobile: "care",
    roles: ["public_health", "facility_admin"], modules: ["public-health"],
  },
  {
    id: "ehmis", label: "eHMIS reporting", to: "/ehmis", icon: "reports", section: "chronic", mobile: "care",
    roles: ["public_health", "facility_admin"], modules: ["public-health"],
  },

  // Virtual Care ---------------------------------------------------------------
  {
    id: "telehealth", label: "Telehealth", to: "/telehealth", icon: "virtual", section: "virtual", mobile: "care",
    roles: ["nurse", "clinician"], modules: ["outpatient"],
  },

  // IoT & Remote Monitoring ----------------------------------------------------
  {
    id: "devices", label: "Devices", to: "/devices", icon: "iot", section: "iot", mobile: "care",
    roles: ["nurse", "clinician", "facility_admin"], modules: ["inpatient", "emergency", "outpatient"],
  },

  // Facility & Location --------------------------------------------------------
  {
    id: "workspace", label: "Workspace profile", to: "/workspace", icon: "facility", section: "facility", mobile: "more",
    staffOnly: true, description: "Facility category, level, modules and organization link",
  },
  {
    id: "operations", label: "Hospital operations", to: "/operations", icon: "operations", section: "facility", mobile: "more",
    roles: ["nurse", "clinician", "facility_admin", "housekeeping", "porter", "mortuary", "cssd", "biomedical", "auditor"],
    modules: ["inpatient"],
  },
  {
    id: "inventory", label: "Inventory and assets", to: "/inventory", icon: "inventory", section: "facility", mobile: "more",
    roles: INVENTORY_ROLES, modules: ["inventory"],
  },
  {
    id: "procurement", label: "Purchasing", to: "/procurement", icon: "procurement", section: "facility", mobile: "more",
    roles: PROCUREMENT_ROLES, modules: ["inventory"],
  },
  {
    id: "provider-directory", label: "Provider directory", to: "/provider-directory", icon: "provider-directory", section: "facility", mobile: "more",
    roles: ["facility_admin"],
  },
  {
    id: "promotions", label: "Sponsorship", to: "/promotions", icon: "promotions", section: "facility", mobile: "more",
    roles: ["facility_admin"],
  },

  // Administration -------------------------------------------------------------
  {
    id: "admin", label: "Facility administration", to: "/admin", icon: "administration", section: "administration", mobile: "more",
    roles: ["facility_admin"], description: "Staff, invitations, roles and facility settings",
  },
  {
    id: "organizations", label: "Organizations", to: "/organizations", icon: "organizations", section: "administration", mobile: "more",
    organization: true,
  },
  {
    id: "credentials", label: "Credentials", to: "/credentials", icon: "credentials", section: "administration", mobile: "more",
    staffOnly: true,
  },
  {
    id: "documents", label: "Documentation", to: "/documents", icon: "documents", section: "administration", mobile: "more",
    roles: ["clinician", "nurse", "records", "receptionist", "facility_admin", "hr", "quality"],
  },
  {
    id: "workforce", label: "Workforce", to: "/workforce", icon: "workforce", section: "administration", mobile: "more",
    roles: ["hr", "facility_admin"],
  },
  {
    id: "onboarding", label: "Onboarding", to: "/onboarding", icon: "onboarding", section: "administration", mobile: "more",
    staffOnly: true, description: "Your professional onboarding and affiliation steps",
  },
  {
    id: "onboarding-workflow", label: "Staff onboarding", to: "/onboarding-workflow", icon: "onboarding", section: "administration", mobile: "more",
    staffOnly: true,
  },
  {
    id: "caregiver-requests", label: "Caregiver requests", to: "/caregiver-requests", icon: "caregivers", section: "administration", mobile: "more",
    roles: ["facility_admin", "records"],
  },
  {
    id: "patient-merges", label: "Patient merges", to: "/patient-merges", icon: "merge", section: "administration", mobile: "more",
    roles: ["facility_admin", "records"],
  },
  {
    id: "catalogue-editor", label: "Catalogue editor", to: "/catalogue-editor", icon: "documents", section: "administration", mobile: "more",
    roles: ["facility_admin"],
  },
  {
    id: "finance", label: "Finance", to: "/finance", icon: "finance", section: "reception", mobile: "analytics",
    roles: ["finance", "facility_admin"], modules: ["finance"],
  },
  {
    id: "pos", label: "Point of sale", to: "/pos", icon: "pos", section: "reception", mobile: "more",
    roles: CASHIER_ROLES, modules: ["finance"],
  },
  {
    id: "price-list", label: "Price list", to: "/price-list", icon: "price-list", section: "reception", mobile: "more",
    roles: CASHIER_ROLES, modules: ["finance"],
  },
  {
    id: "subscription", label: "Subscription and usage", to: "/subscription", icon: "subscription", section: "administration", mobile: "more",
    staffOnly: true,
  },
  {
    id: "security", label: "Session security", to: "/security", icon: "security", section: "administration", mobile: "more",
    staffOnly: true,
  },

  // Medveris Intelligence ------------------------------------------------------
  {
    id: "ai", label: "Assistive AI", to: "/ai", icon: "ai", section: "intelligence", mobile: "knowledge",
    roles: ["nurse", "clinician"], modules: ["outpatient", "radiology"],
    description: "Decision-support job history, never a diagnosis", quickAction: true,
    activePrefixes: ["/ai/chat"],
  },
  {
    id: "ai-chat", label: "AI chat", to: "/ai/chat", icon: "ai", section: "intelligence", mobile: "knowledge",
    roles: ["nurse", "clinician"], modules: ["outpatient", "radiology"],
    description: "Assistive conversation with Medveris Intelligence",
  },
  {
    id: "reports", label: "Reports", to: "/reports", icon: "reports", section: "intelligence", mobile: "analytics",
    description: "Facility and department operational reports", quickAction: true,
  },
  {
    id: "content", label: "Health library", to: "/content", icon: "content", section: "intelligence", mobile: "knowledge",
    staffOnly: true, description: "Research, guidelines, global health updates and CPD opportunities",
  },

  // Patient Portal -------------------------------------------------------------
  {
    id: "portal", label: "My health record", to: "/portal", icon: "portal", section: "portal", mobile: "more",
    patientOnly: true, description: "Released notes, observations and follow-ups", quickAction: true,
  },
  {
    id: "portal-consents", label: "Consent and sharing", to: "/portal/consents", icon: "security", section: "portal", mobile: "more",
    patientOnly: true, description: "Review and revoke sharing consents", quickAction: true,
  },
  {
    id: "portal-access", label: "Access history", to: "/portal/access", icon: "documents", section: "portal", mobile: "more",
    patientOnly: true,
  },
  {
    id: "caregivers", label: "Caregivers", to: "/caregivers", icon: "caregivers", section: "portal", mobile: "more",
    patientOnly: true,
  },
  {
    id: "content-patient", label: "Health library", to: "/content", icon: "content", section: "portal", mobile: "knowledge",
    patientOnly: true,
  },
]);

/** Platform Operations is a separate area and never appears in facility navigation. */
export const PLATFORM_NAV: readonly PlatformNavItem[] = Object.freeze([
  { id: "directory-governance", label: "Directory governance", to: "/directory-governance", icon: "organizations" },
  { id: "platform-integrations", label: "Integrations", to: "/platform-integrations", icon: "iot" },
  { id: "reviewer", label: "Credential review", to: "/reviewer", icon: "credentials" },
  { id: "platform-billing", label: "Platform billing", to: "/platform-billing", icon: "finance" },
  { id: "platform-observability", label: "Observability", to: "/platform-observability", icon: "reports" },
]);

function categoryVisible(item: NavDestination, me: MeResponse): boolean {
  if (!item.serviceCategories?.length || !me.activeTenant) return true;
  const category = me.activeTenant.workspace?.serviceCategory;
  return category ? item.serviceCategories.includes(category) : true;
}

export function canSeeNavItem(item: NavDestination, me: MeResponse): boolean {
  const roles = me.activeTenant?.roles ?? [];
  const profile = workspaceProfile(me.activeTenant);
  if (item.patientOnly) return Boolean(me.patientId);
  if (item.staffOnly && !me.activeTenant) return false;
  if (item.modules && me.activeTenant && !hasModule(profile, ...item.modules)) return false;
  if (!categoryVisible(item, me)) return false;
  // An independent workspace never needs organization screens; it can still ask to join from its workspace profile.
  if (item.organization) return Boolean(me.organizations?.length) || (roles.includes("facility_admin") && !profile.independent);
  if (item.roles) return item.roles.some((role) => roles.includes(role));
  return true;
}

export function navSectionsFor(me: MeResponse): VisibleNavSection[] {
  return NAV_SECTIONS
    .map((section) => ({
      ...section,
      items: NAV_DESTINATIONS.filter((item) => item.section === section.id && canSeeNavItem(item, me)),
    }))
    .filter((section) => section.items.length > 0);
}

export function platformNavFor(me: MeResponse): readonly PlatformNavItem[] {
  return me.platformRoles.length > 0 ? PLATFORM_NAV : [];
}

/** Backwards-compatible shape used by the shell. */
export function navFor(me: MeResponse): { sections: VisibleNavSection[]; platform: readonly PlatformNavItem[] } {
  return { sections: navSectionsFor(me), platform: platformNavFor(me) };
}

export function navDestinationsFor(me: MeResponse): NavDestination[] {
  return NAV_DESTINATIONS.filter((item) => canSeeNavItem(item, me));
}

export function quickActionsFor(me: MeResponse): NavDestination[] {
  return navDestinationsFor(me).filter((item) => item.quickAction);
}

export function intelligenceDestinationFor(me: MeResponse): NavDestination | undefined {
  return navDestinationsFor(me).find((item) => item.section === "intelligence");
}

export function destinationById(me: MeResponse, id: string): NavDestination | undefined {
  return navDestinationsFor(me).find((item) => item.id === id);
}

export function mobileTabsFor(me: MeResponse): VisibleMobileTab[] {
  const destinations = navDestinationsFor(me);
  return MOBILE_TABS
    .map((tab) => ({ ...tab, items: destinations.filter((item) => item.mobile === tab.id) }))
    .filter((tab) => tab.id === "home" || tab.id === "more" || tab.items.length > 0);
}

export function mobileSectionsFor(me: MeResponse, tabId: MobileTabId): VisibleNavSection[] {
  return navSectionsFor(me)
    .map((section) => ({ ...section, items: section.items.filter((item) => item.mobile === tabId) }))
    .filter((section) => section.items.length > 0);
}

function matchesPath(item: NavDestination, pathname: string): boolean {
  if (pathname === item.to || pathname.startsWith(`${item.to}/`)) return true;
  return Boolean(item.activePrefixes?.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)));
}

/** The most specific destination for the current URL, including detail pages. */
export function activeDestination(pathname: string): NavDestination | undefined {
  return [...NAV_DESTINATIONS]
    .sort((left, right) => right.to.length - left.to.length)
    .find((item) => matchesPath(item, pathname));
}

export function activeSectionForPath(pathname: string): NavSectionId | undefined {
  return activeDestination(pathname)?.section;
}

export function activeMobileTabForPath(pathname: string): MobileTabId {
  return activeDestination(pathname)?.mobile ?? "more";
}
