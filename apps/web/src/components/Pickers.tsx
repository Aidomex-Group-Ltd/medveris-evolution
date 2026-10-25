import { Field, Select } from "@medveris/ui";
import { useQuery } from "../lib/useQuery";
import type { PatientSummary, WorklistEncounter } from "../lib/types";

interface Member { id: string; displayName: string; roles: string[] }

export function PatientPicker({ value, onChange, id = "patient-picker", label = "Patient", required = true }: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  label?: string;
  required?: boolean;
}) {
  const patients = useQuery<{ patients: PatientSummary[] }>("/patients/recent");
  return (
    <Field label={label} htmlFor={id} hint={patients.error ?? undefined}>
      <Select id={id} value={value} onChange={(event) => onChange(event.target.value)} required={required} disabled={patients.loading}>
        <option value="">{patients.loading ? "Loading patients…" : "Select a patient…"}</option>
        {patients.data?.patients.map((patient) => (
          <option key={patient.id} value={patient.id}>{patient.familyName}, {patient.givenName} — {patient.publicId}</option>
        ))}
      </Select>
    </Field>
  );
}

export function EncounterPicker({ value, onChange, patientId, id = "encounter-picker", label = "Active encounter" }: {
  value: string;
  onChange: (value: string) => void;
  patientId?: string;
  id?: string;
  label?: string;
}) {
  const worklist = useQuery<{ encounters: WorklistEncounter[] }>("/encounters/worklist");
  const encounters = (worklist.data?.encounters ?? []).filter((row) => !patientId || row.patientId === patientId);
  return (
    <Field label={label} htmlFor={id} hint={worklist.error ?? "Only arrived, triaged or in-progress encounters are listed."}>
      <Select id={id} value={value} onChange={(event) => onChange(event.target.value)} required disabled={worklist.loading}>
        <option value="">{worklist.loading ? "Loading encounters…" : "Select an active encounter…"}</option>
        {encounters.map((row) => (
          <option key={row.id} value={row.id}>{row.givenName} {row.familyName} — {row.type} · {row.state} · {row.publicId}</option>
        ))}
      </Select>
    </Field>
  );
}

export function MemberPicker({ value, onChange, id = "member-picker", label = "Recipient", required = true }: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  label?: string;
  required?: boolean;
}) {
  const members = useQuery<{ members: Member[] }>("/directory/clinical-members");
  return (
    <Field label={label} htmlFor={id} hint={members.error ?? undefined}>
      <Select id={id} value={value} onChange={(event) => onChange(event.target.value)} required={required} disabled={members.loading}>
        <option value="">{members.loading ? "Loading members…" : "Select a clinical member…"}</option>
        {members.data?.members.map((member) => (
          <option key={member.id} value={member.id}>{member.displayName} ({member.roles.join(", ")})</option>
        ))}
      </Select>
    </Field>
  );
}

export function PatientContextLink({ patientId, label = "Open patient diagnostics" }: { patientId: string; label?: string }) {
  return <a href={`/diagnostics?patientId=${patientId}`}>{label}</a>;
}
