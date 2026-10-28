import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Tabs, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDateTime } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";
import { EncounterPicker, PatientPicker } from "../components/Pickers";

interface Ward { id: string; name: string; wardType: string; description: string | null; status: string; bedCount: number; availableBeds: number }
interface Bed { id: string; wardId: string; label: string; status: string; statusReason: string | null; version: number; wardName: string; wardType: string }
interface Admission { id: string; patientId: string; encounterId: string; wardType: string; status: string; version: number; reason: string; admittedAt: string; dischargedAt: string | null; publicId: string; givenName: string; familyName: string; attendingName: string | null; bedLabel: string | null; wardName: string | null }

const WARD_TYPES = ["general", "adult-male", "adult-female", "pediatric", "surgical", "maternity", "nicu", "icu"];

export function WardsPage() {
  const { me } = useAuth();
  const roles = me?.activeTenant?.roles ?? [];
  const clinical = roles.some((role) => ["clinician", "nurse"].includes(role));
  const admin = roles.includes("facility_admin");
  const [tab, setTab] = useState<"board" | "admissions" | "configure">("board");
  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Inpatient" title="Wards and bed management" description="Bed allocation is atomic and version-checked. Ward configuration does not grant clinical chart access." />
      <Tabs label="Ward sections" value={tab} onChange={setTab} options={[
        { value: "board", label: "Bed board" },
        ...(clinical ? [{ value: "admissions" as const, label: "Admissions" }] : []),
        ...(admin ? [{ value: "configure" as const, label: "Configure wards" }] : []),
      ]} />
      {tab === "board" ? <BedBoard clinical={clinical} admin={admin} /> : null}
      {tab === "admissions" && clinical ? <Admissions /> : null}
      {tab === "configure" && admin ? <WardConfiguration /> : null}
    </div>
  );
}

