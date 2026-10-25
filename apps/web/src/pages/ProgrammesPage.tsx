import { useState, type FormEvent } from "react";
import { Badge, Button, Card, DataList, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Tabs, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { formatDate, formatDateTime, todayInput } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";
import { PatientPicker } from "../components/Pickers";

interface Programme { id: string; name: string; programmeType: string; description: string | null; active: boolean; activeEnrolments: number }
interface Enrolment { id: string; patientId: string; programmeId: string; status: string; notes: string | null; createdAt: string; publicId: string; givenName: string; familyName: string; latestCarePlanVersion: number | null }
interface PatientProgramme { enrolments: Array<Enrolment & { programmeName: string; programmeType: string }>; events: Array<{ id: string; enrolmentId: string; eventType: string; details: string; occurredAt: string }>; carePlans: Array<{ id: string; enrolmentId: string; version: number; goals: Array<{ description: string; targetDate: string | null }>; interventions: string; reviewDue: string | null; createdAt: string }>; advanceCare: Array<{ id: string; documentType: string; content: string; witnessedBy: string | null; createdAt: string }> }

const PROGRAMME_TYPES = ["primary-care", "preventive", "immunization", "chronic", "maternal", "hospice", "palliative", "community"];
const EVENT_TYPES = ["immunization", "screening", "community-referral", "home-visit", "symptom", "review"];

export function ProgrammesPage() {
  const [tab, setTab] = useState<"programmes" | "patient">("programmes");
  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Programmes" title="Care programmes" description="Enrolments, versioned care plans and programme events are audited. Condition coding is optional." />
      <Tabs label="Programme sections" value={tab} onChange={setTab} options={[{ value: "programmes", label: "Programmes" }, { value: "patient", label: "Patient record" }]} />
      {tab === "programmes" ? <Programmes /> : <PatientProgrammes />}
    </div>
  );
}

