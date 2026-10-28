import { Badge, Card, DataList, EmptyState, ErrorState, LoadingState, PageHeader, Tabs } from "@medveris/ui";
import { useState } from "react";
import { useQuery } from "../lib/useQuery";
import type { AuditEventRow, PatientPortalProfile, PatientRecords } from "../lib/types";

type View = "released" | "observations" | "conditions" | "allergies" | "appointments";

export function PatientPortalPage() {
  const profile = useQuery<PatientPortalProfile>("/me/patient");
  const records = useQuery<PatientRecords>("/me/records");
  const appointments = useQuery<{ appointments: Array<{ id: string; startAt: string; durationMinutes: number; reason: string; status: string; facilityName: string }> }>("/me/appointments");
  const [view, setView] = useState<View>("released");

  if (profile.loading) return <LoadingState label="Loading your record" variant="page" />;
  if (profile.error) return <ErrorState message={profile.error} onRetry={profile.reload} />;
  if (!profile.data) return <EmptyState title="Patient profile unavailable" description="No verified patient identity is linked to this account." />;
  const patient = profile.data.patient;

  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Patient portal" title={`${patient.givenName} ${patient.familyName}`} description="This view contains only records released by their source facility. Source and author remain visible." />
      <div className="mv-patient-banner">
        <div><strong className="mv-id">{patient.publicId}</strong><div className="mv-patient-banner__meta"><span>DOB {patient.dateOfBirth}</span><span>{patient.sex}</span><span>Identity confidence: {patient.identityConfidence}</span></div></div>
        <Badge tone="info">Identity locator — not a password</Badge>
      </div>
      <div className="mv-grid mv-grid--2">
        <Card title="Facilities holding your record">
          {profile.data.facilityLinks.length ? <DataList items={profile.data.facilityLinks.map((link) => ({ label: link.tenantName, value: <Badge tone={link.releaseSignedRecords ? "success" : "warning"}>{link.releaseSignedRecords ? "releases signed records" : "records not released"}</Badge> }))} /> : <EmptyState title="No linked facility" description="A facility links your identity when it registers or resolves you." />}
        </Card>
        <Card title="Account">
          <DataList items={[{ label: "Email", value: patient.email ?? "Not provided" }, { label: "Phone", value: patient.phone ?? "Not provided" }, { label: "Registered", value: new Date(patient.createdAt).toLocaleDateString() }]} />
        </Card>
      </div>

      <Tabs label="Record sections" value={view} onChange={setView} options={[
        { value: "released", label: `Released notes (${records.data?.notes.length ?? 0})` },
        { value: "observations", label: "Observations" },
        { value: "conditions", label: "Conditions" },
        { value: "allergies", label: "Allergies" },
        { value: "appointments", label: "Appointments" },
      ]} />

      {records.error ? <ErrorState message={records.error} onRetry={records.reload} /> : null}
      {records.loading ? <LoadingState /> : null}
      {view === "released" ? (
        <Card title="Released clinical notes" description="Amendments preserve prior signed versions. Entered-in-error items remain visible as corrected.">
          {!records.data?.notes.length ? <EmptyState title="No released notes" description="A facility must release your signed records before they appear here." /> : records.data.notes.map((note) => (
            <article key={note.id} className={`mv-note mv-note--${note.status}`} style={{ marginBottom: 12 }}>
              <div className="mv-spread"><strong>{note.title}</strong><Badge tone={note.status === "amended" ? "info" : note.status === "entered-in-error" ? "danger" : "success"}>{note.status}</Badge></div>
              <div className="mv-small mv-muted">{note.sourceFacility} · {note.authorName} · {new Date(note.occurredAt).toLocaleString()} · version {note.version}</div>
              <div style={{ marginTop: 8 }}>
                {(["subjective", "objective", "assessment", "plan"] as const).map((key) => note.content[key] ? <p key={key} className="mv-pre" style={{ marginBottom: 5 }}><strong>{key}:</strong> {note.content[key]}</p> : null)}
              </div>
            </article>
          ))}
        </Card>
      ) : null}
      {view === "observations" ? (
        <Card title="Observations">{!records.data?.observations.length ? <EmptyState title="No released observations" description="There are no released measurements." /> : <ul className="mv-stack" style={{ listStyle: "none", padding: 0 }}>{records.data.observations.map((obs) => <li key={obs.id} className="mv-spread"><span>{obs.display} <span className="mv-small mv-muted">({obs.sourceFacility})</span></span><strong>{obs.valueNum} {obs.unitCode}</strong><span className="mv-small mv-muted">{new Date(obs.occurredAt).toLocaleString()}</span></li>)}</ul>}</Card>
      ) : null}
      {view === "conditions" ? (
        <Card title="Conditions">{!records.data?.conditions.length ? <EmptyState title="No released conditions" description="There are no released diagnoses." /> : <ul>{records.data.conditions.map((condition) => <li key={condition.id}>{condition.display} — {condition.clinicalStatus} · {condition.sourceFacility}</li>)}</ul>}</Card>
      ) : null}
      {view === "allergies" ? (
        <Card title="Allergies">{!records.data?.allergies.length ? <EmptyState title="No released allergy state" description="Ask the treating facility to record allergy status." /> : <ul>{records.data.allergies.map((allergy) => <li key={allergy.id}>{allergy.state === "recorded" ? `${allergy.substanceCoding?.display ?? "Recorded substance"} (${allergy.severity})` : allergy.state} · {allergy.sourceFacility}</li>)}</ul>}</Card>
      ) : null}
      {view === "appointments" ? (
        <Card title="Appointments">{!appointments.data?.appointments.length ? <EmptyState title="No appointments" description="No scheduled appointments are visible." /> : <ul>{appointments.data.appointments.map((appointment) => <li key={appointment.id}>{new Date(appointment.startAt).toLocaleString()} · {appointment.facilityName} · {appointment.reason} <Badge tone="neutral">{appointment.status}</Badge></li>)}</ul>}</Card>
      ) : null}
      <AuditPreview />
    </div>
  );
}

function AuditPreview() {
  const history = useQuery<{ events: AuditEventRow[] }>("/me/access-history");
  return (
    <Card title="Recent access history" description="Patient-readable summary. Security investigation detail is restricted.">
      {history.loading ? <LoadingState /> : history.error ? <ErrorState message={history.error} onRetry={history.reload} /> : !history.data?.events.length ? <EmptyState title="No access history" description="No recorded access yet." /> : <ul className="mv-small">{history.data.events.slice(0, 6).map((event) => <li key={event.id}>{event.summary} · {new Date(event.occurredAt).toLocaleString()} {event.decision === "deny" ? <Badge tone="danger">denied</Badge> : null}</li>)}</ul>}
    </Card>
  );
}
