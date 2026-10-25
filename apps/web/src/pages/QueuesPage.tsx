import { useEffect, useState } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, Notice, PageHeader, Select, Table } from "@medveris/ui";
import { api, errorMessage } from "../lib/api";
import { useQuery } from "../lib/useQuery";
import type { PatientSummary, Queue, QueueEntryDetail } from "../lib/types";

export function QueuesPage() {
  const queues = useQuery<{ queues: Queue[] }>("/queues");
  const patients = useQuery<{ patients: PatientSummary[] }>("/patients/recent");
  const [selected, setSelected] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [patientId, setPatientId] = useState("");
  const [priority, setPriority] = useState("routine");
  const entries = useQuery<{ entries: QueueEntryDetail[] }>(selected ? `/queues/${selected}/entries` : null);

  useEffect(() => {
    if (!selected && queues.data?.queues[0]) setSelected(queues.data.queues[0].id);
  }, [queues.data, selected]);

  async function addEntry() {
    if (!selected || !patientId) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api(`/queues/${selected}/entries`, { method: "POST", body: { patientId, priority } });
      setMessage("Queue entry added and audited.");
      entries.reload();
      queues.reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Reception" title="Outpatient queues" description="Queue ordering uses declared priority and arrival time. Clinical details stay in the authorized chart." />
      {error ? <ErrorState message={error} /> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      <div className="mv-grid mv-grid--2">
        <Card title="Queues" description="Only this facility's queues are visible.">
          {queues.loading ? <LoadingState /> : queues.error ? <ErrorState message={queues.error} onRetry={queues.reload} /> : !queues.data?.queues.length ? <EmptyState title="No queues" description="Create the default outpatient queue from the API before adding entries." /> : (
            <div className="mv-stack">
              {queues.data.queues.map((queue) => (
                <button key={queue.id} type="button" className={`mv-note ${selected === queue.id ? "mv-note--amended" : ""}`} style={{ textAlign: "left", cursor: "pointer", width: "100%" }} onClick={() => setSelected(queue.id)} aria-pressed={selected === queue.id}>
                  <div className="mv-spread"><strong>{queue.name}</strong><Badge tone={queue.waiting ? "warning" : "neutral"}>{queue.waiting} waiting</Badge></div>
                </button>
              ))}
            </div>
          )}
        </Card>
        <Card title="Add to queue" description="Patients must already be linked to this facility.">
          <div className="mv-stack">
            <label className="mv-field">
              <span className="mv-field__label">Patient</span>
              <Select value={patientId} onChange={(e) => setPatientId(e.target.value)}>
                <option value="">Select a recent patient…</option>
                {patients.data?.patients.map((patient) => <option key={patient.id} value={patient.id}>{patient.familyName}, {patient.givenName} — {patient.publicId}</option>)}
              </Select>
            </label>
            <label className="mv-field">
              <span className="mv-field__label">Priority</span>
              <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="routine">Routine</option>
                <option value="urgent">Urgent</option>
                <option value="emergency">Emergency</option>
              </Select>
            </label>
            <Button onClick={() => void addEntry()} disabled={!selected || !patientId || busy}>{busy ? "Adding…" : "Add queue entry"}</Button>
            {patients.error ? <ErrorState message={patients.error} onRetry={patients.reload} /> : null}
          </div>
        </Card>
      </div>

      <Card title="Waiting" description={selected ? "Current active entries for the selected queue." : "Select a queue."}>
        {!selected ? <EmptyState title="No queue selected" description="Select a queue to inspect waiting entries." /> : entries.loading ? <LoadingState /> : entries.error ? <ErrorState message={entries.error} onRetry={entries.reload} /> : !entries.data?.entries.length ? <EmptyState title="Queue is clear" description="No active entries in this queue." /> : (
          <Table head={["Patient", "Priority", "Status", "Queued", "Encounter"]} caption="Active queue entries">
            {entries.data.entries.map((entry) => (
              <tr key={entry.id}>
                <td><strong>{entry.givenName} {entry.familyName}</strong><div className="mv-small mv-muted mv-id">{entry.publicId}</div></td>
                <td><Badge tone={entry.priority === "emergency" ? "danger" : entry.priority === "urgent" ? "warning" : "neutral"}>{entry.priority}</Badge></td>
                <td>{entry.status}</td>
                <td>{new Date(entry.createdAt).toLocaleString()}</td>
                <td>{entry.encounterState ?? "not started"}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