function Programmes() {
  const programmes = useQuery<{ programmes: Programme[] }>("/programmes");
  const action = useAction();
  const [selected, setSelected] = useState<string>("");
  const [name, setName] = useState("");
  const [type, setType] = useState("primary-care");
  const [description, setDescription] = useState("");
  const [enrolPatient, setEnrolPatient] = useState("");
  const [enrolNotes, setEnrolNotes] = useState("");
  const activeProgramme = programmes.data?.programmes.find((row) => row.id === selected) ?? programmes.data?.programmes[0];

  async function create(event: FormEvent) {
    event.preventDefault();
    await action.run("create", async () => {
      await api("/programmes", { method: "POST", body: { name, programmeType: type, description } });
      setName("");
      setDescription("");
      programmes.reload();
      return "Programme created.";
    });
  }

  async function enrol(event: FormEvent) {
    event.preventDefault();
    if (!activeProgramme) return;
    await action.run("enrol", async () => {
      await api(`/programmes/${activeProgramme.id}/enrolments`, { method: "POST", body: { patientId: enrolPatient, notes: enrolNotes } });
      setEnrolPatient("");
      setEnrolNotes("");
      programmes.reload();
      return "Patient enrolled.";
    });
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <div className="mv-grid mv-grid--2">
        <Card title="Programmes">
          {programmes.loading ? <LoadingState /> : programmes.error ? <ErrorState message={programmes.error} onRetry={programmes.reload} /> : !programmes.data?.programmes.length ? <EmptyState title="No programmes" description="Create the first care programme." /> : (
            <Table head={["Programme", "Type", "Active enrolments", ""]} caption="Care programmes">
              {programmes.data.programmes.map((programme) => (
                <tr key={programme.id}>
                  <td><strong>{programme.name}</strong><div className="mv-small mv-muted">{programme.description}</div></td>
                  <td>{programme.programmeType}</td>
                  <td>{programme.activeEnrolments}</td>
                  <td><Button size="sm" variant={activeProgramme?.id === programme.id ? "primary" : "secondary"} onClick={() => setSelected(programme.id)}>Select</Button></td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title="Create a programme">
          <form className="mv-stack" onSubmit={create}>
            <Field label="Name" htmlFor="programme-name"><Input id="programme-name" value={name} onChange={(event) => setName(event.target.value)} required minLength={2} /></Field>
            <Field label="Type"><Select value={type} onChange={(event) => setType(event.target.value)}>{PROGRAMME_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}</Select></Field>
            <Field label="Description" htmlFor="programme-description"><Textarea id="programme-description" value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
            <Button type="submit" disabled={action.busy !== null || name.trim().length < 2}>{action.busy === "create" ? "Creating…" : "Create programme"}</Button>
          </form>
        </Card>
      </div>
      {activeProgramme ? (
        <>
          <Card title={`Enrol a patient — ${activeProgramme.name}`}>
            <form className="mv-stack" onSubmit={enrol}>
              <PatientPicker value={enrolPatient} onChange={setEnrolPatient} />
              <Field label="Enrolment notes" htmlFor="enrol-notes"><Textarea id="enrol-notes" value={enrolNotes} onChange={(event) => setEnrolNotes(event.target.value)} maxLength={2000} /></Field>
              <Button type="submit" disabled={action.busy !== null || !enrolPatient}>{action.busy === "enrol" ? "Enrolling…" : "Enrol patient"}</Button>
            </form>
          </Card>
          <Enrolments programmeId={activeProgramme.id} />
        </>
      ) : null}
    </div>
  );
}

function Enrolments({ programmeId }: { programmeId: string }) {
  const enrolments = useQuery<{ enrolments: Enrolment[] }>(`/programmes/${programmeId}/enrolments`);
  if (enrolments.loading) return <LoadingState />;
  if (enrolments.error) return <ErrorState message={enrolments.error} onRetry={enrolments.reload} />;
  return (
    <Card title="Enrolments" description="Open the patient record below to create a care plan or record events.">
      {!enrolments.data?.enrolments.length ? <EmptyState title="No enrolments" description="Enrol a patient in this programme." /> : (
        <Table head={["Patient", "Status", "Care plan", "Enrolled", "Notes"]} caption="Programme enrolments">
          {enrolments.data.enrolments.map((enrolment) => (
            <tr key={enrolment.id}>
              <td><strong>{enrolment.givenName} {enrolment.familyName}</strong><div className="mv-small mv-muted mv-id">{enrolment.publicId}</div></td>
              <td><Badge tone={enrolment.status === "active" ? "success" : "neutral"}>{enrolment.status}</Badge></td>
              <td>{enrolment.latestCarePlanVersion ? `v${enrolment.latestCarePlanVersion}` : "—"}</td>
              <td className="mv-small">{formatDateTime(enrolment.createdAt)}</td>
              <td className="mv-small">{enrolment.notes}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

function PatientProgrammes() {
  const [patientId, setPatientId] = useState("");
  const data = useQuery<PatientProgramme>(patientId ? `/patients/${patientId}/programmes` : null);
  return (
    <div className="mv-stack">
      <Card title="Patient programme record"><PatientPicker value={patientId} onChange={setPatientId} required={false} /></Card>
      {!patientId ? <EmptyState title="No patient selected" description="Choose a patient to review enrolments, care plans, events and advance-care documents." /> : data.loading ? <LoadingState /> : data.error ? <ErrorState message={data.error} onRetry={data.reload} /> : (
        <div className="mv-stack">
          <Card title="Enrolments and care plans">
            {!data.data?.enrolments.length ? <EmptyState title="No enrolments" description="This patient is not enrolled in a programme." /> : (
              <div className="mv-stack">
                {data.data.enrolments.map((enrolment) => {
                  const plan = data.data?.carePlans.find((row) => row.enrolmentId === enrolment.id);
                  return (
                    <div key={enrolment.id} className="mv-note">
                      <div className="mv-spread"><strong>{enrolment.programmeName}</strong><Badge tone={enrolment.status === "active" ? "success" : "neutral"}>{enrolment.status}</Badge></div>
                      <div className="mv-small mv-muted">{enrolment.programmeType} · enrolled {formatDateTime(enrolment.createdAt)}</div>
                      {plan ? (
                        <div style={{ marginTop: 8 }}>
                          <DataList items={[
                            { label: "Care plan version", value: `v${plan.version}` },
                            { label: "Review due", value: formatDate(plan.reviewDue) },
                            { label: "Goals", value: plan.goals.length ? plan.goals.map((goal) => `${goal.description}${goal.targetDate ? ` (by ${formatDate(goal.targetDate)})` : ""}`).join("; ") : "None" },
                            { label: "Interventions", value: plan.interventions },
                          ]} />
                          <CarePlanEditor plan={plan} onDone={data.reload} />
                        </div>
                      ) : enrolment.status === "active" ? <CarePlanCreator enrolmentId={enrolment.id} onDone={data.reload} /> : null}
                      {enrolment.status === "active" ? <EventForm enrolmentId={enrolment.id} onDone={data.reload} /> : null}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
          <div className="mv-grid mv-grid--2">
            <Card title="Programme events">
              {!data.data?.events.length ? <EmptyState title="No events" description="Record immunization, screening, home-visit or review events." /> : (
                <div className="mv-stack">
                  {data.data.events.map((event) => (
                    <div key={event.id} className="mv-note"><div className="mv-spread"><strong>{event.eventType}</strong><span className="mv-small mv-muted">{formatDateTime(event.occurredAt)}</span></div><p>{event.details}</p></div>
                  ))}
                </div>
              )}
            </Card>
            <Card title="Advance care documents">
              {!data.data?.advanceCare.length ? <EmptyState title="No documents" description="Record a documented advance-care preference." /> : (
                <div className="mv-stack">
                  {data.data.advanceCare.map((document) => (
                    <div key={document.id} className="mv-note"><div className="mv-spread"><strong>{document.documentType}</strong><span className="mv-small mv-muted">{formatDateTime(document.createdAt)}</span></div><p>{document.content}</p>{document.witnessedBy ? <div className="mv-small mv-muted">Witness: {document.witnessedBy}</div> : null}</div>
                  ))}
                </div>
              )}
              <AdvanceCareForm patientId={patientId} onDone={data.reload} />
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function CarePlanCreator({ enrolmentId, onDone }: { enrolmentId: string; onDone: () => void }) {
  const [goal, setGoal] = useState("");
  const [interventions, setInterventions] = useState("");
  const [reviewDue, setReviewDue] = useState("");
  const [changeNote, setChangeNote] = useState("");
  const action = useAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run("plan", async () => {
      await api(`/enrolments/${enrolmentId}/care-plans`, { method: "POST", body: { goals: [{ description: goal, targetDate: null }], interventions, reviewDue: reviewDue || null, changeNote } });
      onDone();
      return "Care plan created.";
    });
  }
  return (
    <details style={{ marginTop: 8 }}>
      <summary>Create care plan</summary>
      <form className="mv-stack" onSubmit={submit}>
        {action.error ? <ErrorState message={action.error} /> : null}
        <Field label="Goal"><Input value={goal} onChange={(event) => setGoal(event.target.value)} required minLength={2} /></Field>
        <Field label="Interventions"><Textarea value={interventions} onChange={(event) => setInterventions(event.target.value)} required minLength={2} /></Field>
        <Field label="Review due"><Input type="date" min={todayInput()} value={reviewDue} onChange={(event) => setReviewDue(event.target.value)} /></Field>
        <Field label="Change note"><Input value={changeNote} onChange={(event) => setChangeNote(event.target.value)} required minLength={5} /></Field>
        <Button size="sm" type="submit" disabled={action.busy !== null || !goal || !interventions || changeNote.length < 5}>Create plan</Button>
      </form>
    </details>
  );
}

function CarePlanEditor({ plan, onDone }: { plan: { id: string; version: number; goals: Array<{ description: string; targetDate: string | null }>; interventions: string; reviewDue: string | null }; onDone: () => void }) {
  const [goal, setGoal] = useState(plan.goals[0]?.description ?? "");
  const [interventions, setInterventions] = useState(plan.interventions);
  const [reviewDue, setReviewDue] = useState(plan.reviewDue?.slice(0, 10) ?? "");
  const [changeNote, setChangeNote] = useState("");
  const action = useAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run("update", async () => {
      await api(`/care-plans/${plan.id}`, { method: "PUT", body: { goals: [{ description: goal, targetDate: null }], interventions, reviewDue: reviewDue || null, changeNote, expectedVersion: plan.version } });
      onDone();
      return "Care plan updated.";
    });
  }
  return (
    <details style={{ marginTop: 8 }}>
      <summary>Update care plan</summary>
      <form className="mv-stack" onSubmit={submit}>
        {action.error ? <ErrorState message={action.error} /> : null}
        <Field label="Goal"><Input value={goal} onChange={(event) => setGoal(event.target.value)} required /></Field>
        <Field label="Interventions"><Textarea value={interventions} onChange={(event) => setInterventions(event.target.value)} required /></Field>
        <Field label="Review due"><Input type="date" value={reviewDue} onChange={(event) => setReviewDue(event.target.value)} /></Field>
        <Field label="Change note (required)"><Input value={changeNote} onChange={(event) => setChangeNote(event.target.value)} required minLength={5} /></Field>
        <Button size="sm" variant="secondary" type="submit" disabled={action.busy !== null || changeNote.trim().length < 5}>{action.busy === "update" ? "Updating…" : "Save new version"}</Button>
      </form>
    </details>
  );
}

function EventForm({ enrolmentId, onDone }: { enrolmentId: string; onDone: () => void }) {
  const [eventType, setEventType] = useState("review");
  const [details, setDetails] = useState("");
  const [occurredAt, setOccurredAt] = useState(new Date().toISOString().slice(0, 16));
  const action = useAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run("event", async () => {
      await api(`/enrolments/${enrolmentId}/events`, { method: "POST", body: { eventType, details, occurredAt: new Date(occurredAt).toISOString() } });
      setDetails("");
      onDone();
      return "Programme event recorded.";
    });
  }
  return (
    <details style={{ marginTop: 8 }}>
      <summary>Record programme event</summary>
      <form className="mv-stack" onSubmit={submit}>
        {action.error ? <ErrorState message={action.error} /> : null}
        <div className="mv-form-grid">
          <Field label="Event type"><Select value={eventType} onChange={(event) => setEventType(event.target.value)}>{EVENT_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}</Select></Field>
          <Field label="Occurred at"><Input type="datetime-local" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} required /></Field>
        </div>
        <Field label="Details"><Textarea value={details} onChange={(event) => setDetails(event.target.value)} required minLength={2} /></Field>
        <Button size="sm" type="submit" disabled={action.busy !== null || details.trim().length < 2}>{action.busy === "event" ? "Recording…" : "Record event"}</Button>
      </form>
    </details>
  );
}

function AdvanceCareForm({ patientId, onDone }: { patientId: string; onDone: () => void }) {
  const [documentType, setDocumentType] = useState("advance-directive");
  const [content, setContent] = useState("");
  const [witnessedBy, setWitnessedBy] = useState("");
  const action = useAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run("advance", async () => {
      await api(`/patients/${patientId}/advance-care`, { method: "POST", body: { documentType, content, witnessedBy } });
      setContent("");
      setWitnessedBy("");
      onDone();
      return "Advance-care document recorded.";
    });
  }
  return (
    <details style={{ marginTop: 8 }}>
      <summary>Record advance-care document</summary>
      <form className="mv-stack" onSubmit={submit}>
        {action.error ? <ErrorState message={action.error} /> : null}
        <Field label="Document type"><Select value={documentType} onChange={(event) => setDocumentType(event.target.value)}><option value="advance-directive">Advance directive</option><option value="treatment-preference">Treatment preference</option><option value="resuscitation-preference">Resuscitation preference</option><option value="other">Other</option></Select></Field>
        <Field label="Content"><Textarea value={content} onChange={(event) => setContent(event.target.value)} required minLength={5} /></Field>
        <Field label="Witness name"><Input value={witnessedBy} onChange={(event) => setWitnessedBy(event.target.value)} /></Field>
        <Button size="sm" type="submit" disabled={action.busy !== null || content.trim().length < 5}>{action.busy === "advance" ? "Recording…" : "Record document"}</Button>
      </form>
    </details>
  );
}
