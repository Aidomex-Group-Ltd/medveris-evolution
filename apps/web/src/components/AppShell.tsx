import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Badge, Button } from "@medveris/ui";
import { BrandMark } from "./BrandMark";
import { NavIcon } from "./NavIcon";
import { useAuth } from "../lib/auth";
import { useQuery } from "../lib/useQuery";
import { api } from "../lib/api";
import {
  NAV_GROUPS,
  NAV_SECTIONS,
  activeDestination,
  activeMobileTabForPath,
  intelligenceDestinationFor,
  mobileSectionsFor,
  mobileTabsFor,
  navDestinationsFor,
  navFor,
  type MobileTabId,
  type PlatformNavItem,
  MOBILE_TABS,
  type NavDestination,
  type NavSectionId,
} from "../lib/nav";
import { workspaceProfile } from "../lib/workspace";
import { useFocusTrap } from "../lib/focusTrap";
import type { MeResponse } from "../lib/types";

interface BillingStatusView {
  accessMode: string;
  restrictedCapabilities: string[];
  billing: { status: string | null; label: string; trialEndsAt?: string | null; trialDaysRemaining?: number | null; canManage?: boolean };
}

interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  resourceType: string | null;
  resourceId: string | null;
  createdAt: string;
  readAt: string | null;
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
      {billing.canManage ? <> <Link to="/subscription">Review subscription</Link></> : null}
    </div>
  );
}

function FacilityContext({ me }: { me: MeResponse }) {
  const profile = workspaceProfile(me.activeTenant);
  if (!me.activeTenant) {
    return <span className="mv-facility mv-facility--empty"><NavIcon name="facility" size={18} /><span>{me.patientId ? "Patient account" : "No active facility"}</span></span>;
  }
  const switchable = me.memberships.length > 1;
  const target = switchable ? "/facility-staff" : "/workspace";
  return (
    <Link className="mv-facility" to={target} aria-label={switchable ? "Switch facility or branch" : "Open workspace profile"}>
      <NavIcon name="facility" size={18} />
      <span className="mv-facility__text">
        <strong>{me.activeTenant.name}</strong>
        <small>{profile.categoryLabel ?? "Facility workspace"}{switchable ? " · switch facility" : ""}</small>
      </span>
      <NavIcon name="chevron" size={15} />
    </Link>
  );
}

function IntelligenceLink({ me }: { me: MeResponse }) {
  const destination = intelligenceDestinationFor(me);
  if (!destination) return null;
  return (
    <Link className="mv-intelligence-link" to={destination.to}>
      <NavIcon name="sparkles" size={18} />
      <span>Intelligence</span>
    </Link>
  );
}