function BedBoard({ clinical, admin }: { clinical: boolean; admin: boolean }) {
  const wards = useQuery<{ wards: Ward[] }>("/wards");
  const beds = useQuery<{ beds: Bed[] }>("/beds");
  const action = useAction();
  const [wardId, setWardId] = useState("");
  const [bedLabel, setBedLabel] = useState("");
  const [features, setFeatures] = useState("");

  async function addBed(event: FormEvent) {
    event.preventDefault();
    const targetWard = wardId || wards.data?.wards[0]?.id;
    if (!targetWard) return;
    await action.run("bed", async () => {
      await api(`/wards/${targetWard}/beds`, {
        method: "POST",
        body: { label: bedLabel, features: features.trim() ? { notes: features.trim() } : {} },
      });
      setBedLabel("");
      setFeatures("");
      wards.reload();
      beds.reload();
      return "Bed added to the ward.";
    });
  }

  async function setStatus(bed: Bed, status: string) {
    await action.run(bed.id, async () => {
      await api(`/beds/${bed.id}/status`, { method: "PATCH", body: { status, expectedVersion: bed.version } });
      beds.reload();
      return `Bed ${bed.label} marked ${status}.`;
    });
  }

  if (wards.loading || beds.loading) return <LoadingState label="Loading bed board" variant="page" />;
  if (wards.error) return <ErrorState message={wards.error} onRetry={wards.reload} />;
  if (beds.error) return <ErrorState message={beds.error} onRetry={beds.reload} />;
  if (!wards.data?.wards.length) return <EmptyState title="No wards configured" description={admin ? "Create a ward from the Configure wards tab." : "A facility administrator must configure the first ward."} />;

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <div className="mv-grid mv-grid--3">
        {wards.data.wards.map((ward) => {
          const wardBeds = beds.data?.beds.filter((bed) => bed.wardId === ward.id) ?? [];
          return (
            <Card key={ward.id} title={ward.name} description={`${ward.wardType} · ${ward.availableBeds} of ${ward.bedCount} available`}>
              {!wardBeds.length ? <p className="mv-small mv-muted">No beds configured.</p> : (
                <div className="mv-stack" style={{ gap: 8 }}>
                  {wardBeds.map((bed) => (
                    <div key={bed.id} className="mv-note">
                      <div className="mv-spread">
                        <strong>{bed.label}</strong>
                        <Badge tone={bed.status === "available" ? "success" : bed.status === "occupied" ? "info" : bed.status === "cleaning" ? "warning" : "danger"}>{bed.status}</Badge>
                      </div>
                      {bed.statusReason ? <div className="mv-small mv-muted">{bed.statusReason}</div> : null}
                      {bed.status !== "occupied" ? (
                        <div className="mv-row" style={{ marginTop: 8 }}>
                          {bed.status !== "available" ? <Button size="sm" variant="secondary" onClick={() => void setStatus(bed, "available")} disabled={action.busy !== null}>Mark available</Button> : null}
                          {bed.status !== "cleaning" ? <Button size="sm" variant="ghost" onClick={() => void setStatus(bed, "cleaning")} disabled={action.busy !== null}>Cleaning</Button> : null}
                          {bed.status !== "unavailable" ? <Button size="sm" variant="ghost" onClick={() => void setStatus(bed, "unavailable")} disabled={action.busy !== null}>Unavailable</Button> : null}
                        </div>
                      ) : <div className="mv-small mv-muted">Release or transfer the admission to free this bed.</div>}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          );
        })}
      </div>
      {clinical || admin ? (
        <Card title="Add a bed" description="Beds belong to a configured ward.">
          <form className="mv-stack" onSubmit={addBed}>
            <div className="mv-form-grid">
              <Field label="Ward"><Select value={wardId || (wards.data.wards[0]?.id ?? "")} onChange={(event) => setWardId(event.target.value)}>{wards.data.wards.map((ward) => <option key={ward.id} value={ward.id}>{ward.name}</option>)}</Select></Field>
              <Field label="Bed label" htmlFor="bed-label"><Input id="bed-label" value={bedLabel} onChange={(event) => setBedLabel(event.target.value)} required maxLength={40} /></Field>
            </div>
            <Field label="Bed features (optional)" htmlFor="bed-features" hint="Free-text operational note. Not a validated device capability."><Input id="bed-features" value={features} onChange={(event) => setFeatures(event.target.value)} maxLength={200} /></Field>
            <Button type="submit" disabled={action.busy !== null || !bedLabel.trim()}>{action.busy === "bed" ? "Adding…" : "Add bed"}</Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}

function Admissions() {
  const admissions = useQuery<{ admissions: Admission[] }>("/admissions");
  const action = useAction();
  const [patientId, setPatientId] = useState("");
  const [encounterId, setEncounterId] = useState("");
  const [wardType, setWardType] = useState("general");
  const [reason, setReason] = useState("");

  async function admit(event: FormEvent) {
    event.preventDefault();
    await action.run("admit", async () => {
      const result = await api<{ admission: { id: string } }>("/admissions", {
        method: "POST",
        body: { patientId, encounterId, wardType, reason },
      });
      setReason("");
      admissions.reload();
      return `Admission created. Open ${result.admission.id.slice(0, 8)} to assign a bed.`;
    });
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title="Request admission" description="The encounter must still be open and belong to the selected patient.">
        <form className="mv-stack" onSubmit={admit}>
          <div className="mv-form-grid">
            <PatientPicker value={patientId} onChange={(value) => { setPatientId(value); setEncounterId(""); }} />
            <EncounterPicker value={encounterId} onChange={setEncounterId} patientId={patientId || undefined} />
            <Field label="Ward type"><Select value={wardType} onChange={(event) => setWardType(event.target.value)}>{WARD_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</Select></Field>
          </div>
          <Field label="Admission reason" htmlFor="admission-reason"><Textarea id="admission-reason" value={reason} onChange={(event) => setReason(event.target.value)} required minLength={5} /></Field>
          <Button type="submit" disabled={action.busy !== null || !patientId || !encounterId || reason.trim().length < 5}>{action.busy === "admit" ? "Admitting…" : "Create admission"}</Button>
        </form>
      </Card>
      <Card title="Admissions" description="Active and closed admissions for this facility.">
        {admissions.loading ? <LoadingState /> : admissions.error ? <ErrorState message={admissions.error} onRetry={admissions.reload} /> : !admissions.data?.admissions.length ? <EmptyState title="No admissions" description="Create an admission request from an active encounter." /> : (
          <Table head={["Patient", "Ward / bed", "Status", "Admitted", ""]} caption="Facility admissions">
            {admissions.data.admissions.map((row) => (
              <tr key={row.id}>
                <td><strong>{row.givenName} {row.familyName}</strong><div className="mv-small mv-muted mv-id">{row.publicId}</div><div className="mv-small mv-muted">{row.reason}</div></td>
                <td>{row.wardName ?? row.wardType}<div className="mv-small mv-muted">{row.bedLabel ?? "No bed assigned"}</div></td>
                <td><Badge tone={row.status === "admitted" ? "info" : row.status === "deceased" ? "danger" : "neutral"}>{row.status}</Badge></td>
                <td className="mv-small">{formatDateTime(row.admittedAt)}</td>
                <td><Link className="mv-button mv-button--secondary mv-button--sm" to={`/wards/admissions/${row.id}`}>Open</Link></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function WardConfiguration() {
  const wards = useQuery<{ wards: Ward[] }>("/wards");
  const action = useAction();
  const [name, setName] = useState("");
  const [wardType, setWardType] = useState("general");
  const [description, setDescription] = useState("");

  async function create(event: FormEvent) {
    event.preventDefault();
    await action.run("ward", async () => {
      await api("/wards", { method: "POST", body: { name, wardType, description } });
      setName("");
      setDescription("");
      wards.reload();
      return "Ward created.";
    });
  }

  const counts = useMemo(() => wards.data?.wards.reduce((sum, ward) => sum + ward.bedCount, 0) ?? 0, [wards.data]);

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title="Create a ward" description={`${wards.data?.wards.length ?? 0} wards and ${counts} beds configured.`}>
        <form className="mv-stack" onSubmit={create}>
          <div className="mv-form-grid">
            <Field label="Ward name" htmlFor="ward-name"><Input id="ward-name" value={name} onChange={(event) => setName(event.target.value)} required minLength={2} maxLength={120} /></Field>
            <Field label="Ward type"><Select value={wardType} onChange={(event) => setWardType(event.target.value)}>{WARD_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</Select></Field>
          </div>
          <Field label="Description" htmlFor="ward-description"><Textarea id="ward-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} /></Field>
          <Button type="submit" disabled={action.busy !== null || name.trim().length < 2}>{action.busy === "ward" ? "Creating…" : "Create ward"}</Button>
        </form>
      </Card>
      <Card title="Configured wards">
        {wards.loading ? <LoadingState /> : wards.error ? <ErrorState message={wards.error} onRetry={wards.reload} /> : !wards.data?.wards.length ? <EmptyState title="No wards" description="Create the first ward above." /> : (
          <Table head={["Ward", "Type", "Beds", "Available", "Status"]} caption="Ward configuration">
            {wards.data.wards.map((ward) => (
              <tr key={ward.id}><td><strong>{ward.name}</strong><div className="mv-small mv-muted">{ward.description}</div></td><td>{ward.wardType}</td><td>{ward.bedCount}</td><td>{ward.availableBeds}</td><td><Badge tone={ward.status === "open" ? "success" : "warning"}>{ward.status}</Badge></td></tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
