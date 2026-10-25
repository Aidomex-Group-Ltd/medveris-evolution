import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";
import { CodingPicker } from "../components/CodingPicker";
import { MemberPicker } from "../components/Pickers";
import { TriagePanel } from "../components/TriagePanel";
import type { Coding } from "../lib/types";

interface CaseRecord {
  id: string;
  encounterId: string;
  patientId: string;
  arrivalMode: string;
  location: string | null;
  status: string;
  disposition: string | null;
  dispositionNote: string | null;
  closedAt: string | null;
  createdAt: string;
  state: string;
  encounterVersion: number;
  reason: string;
  publicId: string;
  givenName: string;
  familyName: string;
  dateOfBirth: string;
  sex: string;
  identityConfidence: string;
  createdVia: string;
}

interface Detail {
  case: CaseRecord;
  triage: Array<{ id: string; complaint: string; urgency: string; notes: string | null; createdAt: string }>;
  observations: Array<{ id: string; display: string; loincCode: string; valueNum: number; valueText: string | null; unitCode: string; occurredAt: string; status: string }>;
  allergies: Array<{ id: string; state: string; severity: string; note: string | null; recordedAt: string }>;
  conditions: Array<{ id: string; display: string; clinicalStatus: string; recordedAt: string }>;
  entries: Array<{ id: string; status: string; title: string; authorName: string; occurredAt: string; signedAt: string | null }>;
  handoffs: Array<{ id: string; summary: string; fromName: string; toName: string; createdAt: string }>;
}

const DISPOSITIONS = ["admitted", "discharged", "transferred", "deceased", "left-without-seen", "cancelled"];
const UNITS = [
  { code: "mm[Hg]", display: "mm[Hg]" },
  { code: "/min", display: "per minute" },
  { code: "Cel", display: "°C" },
  { code: "%", display: "percent" },
  { code: "kg", display: "kg" },
  { code: "cm", display: "cm" },
  { code: "mg/dL", display: "mg/dL" },
];