function NotificationsMenu() {
  const notifications = useQuery<{ notifications: NotificationRow[] }>("/notifications?limit=8", { enabled: true });
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const rows = notifications.data?.notifications ?? [];
  const unread = rows.filter((row) => !row.readAt).length;

  async function markRead(id: string) {
    setBusy(id);
    setActionError(null);
    try {
      await api(`/notifications/${id}/read`, { method: "POST" });
      notifications.reload();
    } catch {
      setActionError("The notification could not be marked read.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <details className="mv-menu mv-menu--notifications">
      <summary className="mv-icon-button" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} title="Notifications">
        <NavIcon name="bell" size={19} />
        {unread ? <span className="mv-icon-button__count">{unread > 9 ? "9+" : unread}</span> : null}
      </summary>
      <div className="mv-menu__panel mv-menu__panel--wide" role="region" aria-label="Notifications">
        <div className="mv-menu__head">
          <strong>Notifications</strong>
          <span className="mv-small mv-muted">{unread} unread</span>
        </div>
        {actionError ? <p className="mv-small mv-muted" role="alert">{actionError}</p> : null}
        {notifications.loading && !notifications.data ? <p className="mv-small mv-muted">Loading notifications…</p> : null}
        {notifications.error ? <p className="mv-small mv-muted" role="alert">{notifications.error}</p> : null}
        {!notifications.loading && !notifications.error && !rows.length ? <p className="mv-small mv-muted">No notifications.</p> : null}
        {rows.map((row) => (
          <article className={`mv-notification${row.readAt ? " is-read" : ""}`} key={row.id}>
            <strong>{row.title}</strong>
            <p className="mv-small">{row.body}</p>
            <div className="mv-row mv-row--between">
              <span className="mv-small mv-muted">{new Date(row.createdAt).toLocaleString()}</span>
              {!row.readAt ? (
                <button type="button" className="mv-link-button" disabled={busy === row.id} onClick={() => void markRead(row.id)}>
                  {busy === row.id ? "Marking…" : "Mark read"}
                </button>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </details>
  );
}

function ProfileMenu({ me, onSignOut }: { me: MeResponse; onSignOut: () => Promise<void> }) {
  const initials = `${me.user.givenName?.[0] ?? ""}${me.user.familyName?.[0] ?? ""}` || me.user.displayName.slice(0, 2).toUpperCase();
  return (
    <details className="mv-menu mv-menu--profile">
      <summary className="mv-profile-button" aria-label="Account menu" title="Account menu">
        <span className="mv-avatar" aria-hidden="true">{initials}</span>
        <span className="mv-profile-button__name">{me.user.givenName || "Account"}</span>
      </summary>
      <div className="mv-menu__panel">
        <div className="mv-menu__identity">
          <strong>{me.user.displayName}</strong>
          <span className="mv-small mv-muted">{me.user.email}</span>
          {me.activeTenant ? <span className="mv-small mv-muted">{me.activeTenant.name}</span> : null}
        </div>
        <Link to="/security">Session security</Link>
        {me.activeTenant ? <Link to="/workspace">Workspace profile</Link> : null}
        {me.memberships.length > 1 ? <Link to="/facility-staff">Switch facility</Link> : null}
        <Link to="/help">Help and support</Link>
        <button type="button" onClick={() => void onSignOut()}>Sign out</button>
      </div>
    </details>
  );
}

function GlobalSearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me } = useAuth();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, { active: open, onEscape: onClose });
  const destinations = useMemo(() => (me ? navDestinationsFor(me) : []), [me]);
  const sectionLabels = useMemo(() => new Map(NAV_SECTIONS.map((section) => [section.id, section.label])), []);
  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return destinations.filter((item) => item.quickAction).slice(0, 8);
    return destinations
      .filter((item) => [item.label, sectionLabels.get(item.section) ?? "", item.description ?? ""].some((value) => value.toLowerCase().includes(needle)))
      .slice(0, 10);
  }, [destinations, query, sectionLabels]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
  }, [open]);

  useEffect(() => {
    if (index >= results.length) setIndex(0);
  }, [index, results.length]);

  if (!open) return null;

  function go(to: string) {
    onClose();
    navigate(to);
  }

  return (
    <div className="mv-search" role="presentation">
      <button type="button" className="mv-search__scrim" aria-label="Close search" onClick={onClose} />
      <div className="mv-search__panel" ref={panelRef} role="dialog" aria-modal="true" aria-label="Search workspace">
        <div className="mv-search__field">
          <NavIcon name="search" size={20} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setIndex((current) => (results.length ? (current + 1) % results.length : 0));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setIndex((current) => (results.length ? (current - 1 + results.length) % results.length : 0));
              } else if (event.key === "Enter") {
                const item = results[index];
                if (item) {
                  event.preventDefault();
                  go(item.to);
                }
              } else if (event.key === "Escape") {
                onClose();
              }
            }}
            placeholder="Search workspace destinations"
            aria-label="Search workspace"
            autoComplete="off"
          />
          <kbd>Esc</kbd>
        </div>
        <div className="mv-search__results" role="listbox" aria-label="Workspace destinations">
          {results.map((item, position) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={position === index}
              className={`mv-search__result${position === index ? " is-active" : ""}`}
              onMouseEnter={() => setIndex(position)}
              onClick={() => go(item.to)}
            >
              <span className="mv-search__icon"><NavIcon name={item.icon} size={18} /></span>
              <span>
                <strong>{item.label}</strong>
                <small>{sectionLabels.get(item.section)}</small>
              </span>
            </button>
          ))}
          {!results.length ? <p className="mv-small mv-muted mv-search__empty">No matching destination. Try “patients”, “pharmacy” or “reports”.</p> : null}
        </div>
        <p className="mv-search__hint">Search covers workspace areas and destinations. Patient records are searched from the Patients page.</p>
      </div>
    </div>
  );
}

