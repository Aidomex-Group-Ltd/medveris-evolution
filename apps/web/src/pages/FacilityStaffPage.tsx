import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { Badge, Button, Card, ErrorState, LoadingState, Notice } from "@medveris/ui";
import { AuthFrame } from "../components/AuthFrame";
import { errorMessage } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useQuery } from "../lib/useQuery";

interface StaffFacilities {
  facilities: Array<{ tenantId: string; name: string; roles: string[] }>;
  inactive: Array<{ name: string; reason: string }>;
  activeTenantId: string | null;
}

const INACTIVE_REASON: Record<string, string> = {
  removed: "your access was removed by the facility",
  suspended: "your access is suspended",
  facility_unavailable: "the facility is not currently active",
};

/**
 * Facility staff sign-in, after authentication: the facility always comes from the server's list of the
 * user's active staff assignments, and the server re-checks the choice when the session switches to it.
 */
export function FacilityStaffPage() {
  const { me, loading, switchTenant, logout } = useAuth();
  const navigate = useNavigate();
  const staff = useQuery<StaffFacilities>("/me/facilities", { enabled: Boolean(me) });
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoSelected = useRef(false);

  async function open(tenantId: string) {
    setOpening(tenantId);
    setError(null);
    try {
      await switchTenant(tenantId);
      navigate("/", { replace: true });
    } catch (cause) {
      setError(errorMessage(cause));
      setOpening(null);
      staff.reload();
    }
  }

  const facilities = staff.data?.facilities ?? [];
  useEffect(() => {
    if (facilities.length !== 1 || autoSelected.current) return;
    autoSelected.current = true;
    void open(facilities[0]!.tenantId);
  }, [facilities.length]);

  if (loading) return <LoadingState label="Restoring session" variant="page" />;
  if (!me) return <Navigate to="/login?as=staff" replace />;

  function body() {
    if (staff.loading || (facilities.length === 1 && !error)) {
      return <Card title="Facility staff sign-in"><LoadingState label="Opening your facility workspace" /></Card>;
    }
    if (staff.error) return <ErrorState title="Could not load your staff assignments" message={staff.error} onRetry={staff.reload} />;
    if (!facilities.length) {
      return (
        <Card title="Not registered as facility staff" description={me?.user.email}>
          <div className="mv-stack">
            <Notice tone="warning">
              This account does not have an active staff assignment at any facility, so no facility workspace can be opened.
            </Notice>
            {staff.data?.inactive.length ? (
              <ul className="mv-small" style={{ margin: 0, paddingLeft: 18 }}>
                {staff.data.inactive.map((item) => <li key={item.name}>{item.name}: {INACTIVE_REASON[item.reason] ?? "access is not active"}. Contact that facility's administrator.</li>)}
              </ul>
            ) : null}
            <p className="mv-small">To join a facility, open the invitation link your facility administrator emailed you and accept it, or ask the administrator to send a new invitation.</p>
            <div className="mv-row">
              {me?.patientId ? <Button variant="secondary" type="button" onClick={() => navigate("/portal")}>Go to patient portal</Button> : null}
              <Button variant="ghost" type="button" onClick={() => void logout().then(() => navigate("/login", { replace: true }))}>Sign out</Button>
            </div>
          </div>
        </Card>
      );
    }
    return (
      <Card title="Choose a facility" description="You are staff at more than one facility. Choose where to work in this session.">
        <div className="mv-stack">
          {error ? <ErrorState title="Could not open the facility" message={error} /> : null}
          {facilities.map((facility) => (
            <Button key={facility.tenantId} variant="secondary" type="button" disabled={opening !== null} onClick={() => void open(facility.tenantId)}>
              <span className="mv-row" style={{ justifyContent: "space-between", width: "100%" }}>
                <strong>{facility.name}</strong>
                <span className="mv-row">{facility.roles.map((role) => <Badge key={role} tone="info">{role.replace(/_/g, " ")}</Badge>)}</span>
              </span>
            </Button>
          ))}
          <p className="mv-small mv-muted">You can switch facility later from the workspace menu. <Link to="/login">Use a different account</Link></p>
        </div>
      </Card>
    );
  }

  return (
    <AuthFrame
      eyebrow="Facility staff sign-in"
      heading="Open your facility workspace."
      intro={<p>Your facility is chosen from your verified staff assignments, not from this device or the address bar.</p>}
    >
      {body()}
    </AuthFrame>
  );
}
