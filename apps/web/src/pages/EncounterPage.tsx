import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Badge, Button, Card, DataList, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Tabs, Textarea } from "@medveris/ui";
import { api, errorMessage } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useQuery } from "../lib/useQuery";
import type { Coding, EncounterDetail } from "../lib/types";
import { ClinicalNotePanel } from "../components/ClinicalNotePanel";
import { CodingPicker } from "../components/CodingPicker";
import { TriagePanel } from "../components/TriagePanel";

const UNITS = ["mm[Hg]", "/min", "Cel", "%", "kg", "cm", "mg/dL"];

export function EncounterPage() {
  const { id } = useParams();
  const { me } = useAuth();
  const navigate = useNavigate();
  const detail = useQuery<EncounterDetail>(id ? `/encounters/${id}` : null);
  const [tab, setTab] = useState<"summary" | "notes">("summary");
  const [selectedEntry, setSelectedEntry] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const roles = me?.activeTenant?.roles ?? [];
  const clinical = roles.some((role) => ["nurse", "clinician"].includes(role));
  const canSign = roles.includes("clinician");

  const data = detail.data;
  const entry = data?.entries.find((row) => row.id === selectedEntry) ?? data?.entries[data.entries.length - 1] ?? null;

  useEffect(() => {
    if (!selectedEntry && data?.entries.length) setSelectedEntry(data.entries[data.entries.length - 1]!.id);
  }, [data, selectedEntry]);

  async function transition(state: string) {
    if (!data) return;
    if (state === "completed" && !window.confirm("Complete this encounter? All draft notes must be signed or resolved first.")) return;
    setBusy(state);
    setError(null);
    setMessage(null);
    try {
      await api(`/encounters/${id}/transitions`, { method: "POST", body: { state, expectedVersion: data.encounter.version, reason: state === "cancelled" ? "Cancelled by clinical team" : undefined } });
      setMessage(`Encounter moved to ${state}.`);
      detail.reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  if (detail.loading && !detail.data) return <LoadingState label="Opening authorized chart" />;
  if (detail.error) return <ErrorState message={detail.error} onRetry={detail.reload} />;
  if (!data) return <EmptyState title="Encounter not found" description="The encounter is unavailable in this facility context." />;

  const encounter = data.encounter;
  const allergyText = data.allergies.length ? data.allergies.map((allergy) => allergy.state === "recorded" ? `${allergy.substanceCoding?.display ?? "Recorded substance"}${allergy.reactionCoding ? ` → ${allergy.reactionCoding.display}` : ""} (${allergy.severity})` : allergy.state === "none" ? "No known allergies" : "Allergy status unknown").join("; ") : "Not assessed";

  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow="Authorized clinical record"
        title={`${encounter.givenName} ${encounter.familyName}`}
        description={`${encounter.facilityName} · ${encounter.type} · ${encounter.reason}`}
        actions={<Link className="mv-button mv-button--secondary mv-button--md" to="/worklist">Back to worklist</Link>}
      />
      <div className="mv-patient-banner">
        <div>
          <strong className="mv-id">{encounter.publicId}</strong>
          <div className="mv-patient-banner__meta">
            <span>DOB {encounter.dateOfBirth}</span><span>{encounter.sex}</span><span>Identity: {encounter.identityConfidence}</span>
          </div>
        </div>
        <div className="mv-row"><Badge tone={encounter.state === "in-progress" ? "info" : encounter.state === "triaged" ? "warning" : "neutral"}>{encounter.state}</Badge><Badge tone={data.allergies.length ? "danger" : "warning"}>Allergy: {allergyText}</Badge></div>
      </div>

      {error ? <ErrorState message={error} /> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}

      <Tabs label="Chart sections" value={tab} onChange={setTab} options={[{ value: "summary", label: "Summary and triage" }, { value: "notes", label: `Notes (${data.entries.length})` }]} />

      {tab === "summary" ? (
        <>
          <div className="mv-grid mv-grid--2">
            <Card title="Encounter" description="State transitions are version-checked and audited.">
              <DataList items={[
                { label: "Opened", value: new Date(encounter.openedAt).toLocaleString() },
                { label: "Version", value: encounter.version },
                { label: "Reason", value: encounter.reason },
                { label: "Source", value: encounter.facilityName },
              ]} />
              {clinical ? (
                <div className="mv-row" style={{ marginTop: 14 }}>
                  {encounter.state === "in-progress" ? <Button onClick={() => void transition("completed")} disabled={busy !== null}>{busy === "completed" ? "Completing…" : "Complete encounter"}</Button> : null}
                  {["arrived", "triaged", "in-progress"].includes(encounter.state) ? <Button variant="secondary" onClick={() => void transition("cancelled")} disabled={busy !== null}>{busy === "cancelled" ? "Cancelling…" : "Cancel encounter"}</Button> : null}
                  <Button variant="ghost" type="button" onClick={() => navigate("/worklist")}>Return</Button>
                </div>
              ) : <Notice tone="info">Reception can open limited encounter context but cannot read clinical narratives.</Notice>}
            </Card>
            <Card title="Triage record">
              {!data.triage.length ? <EmptyState title="Not triaged" description="Triage must be recorded before a note can be documented." /> : data.triage.map((record) => (
                <div key={record.id} style={{ marginBottom: 10 }}>
                  <div className="mv-spread"><strong>{record.complaint}</strong><Badge tone={record.urgency === "emergency" ? "danger" : record.urgency === "urgent" ? "warning" : "neutral"}>{record.urgency}</Badge></div>
                  <div className="mv-small mv-muted">{new Date(record.createdAt).toLocaleString()} {record.notes ? `· ${record.notes}` : ""}</div>
                </div>
              ))}
            </Card>
          </div>

          {clinical && ["arrived", "triaged"].includes(encounter.state) ? <TriagePanel encounterId={encounter.id} onSaved={detail.reload} /> : null}

          <div className="mv-grid mv-grid--2">
            <Card title="Observations" description="LOINC identity with UCUM units and source time.">
              {!data.observations.length ? <EmptyState title="No observations" description="Record observations during triage or add a validated measurement below." /> : (
                <ul className="mv-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {data.observations.map((obs) => (
                    <li key={obs.id} className="mv-spread"><span>{obs.display}</span><strong>{obs.valueNum} {obs.unitCode}</strong><span className="mv-small mv-muted">{new Date(obs.occurredAt).toLocaleString()}</span></li>
                  ))}
                </ul>
              )}
              {clinical ? <ObservationForm encounterId={encounter.id} onSaved={detail.reload} /> : null}
            </Card>
            <Card title="Problems and follow-up">
              <h3 style={{ marginBottom: 6 }}>Conditions</h3>
              {!data.conditions.length ? <p className="mv-small mv-muted">No conditions recorded.</p> : <ul className="mv-small">{data.conditions.map((condition) => <li key={condition.id}>{condition.display} — {condition.clinicalStatus} ({new Date(condition.recordedAt).toLocaleDateString()})</li>)}</ul>}
              <hr className="mv-divider" />
              <h3 style={{ marginBottom: 6 }}>Allergies</h3>
              {!data.allergies.length ? <p className="mv-small mv-muted">Not assessed in this encounter.</p> : <ul className="mv-small">{data.allergies.map((allergy) => <li key={allergy.id}>{allergy.state === "recorded" ? `${allergy.substanceCoding?.display} (${allergy.severity})` : allergy.state}</li>)}</ul>}
              <hr className="mv-divider" />
              <h3 style={{ marginBottom: 6 }}>Follow-ups</h3>
              {!data.followUps.length ? <p className="mv-small mv-muted">No follow-up scheduled.</p> : <ul className="mv-small">{data.followUps.map((followUp) => <li key={followUp.id}>{followUp.dueDate}: {followUp.instructions} ({followUp.status})</li>)}</ul>}
              {clinical ? <FollowUpForm encounterId={encounter.id} onSaved={detail.reload} /> : null}
              <hr className="mv-divider" />
              <h3 style={{ marginBottom: 6 }}>Referrals</h3>
              {!data.referrals.length ? <p className="mv-small mv-muted">No referral recorded.</p> : <ul className="mv-small">{data.referrals.map((referral) => <li key={referral.id}>{referral.toFacility} — {referral.reason} ({referral.priority}, {referral.status})</li>)}</ul>}
              {clinical ? <ReferralForm encounterId={encounter.id} onSaved={detail.reload} /> : null}
            </Card>
          </div>
        </>
      ) : !clinical ? (
        <EmptyState title="Clinical notes restricted" description="Your role does not permit reading clinical narratives." />
      ) : (
        <div className="mv-grid" style={{ gridTemplateColumns: "minmax(220px, 0.32fr) minmax(0, 1fr)" }}>
          <Card title="Entries">
            {!data.entries.length ? <p className="mv-small mv-muted">No notes yet.</p> : (
              <div className="mv-stack" style={{ gap: 6 }}>
                {data.entries.map((row) => (
                  <button key={row.id} type="button" className={`mv-note mv-note--${row.status}`} style={{ textAlign: "left", cursor: "pointer" }} onClick={() => setSelectedEntry(row.id)} aria-pressed={row.id === entry?.id}>
                    <strong>{row.title}</strong>
                    <div className="mv-small mv-muted">v{row.currentVersion} · {row.status}</div>
                  </button>
                ))}
              </div>
            )}
          </Card>
          <ClinicalNotePanel encounterId={encounter.id} entry={entry} canSign={canSign} onChanged={detail.reload} />
        </div>
      )}
    </div>
  );
}

