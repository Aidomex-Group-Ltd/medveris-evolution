import { useNavigate } from "react-router-dom";
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, Notice, PageHeader, Table } from "@medveris/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useQuery } from "../lib/useQuery";

interface SessionRow {
  id: string;
  activeTenantId: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
  userAgent: string | null;
  current: boolean;
}

export function SecurityPage() {
  const { me, switchTenant, logout } = useAuth();
  const navigate = useNavigate();
  const sessions = useQuery<{ sessions: SessionRow[] }>("/me/sessions");
  const reload = () => {
    sessions.reload();
  };

  async function changeTenant(tenantId: string) {
    await switchTenant(tenantId);
    navigate("/", { replace: true });
  }

  async function revoke(id: string) {
    if (!window.confirm("Revoke this session? The device will need to sign in again.")) return;
    await api(`/me/sessions/${id}`, { method: "DELETE" });
    reload();
  }

  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Account security" title="Session and facility context" description="Each request carries one explicit active facility. Switching contexts re-evaluates entitlement and clears patient-specific page state." />
      <div className="mv-grid mv-grid--2">
        <Card title="Facility memberships" description="Only active, current memberships can become an active context.">
          {!me?.memberships.length ? <EmptyState title="No memberships" description="Your account has no active facility membership." /> : (
            <div className="mv-stack">
              {me.memberships.map((membership) => (
                <div key={membership.id} className="mv-spread mv-note">
                  <div><strong>{membership.tenantName}</strong><div className="mv-small mv-muted">{membership.roles.join(", ")}</div></div>
                  {me.activeTenant?.id === membership.tenantId ? <Badge tone="success">active</Badge> : <Button size="sm" variant="secondary" onClick={() => void changeTenant(membership.tenantId)}>Switch</Button>}
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card title="Security posture">
          <ul className="mv-small mv-muted" style={{ paddingLeft: 18, lineHeight: 1.8 }}>
            <li>MFA enrolled: <strong>{me?.user.mfaEnrolled ? "yes" : "no"}</strong></li>
            <li>MFA verified this session: <strong>{me?.user.mfaVerified ? "yes" : "no"}</strong></li>
            <li>Session cookie is HttpOnly and SameSite Strict; CSRF token is held in memory only.</li>
            <li>No chart data is stored in localStorage or a service worker cache.</li>
            <li>Clinical API responses require no-store and are audited before return.</li>
          </ul>
          <div className="mv-row" style={{ marginTop: 12 }}><Button variant="secondary" onClick={async () => { await logout(); navigate("/login", { replace: true }); }}>Sign out everywhere on this device</Button></div>
        </Card>
      </div>
      <Card title="Sessions" description="Revocation takes effect on the next request. Role changes and membership removal also revoke affected sessions.">
        {sessions.loading ? <LoadingState /> : sessions.error ? <ErrorState message={sessions.error} onRetry={sessions.reload} /> : !sessions.data?.sessions.length ? <EmptyState title="No sessions" description="No sessions found." /> : (
          <Table head={["Session", "Created", "Expires", "Status", ""]} caption="Account sessions">
            {sessions.data.sessions.map((session) => (
              <tr key={session.id}>
                <td>{session.current ? <Badge tone="success">current</Badge> : <Badge tone="neutral">other device</Badge>}<div className="mv-small mv-muted">{session.userAgent ?? "unknown client"}</div></td>
                <td>{new Date(session.createdAt).toLocaleString()}</td>
                <td>{new Date(session.expiresAt).toLocaleString()}</td>
                <td>{session.revokedAt ? <Badge tone="danger">revoked</Badge> : <Badge tone="success">active</Badge>}</td>
                <td>{!session.current && !session.revokedAt ? <Button size="sm" variant="danger" onClick={() => void revoke(session.id)}>Revoke</Button> : null}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Notice tone="info" title="Downtime procedure">If the API or database is unavailable, do not capture clinical notes in untracked files. Use the facility's approved downtime form and reconcile it through an attributed, reasoned workflow after service restoration.</Notice>
    </div>
  );
}
