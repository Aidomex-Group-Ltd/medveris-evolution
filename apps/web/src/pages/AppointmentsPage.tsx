import { useState, type FormEvent } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Textarea } from "@medveris/ui";
import { api, errorMessage } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";
import { MemberPicker, PatientPicker } from "../components/Pickers";

interface Appointment {
  id: string;
  startAt: string;
  durationMinutes: number;
  reason: string;
  status: string;
  version: number;
  statusNote: string | null;
  patientId: string;
  publicId: string;
  givenName: string;
  familyName: string;
  clinicianUserId: string | null;
  clinicianName: string | null;
}

interface RescheduleTarget { appointment: Appointment }
interface StatusTarget { appointment: Appointment; status: "cancelled" | "no-show" }

const statusTone = (status: string) =>
  status === "completed" ? "success"
    : status === "cancelled" || status === "no-show" ? "neutral"
      : status === "arrived" ? "info"
        : "warning";

function defaultStart(): string {
  const date = new Date(Date.now() + 86_400_000);
  date.setHours(9, 0, 0, 0);
  return localInput(date.toISOString());
}

function localInput(value: string): string {
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function AppointmentsPage() {
  const [scope, setScope] = useState("upcoming");
  const [status, setStatus] = useState("all");
  const appointments = useQuery<{ appointments: Appointment[] }>(`/appointments?scope=${scope}&status=${status}`);
  const [showForm, setShowForm] = useState(false);
  const [reschedule, setReschedule] = useState<RescheduleTarget | null>(null);
  const [statusTarget, setStatusTarget] = useState<StatusTarget | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function saved(text: string) {
    setMessage(text);
    setReschedule(null);
    setStatusTarget(null);
    appointments.reload();
  }

  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow="Reception"
        title="Appointments"
        description="Schedule, reschedule and record local appointment outcomes. Starting an encounter records arrival; no SMS or email reminder is sent."
      />
      {message ? <Notice tone="success">{message}</Notice> : null}
      {reschedule ? <ReschedulePanel target={reschedule.appointment} onCancel={() => setReschedule(null)} onSaved={() => saved("Appointment rescheduled.")} /> : null}
      {statusTarget ? <StatusPanel target={statusTarget} onCancel={() => setStatusTarget(null)} onSaved={() => saved(`Appointment marked ${statusTarget.status}.`)} /> : null}
      <div className="mv-row" style={{ justifyContent: "flex-end" }}>
        <Button onClick={() => setShowForm((prev) => !prev)}>{showForm ? "Close form" : "New appointment"}</Button>
      </div>
      {showForm ? <NewAppointment onCreated={() => { setShowForm(false); saved("Appointment scheduled."); }} /> : null}
      <Card
        title="Appointment schedule"
        description="Times shown in local time. Only scheduled appointments can be rescheduled or marked cancelled/no-show."
        actions={<div className="mv-row">
          <Select aria-label="Filter appointments by period" value={scope} onChange={(event) => setScope(event.target.value)}>
            <option value="upcoming">Upcoming</option>
            <option value="past">Past</option>
            <option value="all">All time</option>
          </Select>
          <Select aria-label="Filter appointments by status" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="all">All statuses</option>
            <option value="scheduled">Scheduled</option>
            <option value="arrived">Arrived</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
            <option value="no-show">No-show</option>
          </Select>
        </div>}
      >
        {appointments.loading ? <LoadingState /> : appointments.error ? <ErrorState message={appointments.error} onRetry={appointments.reload} /> : !appointments.data?.appointments.length ? <EmptyState title="No appointments" description="No appointments match the selected filters." /> : (
          <Table head={["When", "Patient", "Clinician", "Reason", "Status", ""]} caption="Appointment schedule">
            {appointments.data.appointments.map((row) => (
              <tr key={row.id}>
                <td><strong>{formatDateTime(row.startAt)}</strong><div className="mv-small mv-muted">{row.durationMinutes} minutes</div></td>
                <td><strong>{row.givenName} {row.familyName}</strong><div className="mv-small mv-muted mv-id">{row.publicId}</div></td>
                <td>{row.clinicianName ?? <span className="mv-small mv-muted">Unassigned</span>}</td>
                <td>{row.reason}</td>
                <td>
                  <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                  {row.statusNote ? <div className="mv-small mv-muted">{row.statusNote}</div> : null}
                </td>
                <td>
                  {row.status === "scheduled" ? (
                    <div className="mv-row">
                      <Button size="sm" variant="secondary" onClick={() => setReschedule({ appointment: row })}>Reschedule</Button>
                      <Button size="sm" variant="secondary" onClick={() => setStatusTarget({ appointment: row, status: "cancelled" })}>Cancel</Button>
                      <Button size="sm" variant="ghost" onClick={() => setStatusTarget({ appointment: row, status: "no-show" })}>No-show</Button>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function NewAppointment({ onCreated }: { onCreated: () => void }) {
  const action = useAction();
  const [patientId, setPatientId] = useState("");
  const [clinicianUserId, setClinicianUserId] = useState("");
  const [startAt, setStartAt] = useState(defaultStart());
  const [durationMinutes, setDurationMinutes] = useState("20");
  const [reason, setReason] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run("create", async () => {
      await api("/appointments", {
        method: "POST",
        body: {
          patientId,
          clinicianUserId: clinicianUserId || null,
          startAt: new Date(startAt).toISOString(),
          durationMinutes: Number(durationMinutes),
          reason,
        },
      });
      setPatientId("");
      setClinicianUserId("");
      setReason("");
      setStartAt(defaultStart());
      onCreated();
    });
  }

  return (
    <Card title="Schedule an appointment" description="The patient must already be linked to this facility. The selected clinician must be an active clinical member.">
      {action.error ? <ErrorState message={action.error} /> : null}
      <form className="mv-stack" onSubmit={submit}>
        <div className="mv-form-grid">
          <PatientPicker value={patientId} onChange={setPatientId} />
          <MemberPicker value={clinicianUserId} onChange={setClinicianUserId} label="Clinician (optional)" required={false} />
          <Field label="Start time" htmlFor="appointment-start"><Input id="appointment-start" type="datetime-local" value={startAt} onChange={(event) => setStartAt(event.target.value)} required /></Field>
          <Field label="Duration (minutes)" htmlFor="appointment-duration"><Input id="appointment-duration" type="number" min={5} max={480} value={durationMinutes} onChange={(event) => setDurationMinutes(event.target.value)} required /></Field>
        </div>
        <Field label="Reason" htmlFor="appointment-reason"><Input id="appointment-reason" value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={1000} /></Field>
        <Button type="submit" disabled={action.busy !== null || !patientId || !reason.trim()}>{action.busy === "create" ? "Scheduling…" : "Schedule appointment"}</Button>
      </form>
    </Card>
  );
}

function ReschedulePanel({ target, onCancel, onSaved }: { target: Appointment; onCancel: () => void; onSaved: () => void }) {
  const [startAt, setStartAt] = useState(localInput(target.startAt));
  const [durationMinutes, setDurationMinutes] = useState(String(target.durationMinutes));
  const [clinicianUserId, setClinicianUserId] = useState(target.clinicianUserId ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/appointments/${target.id}`, {
        method: "PATCH",
        body: {
          startAt: new Date(startAt).toISOString(),
          durationMinutes: Number(durationMinutes),
          clinicianUserId: clinicianUserId || null,
          note,
          expectedVersion: target.version,
        },
      });
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Reschedule appointment" description={`${target.givenName} ${target.familyName} · currently ${formatDateTime(target.startAt)}`}>
      {error ? <ErrorState message={error} /> : null}
      <form className="mv-stack" onSubmit={submit}>
        <div className="mv-form-grid">
          <Field label="New start time" htmlFor="reschedule-start"><Input id="reschedule-start" type="datetime-local" value={startAt} onChange={(event) => setStartAt(event.target.value)} required /></Field>
          <Field label="Duration (minutes)" htmlFor="reschedule-duration"><Input id="reschedule-duration" type="number" min={5} max={480} value={durationMinutes} onChange={(event) => setDurationMinutes(event.target.value)} required /></Field>
          <MemberPicker value={clinicianUserId} onChange={setClinicianUserId} label="Clinician (optional)" required={false} />
        </div>
        <Field label="Reschedule note" htmlFor="reschedule-note" hint="Minimum five characters. This note is audited.">
          <Textarea id="reschedule-note" value={note} onChange={(event) => setNote(event.target.value)} required minLength={5} maxLength={2000} />
        </Field>
        <div className="mv-row">
          <Button type="submit" disabled={busy || note.trim().length < 5}>{busy ? "Saving…" : "Save reschedule"}</Button>
          <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

function StatusPanel({ target, onCancel, onSaved }: { target: StatusTarget; onCancel: () => void; onSaved: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/appointments/${target.appointment.id}/status`, {
        method: "POST",
        body: { status: target.status, note, expectedVersion: target.appointment.version },
      });
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={`Mark appointment ${target.status}`} description={`${target.appointment.givenName} ${target.appointment.familyName} · ${formatDateTime(target.appointment.startAt)}`}>
      {error ? <ErrorState message={error} /> : null}
      <form className="mv-stack" onSubmit={submit}>
        <Field label="Decision note" htmlFor="appointment-status-note" hint="Minimum five characters. This note is audited.">
          <Textarea id="appointment-status-note" value={note} onChange={(event) => setNote(event.target.value)} required minLength={5} maxLength={2000} />
        </Field>
        <div className="mv-row">
          <Button type="submit" disabled={busy || note.trim().length < 5}>{busy ? "Saving…" : "Save status"}</Button>
          <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}