function MobileSheet({ tabId, onClose }: { tabId: MobileTabId; onClose: () => void }) {
  const { me } = useAuth();
  const sections = useMemo(() => (me ? mobileSectionsFor(me, tabId) : []), [me, tabId]);
  const tab = MOBILE_TABS.find((candidate) => candidate.id === tabId);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, { active: Boolean(tab), onEscape: onClose });
  if (!tab) return null;
  return (
    <div className="mv-sheet" role="presentation">
      <button type="button" className="mv-sheet__scrim" aria-label="Close menu" onClick={onClose} />
      <div className="mv-sheet__panel" ref={panelRef} role="dialog" aria-modal="true" aria-label={`${tab.label} navigation`}>
        <div className="mv-sheet__head">
          <h2>{tab.label}</h2>
          <button type="button" className="mv-icon-button" aria-label="Close menu" onClick={onClose}>
            <NavIcon name="close" size={20} />
          </button>
        </div>
        <div className="mv-sheet__body">
          {sections.map((section) => (
            <section className="mv-sheet__section" key={section.id}>
              <h3>{section.label}</h3>
              <div className="mv-sheet__links">
                {section.items.map((item) => (
                  <Link key={item.id} to={item.to} onClick={onClose}>
                    <NavIcon name={item.icon} size={18} />
                    <span>{item.label}</span>
                  </Link>
                ))}
              </div>
            </section>
          ))}
          {!sections.length ? <p className="mv-small mv-muted">No destinations are available for this account.</p> : null}
        </div>
      </div>
    </div>
  );
}

function SidebarDestination({ item, active }: { item: NavDestination; active: boolean }) {
  return (
    <Link to={item.to} className={`mv-nav__item${active ? " is-active" : ""}`} aria-current={active ? "page" : undefined}>
      <NavIcon name={item.icon} size={17} />
      <span>{item.label}</span>
    </Link>
  );
}

function PrimaryNavStrip({ sections, platform, active, locationPathname }: { sections: ReturnType<typeof navFor>["sections"]; platform: readonly PlatformNavItem[]; active: NavDestination | undefined; locationPathname: string }) {
  return (
    <nav className="mv-nav-strip" aria-label="Primary navigation">
      {sections.map((section) => {
        const primaryItem = section.items[0];
        const itemId = primaryItem?.id;
        const isActive = active?.id === itemId;
        const href = primaryItem?.to;
        return (
          <Link
            key={section.id}
            to={href ?? "#"}
            className={`mv-nav-strip__item${isActive ? " is-active" : ""}`}
            aria-current={isActive ? "page" : undefined}
            aria-label={section.label}
            title={section.label}
          >
            <NavIcon name={section.icon} size={17} />
            <span className="mv-nav-strip__label">{section.label}</span>
          </Link>
        );
      })}
      {platform.map((item) => (
        <Link
          key={item.id}
          to={item.to}
          className={`mv-nav-strip__item${locationPathname === item.to || locationPathname.startsWith(`${item.to}/`) ? " is-active" : ""}`}
          aria-label={item.label}
          title={item.label}
        >
          <NavIcon name={item.icon} size={17} />
          <span className="mv-nav-strip__label">{item.label}</span>
        </Link>
      ))}
    </nav>
  );
}

