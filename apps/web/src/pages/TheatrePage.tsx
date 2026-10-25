import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Tabs } from "@medveris/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDateTime, futureIso } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";
import { EncounterPicker, MemberPicker, PatientPicker } from "../components/Pickers";

interface Theatre { id: string; name: string; status: string }
interface CaseRow { id: string; patientId: string; encounterId: string; admissionId: string | null; procedureName: string; laterality: string; site: string | null; urgency: string; scheduledAt: string; status: string; version: number; publicId: string; givenName: string; familyName: string; theatreName: string | null; surgeonName: string | null }

export function TheatrePage() {
  const { me } = useAuth();
  const admin = (me?.activeTenant?.roles ?? []).includes("facility_admin");
  const [tab, setTab] = useState<"cases" | "theatres">("cases");
  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Theatre" title="Operating theatre and anesthesia" description="Safety checkpoints gate case progression. Theatres are configured per facility; exceptions are recorded with a reason." />
      <Tabs label="Theatre sections" value={tab} onChange={setTab} options={[{ value: "cases", label: "Cases" }, ...(admin ? [{ value: "theatres" as const, label: "Theatres" }] : [])]} />
      {tab === "cases" ? <Cases /> : null}
      {tab === "theatres" && admin ? <Theatres /> : null}
    </div>
  );
}

