import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Badge, Button } from "@medveris/ui";
import { BrandMark } from "./BrandMark";
import { useAuth } from "../lib/auth";
import { useQuery } from "../lib/useQuery";
import type { Role } from "../lib/types";
import { CASHIER_ROLES, DEPARTMENT_QUEUE_ROLES, INVENTORY_ROLES, PROCUREMENT_ROLES, VISIT_ROLES } from "../lib/roles";
import { DEPARTMENT_MODULES, hasModule, workspaceProfile } from "../lib/workspace";

interface NavItem {
  to: string;
  label: string;
  roles?: readonly Role[];
  patientOnly?: boolean;
  staffOnly?: boolean;
  platform?: boolean;
  /** Members of an organization, or administrators of a workspace linked to one. */
  organization?: boolean;
  /** Shown only when the active workspace has one of these modules enabled. */
  modules?: readonly string[];
}

const groups: { label: string; items: NavItem[] }[] = [
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
      { to: "/directory-governance", label: "Directory governance", platform: true },
      { to: "/reviewer", label: "Credential review", platform: true },
      { to: "/platform-billing", label: "Platform billing", platform: true },
      { to: "/security", label: "Session security", staffOnly: true },
    ],
  },
];

interface BillingStatusView {
  accessMode: string;
  restrictedCapabilities: string[];
  billing: { status: string | null; label: string; trialEndsAt?: string | null; trialDaysRemaining?: number | null; canManage?: boolean };
}

function SubscriptionBanner() {
  const { me } = useAuth();
  const status = useQuery<BillingStatusView>(me?.activeTenant ? "/billing/status" : null);
  if (!me?.activeTenant || !status.data) return null;
  const billing = status.data.billing;
  const restricted = status.data.accessMode === "restricted";
  const trialSoon = billing.status === "trialing" && (billing.trialDaysRemaining ?? 99) <= 7;
  if (!restricted && !trialSoon && !["past_due", "trial_expired", "suspended"].includes(billing.status ?? "")) return null;
  return (
    <div className={`mv-billing-banner${restricted ? " mv-billing-banner--warning" : ""}`} role="status">
      <strong>{billing.label}</strong>
      {restricted ? <span> Some billing-sensitive actions are paused. Clinical records remain available.</span> : null}
      {trialSoon ? <span> Your free trial ends in {billing.trialDaysRemaining} day{billing.trialDaysRemaining === 1 ? "" : "s"}.</span> : null}
      {billing.canManage ? <> <NavLink to="/subscription">Review subscription</NavLink></> : null}
    </div>
  );
}

