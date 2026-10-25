import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Tabs, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";
import { MemberPicker, PatientPicker } from "../components/Pickers";

interface EmergencyCase {
  id: string;
  encounterId: string;
  patientId: string;
  arrivalMode: string;
  location: string | null;
  status: string;
  disposition: string | null;
  createdAt: string;
  publicId: string;
  givenName: string;
  familyName: string;
  identityConfidence: string;
  createdVia: string;
  encounterState: string;
  encounterVersion: number;
  reason: string;
  triageComplaint: string | null;
  triageUrgency: string | null;
  observationCount: number;
  lastObservationAt: string | null;
  assignedName: string | null;
}

const ARRIVAL_MODES = ["walk-in", "ambulance", "referral", "police", "other"];

export function EmergencyPage() {
  const [status, setStatus] = useState<"active" | "closed" | "all">("active");
  const cases = useQuery<{ cases: EmergencyCase[] }>(`/emergency/cases?status=${status}`);
  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Emergency" title="Emergency care board" description="Temporary identity, triage, serial observations, handoff and disposition share the audited clinical record. Billing is never required to document emergency care." />
      <Notice tone="info">Emergency registration creates a synthetic-capable temporary identity. Reconcile the patient when confirmed identifiers are available. No treatment protocol or physiological threshold is inferred by this workflow.</Notice>
      <Tabs label="Emergency case status" value={status} onChange={setStatus} options={[
        { value: "active", label: "Active" },
        { value: "closed", label: "Closed" },
        { value: "all", label: "All" },
      ]} />
      <RegisterEmergencyCase />
      <Card title={status === "active" ? "Active emergency cases" : status === "closed" ? "Closed emergency cases" : "All emergency cases"} description="Sorted by urgency and arrival time.">
        {cases.loading ? <LoadingState label="Loading emergency board" /> : cases.error ? <ErrorState message={cases.error} onRetry={cases.reload} /> : !cases.data?.cases.length ? <EmptyState title="No emergency cases" description="Register an emergency arrival above." /> : (
          <Table head={["Patient", "Arrival", "Triage", "Observations", "Status", ""]} caption="Emergency care board">
            {cases.data.cases.map((row) => (
              <tr key={row.id}>
                <td>
                  <strong>{row.givenName} {row.familyName}</strong>
                  <div className="mv-small mv-muted mv-id">{row.publicId}</div>
                  <div className="mv-small mv-muted">{row.reason}</div>
                  {row.identityConfidence === "temporary" ? <Badge tone="warning">Temporary identity</Badge> : null}
                </td>
                <td>
                  <Badge tone="neutral">{row.arrivalMode}</Badge>
                  <div className="mv-small mv-muted">{formatDateTime(row.createdAt)}</div>
                  {row.location ? <div className="mv-small mv-muted">{row.location}</div> : null}
                </td>
                <td>
                  {row.triageUrgency ? <Badge tone={row.triageUrgency === "emergency" ? "danger" : row.triageUrgency === "urgent" ? "warning" : "neutral"}>{row.triageUrgency}</Badge> : <Badge tone="warning">Awaiting triage</Badge>}
                  <div className="mv-small mv-muted">{row.triageComplaint ?? "No triage recorded"}</div>
                </td>
                <td>
                  <strong>{row.observationCount}</strong>
                  <div className="mv-small mv-muted">{row.lastObservationAt ? `Last ${formatDateTime(row.lastObservationAt)}` : "None recorded"}</div>
                </td>
                <td>
                  <Badge tone={row.status === "closed" ? "neutral" : row.encounterState === "in-progress" ? "info" : "warning"}>{row.status === "closed" ? row.disposition : row.encounterState}</Badge>
                  {row.assignedName ? <div className="mv-small mv-muted">{row.assignedName}</div> : null}
                </td>
                <td><Link className="mv-button mv-button--secondary mv-button--sm" to={`/emergency/${row.id}`}>Open</Link></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function RegisterEmergencyCase() {
  const navigate = useNavigate();
  const action = useAction();
  const [mode, setMode] = useState<"existing" | "temporary">("existing");
  const [patientId, setPatientId] = useState("");
  const [givenName, setGivenName] = useState("Unknown");
  const [familyName, setFamilyName] = useState("Emergency");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [sex, setSex] = useState("unknown");
  const [reason, setReason] = useState("");
  const [arrivalMode, setArrivalMode] = useState("walk-in");
  const [location, setLocation] = useState("");
  const [assignedUserId, setAssignedUserId] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run("register", async () => {
      const result = await api<{ case: { id: string } }>("/emergency/cases", {
        method: "POST",
        body: {
          patientId: mode === "existing" ? patientId : null,
          temporaryPatient: mode === "temporary" ? { givenName, familyName, dateOfBirth, sex } : null,
          reason,
          arrivalMode,
          location,
          assignedUserId: assignedUserId || null,
        },
      });
      navigate(`/emergency/${result.case.id}`);
      return "Emergency case registered.";
    });
  }

  return (
    <Card title="Register emergency arrival" description="Use an existing linked patient or create a temporary identity. Triage is recorded on the case page.">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <form className="mv-stack" onSubmit={submit}>
        <Tabs label="Patient identity" value={mode} onChange={setMode} options={[
          { value: "existing", label: "Existing patient" },
          { value: "temporary", label: "Temporary / unidentified" },
        ]} />
        {mode === "existing" ? <PatientPicker value={patientId} onChange={setPatientId} /> : (
          <div className="mv-grid mv-grid--2">
            <Field label="Given name" htmlFor="emergency-given"><Input id="emergency-given" value={givenName} onChange={(event) => setGivenName(event.target.value)} required maxLength={120} /></Field>
            <Field label="Family name" htmlFor="emergency-family"><Input id="emergency-family" value={familyName} onChange={(event) => setFamilyName(event.target.value)} required maxLength={120} /></Field>
            <Field label="Approximate date of birth" htmlFor="emergency-dob"><Input id="emergency-dob" type="date" value={dateOfBirth} onChange={(event) => setDateOfBirth(event.target.value)} required /></Field>
            <Field label="Sex"><Select value={sex} onChange={(event) => setSex(event.target.value)}><option value="unknown">Unknown</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></Select></Field>
          </div>
        )}
        <div className="mv-form-grid">
          <Field label="Arrival mode"><Select value={arrivalMode} onChange={(event) => setArrivalMode(event.target.value)}>{ARRIVAL_MODES.map((value) => <option key={value} value={value}>{value}</option>)}</Select></Field>
          <Field label="Location (optional)" htmlFor="emergency-location"><Input id="emergency-location" value={location} onChange={(event) => setLocation(event.target.value)} maxLength={120} placeholder="Resus bay, triage room…" /></Field>
        </div>
        <MemberPicker value={assignedUserId} onChange={setAssignedUserId} label="Assigned clinician (optional)" required={false} />
        <Field label="Presenting problem" htmlFor="emergency-reason"><Textarea id="emergency-reason" value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={2000} /></Field>
        <Button type="submit" disabled={action.busy !== null || !reason.trim() || (mode === "existing" ? !patientId : !dateOfBirth)}>{action.busy === "register" ? "Registering…" : "Register emergency case"}</Button>
      </form>
    </Card>
  );
}