function ObservationForm({ encounterId, onSaved }: { encounterId: string; onSaved: () => void }) {
  const [coding, setCoding] = useState<Coding | null>(null);
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("mm[Hg]");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!coding) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/encounters/${encounterId}/observations`, { method: "POST", body: { coding, value: Number(value), unit: { code: unit, system: "http://unitsofmeasure.org" }, occurredAt: new Date().toISOString(), note: "" } });
      setCoding(null);
      setValue("");
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="mv-stack" style={{ marginTop: 14 }} onSubmit={submit}>
      {error ? <ErrorState message={error} /> : null}
      <CodingPicker field="observation" label="Add validated observation (LOINC)" value={coding} onChange={setCoding} />
      {coding ? <div className="mv-form-grid"><Field label="Value"><Input type="number" step="any" value={value} onChange={(e) => setValue(e.target.value)} required /></Field><Field label="UCUM unit"><Select value={unit} onChange={(e) => setUnit(e.target.value)}>{UNITS.map((code) => <option key={code}>{code}</option>)}</Select></Field></div> : null}
      <Button type="submit" variant="secondary" disabled={!coding || busy || value === ""}>{busy ? "Saving…" : "Add observation"}</Button>
    </form>
  );
}

function FollowUpForm({ encounterId, onSaved }: { encounterId: string; onSaved: () => void }) {
  const [dueDate, setDueDate] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/encounters/${encounterId}/follow-ups`, { method: "POST", body: { dueDate, instructions } });
      setDueDate("");
      setInstructions("");
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="mv-stack" style={{ marginTop: 14 }} onSubmit={submit}>
      {error ? <ErrorState message={error} /> : null}
      <Field label="Follow-up date"><Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required /></Field>
      <Field label="Instructions"><Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} required /></Field>
      <Button type="submit" variant="secondary" disabled={busy}>{busy ? "Saving…" : "Schedule follow-up"}</Button>
    </form>
  );
}

