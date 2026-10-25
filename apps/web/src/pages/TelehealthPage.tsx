import { useState, type FormEvent } from "react";
import { Badge, Button, Card, DataList, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { formatDateTime, futureIso } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";
import { MemberPicker, PatientPicker } from "../components/Pickers";

interface Session { id: string; patientId: string; appointmentId: string | null; clinicianUserId: string; scheduledAt: string; status: string; version: number; connectionStatus: string | null; notes: string | null; publicId: string; givenName: string; familyName: string; clinicianName: string; latestConsent: boolean | null }

export function TelehealthPage() {
  const sessions = useQuery<{ sessions: Session[] }>("/telehealth/sessions");
  const [showForm, setShowForm] = useState(false);
  const [patientId, setPatientId] = useState("");
  const [clinicianId, setClinicianId] = useState("");
  const [scheduledAt, setScheduledAt] = useState(futureIso(1).slice(0, 16));
  const action = useAction();

  async function create(event: FormEvent) {
    event.preventDefault();
    await action.run("create", async () => {
      await api("/telehealth/sessions", { method: "POST", body: { patientId, clinicianUserId: clinicianId, scheduledAt: new Date(scheduledAt).toISOString() } });
      setShowForm(false);
      sessions.reload();
      return "Telehealth session scheduled.";
    });
  }

  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Telehealth" title="Remote consultation records" description="Consent and session outcomes are recorded. A media adapter is not configured in this build, so joining is unavailable." />
      <Notice tone="warning">Telemedicine media is not configured. Session scheduling, consent and outcome records work; the external video provider is intentionally disabled.</Notice>
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <div className="mv-row" style={{ justifyContent: "flex-end" }}><Button onClick={() => setShowForm((prev) => !prev)}>{showForm ? "Close form" : "Schedule session"}</Button></div>
      {showForm ? (
        <Card title="Schedule a telehealth session">
          <form className="mv-stack" onSubmit={create}>
            <div className="mv-form-grid">
              <PatientPicker value={patientId} onChange={setPatientId} />
              <MemberPicker value={clinicianId} onChange={setClinicianId} label="Clinician" />
              <Field label="Scheduled at" htmlFor="telehealth-time"><Input id="telehealth-time" type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} required /></Field>
            </div>
            <Button type="submit" disabled={action.busy !== null || !patientId || !clinicianId}>{action.busy === "create" ? "Scheduling…" : "Schedule session"}</Button>
          </form>
        </Card>
      ) : null}
      <Card title="Sessions">
        {sessions.loading ? <LoadingState /> : sessions.error ? <ErrorState message={sessions.error} onRetry={sessions.reload} /> : !sessions.data?.sessions.length ? <EmptyState title="No sessions" description="Schedule a telehealth session for a linked patient." /> : (
          <div className="mv-stack">
            {sessions.data.sessions.map((session) => <SessionCard key={session.id} session={session} onDone={sessions.reload} />)}
          </div>
        )}
      </Card>
    </div>
  );
}

function SessionCard({ session, onDone }: { session: Session; onDone: () => void }) {
  const [consent, setConsent] = useState("true");
  const [consentNotes, setConsentNotes] = useState("");
  const [outcome, setOutcome] = useState("completed");
  const [notes, setNotes] = useState("");
  const action = useAction();

  async function recordConsent(event: FormEvent) {
    event.preventDefault();
    await action.run("consent", async () => {
      await api(`/telehealth/sessions/${session.id}/consent`, { method: "POST", body: { consent: consent === "true", notes: consentNotes } });
      onDone();
      return "Consent recorded.";
    });
  }

  async function complete(event: FormEvent) {
    event.preventDefault();
    await action.run("complete", async () => {
      await api(`/telehealth/sessions/${session.id}/complete`, { method: "POST", body: { connectionStatus: outcome, notes } });
      onDone();
      return "Session closed.";
    });
  }

  return (
    <div className="mv-note">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <div className="mv-spread">
        <div><strong>{session.givenName} {session.familyName}</strong> <span className="mv-small mv-muted mv-id">{session.publicId}</span><div className="mv-small">Clinician: {session.clinicianName}</div></div>
        <Badge tone={session.status === "completed" ? "success" : session.status === "failed" ? "danger" : session.status === "in-progress" ? "info" : "warning"}>{session.status}</Badge>
      </div>
      <DataList items={[
        { label: "Scheduled", value: formatDateTime(session.scheduledAt) },
        { label: "Consent", value: session.latestConsent === true ? "Recorded" : session.latestConsent === false ? "Declined" : "Not recorded" },
        { label: "Connection", value: session.connectionStatus ?? "Not started" },
        { label: "Outcome notes", value: session.notes ?? "—" },
      ]} />
      {["scheduled", "consented"].includes(session.status) ? (
        <form className="mv-stack mv-note" onSubmit={recordConsent} style={{ marginTop: 8 }}>
          <div className="mv-form-grid">
            <Field label="Patient consent"><Select value={consent} onChange={(event) => setConsent(event.target.value)}><option value="true">Consent given</option><option value="false">Consent declined</option></Select></Field>
            <Field label="Consent notes" htmlFor={`consent-${session.id}`}><Input id={`consent-${session.id}`} value={consentNotes} onChange={(event) => setConsentNotes(event.target.value)} /></Field>
          </div>
          <Button size="sm" type="submit" disabled={action.busy !== null}>{action.busy === "consent" ? "Recording…" : "Record consent"}</Button>
        </form>
      ) : null}
      {["in-progress", "consented"].includes(session.status) ? (
        <form className="mv-stack mv-note" onSubmit={complete} style={{ marginTop: 8 }}>
          <Field label="Outcome"><Select value={outcome} onChange={(event) => setOutcome(event.target.value)}><option value="completed">Completed</option><option value="failed">Failed / no connection</option></Select></Field>
          <Field label="Notes" htmlFor={`outcome-${session.id}`}><Textarea id={`outcome-${session.id}`} value={notes} onChange={(event) => setNotes(event.target.value)} /></Field>
          <Button size="sm" variant="secondary" type="submit" disabled={action.busy !== null}>{action.busy === "complete" ? "Closing…" : "Close session"}</Button>
        </form>
      ) : null}
      <div className="mv-small mv-muted" style={{ marginTop: 8 }}>Join is unavailable because the telemedicine media adapter is not configured.</div>
    </div>
  );
}
