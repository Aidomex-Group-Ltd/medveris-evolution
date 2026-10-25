import { useState, type FormEvent } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Tabs, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";

interface Summary { activeStaff: number; openOnboarding: number; pendingPrivileges: number; enabledDepartments: number; expiredTraining: number }
interface Department { id: string; code: string; name: string; departmentType: string; enabled: boolean; unitCount: number; staffCount: number }
interface OnboardingCase { id: string; status: string; currentStep: number; staffRef: string; givenName: string; familyName: string; professionalDisplayName: string | null; engagementType: string | null; startDate: string | null; primaryDepartment: string | null; createdAt: string }
interface StaffRow { id: string; staffRef: string; givenName: string; familyName: string; professionalDisplayName: string | null; status: string; engagementId: string | null; engagementType: string | null; engagementStatus: string | null; jobTitle: string | null; primaryDepartment: string | null; approvedPrivileges: number }
interface Privilege { id: string; code: string; name: string; category: string; requiresCredential: boolean }
interface Grant { id: string; status: string; scope: string | null; requestedAt: string; privilegeCode: string; privilegeName: string; givenName: string; familyName: string; engagementId: string }

const CONTEXTS = ["governance", "patient-access", "outpatient", "emergency", "inpatient", "maternity", "pediatrics", "critical-care", "theatre", "laboratory", "blood-bank", "radiology", "pharmacy", "renal", "mental-health", "rehabilitation", "nutrition", "dental", "eye-ent", "primary-community", "palliative", "ipc-quality", "cssd", "mortuary", "housekeeping", "portering", "engineering", "catering", "security", "finance", "hr", "procurement", "digital-health", "other"];

export function WorkforcePage() {
  const [tab, setTab] = useState<"structure" | "onboarding" | "staff" | "privileges">("structure");
  return (
    <div className="mv-stack">
      <PageHeader eyebrow="People" title="Organisation and workforce" description="Configure the department hierarchy, onboard staff, and govern clinical privileges. A job title and a privilege are separate decisions." />
      <Tabs label="Workforce sections" value={tab} onChange={setTab} options={[
        { value: "structure", label: "Structure" },
        { value: "onboarding", label: "Onboarding" },
        { value: "staff", label: "Staff directory" },
        { value: "privileges", label: "Privileges" },
      ]} />
      {tab === "structure" ? <Structure /> : null}
      {tab === "onboarding" ? <Onboarding /> : null}
      {tab === "staff" ? <Directory /> : null}
      {tab === "privileges" ? <Privileges /> : null}
    </div>
  );
}