export function EmergencyCasePage() {
  const { id = "" } = useParams();
  const detail = useQuery<Detail>(`/emergency/cases/${id}`);
  if (detail.loading) return <LoadingState label="Loading emergency case" />;
  if (detail.error) return <ErrorState message={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return <EmptyState title="Emergency case not found" description="The case may belong to another facility." />;
  const record = detail.data.case;
  const active = record.status === "active";
  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow="Emergency case"
        title={`${record.givenName} ${record.familyName}`}
        description="Identity, triage, serial observations, signed notes, handoff and disposition remain on one audited timeline."
        actions={<Link className="mv-button mv-button--secondary mv-button--sm" to={`/encounters/${record.encounterId}`}>Open clinical chart</Link>}
      />
      <div className="mv-patient-banner">
        <div>
          <strong>{record.givenName} {record.familyName}</strong>
          <div className="mv-patient-banner__meta">
            <span className="mv-id">{record.publicId}</span>
            <span>DOB {record.dateOfBirth}</span>
            <span>{record.sex}</span>
            <span>{record.identityConfidence.replaceAll("-", " ")}</span>
          </div>
        </div>
        <div className="mv-row">
          <Badge tone={active ? "warning" : "neutral"}>{active ? record.state : record.disposition}</Badge>
          <Badge tone="neutral">{record.arrivalMode}</Badge>
          {record.location ? <Badge tone="info">{record.location}</Badge> : null}
        </div>
      </div>
      {record.identityConfidence === "temporary" ? <Notice tone="warning">Temporary identity. Reconcile the patient against confirmed documents before linking longitudinal records.</Notice> : null}
      {!active ? <Notice tone="info">Case closed: {record.disposition?.replaceAll("-", " ")}. {record.dispositionNote}</Notice> : null}

      <div className="mv-grid mv-grid--2">
        <Card title="Presenting problem">
          <p>{record.reason}</p>
          <p className="mv-small mv-muted">Registered {formatDateTime(record.createdAt)}</p>
        </Card>
        <Card title="Triage">
          {!detail.data.triage.length ? <EmptyState title="Not triaged" description="Record triage before clinical note documentation." /> : (
            <div className="mv-stack" style={{ gap: 8 }}>
              {detail.data.triage.map((row) => (
                <div key={row.id} className="mv-note">
                  <div className="mv-spread"><strong>{row.complaint}</strong><Badge tone={row.urgency === "emergency" ? "danger" : row.urgency === "urgent" ? "warning" : "neutral"}>{row.urgency}</Badge></div>
                  {row.notes ? <div className="mv-small mv-muted">{row.notes}</div> : null}
                  <div className="mv-small mv-muted">{formatDateTime(row.createdAt)}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {active && !detail.data.triage.length ? <TriagePanel encounterId={record.encounterId} onSaved={detail.reload} /> : null}
      {active ? <ObservationForm caseId={record.id} onSaved={detail.reload} /> : null}

      <Card title="Serial observations" description="Measured time, validated LOINC identity and UCUM units are shown. No physiological alert threshold is applied.">
        {!detail.data.observations.length ? <EmptyState title="No observations" description="Record triage observations or add a repeat measurement above." /> : (
          <Table head={["Observation", "Value", "Measured", "Status"]} caption="Emergency observations">
            {detail.data.observations.map((row) => (
              <tr key={row.id}>
                <td>{row.display}<div className="mv-small mv-muted mv-id">{row.loincCode}</div></td>
                <td>{row.valueText ?? row.valueNum} {row.unitCode}</td>
                <td className="mv-small">{formatDateTime(row.occurredAt)}</td>
                <td><Badge tone={row.status === "final" ? "success" : "warning"}>{row.status}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <div className="mv-grid mv-grid--2">
        <Card title="Allergies">
          {!detail.data.allergies.length ? <p className="mv-small mv-muted">Allergy state not recorded.</p> : <ul className="mv-small">{detail.data.allergies.map((row) => <li key={row.id}>{row.state}{row.severity ? ` · ${row.severity}` : ""}{row.note ? ` · ${row.note}` : ""}</li>)}</ul>}
        </Card>
        <Card title="Problems">
          {!detail.data.conditions.length ? <p className="mv-small mv-muted">No conditions recorded.</p> : <ul className="mv-small">{detail.data.conditions.map((row) => <li key={row.id}>{row.display} · {row.clinicalStatus}</li>)}</ul>}
        </Card>
      </div>

      <Card title="Clinical notes" description="Only signed and amended versions are shown here. Drafts remain in the clinical chart.">
        {!detail.data.entries.length ? <EmptyState title="No notes" description="Document clinical care from the chart." /> : (
          <ul className="mv-stack" style={{ gap: 8 }}>
            {detail.data.entries.map((entry) => (
              <li key={entry.id} className={`mv-note mv-note--${entry.status}`}>
                <div className="mv-spread"><strong>{entry.title}</strong><Badge tone={entry.status === "signed" ? "success" : "info"}>{entry.status}</Badge></div>
                <div className="mv-small mv-muted">{entry.authorName} · {formatDateTime(entry.occurredAt)}{entry.signedAt ? ` · signed ${formatDateTime(entry.signedAt)}` : ""}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {active ? <HandoffForm caseId={record.id} onSaved={detail.reload} /> : null}
      <Card title="Team handoffs">
        {!detail.data.handoffs.length ? <EmptyState title="No handoffs" description="No shift handoff has been recorded for this case." /> : (
          <ul className="mv-stack" style={{ gap: 8 }}>
            {detail.data.handoffs.map((handoff) => (
              <li key={handoff.id} className="mv-note">
                <div className="mv-small mv-muted">{handoff.fromName} → {handoff.toName} · {formatDateTime(handoff.createdAt)}</div>
                <p>{handoff.summary}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {active ? <DispositionForm record={record} onSaved={detail.reload} /> : null}
    </div>
  );
}

function ObservationForm({ caseId, onSaved }: { caseId: string; onSaved: () => void }) {
  const action = useAction();
  const [coding, setCoding] = useState<Coding | null>(null);
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("mm[Hg]");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!coding) return;
    const ok = await action.run("observation", async () => {
      await api(`/emergency/cases/${caseId}/observations`, {
        method: "POST",
        body: { coding, value: Number(value), unit: { code: unit, system: "http://unitsofmeasure.org" }, occurredAt: new Date().toISOString() },
      });
      setCoding(null);
      setValue("");
      onSaved();
      return "Serial observation recorded.";
    });
    if (!ok) return;
  }

  return (
    <Card title="Add serial observation" description="Uses the configured, reviewed LOINC and UCUM value sets.">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <form className="mv-stack" onSubmit={submit}>
        <CodingPicker field="observation" label="Observation type (LOINC)" value={coding} onChange={setCoding} />
        <div className="mv-form-grid">
          <Field label="Value" htmlFor="emergency-obs-value"><Input id="emergency-obs-value" type="number" step="any" value={value} onChange={(event) => setValue(event.target.value)} required disabled={!coding} /></Field>
          <Field label="UCUM unit"><Select value={unit} onChange={(event) => setUnit(event.target.value)} disabled={!coding}>{UNITS.map((item) => <option key={item.code} value={item.code}>{item.display} ({item.code})</option>)}</Select></Field>
        </div>
        <Button type="submit" disabled={action.busy !== null || !coding || value === ""}>{action.busy === "observation" ? "Recording…" : "Record observation"}</Button>
      </form>
    </Card>
  );
}

function HandoffForm({ caseId, onSaved }: { caseId: string; onSaved: () => void }) {
  const action = useAction();
  const [toUserId, setToUserId] = useState("");
  const [summary, setSummary] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    const ok = await action.run("handoff", async () => {
      await api(`/emergency/cases/${caseId}/handoffs`, { method: "POST", body: { toUserId, summary } });
      setSummary("");
      onSaved();
      return "Handoff recorded.";
    });
    if (ok) setToUserId("");
  }
  return (
    <Card title="Record team handoff" description="Delivery alone is not acknowledgement; the receiving clinical member is recorded.">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <form className="mv-stack" onSubmit={submit}>
        <MemberPicker value={toUserId} onChange={setToUserId} label="Receiving clinician" />
        <Field label="Handoff summary" htmlFor="handoff-summary"><Textarea id="handoff-summary" value={summary} onChange={(event) => setSummary(event.target.value)} required minLength={5} maxLength={10000} /></Field>
        <Button type="submit" disabled={action.busy !== null || !toUserId || summary.trim().length < 5}>{action.busy === "handoff" ? "Recording…" : "Record handoff"}</Button>
      </form>
    </Card>
  );
}

function DispositionForm({ record, onSaved }: { record: CaseRecord; onSaved: () => void }) {
  const action = useAction();
  const [disposition, setDisposition] = useState("discharged");
  const [note, setNote] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    const ok = await action.run("disposition", async () => {
      await api(`/emergency/cases/${record.id}/disposition`, {
        method: "POST",
        body: { disposition, note, expectedVersion: record.encounterVersion },
      });
      onSaved();
      return "Disposition recorded and case closed.";
    });
    if (ok) setNote("");
  }
  return (
    <Card title="Disposition" description="Closes the emergency case. An admitted disposition requires an existing inpatient admission.">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <form className="mv-stack" onSubmit={submit}>
        <div className="mv-form-grid">
          <Field label="Disposition"><Select value={disposition} onChange={(event) => setDisposition(event.target.value)}>{DISPOSITIONS.map((value) => <option key={value} value={value}>{value.replaceAll("-", " ")}</option>)}</Select></Field>
          <Field label="Current encounter state"><Input value={record.state} readOnly /></Field>
        </div>
        <Field label="Disposition note" htmlFor="disposition-note" hint="Record the reason, destination or follow-up instruction. Minimum five characters."><Textarea id="disposition-note" value={note} onChange={(event) => setNote(event.target.value)} required minLength={5} maxLength={4000} /></Field>
        {disposition === "admitted" ? <Notice tone="info">Create the admission from Wards and beds first. This action only records the emergency disposition.</Notice> : null}
        <Button type="submit" disabled={action.busy !== null || note.trim().length < 5}>{action.busy === "disposition" ? "Recording…" : "Record disposition"}</Button>
      </form>
    </Card>
  );
}
