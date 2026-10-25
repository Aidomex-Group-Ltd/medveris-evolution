import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge, Button, Card, DataList, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";
import { MemberPicker } from "../components/Pickers";

interface Admission {
  id: string; patientId: string; encounterId: string; wardType: string; status: string; version: number;
  reason: string; summary: string | null; dispositionReason: string | null; admittedAt: string; dischargedAt: string | null;
  publicId: string; givenName: string; familyName: string; dateOfBirth: string; sex: string;
}
interface Bed { id: string; wardId: string; label: string; status: string; version: number; wardName: string }
interface BedAssignment { id: string; bedId: string; assignedAt: string; releasedAt: string | null; label: string; wardName: string }
interface Assessment { id: string; shift: string; notes: string; painScore: number | null; mobility: string | null; skin: string | null; nurseName: string; createdAt: string }
interface Task { id: string; description: string; dueAt: string | null; status: string; note: string | null; createdByName: string; createdAt: string; completedAt: string | null }
interface Handoff { id: string; summary: string; fromName: string; toName: string; createdAt: string }
interface Detail { admission: Admission; beds: BedAssignment[]; assessments: Assessment[]; tasks: Task[]; handoffs: Handoff[] }
interface DiagnosticSummary { results: Array<{ id: string; testName: string; status: string; valueText: string | null; unit: string | null; referenceRange: string | null; critical: boolean; createdAt: string }>; reports: Array<{ id: string; studyName: string; status: string; impression: string; createdAt: string }> }