export function AppShell() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!navOpen) return;
    const sidebar = document.getElementById("app-sidebar");
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setNavOpen(false);
        menuButtonRef.current?.focus();
        return;
      }
      if (event.key !== "Tab" || !sidebar) return;
      const focusable = Array.from(
        sidebar.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("hidden") && element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus({ preventScroll: true }), 260);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [navOpen]);

  if (!me) return null;
  const roles = me.activeTenant?.roles ?? [];
  const profile = workspaceProfile(me.activeTenant);
  const can = (item: NavItem) => {
    if (item.patientOnly) return Boolean(me.patientId);
    if (item.modules && me.activeTenant && !hasModule(profile, ...item.modules)) return false;
    if (item.staffOnly) return Boolean(me.activeTenant);
    if (item.platform) return me.platformRoles.length > 0;
    // An independent workspace never needs organization screens; it can still ask to join from its workspace profile.
    if (item.organization) return Boolean(me.organizations?.length) || (roles.includes("facility_admin") && !profile.independent);
    if (item.roles) return item.roles.some((role) => roles.includes(role));
    return true;
  };

  function closeNavigation() {
    setNavOpen(false);
    menuButtonRef.current?.focus();
  }

  async function signOut() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="mv-app">
      {navOpen ? <button type="button" className="mv-scrim" aria-label="Close navigation" tabIndex={-1} onClick={closeNavigation} /> : null}
      <aside id="app-sidebar" className={`mv-sidebar${navOpen ? " mv-sidebar--open" : ""}`}>
        <div className="mv-sidebar__head">
          <NavLink to="/" className="mv-brand" aria-label="Medveris home">
            <BrandMark />
            <span>Medveris<small>Outpatient foundation</small></span>
          </NavLink>
          <button ref={closeButtonRef} type="button" className="mv-nav-close" aria-label="Close navigation" onClick={closeNavigation}>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
        </div>
        <nav className="mv-nav" aria-label="Primary navigation">
          {groups.map((group) => {
            const visible = group.items.filter(can);
            if (!visible.length) return null;
            const expanded = !collapsedGroups[group.label];
            const panelId = `nav-group-${group.label.toLowerCase().replaceAll(" ", "-")}`;
            return (
              <section className="mv-nav__group" key={group.label}>
                <button
                  type="button"
                  className="mv-nav__toggle"
                  aria-expanded={expanded}
                  aria-controls={panelId}
                  onClick={() => setCollapsedGroups((previous) => ({ ...previous, [group.label]: expanded }))}
                >
                  <span>{group.label}</span>
                  <svg className={`mv-nav__chevron${expanded ? " mv-nav__chevron--open" : ""}`} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                    <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <div id={panelId} className="mv-nav__items" hidden={!expanded}>
                  {visible.map((item) => (
                    <NavLink key={item.to} to={item.to} end={item.to === "/"}>
                      {item.label}
                    </NavLink>
                  ))}
                </div>
              </section>
            );
          })}
        </nav>
        <div className="mv-sidebar__footer">
          <div>{me.user.displayName}</div>
          <div className="mv-small">{me.activeTenant ? me.activeTenant.name : me.patientId ? "Patient account" : "No active role"}</div>
          <div className="mv-sidebar__actions">
            <Button variant="ghost" size="sm" onClick={() => navigate("/security")}>Security</Button>
            <Button variant="secondary" size="sm" onClick={() => void signOut()}>Sign out</Button>
          </div>
        </div>
      </aside>
      <div className="mv-main">
        <header className="mv-topbar">
          <button
            ref={menuButtonRef}
            type="button"
            className="mv-menu-button"
            aria-label={navOpen ? "Close navigation" : "Open navigation"}
            aria-expanded={navOpen}
            aria-controls="app-sidebar"
            onClick={() => (navOpen ? closeNavigation() : setNavOpen(true))}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
          <NavLink to="/" className="mv-mobile-brand" aria-label="Medveris home">
            <BrandMark />
            <span>Medveris</span>
          </NavLink>
          <div className="context">
            <div className="mv-context">
              <Badge tone={me.activeTenant ? "success" : "info"}>{me.activeTenant ? "Staff session" : me.patientId ? "Patient session" : "Unassigned"}</Badge>
              {me.activeTenant ? (
                <span className="mv-small">
                  <strong>{me.activeTenant.name}</strong>
                  {profile.categoryLabel ? <span className="mv-muted"> · {profile.categoryLabel}{profile.independent ? " · independent" : ""}</span> : null}
                  {me.memberships.length > 1 ? <> · <NavLink to="/facility-staff">Switch</NavLink></> : null}
                </span>
              ) : null}
              {me.activeTenant ? <span className="mv-small mv-muted">Active: {me.activeTenant.roles.join(", ")}</span> : null}
              {me.user.mfaEnrolled ? <Badge tone="neutral">MFA enrolled</Badge> : null}
            </div>
          </div>
          <div className="mv-row mv-topbar__actions">
            <Button variant="ghost" size="sm" onClick={() => navigate("/security")}>Security</Button>
            <Button variant="secondary" size="sm" onClick={() => void signOut()}>Sign out</Button>
          </div>
        </header>
        <SubscriptionBanner />
        <main className="mv-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
