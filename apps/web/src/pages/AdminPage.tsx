import { useState, type FormEvent } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Tabs } from "@medveris/ui";
import { api, errorMessage } from "../lib/api";
import { useQuery } from "../lib/useQuery";

interface MembershipRow {
  id: string;
  roles: string[];
  status: string;
  createdAt: string;
  userId: string;
  displayName: string;
  email: string;
  emailVerifiedAt: string | null;
  mfaEnrolledAt: string | null;
}

interface IntegrationResponse {
  features: Record<string, boolean>;
  integrations: Array<{ name: string; enabled: boolean; state: string; reason: string }>;
  terminology: { mode: string; label: string };
}

interface DuplicateCandidate {
  id: string;
  reason: string;
  status: string;
  createdAt: string;
  primaryPublicId: string;
  primaryGivenName: string;
  primaryFamilyName: string;
  candidatePublicId: string;
  candidateGivenName: string;
  candidateFamilyName: string;
}

const ROLEOPTIONS = ["receptionist", "nurse", "clinician", "facility_admin", "finance", "auditor"];

export function AdminPage() {
  const [tab, setTab] = useState<"members" | "integrations" | "duplicates">("members");
  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Facility administration" title="Administration" description="Administrative scope does not grant clinical chart access. Role changes revoke affected sessions." />
      <Tabs label="Administration sections" value={tab} onChange={setTab} options={[{ value: "members", label: "Memberships" }, { value: "integrations", label: "Integrations" }, { value: "duplicates", label: "Duplicate review" }]} />
      {tab === "members" ? <Memberships /> : null}
      {tab === "integrations" ? <Integrations /> : null}
      {tab === "duplicates" ? <Duplicates /> : null}
    </div>
  );
}

function Memberships() {
  const memberships = useQuery<{ memberships: MembershipRow[] }>("/admin/memberships");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("receptionist");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function invite(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await api<{ delivery: { delivered: boolean; detail?: string } }>("/admin/invitations", { method: "POST", body: { email, roles: [role] } });
      setMessage(`Invitation created. ${response.delivery.delivered ? "Delivered to the local mail sink." : response.delivery.detail ?? "Delivery failed."}`);
      setEmail("");
      memberships.reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Remove this membership? Active sessions for this facility will be revoked.")) return;
    setError(null);
    try {
      await api(`/admin/memberships/${id}`, { method: "DELETE" });
      memberships.reload();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <div className="mv-stack">
      {error ? <ErrorState message={error} /> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      <div className="mv-grid mv-grid--2">
        <Card title="Invite a staff member" description="Invitations do not establish credential verification or MFA enrolment.">
          <form className="mv-stack" onSubmit={invite}>
            <Field label="Work email" htmlFor="invite-email"><Input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
            <Field label="Initial role"><Select value={role} onChange={(e) => setRole(e.target.value)}>{ROLEOPTIONS.map((option) => <option key={option}>{option}</option>)}</Select></Field>
            <Button type="submit" disabled={busy}>{busy ? "Inviting…" : "Create invitation"}</Button>
          </form>
        </Card>
        <Card title="Role boundaries" description="Least privilege is enforced by the server, not the menu.">
          <ul className="mv-small mv-muted" style={{ paddingLeft: 18, lineHeight: 1.8 }}>
            <li>Facility administrators manage membership but cannot read clinical notes.</li>
            <li>Receptionists manage identity and queues; they cannot retrieve clinical narratives.</li>
            <li>Only clinicians sign notes; nurses may document observations and triage.</li>
            <li>Credential reviewer is a platform role and cannot be assigned here.</li>
          </ul>
        </Card>
      </div>
      <Card title="Memberships">
        {memberships.loading ? <LoadingState /> : memberships.error ? <ErrorState message={memberships.error} onRetry={memberships.reload} /> : !memberships.data?.memberships.length ? <EmptyState title="No memberships" description="Invite the first staff member." /> : (
          <Table head={["Member", "Roles", "MFA", "Status", ""]} caption="Facility memberships">
            {memberships.data.memberships.map((member) => (
              <tr key={member.id}>
                <td><strong>{member.displayName}</strong><div className="mv-small mv-muted">{member.email}</div></td>
                <td>{member.roles.join(", ")}</td>
                <td><Badge tone={member.mfaEnrolledAt ? "success" : "warning"}>{member.mfaEnrolledAt ? "enrolled" : "not enrolled"}</Badge></td>
                <td><Badge tone={member.status === "active" ? "success" : "neutral"}>{member.status}</Badge></td>
                <td>{member.status === "active" ? <Button variant="danger" size="sm" onClick={() => void remove(member.id)}>Remove</Button> : null}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function Integrations() {
  const integrations = useQuery<IntegrationResponse>("/admin/integrations");
  if (integrations.loading) return <LoadingState />;
  if (integrations.error) return <ErrorState message={integrations.error} onRetry={integrations.reload} />;
  return (
    <div className="mv-stack">
      <Notice tone="warning" title="No simulated successes">{integrations.data?.terminology.label}. Unavailable integrations are explicitly disabled.</Notice>
      <Card title="External adapters">
        <Table head={["Integration", "State", "Reason"]}>
          {integrations.data?.integrations.map((integration) => (
            <tr key={integration.name}><td><strong>{integration.name}</strong></td><td><Badge tone={integration.enabled ? "success" : "warning"}>{integration.state}</Badge></td><td className="mv-small">{integration.reason}</td></tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

function Duplicates() {
  const duplicates = useQuery<{ candidates: DuplicateCandidate[]; automaticMerge: boolean }>("/admin/duplicate-candidates");
  const [error, setError] = useState<string | null>(null);
  async function review(id: string, status: "reviewed-no-merge" | "linked") {
    const note = window.prompt("Review note (minimum 5 characters):");
    if (!note || note.trim().length < 5) return;
    try {
      await api(`/admin/duplicate-candidates/${id}/review`, { method: "POST", body: { status, note } });
      duplicates.reload();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  return (
    <div className="mv-stack">
      {error ? <ErrorState message={error} /> : null}
      <Notice tone="info" title="Manual review required">Automatic patient merges are disabled. Review is audited, is limited to this facility and does not merge either identity.</Notice>
      <Card title="Pending duplicate candidates">
        {duplicates.loading ? <LoadingState /> : duplicates.error ? <ErrorState message={duplicates.error} onRetry={duplicates.reload} /> : !duplicates.data?.candidates.length ? <EmptyState title="No candidates" description="No unresolved duplicate candidates require review." /> : (
          <Table head={["Primary", "Candidate", "Reason", "Actions"]}>
            {duplicates.data.candidates.map((candidate) => (
              <tr key={candidate.id}>
                <td>{candidate.primaryGivenName} {candidate.primaryFamilyName}<div className="mv-small mv-muted mv-id">{candidate.primaryPublicId}</div></td>
                <td>{candidate.candidateGivenName} {candidate.candidateFamilyName}<div className="mv-small mv-muted mv-id">{candidate.candidatePublicId}</div></td>
                <td className="mv-small">{candidate.reason}</td>
                <td><div className="mv-row"><Button size="sm" variant="secondary" onClick={() => void review(candidate.id, "reviewed-no-merge")}>No merge</Button><Button size="sm" onClick={() => void review(candidate.id, "linked")}>Confirmed duplicate</Button></div></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