function Structure() {
  const summary = useQuery<{ summary: Summary }>("/workforce/summary");
  const departments = useQuery<{ departments: Department[] }>("/organization/departments");
  const action = useAction();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [departmentType, setDepartmentType] = useState("outpatient");

  async function applyCatalogue() {
    await action.run("catalogue", async () => {
      const result = await api<{ applied: { departments: number; units: number; cadres: number; privileges: number } }>("/organization/catalogue", { method: "POST" });
      departments.reload();
      summary.reload();
      return `Catalogue applied: ${result.applied.departments} departments, ${result.applied.units} units, ${result.applied.cadres} cadres and ${result.applied.privileges} privileges added.`;
    });
  }

  async function createDepartment(event: FormEvent) {
    event.preventDefault();
    await action.run("department", async () => {
      await api("/organization/departments", { method: "POST", body: { code, name, departmentType, enabled: true } });
      setCode("");
      setName("");
      departments.reload();
      summary.reload();
      return "Department created.";
    });
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      {summary.loading ? <LoadingState /> : summary.error ? <ErrorState message={summary.error} onRetry={summary.reload} /> : summary.data ? (
        <div className="mv-grid mv-grid--3">
          <Card title="Active staff"><strong style={{ fontSize: "1.65rem" }}>{summary.data.summary.activeStaff}</strong></Card>
          <Card title="Open onboarding"><strong style={{ fontSize: "1.65rem" }}>{summary.data.summary.openOnboarding}</strong></Card>
          <Card title="Pending privileges"><strong style={{ fontSize: "1.65rem" }}>{summary.data.summary.pendingPrivileges}</strong></Card>
          <Card title="Enabled departments"><strong style={{ fontSize: "1.65rem" }}>{summary.data.summary.enabledDepartments}</strong></Card>
        </div>
      ) : null}
      <Card title="Department catalogue" description="Start from the editable catalogue, then rename or disable only what the facility operates.">
        <div className="mv-row">
          <Button onClick={() => void applyCatalogue()} disabled={action.busy !== null}>{action.busy === "catalogue" ? "Applying…" : "Apply default catalogue"}</Button>
          <span className="mv-small mv-muted">Idempotent: existing department, unit, cadre and privilege codes are kept.</span>
        </div>
      </Card>
      <div className="mv-grid mv-grid--2">
        <Card title="Add a department" description="Codes must be unique within the facility.">
          <form className="mv-stack" onSubmit={createDepartment}>
            <div className="mv-form-grid">
              <Field label="Code" htmlFor="dept-code"><Input id="dept-code" value={code} onChange={(event) => setCode(event.target.value)} required minLength={2} maxLength={40} /></Field>
              <Field label="Name" htmlFor="dept-name"><Input id="dept-name" value={name} onChange={(event) => setName(event.target.value)} required minLength={2} /></Field>
            </div>
            <Field label="Department type"><Select value={departmentType} onChange={(event) => setDepartmentType(event.target.value)}>{CONTEXTS.map((type) => <option key={type} value={type}>{type}</option>)}</Select></Field>
            <Button type="submit" disabled={action.busy !== null || code.trim().length < 2 || name.trim().length < 2}>{action.busy === "department" ? "Creating…" : "Create department"}</Button>
          </form>
        </Card>
        <Card title="Departments" description={`${departments.data?.departments.length ?? 0} configured.`}>
          {departments.loading ? <LoadingState /> : departments.error ? <ErrorState message={departments.error} onRetry={departments.reload} /> : !departments.data?.departments.length ? <EmptyState title="No departments" description="Apply the catalogue or add a department." /> : (
            <Table head={["Code", "Department", "Units", "Staff"]} caption="Departments">
              {departments.data.departments.map((row) => (
                <tr key={row.id}><td className="mv-id">{row.code}</td><td><strong>{row.name}</strong><div className="mv-small mv-muted">{row.departmentType}</div></td><td>{row.unitCount}</td><td>{row.staffCount}</td></tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}

function Onboarding() {
  const cases = useQuery<{ cases: OnboardingCase[] }>("/workforce/onboarding");
  const departments = useQuery<{ departments: Department[] }>("/organization/departments");
  const action = useAction();
  const [givenName, setGivenName] = useState("");
  const [familyName, setFamilyName] = useState("");
  const [email, setEmail] = useState("");
  const [engagementType, setEngagementType] = useState("employee");
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [primaryDepartmentId, setPrimaryDepartmentId] = useState("");
  const [decisionCaseId, setDecisionCaseId] = useState("");
  const [decision, setDecision] = useState<"approve" | "reject" | "return">("approve");
  const [reason, setReason] = useState("");

  async function start(event: FormEvent) {
    event.preventDefault();
    await action.run("start", async () => {
      const result = await api<{ onboarding: { staffRef: string } }>("/workforce/onboarding", {
        method: "POST",
        body: { givenName, familyName, email: email || undefined, engagementType, startDate, primaryDepartmentId: primaryDepartmentId || null },
      });
      setGivenName("");
      setFamilyName("");
      setEmail("");
      cases.reload();
      return `Onboarding started for ${result.onboarding.staffRef}.`;
    });
  }

  async function decide(event: FormEvent) {
    event.preventDefault();
    await action.run("decision", async () => {
      await api(`/workforce/onboarding/${decisionCaseId}/decision`, { method: "POST", body: { decision, reason } });
      setDecisionCaseId("");
      setReason("");
      cases.reload();
      return `Onboarding decision recorded: ${decision}.`;
    });
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <div className="mv-grid mv-grid--2">
        <Card title="Start onboarding" description="Creates a staff reference, a pending engagement and an onboarding case. No login account is created here.">
          <form className="mv-stack" onSubmit={start}>
            <div className="mv-form-grid">
              <Field label="Given name" htmlFor="ob-given"><Input id="ob-given" value={givenName} onChange={(event) => setGivenName(event.target.value)} required /></Field>
              <Field label="Family name" htmlFor="ob-family"><Input id="ob-family" value={familyName} onChange={(event) => setFamilyName(event.target.value)} required /></Field>
              <Field label="Email" htmlFor="ob-email"><Input id="ob-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></Field>
              <Field label="Engagement type"><Select value={engagementType} onChange={(event) => setEngagementType(event.target.value)}>{["employee", "contractor", "student", "intern", "trainee", "volunteer", "locum", "visiting-practitioner"].map((type) => <option key={type} value={type}>{type}</option>)}</Select></Field>
              <Field label="Start date" htmlFor="ob-start"><Input id="ob-start" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} required /></Field>
              <Field label="Primary department"><Select value={primaryDepartmentId} onChange={(event) => setPrimaryDepartmentId(event.target.value)}><option value="">Assign later</option>{departments.data?.departments.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</Select></Field>
            </div>
            <Button type="submit" disabled={action.busy !== null || !givenName.trim() || !familyName.trim()}>{action.busy === "start" ? "Starting…" : "Start onboarding"}</Button>
          </form>
        </Card>
        <Card title="Record a decision" description="A decision is only accepted once the case reaches review.">
          <form className="mv-stack" onSubmit={decide}>
            <Field label="Onboarding case"><Select value={decisionCaseId} onChange={(event) => setDecisionCaseId(event.target.value)} required><option value="">Select a case…</option>{cases.data?.cases.map((row) => <option key={row.id} value={row.id}>{row.staffRef} — {row.familyName}, {row.givenName} · {row.status}</option>)}</Select></Field>
            <Field label="Decision"><Select value={decision} onChange={(event) => setDecision(event.target.value as typeof decision)}><option value="approve">Approve</option><option value="return">Return for correction</option><option value="reject">Reject</option></Select></Field>
            <Field label="Reason" htmlFor="ob-reason" hint="At least 10 characters. Recorded in the audit trail."><Textarea id="ob-reason" value={reason} onChange={(event) => setReason(event.target.value)} required minLength={10} /></Field>
            <Button type="submit" disabled={action.busy !== null || !decisionCaseId || reason.trim().length < 10}>{action.busy === "decision" ? "Recording…" : "Record decision"}</Button>
          </form>
        </Card>
      </div>
      <Card title="Onboarding cases">
        {cases.loading ? <LoadingState /> : cases.error ? <ErrorState message={cases.error} onRetry={cases.reload} /> : !cases.data?.cases.length ? <EmptyState title="No onboarding cases" description="Start an onboarding case above." /> : (
          <Table head={["Staff", "Step", "Status", "Department", "Started"]} caption="Onboarding cases">
            {cases.data.cases.map((row) => (
              <tr key={row.id}><td><strong>{row.familyName}, {row.givenName}</strong><div className="mv-small mv-muted mv-id">{row.staffRef}</div></td><td>{row.currentStep}</td><td><Badge tone={row.status === "active" ? "success" : row.status === "rejected" ? "danger" : "info"}>{row.status}</Badge></td><td>{row.primaryDepartment ?? "—"}</td><td className="mv-small">{formatDateTime(row.createdAt)}</td></tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function Directory() {
  const staff = useQuery<{ staff: StaffRow[] }>("/workforce/staff");
  return (
    <Card title="Staff directory" description="Facility-scoped engagements. A directory entry does not grant clinical access.">
      {staff.loading ? <LoadingState /> : staff.error ? <ErrorState message={staff.error} onRetry={staff.reload} /> : !staff.data?.staff.length ? <EmptyState title="No staff" description="Start onboarding to create the first engagement." /> : (
        <Table head={["Staff", "Engagement", "Department", "Privileges", "Status"]} caption="Staff directory">
          {staff.data.staff.map((row) => (
            <tr key={row.id}>
              <td><strong>{row.professionalDisplayName ?? `${row.familyName}, ${row.givenName}`}</strong><div className="mv-small mv-muted mv-id">{row.staffRef}</div></td>
              <td>{row.engagementType ?? "—"}<div className="mv-small mv-muted">{row.jobTitle ?? "No job title"}</div></td>
              <td>{row.primaryDepartment ?? "Unassigned"}</td>
              <td>{row.approvedPrivileges}</td>
              <td><Badge tone={row.engagementStatus === "active" ? "success" : row.status === "suspended" ? "danger" : "warning"}>{row.engagementStatus ?? row.status}</Badge></td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

function Privileges() {
  const privileges = useQuery<{ privileges: Privilege[] }>("/workforce/privileges");
  const grants = useQuery<{ grants: Grant[] }>("/workforce/privilege-grants");
  const staff = useQuery<{ staff: StaffRow[] }>("/workforce/staff");
  const action = useAction();
  const [engagementId, setEngagementId] = useState("");
  const [privilegeId, setPrivilegeId] = useState("");
  const [scope, setScope] = useState("");
  const [grantId, setGrantId] = useState("");
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");
  const [reason, setReason] = useState("");

  async function request(event: FormEvent) {
    event.preventDefault();
    await action.run("request", async () => {
      await api(`/workforce/engagements/${engagementId}/privileges`, { method: "POST", body: { privilegeId, scope: scope || undefined } });
      setPrivilegeId("");
      setScope("");
      grants.reload();
      return "Privilege request recorded.";
    });
  }

  async function decide(event: FormEvent) {
    event.preventDefault();
    await action.run("decide", async () => {
      await api(`/workforce/privilege-grants/${grantId}/decision`, { method: "POST", body: { decision, reason } });
      setGrantId("");
      setReason("");
      grants.reload();
      return `Privilege ${decision}.`;
    });
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <div className="mv-grid mv-grid--2">
        <Card title="Request a privilege" description="Requests are separate from job titles and require a reviewer decision.">
          <form className="mv-stack" onSubmit={request}>
            <Field label="Engagement"><Select value={engagementId} onChange={(event) => setEngagementId(event.target.value)} required><option value="">Select staff…</option>{staff.data?.staff.filter((row) => row.engagementId).map((row) => <option key={row.engagementId} value={row.engagementId!}>{row.familyName}, {row.givenName} — {row.staffRef}</option>)}</Select></Field>
            <Field label="Privilege"><Select value={privilegeId} onChange={(event) => setPrivilegeId(event.target.value)} required><option value="">Select privilege…</option>{privileges.data?.privileges.map((row) => <option key={row.id} value={row.id}>{row.name} ({row.category})</option>)}</Select></Field>
            <Field label="Scope" htmlFor="priv-scope" hint="Optional local scope, for example a unit or procedure list."><Input id="priv-scope" value={scope} onChange={(event) => setScope(event.target.value)} /></Field>
            <Button type="submit" disabled={action.busy !== null || !engagementId || !privilegeId}>{action.busy === "request" ? "Requesting…" : "Request privilege"}</Button>
          </form>
        </Card>
        <Card title="Decide a request" description="Approval requires a clinical reviewer or facility administrator.">
          <form className="mv-stack" onSubmit={decide}>
            <Field label="Pending request"><Select value={grantId} onChange={(event) => setGrantId(event.target.value)} required><option value="">Select request…</option>{grants.data?.grants.filter((row) => row.status === "requested").map((row) => <option key={row.id} value={row.id}>{row.familyName}, {row.givenName} — {row.privilegeName}</option>)}</Select></Field>
            <Field label="Decision"><Select value={decision} onChange={(event) => setDecision(event.target.value as typeof decision)}><option value="approved">Approve</option><option value="rejected">Reject</option></Select></Field>
            <Field label="Reason" htmlFor="priv-reason" hint="At least 10 characters."><Textarea id="priv-reason" value={reason} onChange={(event) => setReason(event.target.value)} required minLength={10} /></Field>
            <Button type="submit" disabled={action.busy !== null || !grantId || reason.trim().length < 10}>{action.busy === "decide" ? "Recording…" : "Record decision"}</Button>
          </form>
        </Card>
      </div>
      <Card title="Privilege requests and grants">
        {grants.loading ? <LoadingState /> : grants.error ? <ErrorState message={grants.error} onRetry={grants.reload} /> : !grants.data?.grants.length ? <EmptyState title="No privilege records" description="Request a privilege for an active engagement." /> : (
          <Table head={["Staff", "Privilege", "Scope", "Status", "Requested"]} caption="Privilege grants">
            {grants.data.grants.map((row) => (
              <tr key={row.id}><td><strong>{row.familyName}, {row.givenName}</strong></td><td>{row.privilegeName}<div className="mv-small mv-muted">{row.privilegeCode}</div></td><td>{row.scope ?? "Facility"}</td><td><Badge tone={row.status === "approved" ? "success" : row.status === "rejected" ? "danger" : "warning"}>{row.status}</Badge></td><td className="mv-small">{formatDateTime(row.requestedAt)}</td></tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
