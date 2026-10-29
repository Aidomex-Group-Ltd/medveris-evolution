import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Tabs, Textarea } from "@medveris/ui";
import { api, errorMessage } from "../lib/api";
import { useAuth } from "../lib/auth";
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
  scopeDepartmentName: string | null;
  scopeUnitName: string | null;
}

interface InvitationRow {
  id: string;
  email: string;
  roles: string[];
  status: "pending" | "accepted" | "revoked" | "declined" | "expired";
  deliveryStatus: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  invitedByName: string;
  acceptedByName: string | null;
}

const INVITATION_TONE: Record<InvitationRow["status"], "success" | "warning" | "danger" | "neutral" | "info"> = {
  pending: "info",
  accepted: "success",
  revoked: "neutral",
  declined: "neutral",
  expired: "warning",
};

interface IntegrationResponse {
  integrations: Array<{
    id: string;
    name: string;
    enabled: boolean;
    state: string;
    reason: string;
    requested: boolean;
    missingPrerequisites: string[];
    lastSuccessfulVerificationAt: string | null;
    lastVerificationOutcome: string;
    effectWhileUnavailable: string;
    remediation: string;
  }>;
  terminology: { mode: string; label: string };
}

const INTEGRATION_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  available: "success",
  degraded: "warning",
  unavailable: "warning",
  disabled: "neutral",
  not_requested: "neutral",
  misconfigured: "danger",
  verification_failed: "danger",
};

interface DuplicateCandidate {
  primaryPatientId: string;
  candidatePatientId: string;
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

const ROLEOPTIONS = ["receptionist", "nurse", "midwife", "ward_manager", "clinician", "pharmacist", "laboratory", "lab_validator", "radiographer", "radiologist", "records", "hr", "finance", "auditor", "privacy_officer", "staff", "report_viewer", "unit_lead", "department_admin", "facility_admin", "owner"];
/** Roles limited to one department or unit; the server refuses them without a scope. */
const SCOPED_ROLES = new Set(["department_admin", "unit_lead"]);

export function AdminPage() {
  const [tab, setTab] = useState<"members" | "integrations" | "duplicates">("members");
  const { me } = useAuth();
  const facilityAdmin = me?.activeTenant?.roles.includes("facility_admin") ?? false;
  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Facility administration" title="Administration" description="Administrative scope does not grant clinical chart access. Role changes revoke affected sessions." />
      <Tabs label="Administration sections" value={tab} onChange={setTab} options={facilityAdmin
        ? [{ value: "members", label: "Memberships" }, { value: "integrations", label: "Integrations" }, { value: "duplicates", label: "Duplicate review" }]
        : [{ value: "members", label: "Department memberships" }]} />
      {tab === "members" ? <Memberships /> : null}
      {tab === "integrations" ? <Integrations /> : null}
      {tab === "duplicates" ? <Duplicates /> : null}
    </div>
  );
}