function Cases() {
  const cases = useQuery<{ cases: CaseRow[] }>("/theatre-cases");
  const theatres = useQuery<{ theatres: Theatre[] }>("/theatres");
  const [showForm, setShowForm] = useState(false);
  const [patientId, setPatientId] = useState("");
  const [encounterId, setEncounterId] = useState("");
  const [procedureName, setProcedureName] = useState("");
  const [laterality, setLaterality] = useState("not-applicable");
  const [site, setSite] = useState("");
  const [urgency, setUrgency] = useState("routine");
  const [scheduledAt, setScheduledAt] = useState(futureIso(1).slice(0, 16));
  const [theatreId, setTheatreId] = useState("");
  const [surgeonId, setSurgeonId] = useState("");
  const action = useAction();

  async function create(event: FormEvent) {
    event.preventDefault();
    await action.run("create", async () => {
      await api("/theatre-cases", {
        method: "POST",
        body: {
          patientId, encounterId, procedureName, laterality, site, urgency,
          scheduledAt: new Date(scheduledAt).toISOString(), theatreId: theatreId || null, surgeonUserId: surgeonId || null,
        },
      });
      setShowForm(false);
      setProcedureName("");
      cases.reload();
      return "Theatre case scheduled.";
    });
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <div className="mv-row" style={{ justifyContent: "flex-end" }}><Button onClick={() => setShowForm((prev) => !prev)}>{showForm ? "Close form" : "New theatre case"}</Button></div>
      {showForm ? (
        <Card title="Schedule a theatre case" description="Pre-operative assessment, consent and the time-out checklist are required before entering theatre.">
          <form className="mv-stack" onSubmit={create}>
            <div className="mv-form-grid">
              <PatientPicker value={patientId} onChange={(value) => { setPatientId(value); setEncounterId(""); }} />
              <EncounterPicker value={encounterId} onChange={setEncounterId} patientId={patientId || undefined} />
              <Field label="Procedure" htmlFor="theatre-procedure"><Input id="theatre-procedure" value={procedureName} onChange={(event) => setProcedureName(event.target.value)} required minLength={3} /></Field>
              <Field label="Laterality"><Select value={laterality} onChange={(event) => setLaterality(event.target.value)}><option value="not-applicable">Not applicable</option><option value="left">Left</option><option value="right">Right</option><option value="bilateral">Bilateral</option></Select></Field>
              <Field label="Site" htmlFor="theatre-site"><Input id="theatre-site" value={site} onChange={(event) => setSite(event.target.value)} /></Field>
              <Field label="Urgency"><Select value={urgency} onChange={(event) => setUrgency(event.target.value)}><option value="routine">Routine</option><option value="urgent">Urgent</option><option value="emergency">Emergency</option></Select></Field>
              <Field label="Scheduled at"><Input type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} required /></Field>
              <Field label="Theatre"><Select value={theatreId} onChange={(event) => setTheatreId(event.target.value)}><option value="">Unassigned</option>{theatres.data?.theatres.map((theatre) => <option key={theatre.id} value={theatre.id}>{theatre.name}</option>)}</Select></Field>
              <MemberPicker value={surgeonId} onChange={setSurgeonId} label="Surgeon (optional)" id="surgeon-picker" required={false} />
            </div>
            <Button type="submit" disabled={action.busy !== null || !patientId || !encounterId || procedureName.trim().length < 3}>{action.busy === "create" ? "Scheduling…" : "Schedule case"}</Button>
          </form>
        </Card>
      ) : null}
      <Card title="Theatre cases">
        {cases.loading ? <LoadingState /> : cases.error ? <ErrorState message={cases.error} onRetry={cases.reload} /> : !cases.data?.cases.length ? <EmptyState title="No theatre cases" description="Schedule a procedure for an active encounter." /> : (
          <Table head={["Patient", "Procedure", "Urgency", "Theatre", "Scheduled", "Status", ""]} caption="Theatre cases">
            {cases.data.cases.map((row) => (
              <tr key={row.id}>
                <td><strong>{row.givenName} {row.familyName}</strong><div className="mv-small mv-muted mv-id">{row.publicId}</div></td>
                <td>{row.procedureName}<div className="mv-small mv-muted">{row.laterality !== "not-applicable" ? `${row.laterality} · ` : ""}{row.site}</div></td>
                <td><Badge tone={row.urgency === "emergency" ? "danger" : row.urgency === "urgent" ? "warning" : "neutral"}>{row.urgency}</Badge></td>
                <td>{row.theatreName ?? "Unassigned"}<div className="mv-small mv-muted">{row.surgeonName}</div></td>
                <td className="mv-small">{formatDateTime(row.scheduledAt)}</td>
                <td><Badge tone={row.status === "completed" ? "success" : row.status === "cancelled" ? "neutral" : row.status === "in-theatre" ? "danger" : "info"}>{row.status}</Badge></td>
                <td><Link className="mv-button mv-button--secondary mv-button--sm" to={`/theatre/${row.id}`}>Open</Link></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function Theatres() {
  const theatres = useQuery<{ theatres: Theatre[] }>("/theatres");
  const [name, setName] = useState("");
  const [status, setStatus] = useState("available");
  const action = useAction();
  async function create(event: FormEvent) {
    event.preventDefault();
    await action.run("theatre", async () => {
      await api("/theatres", { method: "POST", body: { name, status } });
      setName("");
      theatres.reload();
      return "Theatre created.";
    });
  }
  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title="Theatres">
        {theatres.loading ? <LoadingState /> : theatres.error ? <ErrorState message={theatres.error} onRetry={theatres.reload} /> : !theatres.data?.theatres.length ? <EmptyState title="No theatres" description="Create the first theatre below." /> : (
          <Table head={["Theatre", "Status"]} caption="Theatres">{theatres.data.theatres.map((theatre) => <tr key={theatre.id}><td>{theatre.name}</td><td><Badge tone={theatre.status === "available" ? "success" : "warning"}>{theatre.status}</Badge></td></tr>)}</Table>
        )}
      </Card>
      <Card title="Create a theatre">
        <form className="mv-stack" onSubmit={create}>
          <div className="mv-form-grid">
            <Field label="Name" htmlFor="theatre-name"><Input id="theatre-name" value={name} onChange={(event) => setName(event.target.value)} required minLength={2} /></Field>
            <Field label="Status"><Select value={status} onChange={(event) => setStatus(event.target.value)}><option value="available">Available</option><option value="maintenance">Maintenance</option><option value="closed">Closed</option></Select></Field>
          </div>
          <Button type="submit" disabled={action.busy !== null || name.trim().length < 2}>{action.busy === "theatre" ? "Creating…" : "Create theatre"}</Button>
        </form>
      </Card>
    </div>
  );
}