export function AdmissionDetailPage() {
  const { id = "" } = useParams();
  const detail = useQuery<Detail>(id ? `/admissions/${id}` : null);
  const beds = useQuery<{ beds: Bed[] }>("/beds");
  const diagnostics = useQuery<DiagnosticSummary>(detail.data ? `/patients/${detail.data.admission.patientId}/diagnostics` : null);
  const action = useAction();
  const [bedId, setBedId] = useState("");
  const [transferReason, setTransferReason] = useState("");
  const [disposition, setDisposition] = useState("discharged");
  const [summary, setSummary] = useState("");
  const [reason, setReason] = useState("");
  const [shift, setShift] = useState("day");
  const [notes, setNotes] = useState("");
  const [painScore, setPainScore] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [taskDue, setTaskDue] = useState("");
  const [taskNote, setTaskNote] = useState<Record<string, string>>({});
  const [handoffTo, setHandoffTo] = useState("");
  const [handoffSummary, setHandoffSummary] = useState("");

  if (detail.loading) return <LoadingState label="Loading admission" />;
  if (detail.error || !detail.data) return <ErrorState message={detail.error ?? "Admission not found"} onRetry={detail.reload} />;

  const { admission, beds: assignments, assessments, tasks, handoffs } = detail.data;
  const active = admission.status === "admitted";
  const available = (beds.data?.beds ?? []).filter((bed) => bed.status === "available" || assignments.some((row) => !row.releasedAt && row.bedId === bed.id));

  async function assignBed(event: FormEvent) {
    event.preventDefault();
    await action.run("bed", async () => {
      await api(`/admissions/${admission.id}/bed`, { method: "POST", body: { bedId, expectedVersion: admission.version, reason: transferReason } });
      setBedId("");
      setTransferReason("");
      detail.reload();
      beds.reload();
      return "Bed assignment updated.";
    });
  }

  async function transition(event: FormEvent) {
    event.preventDefault();
    if (!window.confirm(`Close this admission as ${disposition}? This frees the bed and may complete the encounter.`)) return;
    await action.run("transition", async () => {
      await api(`/admissions/${admission.id}/transition`, { method: "POST", body: { status: disposition, expectedVersion: admission.version, summary, reason } });
      detail.reload();
      beds.reload();
      return "Admission closed.";
    });
  }

  async function addAssessment(event: FormEvent) {
    event.preventDefault();
    await action.run("assessment", async () => {
      await api(`/admissions/${admission.id}/assessments`, { method: "POST", body: { shift, notes, painScore: painScore === "" ? null : Number(painScore) } });
      setNotes("");
      setPainScore("");
      detail.reload();
      return "Nursing assessment recorded.";
    });
  }

  async function addTask(event: FormEvent) {
    event.preventDefault();
    await action.run("task", async () => {
      await api(`/admissions/${admission.id}/tasks`, { method: "POST", body: { description: taskDescription, dueAt: taskDue ? new Date(taskDue).toISOString() : null } });
      setTaskDescription("");
      setTaskDue("");
      detail.reload();
      return "Nursing task added.";
    });
  }

  async function updateTask(task: Task, status: "completed" | "cancelled") {
    await action.run(task.id, async () => {
      await api(`/admissions/${admission.id}/tasks/${task.id}`, { method: "PATCH", body: { status, note: taskNote[task.id] ?? "" } });
      detail.reload();
      return `Task ${status}.`;
    });
  }

  async function sendHandoff(event: FormEvent) {
    event.preventDefault();
    await action.run("handoff", async () => {
      await api(`/admissions/${admission.id}/handoffs`, { method: "POST", body: { toUserId: handoffTo, summary: handoffSummary } });
      setHandoffSummary("");
      detail.reload();
      return "Handoff recorded.";
    });
  }

  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Inpatient" title={`${admission.givenName} ${admission.familyName}`} description={`${admission.publicId} · ${admission.reason}`} actions={<Link className="mv-button mv-button--ghost mv-button--sm" to="/wards">Back to wards</Link>} />
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <div className="mv-grid mv-grid--2">
        <Card title="Admission">
          <DataList items={[
            { label: "Status", value: <Badge tone={active ? "info" : "neutral"}>{admission.status}</Badge> },
            { label: "Ward type", value: admission.wardType },
            { label: "Admitted", value: formatDateTime(admission.admittedAt) },
            { label: "Closed", value: formatDateTime(admission.dischargedAt) },
            { label: "Encounter", value: <span className="mv-id">{admission.encounterId}</span> },
            { label: "Disposition", value: admission.dispositionReason ?? "—" },
          ]} />
          {admission.summary ? <p className="mv-note">{admission.summary}</p> : null}
        </Card>
        <Card title="Bed assignment" description={active ? "Choose an available bed or transfer within the facility." : "Closed admissions cannot be reassigned."}>
          {assignments.length ? (
            <div className="mv-stack" style={{ gap: 6 }}>
              {assignments.map((row) => (
                <div key={row.id} className="mv-spread mv-note">
                  <span><strong>{row.wardName}</strong> · {row.label}</span>
                  <span className="mv-small mv-muted">{row.releasedAt ? `released ${formatDateTime(row.releasedAt)}` : `since ${formatDateTime(row.assignedAt)}`}</span>
                </div>
              ))}
            </div>
          ) : <p className="mv-small mv-muted">No bed assigned.</p>}
          {active ? (
            <form className="mv-stack" onSubmit={assignBed} style={{ marginTop: 12 }}>
              <Field label="Bed"><Select value={bedId} onChange={(event) => setBedId(event.target.value)} required>{<option value="">Select an available bed…</option>}{available.map((bed) => <option key={bed.id} value={bed.id}>{bed.wardName} · {bed.label}</option>)}</Select></Field>
              <Field label="Transfer reason" htmlFor="transfer-reason"><Input id="transfer-reason" value={transferReason} onChange={(event) => setTransferReason(event.target.value)} maxLength={500} /></Field>
              <Button type="submit" disabled={action.busy !== null || !bedId}>{action.busy === "bed" ? "Assigning…" : assignments.some((row) => !row.releasedAt) ? "Transfer bed" : "Assign bed"}</Button>
            </form>
          ) : null}
        </Card>
      </div>

      <div className="mv-grid mv-grid--2">
        <Card title="Nursing assessments">
          {active ? (
            <form className="mv-stack" onSubmit={addAssessment}>
              <div className="mv-form-grid">
                <Field label="Shift"><Select value={shift} onChange={(event) => setShift(event.target.value)}><option value="day">Day</option><option value="evening">Evening</option><option value="night">Night</option></Select></Field>
                <Field label="Pain score (0–10)" htmlFor="pain-score"><Input id="pain-score" type="number" min={0} max={10} value={painScore} onChange={(event) => setPainScore(event.target.value)} /></Field>
              </div>
              <Field label="Assessment notes" htmlFor="assessment-notes"><Textarea id="assessment-notes" value={notes} onChange={(event) => setNotes(event.target.value)} required minLength={2} /></Field>
              <Button type="submit" disabled={action.busy !== null || notes.trim().length < 2}>{action.busy === "assessment" ? "Recording…" : "Record assessment"}</Button>
            </form>
          ) : null}
          {!assessments.length ? <EmptyState title="No assessments" description="Nursing assessments appear here with author and timestamp." /> : (
            <div className="mv-stack" style={{ marginTop: active ? 16 : 0 }}>
              {assessments.map((row) => (
                <div key={row.id} className="mv-note">
                  <div className="mv-spread"><strong>{row.shift} shift</strong><span className="mv-small mv-muted">{formatDateTime(row.createdAt)}</span></div>
                  <p>{row.notes}</p>
                  <div className="mv-small mv-muted">{row.nurseName}{row.painScore != null ? ` · pain ${row.painScore}/10` : ""}{row.mobility ? ` · mobility: ${row.mobility}` : ""}{row.skin ? ` · skin: ${row.skin}` : ""}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card title="Nursing tasks">
          {active ? (
            <form className="mv-stack" onSubmit={addTask}>
              <Field label="Task" htmlFor="task-description"><Input id="task-description" value={taskDescription} onChange={(event) => setTaskDescription(event.target.value)} required minLength={2} /></Field>
              <Field label="Due at (optional)"><Input type="datetime-local" value={taskDue} onChange={(event) => setTaskDue(event.target.value)} /></Field>
              <Button type="submit" disabled={action.busy !== null || taskDescription.trim().length < 2}>{action.busy === "task" ? "Adding…" : "Add task"}</Button>
            </form>
          ) : null}
          {!tasks.length ? <EmptyState title="No nursing tasks" description="Pending and completed tasks appear here." /> : (
            <div className="mv-stack" style={{ marginTop: active ? 16 : 0 }}>
              {tasks.map((task) => (
                <div key={task.id} className="mv-note">
                  <div className="mv-spread"><strong>{task.description}</strong><Badge tone={task.status === "completed" ? "success" : task.status === "cancelled" ? "neutral" : "warning"}>{task.status}</Badge></div>
                  <div className="mv-small mv-muted">{task.createdByName} · due {formatDateTime(task.dueAt)}</div>
                  {task.note ? <div className="mv-small">Note: {task.note}</div> : null}
                  {task.status === "pending" && active ? (
                    <div className="mv-stack" style={{ gap: 6, marginTop: 8 }}>
                      <Input aria-label={`Completion note for ${task.description}`} placeholder="Completion note (optional)" value={taskNote[task.id] ?? ""} onChange={(event) => setTaskNote((prev) => ({ ...prev, [task.id]: event.target.value }))} maxLength={1000} />
                      <div className="mv-row">
                        <Button size="sm" variant="secondary" onClick={() => void updateTask(task, "completed")} disabled={action.busy !== null}>Complete</Button>
                        <Button size="sm" variant="ghost" onClick={() => void updateTask(task, "cancelled")} disabled={action.busy !== null}>Cancel task</Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="mv-grid mv-grid--2">
        <Card title="Diagnostic summary" description="Finalized or corrected results visible to this facility.">
          {diagnostics.loading ? <LoadingState /> : diagnostics.error ? <ErrorState message={diagnostics.error} /> : (
            <div className="mv-stack">
              {diagnostics.data?.results.slice(0, 6).map((result) => (
                <div key={result.id} className="mv-note">
                  <div className="mv-spread"><strong>{result.testName}</strong><Badge tone={result.critical ? "danger" : "neutral"}>{result.status}</Badge></div>
                  <div>{result.valueText ?? "—"} {result.unit ?? ""} {result.referenceRange ? <span className="mv-small mv-muted">(ref {result.referenceRange})</span> : null}</div>
                </div>
              ))}
              {diagnostics.data?.reports.slice(0, 4).map((report) => (
                <div key={report.id} className="mv-note"><div className="mv-spread"><strong>{report.studyName}</strong><Badge>{report.status}</Badge></div><p>{report.impression}</p></div>
              ))}
              {!diagnostics.data?.results.length && !diagnostics.data?.reports.length ? <p className="mv-small mv-muted">No diagnostic results recorded.</p> : null}
            </div>
          )}
        </Card>
        <Card title="Handoff">
          {active ? (
            <form className="mv-stack" onSubmit={sendHandoff}>
              <MemberPicker value={handoffTo} onChange={setHandoffTo} label="Handoff recipient" />
              <Field label="Handoff summary" htmlFor="handoff-summary"><Textarea id="handoff-summary" value={handoffSummary} onChange={(event) => setHandoffSummary(event.target.value)} required minLength={5} /></Field>
              <Button type="submit" disabled={action.busy !== null || !handoffTo || handoffSummary.trim().length < 5}>{action.busy === "handoff" ? "Recording…" : "Record handoff"}</Button>
            </form>
          ) : null}
          {!handoffs.length ? <EmptyState title="No handoffs" description="Shift handoffs are recorded with sender and recipient." /> : (
            <div className="mv-stack" style={{ marginTop: active ? 16 : 0 }}>
              {handoffs.map((row) => (
                <div key={row.id} className="mv-note">
                  <div className="mv-spread"><strong>{row.fromName} → {row.toName}</strong><span className="mv-small mv-muted">{formatDateTime(row.createdAt)}</span></div>
                  <p>{row.summary}</p>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {active ? (
        <Card title="Disposition" description="Closing an admission releases its bed and may complete the encounter. This action is audited.">
          <form className="mv-stack" onSubmit={transition}>
            <div className="mv-form-grid">
              <Field label="Disposition"><Select value={disposition} onChange={(event) => setDisposition(event.target.value)}><option value="discharged">Discharged</option><option value="transferred-out">Transferred out</option><option value="deceased">Deceased</option><option value="cancelled">Cancelled</option></Select></Field>
              <Field label="Reason" htmlFor="disposition-reason"><Input id="disposition-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={2000} /></Field>
            </div>
            <Field label="Discharge summary" htmlFor="disposition-summary"><Textarea id="disposition-summary" value={summary} onChange={(event) => setSummary(event.target.value)} maxLength={20000} /></Field>
            <Button type="submit" variant="danger" disabled={action.busy !== null}>{action.busy === "transition" ? "Closing…" : "Close admission"}</Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
