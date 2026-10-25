import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge, Button, Card, DataList, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";

interface CaseDetail { id: string; patientId: string; encounterId: string; admissionId: string | null; procedureName: string; laterality: string; site: string | null; urgency: string; scheduledAt: string; status: string; version: number; cancellationReason: string | null; emergencyExceptionReason: string | null; publicId: string; givenName: string; familyName: string; dateOfBirth: string; sex: string; theatreName: string | null }
interface Preop { id: string; investigationsReviewed: boolean; fitness: string; notes: string | null; createdAt: string }
interface ConsentRow { id: string; procedureConsent: boolean; siteMarked: boolean; consentReference: string; createdAt: string }
interface ChecklistRow { id: string; stage: string; items: Record<string, boolean>; notes: string | null; createdAt: string }
interface AnesthesiaRow { id: string; anesthesiaType: string; notes: string; startedAt: string; endedAt: string | null }
interface RecoveryRow { id: string; respiratory: string; circulation: string; consciousness: string; pain: string; notes: string | null; occurredAt: string }
interface CountRow { id: string; itemType: string; expectedCount: number; actualCount: number; notes: string | null; createdAt: string }
interface SpecimenRow { id: string; specimenType: string; destination: string; createdAt: string }
interface Detail { case: CaseDetail; preop: Preop[]; consents: ConsentRow[]; checklists: ChecklistRow[]; anesthesia: AnesthesiaRow[]; recovery: RecoveryRow[]; counts: CountRow[]; specimens: SpecimenRow[] }

const NEXT: Record<string, string[]> = {
  scheduled: ["preop-ready", "cancelled"],
  "preop-ready": ["in-theatre", "cancelled"],
  "in-theatre": ["recovery"],
  recovery: ["completed"],
};

const CHECKLIST_ITEMS: Record<string, string[]> = {
  "sign-in": ["identity-confirmed", "site-marked", "allergies-reviewed", "consent-confirmed"],
  "time-out": ["team-introduced", "patient-identity-confirmed", "procedure-site-confirmed", "imaging-reviewed"],
  "sign-out": ["counts-correct", "specimens-labelled", "equipment-checked"],
};