export function AppShell() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileSheet, setMobileSheet] = useState<MobileTabId | null>(null);
  const [openSections, setOpenSections] = useState<NavSectionId[]>([]);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const { sections, platform } = me ? navFor(me) : { sections: [], platform: [] as const };
  const active = activeDestination(location.pathname);
  const activeSection = active?.section;
  const mobileTabs = me ? mobileTabsFor(me) : [];
  const activeMobileTab = activeMobileTabForPath(location.pathname);
  const mobileHomeTarget = me?.patientId ? "/portal" : "/dashboard";

  useEffect(() => {
    setNavOpen(false);
    setMobileSheet(null);
  }, [location.pathname]);

  useEffect(() => {
    if (activeSection) setOpenSections((previous) => (previous.includes(activeSection) ? previous : [...previous, activeSection]));
  }, [activeSection]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    document.addEventListener("keydown", onKey);
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus({ preventScroll: true }), 260);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKey);
    };
  }, [navOpen]);

  useEffect(() => {
    const locked = navOpen || searchOpen || Boolean(mobileSheet);
    const app = document.querySelector(".mv-app") as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = locked ? "hidden" : previousOverflow;
    if (app) app.classList.toggle("is-locked", locked);
    return () => {
      document.body.style.overflow = previousOverflow;
      if (app) app.classList.remove("is-locked");
    };
  }, [navOpen, searchOpen, mobileSheet]);

  if (!me) return null;

  const profile = workspaceProfile(me.activeTenant);

  function closeNavigation() {
    setNavOpen(false);
    menuButtonRef.current?.focus();
  }

  function toggleSection(section: NavSectionId) {
    setOpenSections((previous) => (previous.includes(section) ? previous.filter((id) => id !== section) : [...previous, section]));
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
          <Link to="/dashboard" className="mv-brand" aria-label="Medveris dashboard">
            <BrandMark />
            <span>Medveris<small>Facility workspace</small></span>
          </Link>
          <button ref={closeButtonRef} type="button" className="mv-nav-close" aria-label="Close navigation" onClick={closeNavigation}>
            <NavIcon name="close" size={20} />
          </button>
        </div>

        <nav className="mv-nav" aria-label="Primary navigation">
          {sections.map((section, index) => {
            const previousGroup = index > 0 ? sections[index - 1]!.group : undefined;
            const groupHeading = section.group && section.group !== previousGroup
              ? <p className="mv-nav__area-label">{NAV_GROUPS.find((group) => group.id === section.group)?.label}</p>
              : null;
            if (section.items.length === 1) {
              const item = section.items[0]!;
              return (
                <Fragment key={section.id}>
                  {groupHeading}
                  <Link
                    to={item.to}
                    className={`mv-nav__area${active?.id === item.id ? " is-active" : ""}`}
                    aria-current={active?.id === item.id ? "page" : undefined}
                  >
                    <NavIcon name={section.icon} size={19} />
                    <span>{section.label}</span>
                  </Link>
                </Fragment>
              );
            }
            const expanded = openSections.includes(section.id);
            const panelId = `nav-section-${section.id}`;
            return (
              <Fragment key={section.id}>
                {groupHeading}
                <section className={`mv-nav__section${activeSection === section.id ? " is-active" : ""}`}>
                  <button
                    type="button"
                    className="mv-nav__toggle"
                    aria-expanded={expanded}
                    aria-controls={panelId}
                    onClick={() => toggleSection(section.id)}
                  >
                    <NavIcon name={section.icon} size={19} />
                    <span className="mv-nav__label">{section.label}</span>
                    <svg className={`mv-nav__chevron${expanded ? " is-open" : ""}`} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                      <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <div id={panelId} className="mv-nav__items" hidden={!expanded}>
                    {section.items.map((item) => <SidebarDestination key={item.id} item={item} active={active?.id === item.id} />)}
                  </div>
                </section>
              </Fragment>
            );
          })}
          {platform.length ? (
            <section className="mv-nav__section mv-nav__section--platform">
              <p className="mv-nav__area-label">Platform Operations</p>
              <div className="mv-nav__items mv-nav__items--platform">
                {platform.map((item) => (
                  <Link key={item.id} to={item.to} className={`mv-nav__item${location.pathname === item.to || location.pathname.startsWith(`${item.to}/`) ? " is-active" : ""}`}>
                    <NavIcon name={item.icon} size={17} />
                    <span>{item.label}</span>
                  </Link>
                ))}
              </div>
            </section>
          ) : null}
        </nav>

        <div className="mv-sidebar__footer">
          <div><strong>{me.user.displayName}</strong></div>
          <div className="mv-small">{me.activeTenant ? me.activeTenant.name : me.patientId ? "Patient account" : "No active role"}</div>
          {me.activeTenant ? <div className="mv-small">Role: {me.activeTenant.roles.join(", ") || "none"}</div> : null}
          <div className="mv-small">
            <Link to="/about">About us</Link> · <Link to="/help">Help &amp; support</Link> · <Link to="/contacts">Contacts</Link>
          </div>
          <div className="mv-small mv-muted">A product of Aidomex Group Ltd.</div>
          <p className="mv-nav__area-label">Account &amp; Preferences</p>
          <div className="mv-sidebar__actions">
            <Button variant="ghost" size="sm" onClick={() => navigate("/security")}>Profile</Button>
            {me.activeTenant ? <Button variant="ghost" size="sm" onClick={() => navigate("/workspace")}>Settings</Button> : null}
            <Button variant="secondary" size="sm" onClick={() => void signOut()}>Sign out</Button>
          </div>
        </div>
      </aside>

      <div className="mv-main">
        <header className="mv-topbar">
          <div className="mv-topbar__left">
            <button
              ref={menuButtonRef}
              type="button"
              className="mv-menu-button"
              aria-label={navOpen ? "Close navigation" : "Open navigation"}
              aria-expanded={navOpen}
              aria-controls="app-sidebar"
              onClick={() => (navOpen ? closeNavigation() : setNavOpen(true))}
            >
              <NavIcon name="menu" size={20} />
            </button>
            <Link to="/dashboard" className="mv-mobile-brand" aria-label="Medveris dashboard">
              <BrandMark />
              <span>Medveris</span>
            </Link>
            <div className="mv-topbar__context">
              <FacilityContext me={me} />
              <Badge tone={me.activeTenant ? "success" : me.patientId ? "info" : "neutral"}>
                {me.activeTenant ? "Staff session" : me.patientId ? "Patient session" : "Unassigned"}
              </Badge>
              {me.user.mfaEnrolled ? <Badge tone="neutral">MFA enrolled</Badge> : null}
            </div>
          </div>
          <div className="mv-topbar__tools">
            <button type="button" className="mv-search-trigger" onClick={() => setSearchOpen(true)} aria-label="Search workspace">
              <NavIcon name="search" size={18} />
              <span className="mv-search-trigger__label">Search workspace</span>
              <kbd>⌘K</kbd>
            </button>
            <IntelligenceLink me={me} />
            <NotificationsMenu />
            <ProfileMenu me={me} onSignOut={signOut} />
          </div>
        </header>
        {me.activeTenant ? <PrimaryNavStrip sections={sections} platform={platform} active={active} locationPathname={location.pathname} /> : null}
        <SubscriptionBanner />
        <main className="mv-content" id="main-content">
          <Outlet />
        </main>
      </div>

      {mobileTabs.length ? (
        <nav className="mv-bottom-nav" aria-label="Mobile navigation">
          {mobileTabs.map((tab) => {
            const isActive = activeMobileTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                className={`mv-bottom-nav__item${isActive ? " is-active" : ""}`}
                aria-current={isActive ? "page" : undefined}
                aria-label={tab.label}
                onClick={() => {
                  if (tab.id === "home") {
                    navigate(mobileHomeTarget);
                  } else {
                    setMobileSheet(tab.id);
                  }
                }}
              >
                <NavIcon name={tab.icon} size={19} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>
      ) : null}

      {mobileSheet ? <MobileSheet tabId={mobileSheet} onClose={() => setMobileSheet(null)} /> : null}

      <GlobalSearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />


      <span className="mv-visually-hidden" aria-live="polite">{profile.categoryLabel ?? ""}</span>
    </div>
  );
}