function ReferralForm({ encounterId, onSaved }: { encounterId: string; onSaved: () => void }) {
  const [toFacility, setToFacility] = useState("");
  const [reason, setReason] = useState("");
  const [priority, setPriority] = useState("routine");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/encounters/${encounterId}/referrals`, { method: "POST", body: { toFacility, reason, priority } });
      setToFacility("");
      setReason("");
      setPriority("routine");
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="mv-stack" style={{ marginTop: 14 }} onSubmit={submit}>
      <Notice tone="info">This records a local referral. It is not sent to the destination facility.</Notice>
      {error ? <ErrorState message={error} /> : null}
      <Field label="Destination facility or service" htmlFor="referral-destination"><Input id="referral-destination" value={toFacility} onChange={(event) => setToFacility(event.target.value)} required maxLength={300} /></Field>
      <Field label="Referral reason" htmlFor="referral-reason"><Textarea id="referral-reason" value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={4000} /></Field>
      <Field label="Priority" htmlFor="referral-priority"><Select id="referral-priority" value={priority} onChange={(event) => setPriority(event.target.value)}><option value="routine">Routine</option><option value="urgent">Urgent</option><option value="emergency">Emergency</option></Select></Field>
      <Button type="submit" variant="secondary" disabled={busy || !toFacility.trim() || !reason.trim()}>{busy ? "Saving…" : "Record referral"}</Button>
    </form>
  );
}
