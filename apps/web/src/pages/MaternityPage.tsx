import { useEffect, useState, type FormEvent } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";
import { PatientPicker } from "../components/Pickers";

interface Episode {
  id: string; patientId: string; encounterId: string | null; gravidity: number | null; parity: number | null;
  estimatedDueDate: string | null; datingBasis: string | null; riskLevel: string; status: string;
  admittedAt: string | null; deliveredAt: string | null; closedAt: string | null; version: number; notes: string | null;
  publicId: string; givenName: string; familyName: string; observationCount: number; newbornCount: number; hasDelivery: boolean;
}
interface Observation { id: string; templateType: string; clinicalOccurredAt: string; recordedAt: string; maternal: Record<string, unknown>; fetal: Record<string, unknown>; notes: string | null; lateEntry: boolean; recordedByName: string }
interface Delivery { id: string; deliveredAt: string; mode: string; outcome: string; bloodLossMl: string | null; perineum: string | null; complications: string | null; notes: string | null }
interface Newborn { id: string; givenName: string; familyName: string; sex: string; bornAt: string | null; weightG: number | null; apgar1: number | null; apgar5: number | null; feeding: string | null; status: string }
interface Detail { episode: Episode; observations: Observation[]; delivery: Delivery | null; newborns: Newborn[] }