export function TheatreCasePage() {
  const { id = "" } = useParams();
  const detail = useQuery<Detail>(id ? `/theatre-cases/${id}` : null);
  const action = useAction();
  const [investigationsReviewed, setInvestigationsReviewed] = useState(false);
  const [fitness, setFitness] = useState("");
  const [preopNotes, setPreopNotes] = useState("");
  const [procedureConsent, setProcedureConsent] = useState(false);
  const [siteMarked, setSiteMarked] = useState(false);
  const [consentReference, setConsentReference] = useState("");
  const [stage, setStage] = useState("sign-in");
  const [checkedItems, setCheckedItems] = useState<Record<string, boolean>>({});
  const [checklistNotes, setChecklistNotes] = useState("");
  const [anesthesiaType, setAnesthesiaType] = useState("");
  const [anesthesiaNotes, setAnesthesiaNotes] = useState("");
  const [anesthesiaStart, setAnesthesiaStart] = useState(new Date().toISOString().slice(0, 16));
  const [anesthesiaEnd, setAnesthesiaEnd] = useState("");
  const [respiratory, setRespiratory] = useState("");
  const [circulation, setCirculation] = useState("");
  const [consciousness, setConsciousness] = useState("");
  const [pain, setPain] = useState("");
  const [recoveryNotes, setRecoveryNotes] = useState("");
  const [recoveryAt, setRecoveryAt] = useState(new Date().toISOString().slice(0, 16));
  const [itemType, setItemType] = useState("swabs");
  const [expectedCount, setExpectedCount] = useState("");
  const [actualCount, setActualCount] = useState("");
  const [countNotes, setCountNotes] = useState("");
  const [specimenType, setSpecimenType] = useState("");
  const [destination, setDestination] = useState("");

  if (detail.loading) return <LoadingState label="Loading theatre case" />;
  if (detail.error || !detail.data) return <ErrorState message={detail.error ?? "Theatre case not found"} onRetry={detail.reload} />;
  const { case: record, preop, consents, checklists, anesthesia, recovery, counts, specimens } = detail.data;
  const open = ["scheduled", "preop-ready"].includes(record.status);
  const transitions = NEXT[record.status] ?? [];
  const itemKeys = CHECKLIST_ITEMS[stage] ?? [];

  async function run(key: string, fn: () => Promise<unknown>, success: string) {
    await action.run(key, async () => {
      await fn();
      detail.reload();
      return success;
    });
  }

  async function transition(status: string) {
    let emergencyExceptionReason = "";
    let cancellationReason = "";
    if (status === "preop-ready" && !consents.some((row) => row.procedureConsent && row.siteMarked)) {
      emergencyExceptionReason = window.prompt("Procedure consent/site marking is missing. Enter the emergency exception reason (required).") ?? "";
      if (emergencyExceptionReason.trim().length < 10) {
        action.setError("An emergency exception reason of at least 10 characters is required when consent/site marking is missing.");
        return;
      }
    }
    if (status === "cancelled") {
      cancellationReason = window.prompt("Cancellation reason (required)") ?? "";
      if (cancellationReason.trim().length < 5) return;
    }
    await run(status, () => api(`/theatre-cases/${record.id}/transitions`, { method: "POST", body: { status, expectedVersion: record.version, emergencyExceptionReason: emergencyExceptionReason || undefined, cancellationReason: cancellationReason || undefined } }), `Case moved to ${status}.`);
  }

  async function addPreop(event: FormEvent) {
    event.preventDefault();
    await run("preop", () => api(`/theatre-cases/${record.id}/preop`, { method: "POST", body: { investigationsReviewed, fitness, notes: preopNotes } }), "Pre-operative assessment recorded.");
  }

  async function addConsent(event: FormEvent) {
    event.preventDefault();
    await run("consent", () => api(`/theatre-cases/${record.id}/consent`, { method: "POST", body: { procedureConsent, siteMarked, consentReference } }), "Theatre consent recorded.");
  }

  async function addChecklist(event: FormEvent) {
    event.preventDefault();
    const items = Object.fromEntries(itemKeys.map((key) => [key, Boolean(checkedItems[key])]));
    await run("checklist", () => api(`/theatre-cases/${record.id}/checklist`, { method: "POST", body: { stage, items, notes: checklistNotes } }), "Checklist stage recorded.");
  }

  async function addAnesthesia(event: FormEvent) {
    event.preventDefault();
    await run("anesthesia", () => api(`/theatre-cases/${record.id}/anesthesia`, { method: "POST", body: { anesthesiaType, notes: anesthesiaNotes, startedAt: new Date(anesthesiaStart).toISOString(), endedAt: anesthesiaEnd ? new Date(anesthesiaEnd).toISOString() : null } }), "Anesthesia record saved.");
  }

  async function addRecovery(event: FormEvent) {
    event.preventDefault();
    await run("recovery", () => api(`/theatre-cases/${record.id}/recovery`, { method: "POST", body: { respiratory, circulation, consciousness, pain, notes: recoveryNotes, occurredAt: new Date(recoveryAt).toISOString() } }), "Recovery observation recorded.");
  }

  async function addCount(event: FormEvent) {
    event.preventDefault();
    await run("count", () => api(`/theatre-cases/${record.id}/counts`, { method: "POST", body: { itemType, expectedCount: Number(expectedCount), actualCount: Number(actualCount), notes: countNotes } }), "Count recorded.");
  }

  async function addSpecimen(event: FormEvent) {
    event.preventDefault();
    await run("specimen", () => api(`/theatre-cases/${record.id}/specimens`, { method: "POST", body: { specimenType, destination } }), "Specimen recorded.");
  }

  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Theatre" title={record.procedureName} description={`${record.givenName} ${record.familyName} · ${record.publicId}`} actions={<Link className="mv-button mv-button--ghost mv-button--sm" to="/theatre">Back to theatre</Link>} />
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title="Case">
        <DataList items={[
          { label: "Status", value: <Badge tone={record.status === "completed" ? "success" : record.status === "cancelled" ? "neutral" : record.status === "in-theatre" ? "danger" : "info"}>{record.status}</Badge> },
          { label: "Urgency", value: record.urgency },
          { label: "Theatre", value: record.theatreName ?? "Unassigned" },
          { label: "Laterality / site", value: `${record.laterality}${record.site ? ` · ${record.site}` : ""}` },
          { label: "Scheduled", value: formatDateTime(record.scheduledAt) },
          { label: "Encounter", value: <span className="mv-id">{record.encounterId}</span> },
        ]} />
        {record.emergencyExceptionReason ? <Notice tone="warning">Emergency exception: {record.emergencyExceptionReason}</Notice> : null}
        {record.cancellationReason ? <Notice tone="warning">Cancellation reason: {record.cancellationReason}</Notice> : null}
        {transitions.length ? (
          <div className="mv-row" style={{ marginTop: 12 }}>
            {transitions.map((status) => <Button key={status} size="sm" variant={status === "cancelled" ? "ghost" : "secondary"} onClick={() => void transition(status)} disabled={action.busy !== null}>{status === "cancelled" ? "Cancel case" : status === "preop-ready" ? "Mark preop-ready" : `Move to ${status}`}</Button>)}
          </div>
        ) : null}
      </Card>

      <div className="mv-grid mv-grid--2">
        <Card title="Pre-operative assessment">
          {open ? (
            <form className="mv-stack" onSubmit={addPreop}>
              <label className="mv-check"><input type="checkbox" checked={investigationsReviewed} onChange={(event) => setInvestigationsReviewed(event.target.checked)} /> Investigations reviewed</label>
              <Field label="Fitness" htmlFor="preop-fitness"><Textarea id="preop-fitness" value={fitness} onChange={(event) => setFitness(event.target.value)} required minLength={2} /></Field>
              <Field label="Notes" htmlFor="preop-notes"><Textarea id="preop-notes" value={preopNotes} onChange={(event) => setPreopNotes(event.target.value)} /></Field>
              <Button size="sm" type="submit" disabled={action.busy !== null || !investigationsReviewed || fitness.trim().length < 2}>{action.busy === "preop" ? "Saving…" : "Save assessment"}</Button>
            </form>
          ) : null}
          {!preop.length ? <p className="mv-small mv-muted">No pre-operative assessment recorded.</p> : preop.map((row) => <div key={row.id} className="mv-note" style={{ marginTop: 8 }}><div className="mv-spread"><strong>Fitness: {row.fitness}</strong><span className="mv-small mv-muted">{formatDateTime(row.createdAt)}</span></div><div className="mv-small">Investigations reviewed: {row.investigationsReviewed ? "yes" : "no"}</div>{row.notes ? <p>{row.notes}</p> : null}</div>)}
        </Card>
        <Card title="Procedure consent">
          {open ? (
            <form className="mv-stack" onSubmit={addConsent}>
              <label className="mv-check"><input type="checkbox" checked={procedureConsent} onChange={(event) => setProcedureConsent(event.target.checked)} /> Procedure consent documented</label>
              <label className="mv-check"><input type="checkbox" checked={siteMarked} onChange={(event) => setSiteMarked(event.target.checked)} /> Site marked</label>
              <Field label="Consent reference" htmlFor="consent-reference"><Input id="consent-reference" value={consentReference} onChange={(event) => setConsentReference(event.target.value)} required minLength={2} /></Field>
              <Button size="sm" type="submit" disabled={action.busy !== null || !procedureConsent || !siteMarked || consentReference.trim().length < 2}>{action.busy === "consent" ? "Saving…" : "Record consent"}</Button>
            </form>
          ) : null}
          {!consents.length ? <p className="mv-small mv-muted">No theatre consent recorded.</p> : consents.map((row) => <div key={row.id} className="mv-note" style={{ marginTop: 8 }}><div className="mv-spread"><strong>{row.consentReference}</strong><Badge tone={row.procedureConsent && row.siteMarked ? "success" : "danger"}>{row.procedureConsent && row.siteMarked ? "complete" : "incomplete"}</Badge></div><div className="mv-small">{formatDateTime(row.createdAt)}</div></div>)}
        </Card>
      </div>

      <Card title="Safety checklists" description="Every item in a stage must be confirmed. Stages are recorded once and cannot be overwritten.">
        {open || record.status === "in-theatre" ? (
          <form className="mv-stack" onSubmit={addChecklist}>
            <Field label="Stage"><Select value={stage} onChange={(event) => { setStage(event.target.value); setCheckedItems({}); }}><option value="sign-in">Sign in</option><option value="time-out">Time out</option><option value="sign-out">Sign out</option></Select></Field>
            <div className="mv-form-grid">
              {itemKeys.map((key) => <label key={key} className="mv-check"><input type="checkbox" checked={Boolean(checkedItems[key])} onChange={(event) => setCheckedItems((prev) => ({ ...prev, [key]: event.target.checked }))} /> {key.replaceAll("-", " ")}</label>)}
            </div>
            <Field label="Notes" htmlFor="checklist-notes"><Textarea id="checklist-notes" value={checklistNotes} onChange={(event) => setChecklistNotes(event.target.value)} /></Field>
            <Button size="sm" type="submit" disabled={action.busy !== null || itemKeys.some((key) => !checkedItems[key])}>{action.busy === "checklist" ? "Recording…" : "Record checklist stage"}</Button>
          </form>
        ) : null}
        {!checklists.length ? <p className="mv-small mv-muted">No checklists recorded.</p> : (
          <Table head={["Stage", "Items", "Recorded"]} caption="Theatre checklists">
            {checklists.map((row) => <tr key={row.id}><td><strong>{row.stage}</strong></td><td>{Object.entries(row.items).map(([key, value]) => `${key}: ${value ? "yes" : "no"}`).join(" · ")}</td><td className="mv-small">{formatDateTime(row.createdAt)}</td></tr>)}
          </Table>
        )}
      </Card>

      <div className="mv-grid mv-grid--2">
        <Card title="Anesthesia">
          {["preop-ready", "in-theatre"].includes(record.status) ? (
            <form className="mv-stack" onSubmit={addAnesthesia}>
              <Field label="Anesthesia type" htmlFor="anesthesia-type"><Input id="anesthesia-type" value={anesthesiaType} onChange={(event) => setAnesthesiaType(event.target.value)} required minLength={2} /></Field>
              <Field label="Notes" htmlFor="anesthesia-notes"><Textarea id="anesthesia-notes" value={anesthesiaNotes} onChange={(event) => setAnesthesiaNotes(event.target.value)} required minLength={2} /></Field>
              <div className="mv-form-grid">
                <Field label="Started at"><Input type="datetime-local" value={anesthesiaStart} onChange={(event) => setAnesthesiaStart(event.target.value)} required /></Field>
                <Field label="Ended at"><Input type="datetime-local" value={anesthesiaEnd} onChange={(event) => setAnesthesiaEnd(event.target.value)} /></Field>
              </div>
              <Button size="sm" type="submit" disabled={action.busy !== null || anesthesiaType.trim().length < 2 || anesthesiaNotes.trim().length < 2}>{action.busy === "anesthesia" ? "Saving…" : "Save anesthesia record"}</Button>
            </form>
          ) : null}
          {!anesthesia.length ? <p className="mv-small mv-muted">No anesthesia record.</p> : anesthesia.map((row) => <div key={row.id} className="mv-note" style={{ marginTop: 8 }}><strong>{row.anesthesiaType}</strong><div className="mv-small mv-muted">{formatDateTime(row.startedAt)} → {formatDateTime(row.endedAt)}</div><p>{row.notes}</p></div>)}
        </Card>
        <Card title="Recovery">
          {["in-theatre", "recovery"].includes(record.status) ? (
            <form className="mv-stack" onSubmit={addRecovery}>
              <div className="mv-form-grid">
                <Field label="Respiratory" htmlFor="recovery-resp"><Input id="recovery-resp" value={respiratory} onChange={(event) => setRespiratory(event.target.value)} required /></Field>
                <Field label="Circulation" htmlFor="recovery-circ"><Input id="recovery-circ" value={circulation} onChange={(event) => setCirculation(event.target.value)} required /></Field>
                <Field label="Consciousness" htmlFor="recovery-cons"><Input id="recovery-cons" value={consciousness} onChange={(event) => setConsciousness(event.target.value)} required /></Field>
                <Field label="Pain" htmlFor="recovery-pain"><Input id="recovery-pain" value={pain} onChange={(event) => setPain(event.target.value)} required /></Field>
                <Field label="Observed at"><Input type="datetime-local" value={recoveryAt} onChange={(event) => setRecoveryAt(event.target.value)} required /></Field>
              </div>
              <Field label="Notes" htmlFor="recovery-notes"><Textarea id="recovery-notes" value={recoveryNotes} onChange={(event) => setRecoveryNotes(event.target.value)} /></Field>
              <Button size="sm" type="submit" disabled={action.busy !== null || !respiratory || !circulation || !consciousness || !pain}>{action.busy === "recovery" ? "Recording…" : "Record recovery observation"}</Button>
            </form>
          ) : null}
          {!recovery.length ? <p className="mv-small mv-muted">No recovery observations.</p> : recovery.map((row) => <div key={row.id} className="mv-note" style={{ marginTop: 8 }}><div className="mv-spread"><strong>{formatDateTime(row.occurredAt)}</strong></div><div className="mv-small">Resp {row.respiratory} · Circ {row.circulation} · Consciousness {row.consciousness} · Pain {row.pain}</div></div>)}
        </Card>
      </div>

      <div className="mv-grid mv-grid--2">
        <Card title="Counts">
          <form className="mv-stack" onSubmit={addCount}>
            <div className="mv-form-grid">
              <Field label="Item type" htmlFor="count-type"><Input id="count-type" value={itemType} onChange={(event) => setItemType(event.target.value)} required /></Field>
              <Field label="Expected" htmlFor="count-expected"><Input id="count-expected" type="number" min={0} value={expectedCount} onChange={(event) => setExpectedCount(event.target.value)} required /></Field>
              <Field label="Actual" htmlFor="count-actual"><Input id="count-actual" type="number" min={0} value={actualCount} onChange={(event) => setActualCount(event.target.value)} required /></Field>
            </div>
            <Field label="Notes" htmlFor="count-notes"><Input id="count-notes" value={countNotes} onChange={(event) => setCountNotes(event.target.value)} /></Field>
            <Button size="sm" type="submit" disabled={action.busy !== null || !itemType || expectedCount === "" || actualCount === ""}>{action.busy === "count" ? "Recording…" : "Record count"}</Button>
          </form>
          {counts.length ? <Table head={["Item", "Expected", "Actual", "Match"]} caption="Theatre counts">{counts.map((row) => <tr key={row.id}><td>{row.itemType}</td><td>{row.expectedCount}</td><td>{row.actualCount}</td><td><Badge tone={row.expectedCount === row.actualCount ? "success" : "danger"}>{row.expectedCount === row.actualCount ? "match" : "discrepancy"}</Badge></td></tr>)}</Table> : null}
        </Card>
        <Card title="Specimens">
          <form className="mv-stack" onSubmit={addSpecimen}>
            <div className="mv-form-grid">
              <Field label="Specimen type" htmlFor="specimen-type"><Input id="specimen-type" value={specimenType} onChange={(event) => setSpecimenType(event.target.value)} required /></Field>
              <Field label="Destination" htmlFor="specimen-destination"><Input id="specimen-destination" value={destination} onChange={(event) => setDestination(event.target.value)} required /></Field>
            </div>
            <Button size="sm" type="submit" disabled={action.busy !== null || !specimenType || !destination}>{action.busy === "specimen" ? "Recording…" : "Record specimen"}</Button>
          </form>
          {!specimens.length ? <EmptyState title="No specimens" description="Record specimens sent for pathology." /> : <Table head={["Specimen", "Destination", "Recorded"]} caption="Theatre specimens">{specimens.map((row) => <tr key={row.id}><td>{row.specimenType}</td><td>{row.destination}</td><td className="mv-small">{formatDateTime(row.createdAt)}</td></tr>)}</Table>}
        </Card>
      </div>
    </div>
  );
}
