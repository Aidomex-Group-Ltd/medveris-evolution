import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { Badge, Button } from "@medveris/ui";
import { useAuth } from "../lib/auth";
import type { Role } from "../lib/types";

interface NavItem {
  to: string;
  label: string;
  roles?: Role[];
  patientOnly?: boolean;
  staffOnly?: boolean;
  platform?: boolean;
}

const groups: { label: string; items: NavItem[] }[] = [
  {
    label: "Workspace",
    items: [
      { to: "/", label: "Overview" },
      { to: "/patients", label: "Patients", roles: ["receptionist", "nurse", "clinician", "facility_admin"] },
      { to: "/queues", label: "Queues", roles: ["receptionist", "nurse", "clinician", "facility_admin"] },
      { to: "/worklist", label: "Clinical worklist", roles: ["nurse", "clinician"] },
      { to: "/exchange", label: "Record exchange", roles: ["nurse", "clinician"] },
    ],
  },
  {
    label: "Patient portal",
    items: [
      { to: "/portal", label: "My health record", patientOnly: true },
      { to: "/portal/consents", label: "Consent and sharing", patientOnly: true },
      { to: "/portal/access", label: "Access history", patientOnly: true },
    ],
  },
  {
    label: "Governance",
    items: [
      { to: "/credentials", label: "Credentials", staffOnly: true },
      { to: "/admin", label: "Facility administration", roles: ["facility_admin"] },
      { to: "/reviewer", label: "Credential review", platform: true },
      { to: "/security", label: "Session security", staffOnly: true },
    ],
  },
];

export function AppShell() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  if (!me) return null;
  const roles = me.activeTenant?.roles ?? [];
  const can = (item: NavItem) => {
    if (item.patientOnly) return Boolean(me.patientId);
    if (item.staffOnly) return Boolean(me.activeTenant);
    if (item.platform) return me.platformRoles.length > 0;
    if (item.roles) return item.roles.some((role) => roles.includes(role));
    return true;
  };
  return (
    <div className="mv-app">
      <aside className="mv-sidebar">
        <NavLink to="/" className="mv-brand" aria-label="Medveris home">
          <span className="mv-brand__mark" aria-hidden="true">M</span>
          <span>Medveris<small>Outpatient foundation</small></span>
        </NavLink>
        <nav className="mv-nav" aria-label="Primary navigation">
          {groups.map((group) => {
            const visible = group.items.filter(can);
            if (!visible.length) return null;
            return (
              <div key={group.label}>
                <p className="mv-nav__label">{group.label}</p>
                {visible.map((item) => (
                  <NavLink key={item.to} to={item.to} end={item.to === "/"}>
                    {item.label}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="mv-sidebar__footer">
          <div>{me.user.displayName}</div>
          <div className="mv-small">{me.activeTenant ? me.activeTenant.name : me.patientId ? "Patient account" : "No active role"}</div>
        </div>
      </aside>
      <div className="mv-main">
        <header className="mv-topbar">
          <div className="context">
            <div className="mv-context">
              <Badge tone={me.activeTenant ? "success" : "info"}>{me.activeTenant ? "Staff session" : me.patientId ? "Patient session" : "Unassigned"}</Badge>
              {me.activeTenant ? <span className="mv-small mv-muted">Active: {me.activeTenant.roles.join(", ")}</span> : null}
              {me.user.mfaEnrolled ? <Badge tone="neutral">MFA enrolled</Badge> : null}
            </div>
          </div>
          <div className="mv-row">
            <Button variant="ghost" size="sm" onClick={() => navigate("/security")}>Security</Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                await logout();
                navigate("/login", { replace: true });
              }}
            >
              Sign out
            </Button>
          </div>
        </header>
        <main className="mv-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
