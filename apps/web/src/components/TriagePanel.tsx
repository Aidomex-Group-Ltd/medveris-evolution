import { useState, type FormEvent } from "react";
import { Button, Card, ErrorState, Field, Input, Notice, Select, Textarea } from "@medveris/ui";
import { api, errorMessage } from "../lib/api";
import type { Coding } from "../lib/types";
import { CodingPicker } from "./CodingPicker";

const UNITS = [
  { code: "mm[Hg]", display: "mm[Hg]" },
  { code: "/min", display: "per minute" },
  { code: "Cel", display: "°C" },
  { code: "%", display: "percent" },
  { code: "kg", display: "kg" },
  { code: "cm", display: "cm" },
  { code: "mg/dL", display: "mg/dL" },
];
const UCUMVERSION = "2.2-medveris-synthetic";

export function TriagePanel({ encounterId, onSaved }: { encounterId: string; onSaved: () => void }) {
  const [complaint, setComplaint] = useState("");
  const [urgency, setUrgency] = useState("routine");
  const [notes, setNotes] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [allergyState, setAllergyState] = useState("unknown");
  const [substance, setSubstance] = useState<Coding | null>(null);
  const [reaction, setReaction] = useState<Coding | null>(null);
  const [observation, setObservation] = useState<Coding | null>(null);
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("mm[Hg]");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!complaint.trim()) {
      setError("Enter the presenting complaint to save triage.");
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const observations = showAdvanced && observation && value ? [{
        coding: observation,
        value: Number(value),
        unit: { code: unit, system: "http://unitsofmeasure.org" },
        occurredAt: new Date().toISOString(),
      }] : [];
      await api(`/encounters/${encounterId}/triage`, {
        method: "POST",
        body: {
          complaint: complaint.trim(),
          urgency,
          notes: notes.trim(),
          observations,
          allergyState: showAdvanced ? allergyState : "unknown",
          allergy: showAdvanced && allergyState === "recorded" && substance ? { substance, reaction: reaction ?? null, note: "" } : null,
        },
      });
      setSaved(true);
      setComplaint("");
      setNotes("");
      setObservation(null);
      setValue("");
      setSubstance(null);
      setReaction(null);
      setShowAdvanced(false);
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const missingAllergySubstance = showAdvanced && allergyState === "recorded" && !substance;

  return (
    <Card title="Record triage" description="Only complaint and urgency are required to unlock the consultation note.">
      {error ? <ErrorState message={error} /> : null}
      {saved ? <Notice tone="success">Triage saved. You can now document the consultation note.</Notice> : null}
      <form className="mv-stack" onSubmit={submit}>
        <Field label="Presenting complaint" htmlFor="complaint">
          <Textarea id="complaint" value={complaint} onChange={(e) => setComplaint(e.target.value)} required maxLength={4000} placeholder="e.g. Fever and cough for 3 days" />
        </Field>
        <div className="mv-form-grid">
          <Field label="Urgency"><Select value={urgency} onChange={(e) => setUrgency(e.target.value)}><option value="routine">Routine</option><option value="urgent">Urgent</option><option value="emergency">Emergency</option></Select></Field>
          <Field label="Notes (optional)" htmlFor="triage-notes"><Input id="triage-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} /></Field>
        </div>
        <details open={showAdvanced} onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}>
          <summary className="mv-small" style={{ cursor: "pointer" }}>Advanced — optional observation & allergy</summary>
          <div className="mv-stack" style={{ marginTop: 10, gap: 10 }}>
            <CodingPicker field="observation" label="Observation type (LOINC) — optional" value={observation} onChange={setObservation} />
            {observation ? (
              <div className="mv-form-grid">
                <Field label="Value" htmlFor="obs-value"><Input id="obs-value" type="number" step="any" value={value} onChange={(e) => setValue(e.target.value)} /></Field>
                <Field label="UCUM unit"><Select value={unit} onChange={(e) => setUnit(e.target.value)}>{UNITS.map((u) => <option key={u.code} value={u.code}>{u.display} ({u.code})</option>)}</Select></Field>
              </div>
            ) : null}
            {observation ? <span className="mv-small mv-muted">Stored release: {observation.version}; unit release: {UCUMVERSION}</span> : null}
            <Field label="Allergy state">
              <Select value={allergyState} onChange={(e) => setAllergyState(e.target.value)}>
                <option value="unknown">Unknown</option>
                <option value="none">No known allergies</option>
                <option value="recorded">Recorded allergy</option>
              </Select>
            </Field>
            {allergyState === "recorded" ? (
              <div className="mv-grid mv-grid--2">
                <CodingPicker field="allergy-substance" label="Substance" value={substance} onChange={setSubstance} />
                <CodingPicker field="allergy-reaction" label="Reaction (optional)" value={reaction} onChange={setReaction} />
              </div>
            ) : null}
            {missingAllergySubstance ? <Notice tone="warning">A recorded allergy requires a validated substance. Unknown is distinct from no known allergies.</Notice> : null}
          </div>
        </details>
        <Button type="submit" className="mv-full-width-sm" disabled={busy || missingAllergySubstance || !complaint.trim()}>{busy ? "Saving triage…" : "Save triage"}</Button>
      </form>
    </Card>
  );
}
