import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Badge, Button } from "@medveris/ui";
import { BrandMark } from "./BrandMark";
import { useAuth } from "../lib/auth";
import { useQuery } from "../lib/useQuery";
import { navFor } from "../lib/nav";
import { workspaceProfile } from "../lib/workspace";

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
  const profile = workspaceProfile(me.activeTenant);
  const { workspace: groups, platform } = navFor(me);

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
          <NavLink to="/dashboard" className="mv-brand" aria-label="Medveris home">
            <BrandMark />
            <span>Medveris<small>Outpatient foundation</small></span>
          </NavLink>
          <button ref={closeButtonRef} type="button" className="mv-nav-close" aria-label="Close navigation" onClick={closeNavigation}>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
        </div>
        <nav className="mv-nav" aria-label="Primary navigation">
          {groups.map((group) => {
            const visible = group.items;
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
          {platform.length ? (
            <section className="mv-nav__group mv-nav__group--platform">
              <p className="mv-nav__area-label">Platform</p>
              <div className="mv-nav__items">
                {platform.map((item) => (
                  <NavLink key={item.to} to={item.to}>{item.label}</NavLink>
                ))}
              </div>
            </section>
          ) : null}
        </nav>
        <div className="mv-sidebar__footer">
          <div>{me.user.displayName}</div>
          <div className="mv-small">{me.activeTenant ? me.activeTenant.name : me.patientId ? "Patient account" : "No active role"}</div>
          <div className="mv-small">
            <NavLink to="/about">About us</NavLink> · <NavLink to="/help">Help &amp; support</NavLink> · <NavLink to="/contacts">Contacts</NavLink>
          </div>
          <div className="mv-small mv-muted">A product of Aidomex Group Ltd.</div>
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
          <NavLink to="/dashboard" className="mv-mobile-brand" aria-label="Medveris home">
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