export function MaternityPage() {
  const episodes = useQuery<{ episodes: Episode[] }>("/maternity/episodes");
  const action = useAction();
  const [selectedId, setSelectedId] = useState("");
  const [patientId, setPatientId] = useState("");
  const [gravidity, setGravidity] = useState("");
  const [parity, setParity] = useState("");
  const [estimatedDueDate, setEstimatedDueDate] = useState("");
  const [riskLevel, setRiskLevel] = useState("not-assessed");
  const [notes, setNotes] = useState("");

  async function create(event: FormEvent) {
    event.preventDefault();
    await action.run("episode", async () => {
      await api("/maternity/episodes", {
        method: "POST",
        body: {
          patientId,
          gravidity: gravidity ? Number(gravidity) : null,
          parity: parity ? Number(parity) : null,
          estimatedDueDate: estimatedDueDate || null,
          riskLevel,
          notes,
        },
      });
      setNotes("");
      episodes.reload();
      return "Maternity episode opened.";
    });
  }

  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Maternal health" title="Maternity and labour" description="Antenatal and intrapartum episodes with time-stamped labour charting, delivery and newborn records. Late entry is labelled rather than hidden." />
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <div className="mv-grid mv-grid--2">
        <Card title="Open an episode" description="The patient must belong to this facility.">
          <form className="mv-stack" onSubmit={create}>
            <PatientPicker value={patientId} onChange={setPatientId} />
            <div className="mv-form-grid">
              <Field label="Gravidity" htmlFor="mat-grav"><Input id="mat-grav" type="number" min={0} max={30} value={gravidity} onChange={(event) => setGravidity(event.target.value)} /></Field>
              <Field label="Parity" htmlFor="mat-parity"><Input id="mat-parity" type="number" min={0} max={30} value={parity} onChange={(event) => setParity(event.target.value)} /></Field>
              <Field label="Estimated due date" htmlFor="mat-edd"><Input id="mat-edd" type="date" value={estimatedDueDate} onChange={(event) => setEstimatedDueDate(event.target.value)} /></Field>
              <Field label="Risk level"><Select value={riskLevel} onChange={(event) => setRiskLevel(event.target.value)}>{["not-assessed", "low", "moderate", "high"].map((level) => <option key={level} value={level}>{level}</option>)}</Select></Field>
            </div>
            <Field label="Notes" htmlFor="mat-notes"><Textarea id="mat-notes" value={notes} onChange={(event) => setNotes(event.target.value)} /></Field>
            <Button type="submit" disabled={action.busy !== null || !patientId}>{action.busy === "episode" ? "Opening…" : "Open episode"}</Button>
          </form>
        </Card>
        <Card title="Episodes" description={`${episodes.data?.episodes.length ?? 0} episodes.`}>
          {episodes.loading ? <LoadingState /> : episodes.error ? <ErrorState message={episodes.error} onRetry={episodes.reload} /> : !episodes.data?.episodes.length ? <EmptyState title="No episodes" description="Open a maternity episode." /> : (
            <Table head={["Patient", "Risk", "Status", "Chart", ""]} caption="Maternity episodes">
              {episodes.data.episodes.map((row) => (
                <tr key={row.id}>
                  <td><strong>{row.familyName}, {row.givenName}</strong><div className="mv-small mv-muted mv-id">{row.publicId}</div></td>
                  <td><Badge tone={row.riskLevel === "high" ? "danger" : row.riskLevel === "moderate" ? "warning" : "info"}>{row.riskLevel}</Badge></td>
                  <td><Badge tone={row.status === "active" ? "info" : row.status === "delivered" ? "success" : "neutral"}>{row.status}</Badge></td>
                  <td>{row.observationCount} obs<div className="mv-small mv-muted">{row.hasDelivery ? "Delivered" : "No delivery"}</div></td>
                  <td><Button size="sm" variant="secondary" onClick={() => setSelectedId(row.id)}>Open</Button></td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
      {selectedId ? <EpisodeDetail id={selectedId} onClose={() => setSelectedId("")} onChanged={() => episodes.reload()} /> : null}
    </div>
  );
}

function EpisodeDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const detail = useQuery<Detail>(`/maternity/episodes/${id}`);
  const action = useAction();
  const [templateType, setTemplateType] = useState<"labour-care-guide" | "partograph">("partograph");
  const [occurredAt, setOccurredAt] = useState(new Date().toISOString().slice(0, 16));
  const [maternal, setMaternal] = useState(`{"cervixCm": 4, "contractionsPer10Min": 3, "bloodPressureSystolic": 118, "bloodPressureDiastolic": 74}`);
  const [fetal, setFetal] = useState(`{"heartRate": 140}`);
  const [lateEntry, setLateEntry] = useState(false);
  const [deliveredAt, setDeliveredAt] = useState(new Date().toISOString().slice(0, 16));
  const [mode, setMode] = useState("spontaneous-vaginal");
  const [outcome, setOutcome] = useState("live-birth");
  const [bloodLoss, setBloodLoss] = useState("");
  const [newbornFamilyName, setNewbornFamilyName] = useState("");
  const [newbornGivenName, setNewbornGivenName] = useState("Baby");
  const [sex, setSex] = useState("unknown");
  const [weightG, setWeightG] = useState("");
  const [apgar1, setApgar1] = useState("");
  const [apgar5, setApgar5] = useState("");

  useEffect(() => {
    if (detail.data) setNewbornFamilyName(detail.data.episode.familyName);
  }, [detail.data]);

  function refresh() {
    detail.reload();
    onChanged();
  }

  async function chart(event: FormEvent) {
    event.preventDefault();
    await action.run("chart", async () => {
      await api(`/maternity/episodes/${id}/observations`, {
        method: "POST",
        body: {
          templateType,
          clinicalOccurredAt: new Date(occurredAt).toISOString(),
          maternal: JSON.parse(maternal),
          fetal: JSON.parse(fetal),
          lateEntry,
        },
      });
      refresh();
      return "Labour observation charted.";
    });
  }

  async function recordDelivery(event: FormEvent) {
    event.preventDefault();
    await action.run("delivery", async () => {
      await api(`/maternity/episodes/${id}/delivery`, {
        method: "POST",
        body: { deliveredAt: new Date(deliveredAt).toISOString(), mode, outcome, bloodLossMl: bloodLoss ? Number(bloodLoss) : null },
      });
      refresh();
      return "Delivery recorded.";
    });
  }

  async function recordNewborn(event: FormEvent) {
    event.preventDefault();
    await action.run("newborn", async () => {
      await api(`/maternity/episodes/${id}/newborns`, {
        method: "POST",
        body: {
          givenName: newbornGivenName,
          familyName: newbornFamilyName,
          sex,
          weightG: weightG ? Number(weightG) : null,
          apgar1: apgar1 ? Number(apgar1) : null,
          apgar5: apgar5 ? Number(apgar5) : null,
        },
      });
      refresh();
      return "Newborn record added.";
    });
  }

  if (detail.loading) return <LoadingState />;
  if (detail.error) return <ErrorState message={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return null;
  const { episode, observations, delivery, newborns } = detail.data;

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title={`${episode.familyName}, ${episode.givenName}`} description={`${episode.status} · risk ${episode.riskLevel} · version ${episode.version}`}>
        <div className="mv-spread"><span className="mv-small mv-muted">{episode.publicId}</span><Button size="sm" variant="ghost" onClick={onClose}>Close</Button></div>
        <div className="mv-grid mv-grid--3" style={{ marginTop: 12 }}>
          <div><span className="mv-small mv-muted">Gravidity / parity</span><div>{episode.gravidity ?? "—"} / {episode.parity ?? "—"}</div></div>
          <div><span className="mv-small mv-muted">Estimated due date</span><div>{episode.estimatedDueDate ?? "—"}</div></div>
          <div><span className="mv-small mv-muted">Delivered</span><div>{episode.deliveredAt ? formatDateTime(episode.deliveredAt) : "—"}</div></div>
        </div>
      </Card>
      <div className="mv-grid mv-grid--2">
        <Card title="Chart a labour observation" description="Clinical occurrence time is kept separate from the recording time.">
          <form className="mv-stack" onSubmit={chart}>
            <div className="mv-form-grid">
              <Field label="Template"><Select value={templateType} onChange={(event) => setTemplateType(event.target.value as typeof templateType)}><option value="partograph">Partograph</option><option value="labour-care-guide">Labour care guide</option></Select></Field>
              <Field label="Occurred at" htmlFor="obs-at"><Input id="obs-at" type="datetime-local" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} required /></Field>
            </div>
            <Field label="Maternal values (JSON)" htmlFor="obs-maternal"><Textarea id="obs-maternal" value={maternal} onChange={(event) => setMaternal(event.target.value)} rows={3} /></Field>
            <Field label="Fetal values (JSON)" htmlFor="obs-fetal"><Textarea id="obs-fetal" value={fetal} onChange={(event) => setFetal(event.target.value)} rows={2} /></Field>
            <label className="mv-row"><input type="checkbox" checked={lateEntry} onChange={(event) => setLateEntry(event.target.checked)} /> Late entry</label>
            <Button type="submit" disabled={action.busy !== null}>{action.busy === "chart" ? "Charting…" : "Chart observation"}</Button>
          </form>
        </Card>
        <Card title="Delivery and newborn">
          {delivery ? (
            <div className="mv-stack">
              <Notice tone="success">Delivery recorded: {delivery.mode} · {delivery.outcome} · {formatDateTime(delivery.deliveredAt)}</Notice>
              <form className="mv-stack" onSubmit={recordNewborn}>
                <div className="mv-form-grid">
                  <Field label="Given name" htmlFor="nb-given"><Input id="nb-given" value={newbornGivenName} onChange={(event) => setNewbornGivenName(event.target.value)} required /></Field>
                  <Field label="Family name" htmlFor="nb-family"><Input id="nb-family" value={newbornFamilyName} onChange={(event) => setNewbornFamilyName(event.target.value)} required /></Field>
                  <Field label="Sex"><Select value={sex} onChange={(event) => setSex(event.target.value)}>{["unknown", "female", "male", "other"].map((value) => <option key={value} value={value}>{value}</option>)}</Select></Field>
                  <Field label="Weight (g)" htmlFor="nb-weight"><Input id="nb-weight" type="number" value={weightG} onChange={(event) => setWeightG(event.target.value)} /></Field>
                  <Field label="Apgar 1" htmlFor="nb-ap1"><Input id="nb-ap1" type="number" min={0} max={10} value={apgar1} onChange={(event) => setApgar1(event.target.value)} /></Field>
                  <Field label="Apgar 5" htmlFor="nb-ap5"><Input id="nb-ap5" type="number" min={0} max={10} value={apgar5} onChange={(event) => setApgar5(event.target.value)} /></Field>
                </div>
                <Button type="submit" disabled={action.busy !== null || !newbornFamilyName.trim()}>{action.busy === "newborn" ? "Saving…" : "Add newborn"}</Button>
              </form>
            </div>
          ) : (
            <form className="mv-stack" onSubmit={recordDelivery}>
              <Field label="Delivered at" htmlFor="del-at"><Input id="del-at" type="datetime-local" value={deliveredAt} onChange={(event) => setDeliveredAt(event.target.value)} required /></Field>
              <div className="mv-form-grid">
                <Field label="Mode"><Select value={mode} onChange={(event) => setMode(event.target.value)}>{["spontaneous-vaginal", "assisted-vaginal", "caesarean", "other"].map((value) => <option key={value} value={value}>{value}</option>)}</Select></Field>
                <Field label="Outcome"><Select value={outcome} onChange={(event) => setOutcome(event.target.value)}>{["live-birth", "stillbirth", "multiple", "other"].map((value) => <option key={value} value={value}>{value}</option>)}</Select></Field>
              </div>
              <Field label="Blood loss (ml)" htmlFor="del-loss"><Input id="del-loss" type="number" value={bloodLoss} onChange={(event) => setBloodLoss(event.target.value)} /></Field>
              <Button type="submit" disabled={action.busy !== null}>{action.busy === "delivery" ? "Recording…" : "Record delivery"}</Button>
            </form>
          )}
        </Card>
      </div>
      <div className="mv-grid mv-grid--2">
        <Card title="Labour chart">
          {!observations.length ? <EmptyState title="No observations" description="Chart the first observation above." /> : (
            <Table head={["Occurred", "Maternal", "Fetal", "Entry"]} caption="Labour observations">
              {observations.map((row) => (
                <tr key={row.id}><td className="mv-small">{formatDateTime(row.clinicalOccurredAt)}<div className="mv-small mv-muted">{row.recordedByName}</div></td><td className="mv-small">{JSON.stringify(row.maternal)}</td><td className="mv-small">{JSON.stringify(row.fetal)}</td><td>{row.lateEntry ? <Badge tone="warning">late entry</Badge> : <Badge tone="success">timely</Badge>}</td></tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title="Newborn records">
          {!newborns.length ? <EmptyState title="No newborns" description="Newborn records are added after delivery." /> : (
            <Table head={["Name", "Sex", "Weight", "Apgar", "Status"]} caption="Newborn records">
              {newborns.map((row) => (
                <tr key={row.id}><td>{row.familyName}, {row.givenName}</td><td>{row.sex}</td><td>{row.weightG ? `${row.weightG} g` : "—"}</td><td>{row.apgar1 ?? "—"} / {row.apgar5 ?? "—"}</td><td>{row.status}</td></tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}