function Memberships() {
  const memberships = useQuery<{ memberships: MembershipRow[] }>("/admin/memberships");
  const invitations = useQuery<{ invitations: InvitationRow[] }>("/admin/invitations");
  const { reload: reloadMemberships } = memberships;
  const { reload: reloadInvitations } = invitations;

  // Invitees accept from their own device; refresh when the administrator returns to this tab.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") {
        reloadMemberships();
        reloadInvitations();
      }
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [reloadMemberships, reloadInvitations]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("receptionist");
  const [scopeDepartmentId, setScopeDepartmentId] = useState("");
  const [scopeUnitId, setScopeUnitId] = useState("");
  const departments = useQuery<{ departments: Array<{ id: string; name: string }> }>("/organization/departments");
  const units = useQuery<{ units: Array<{ id: string; name: string; departmentId: string }> }>(scopeDepartmentId ? `/organization/units?departmentId=${scopeDepartmentId}` : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function invite(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await api<{ delivery: { delivered: boolean; detail?: string } }>("/admin/invitations", { method: "POST", body: { email, roles: [role], scopeDepartmentId: scopeDepartmentId || null, scopeUnitId: scopeUnitId || null } });
      setMessage(response.delivery.delivered
        ? `Invitation emailed to ${email}. They appear under staff once they accept.`
        : `Invitation created, but the email could not be sent: ${response.delivery.detail ?? "delivery failed"}. Revoke it and try again later.`);
      setEmail("");
      invitations.reload();
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

  async function revoke(id: string) {
    if (!window.confirm("Revoke this invitation? Its link will stop working.")) return;
    setError(null);
    try {
      await api(`/admin/invitations/${id}/revoke`, { method: "POST" });
      invitations.reload();
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
            <Field label={SCOPED_ROLES.has(role) ? "Department (required)" : "Department (optional)"} htmlFor="invite-department" hint="Limits department administrators and unit leads to this department.">
              <Select id="invite-department" value={scopeDepartmentId} onChange={(e) => { setScopeDepartmentId(e.target.value); setScopeUnitId(""); }} required={SCOPED_ROLES.has(role)}>
                <option value="">Whole workspace</option>{departments.data?.departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
              </Select>
            </Field>
            {scopeDepartmentId ? (
              <Field label={role === "unit_lead" ? "Unit (required)" : "Unit (optional)"} htmlFor="invite-unit">
                <Select id="invite-unit" value={scopeUnitId} onChange={(e) => setScopeUnitId(e.target.value)} required={role === "unit_lead"}>
                  <option value="">Whole department</option>{units.data?.units.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
                </Select>
              </Field>
            ) : null}
            <Button type="submit" disabled={busy}>{busy ? "Inviting…" : "Create invitation"}</Button>
          </form>
        </Card>
        <Card title="Role boundaries" description="Least privilege is enforced by the server, not the menu.">
          <ul className="mv-small mv-muted" style={{ paddingLeft: 18, lineHeight: 1.8 }}>
            <li>Facility administrators manage membership but cannot read clinical notes.</li>
            <li>Receptionists manage identity and queues; they cannot retrieve clinical narratives.</li>
            <li>Only clinicians sign notes; nurses may document observations and triage.</li>
            <li>Only radiologists sign imaging reports; radiographers register studies and draft. Laboratory validators release results they did not enter.</li>
            <li>Privacy officers review audit and access history; they cannot open clinical records.</li>
            <li>Owners and facility administrators manage the whole workspace; only an owner can grant ownership, and the last owner cannot be removed.</li>
            <li>Department administrators and unit leads manage staff, stock and reports for their own department or unit only.</li>
            <li>Report viewers have read-only access to operational reports.</li>
            <li>Credential reviewer is a platform role and cannot be assigned here.</li>
          </ul>
        </Card>
      </div>
      <Card title="Invitations" description="Accepted invitations appear under facility staff. Pending links expire after 7 days." actions={<Button variant="ghost" size="sm" onClick={() => invitations.reload()}>Refresh</Button>}>
        {invitations.loading && !invitations.data ? <LoadingState /> : invitations.error ? <ErrorState message={invitations.error} onRetry={invitations.reload} /> : !invitations.data?.invitations.length ? <EmptyState title="No invitations" description="Invitations you send appear here with their status." /> : (
          <Table head={["Invited email", "Role", "Status", "Sent", ""]} caption="Facility staff invitations">
            {invitations.data.invitations.map((invitation) => (
              <tr key={invitation.id}>
                <td>{invitation.email}<div className="mv-small mv-muted">by {invitation.invitedByName}</div></td>
                <td>{invitation.roles.join(", ")}</td>
                <td>
                  <Badge tone={INVITATION_TONE[invitation.status]}>{invitation.status}</Badge>
                  {invitation.status === "accepted" && invitation.acceptedByName ? <div className="mv-small mv-muted">by {invitation.acceptedByName}</div> : null}
                  {invitation.status === "pending" && invitation.deliveryStatus === "failed" ? <div className="mv-small mv-muted">email not delivered</div> : null}
                </td>
                <td className="mv-small">{new Date(invitation.createdAt).toLocaleString()}</td>
                <td>{invitation.status === "pending" ? <Button variant="secondary" size="sm" onClick={() => void revoke(invitation.id)}>Revoke</Button> : null}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="Facility staff" actions={<Button variant="ghost" size="sm" onClick={() => memberships.reload()}>Refresh</Button>}>
        {memberships.loading && !memberships.data ? <LoadingState /> : memberships.error ? <ErrorState message={memberships.error} onRetry={memberships.reload} /> : !memberships.data?.memberships.length ? <EmptyState title="No staff yet" description="Invite the first staff member." /> : (
          <Table head={["Member", "Roles", "MFA", "Status", ""]} caption="Facility memberships">
            {memberships.data.memberships.map((member) => (
              <tr key={member.id}>
                <td><strong>{member.displayName}</strong><div className="mv-small mv-muted">{member.email}</div></td>
                <td>{member.roles.join(", ")}{member.scopeDepartmentName ? <div className="mv-small mv-muted">{member.scopeDepartmentName}{member.scopeUnitName ? ` · ${member.scopeUnitName}` : ""}</div> : null}</td>
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

interface VerificationResult { outcome: "passed" | "failed"; checks: Array<{ name: string; passed: boolean; detail: string; durationMs: number }> }

function Integrations() {
  const integrations = useQuery<IntegrationResponse>("/admin/integrations");
  const { me } = useAuth();
  const operator = me?.platformRoles.includes("platform_operator") ?? false;
  const [sampleUid, setSampleUid] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verification, setVerification] = useState<VerificationResult | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  if (integrations.loading) return <LoadingState />;
  if (integrations.error) return <ErrorState message={integrations.error} onRetry={integrations.reload} />;
  const dicomweb = integrations.data?.integrations.find((integration) => integration.id === "dicomweb");

  async function verify(event: FormEvent) {
    event.preventDefault();
    setVerifying(true);
    setVerifyError(null);
    try {
      setVerification(await api<VerificationResult>("/admin/integrations/dicomweb/verify", { method: "POST", body: sampleUid.trim() ? { sampleStudyInstanceUid: sampleUid.trim() } : {} }));
      integrations.reload();
    } catch (cause) {
      setVerifyError(errorMessage(cause));
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="mv-stack">
      <Notice tone="warning" title="No simulated successes">{integrations.data?.terminology.label}. Unavailable integrations are explicitly disabled.</Notice>
      {operator && dicomweb?.requested ? (
        <Card title="DICOMweb conformance run" description="Runs QIDO-RS and WADO-RS checks against the configured PACS from this runtime. Only a passing run makes the PACS available.">
          <form className="mv-row" onSubmit={verify}>
            <Field label="Sample Study Instance UID (optional)" htmlFor="dicomweb-sample"><Input id="dicomweb-sample" value={sampleUid} onChange={(event) => setSampleUid(event.target.value)} maxLength={64} /></Field>
            <Button type="submit" disabled={verifying}>{verifying ? "Verifying…" : "Run verification"}</Button>
          </form>
          {verifyError ? <ErrorState message={verifyError} /> : null}
          {verification ? (
            <Table head={["Check", "Result", "Detail"]} caption={`Verification ${verification.outcome}`}>
              {verification.checks.map((check) => (
                <tr key={check.name}><td>{check.name}</td><td><Badge tone={check.passed ? "success" : "danger"}>{check.passed ? "passed" : "failed"}</Badge></td><td className="mv-small">{check.detail}</td></tr>
              ))}
            </Table>
          ) : null}
        </Card>
      ) : null}
      <Card title="External adapters">
        <Table head={["Integration", "State", "Reason and effect", "Missing prerequisites", "Last verification", "Operator action"]} caption="Server-reported integration availability">
          {integrations.data?.integrations.map((integration) => (
            <tr key={integration.id}>
              <td><strong>{integration.name}</strong>{integration.requested ? <div className="mv-small mv-muted">requested by environment flag</div> : null}</td>
              <td><Badge tone={INTEGRATION_TONE[integration.state] ?? "warning"}>{integration.state.replace("_", " ")}</Badge></td>
              <td className="mv-small">{integration.reason}<div className="mv-muted" style={{ marginTop: 4 }}>{integration.effectWhileUnavailable}</div></td>
              <td className="mv-small"><ul style={{ margin: 0, paddingLeft: 16 }}>{integration.missingPrerequisites.map((item) => <li key={item}>{item}</li>)}</ul></td>
              <td className="mv-small">{integration.lastSuccessfulVerificationAt ? new Date(integration.lastSuccessfulVerificationAt).toLocaleString() : "Never verified"}</td>
              <td className="mv-small">{integration.remediation}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

function Duplicates() {
  const duplicates = useQuery<{ candidates: DuplicateCandidate[]; automaticMerge: boolean }>("/admin/duplicate-candidates");
  const [error, setError] = useState<string | null>(null);
  const [merging, setMerging] = useState<DuplicateCandidate | null>(null);
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
      <Notice tone="info" title="Manual review required">Patients are never merged automatically. A merge is requested here and must be approved by a different administrator or records officer on the <Link to="/patient-merges">Patient merges</Link> page.</Notice>
      {merging ? <MergeRequestForm candidate={merging} onDone={() => { setMerging(null); duplicates.reload(); }} onCancel={() => setMerging(null)} /> : null}
      <Card title="Pending duplicate candidates">
        {duplicates.loading ? <LoadingState /> : duplicates.error ? <ErrorState message={duplicates.error} onRetry={duplicates.reload} /> : !duplicates.data?.candidates.length ? <EmptyState title="No candidates" description="No unresolved duplicate candidates require review." /> : (
          <Table head={["Primary", "Candidate", "Reason", "Actions"]}>
            {duplicates.data.candidates.map((candidate) => (
              <tr key={candidate.id}>
                <td>{candidate.primaryGivenName} {candidate.primaryFamilyName}<div className="mv-small mv-muted mv-id">{candidate.primaryPublicId}</div></td>
                <td>{candidate.candidateGivenName} {candidate.candidateFamilyName}<div className="mv-small mv-muted mv-id">{candidate.candidatePublicId}</div></td>
                <td className="mv-small">{candidate.reason}</td>
                <td><div className="mv-row"><Button size="sm" variant="secondary" onClick={() => void review(candidate.id, "reviewed-no-merge")}>Not a duplicate</Button><Button size="sm" onClick={() => setMerging(candidate)}>Request merge</Button></div></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function MergeRequestForm({ candidate, onDone, onCancel }: { candidate: DuplicateCandidate; onDone: () => void; onCancel: () => void }) {
  const [survivor, setSurvivor] = useState<"primary" | "candidate">("primary");
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const primary = { id: candidate.primaryPatientId, label: `${candidate.primaryGivenName} ${candidate.primaryFamilyName} (${candidate.primaryPublicId})` };
  const other = { id: candidate.candidatePatientId, label: `${candidate.candidateGivenName} ${candidate.candidateFamilyName} (${candidate.candidatePublicId})` };
  const [keep, retire] = survivor === "primary" ? [primary, other] : [other, primary];
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/patient-merges", { method: "POST", body: { sourcePatientId: retire.id, survivorPatientId: keep.id, duplicateCandidateId: candidate.id, reason, evidence } });
      onDone();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Request a patient merge" description="The retired identity's records stay under its original ID and are shown with the surviving record. A second authorised person must approve.">
      <form className="mv-stack" onSubmit={submit}>
        {error ? <ErrorState message={error} /> : null}
        <Field label="Record to keep"><Select value={survivor} onChange={(event) => setSurvivor(event.target.value as "primary" | "candidate")}>
          <option value="primary">{primary.label}</option><option value="candidate">{other.label}</option>
        </Select></Field>
        <p className="mv-small">Retired identity: <strong>{retire.label}</strong></p>
        <Field label="Reason" htmlFor="merge-reason" hint="At least 10 characters."><Textarea id="merge-reason" value={reason} onChange={(event) => setReason(event.target.value)} minLength={10} required /></Field>
        <Field label="Identity evidence" htmlFor="merge-evidence" hint="How it was confirmed that both records are the same person (at least 10 characters)."><Textarea id="merge-evidence" value={evidence} onChange={(event) => setEvidence(event.target.value)} minLength={10} required /></Field>
        <div className="mv-row"><Button type="submit" disabled={busy || reason.trim().length < 10 || evidence.trim().length < 10}>{busy ? "Requesting…" : "Request merge"}</Button><Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button></div>
      </form>
    </Card>
  );
}
