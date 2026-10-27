import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge, Button, Card, DataList, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDateTime } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";
import { MemberPicker } from "../components/Pickers";

interface Order { id: string; patientId: string; encounterId: string; orderType: string; priority: string; clinicalNote: string; status: string; version: number; publicId: string; givenName: string; familyName: string; createdAt: string }
interface ResultRow { id: string; version: number; status: string; critical: boolean; value_text: string | null; value_num: string | null; unit_code: string | null; reference_range: string | null; interpretation: string }
interface SpecimenRow { id: string; status: string; specimen_type: string; rejection_reason: string | null }
interface StudyRow { id: string; modality: string; body_site: string; pacs_state: string; accession: string | null }
interface ReportRow { id: string; version: number; status: string; critical: boolean; findings: string; impression: string }
interface Item { id: string; name: string; specimenType: string | null; status: string; latestResult: ResultRow | null; latestSpecimen: SpecimenRow | null; imagingStudy: StudyRow | null; latestReport: ReportRow | null }
interface Detail { order: Order; items: Item[] }

const NEXT_ORDER_STATUS: Record<string, string[]> = {
  ordered: ["collected", "cancelled"],
  collected: ["in-progress", "cancelled"],
  "in-progress": ["resulted", "cancelled"],
};

export function OrderDetailPage() {
  const { id = "" } = useParams();
  const detail = useQuery<Detail>(id ? `/diagnostic-orders/${id}` : null);
  if (detail.loading) return <LoadingState label="Loading diagnostic order" />;
  if (detail.error || !detail.data) return <ErrorState message={detail.error ?? "Order not found"} onRetry={detail.reload} />;
  const { order, items } = detail.data;
  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Diagnostics" title={`${order.givenName} ${order.familyName}`} description={`${order.publicId} · ${order.orderType} order · ${order.priority}`} actions={<Link className="mv-button mv-button--ghost mv-button--sm" to="/diagnostics">Back to orders</Link>} />
      <Card title="Order">
        <DataList items={[
          { label: "Status", value: <Badge tone={order.status === "resulted" ? "success" : order.status === "cancelled" ? "neutral" : "info"}>{order.status}</Badge> },
          { label: "Ordered", value: formatDateTime(order.createdAt) },
          { label: "Encounter", value: <span className="mv-id">{order.encounterId}</span> },
          { label: "Clinical note", value: order.clinicalNote },
        ]} />
        <OrderTransitions order={order} onDone={detail.reload} />
      </Card>
      {items.map((item) => <ItemWorkflow key={item.id} order={order} item={item} onDone={detail.reload} />)}
    </div>
  );
}

function OrderTransitions({ order, onDone }: { order: Order; onDone: () => void }) {
  const action = useAction();
  const options = NEXT_ORDER_STATUS[order.status] ?? [];
  async function transition(status: string) {
    let reason = "";
    if (status === "cancelled") {
      reason = window.prompt("Cancellation reason (required)") ?? "";
      if (!reason.trim()) return;
    }
    await action.run(status, async () => {
      await api(`/diagnostic-orders/${order.id}/transitions`, { method: "POST", body: { status, expectedVersion: order.version, reason } });
      onDone();
      return `Order marked ${status}.`;
    });
  }
  if (!options.length) return null;
  return (
    <div className="mv-stack" style={{ marginTop: 16 }}>
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <div className="mv-row">
        {options.map((status) => <Button key={status} size="sm" variant={status === "cancelled" ? "ghost" : "secondary"} onClick={() => void transition(status)} disabled={action.busy !== null}>{status === "in-progress" ? "Start processing" : status === "cancelled" ? "Cancel order" : `Mark ${status}`}</Button>)}
      </div>
    </div>
  );
}

function ItemWorkflow({ order, item, onDone }: { order: Order; item: Item; onDone: () => void }) {
  const { me } = useAuth();
  const roles = me?.activeTenant?.roles ?? [];
  const clinician = roles.includes("clinician");
  const laboratory = roles.includes("laboratory");
  const radiology = roles.includes("radiology");
  const action = useAction();
  const [specimenType, setSpecimenType] = useState(item.specimenType ?? "");
  const [valueNum, setValueNum] = useState(item.latestResult?.value_num ?? "");
  const [valueText, setValueText] = useState(item.latestResult?.value_text ?? "");
  const [unitCode, setUnitCode] = useState(item.latestResult?.unit_code ?? "");
  const [referenceRange, setReferenceRange] = useState(item.latestResult?.reference_range ?? "");
  const [interpretation, setInterpretation] = useState("indeterminate");
  const [critical, setCritical] = useState(false);
  const [resultStatus, setResultStatus] = useState<"preliminary" | "final">("preliminary");
  const [changeReason, setChangeReason] = useState("");
  const [recipient, setRecipient] = useState("");
  const [commMethod, setCommMethod] = useState("phone");
  const [commNotes, setCommNotes] = useState("");
  const [modality, setModality] = useState("CR");
  const [bodySite, setBodySite] = useState("");
  const [accession, setAccession] = useState("");
  const [pacsState, setPacsState] = useState("not-configured");
  const [findings, setFindings] = useState("");
  const [impression, setImpression] = useState("");
  const [reportStatus, setReportStatus] = useState<"preliminary" | "final">("preliminary");
  const [reportCritical, setReportCritical] = useState(false);

  const lab = order.orderType === "laboratory";
  const imaging = order.orderType === "imaging";
  const result = item.latestResult;
  const specimen = item.latestSpecimen;

  useEffect(() => {
    if (!result) return;
    setValueNum(result.value_num ?? "");
    setValueText(result.value_text ?? "");
    setUnitCode(result.unit_code ?? "");
    setReferenceRange(result.reference_range ?? "");
    setInterpretation(result.interpretation);
    setCritical(result.critical);
  }, [result?.id, result?.version]);

  useEffect(() => {
    const report = item.latestReport;
    if (!report) return;
    setFindings(report.findings);
    setImpression(report.impression);
    setReportCritical(report.critical);
  }, [item.latestReport?.id, item.latestReport?.version]);

  async function run(key: string, fn: () => Promise<unknown>, success: string) {
    await action.run(key, async () => {
      await fn();
      onDone();
      return success;
    });
  }

  async function collectSpecimen(event: FormEvent) {
    event.preventDefault();
    await run("specimen", () => api("/specimens", { method: "POST", body: { orderItemId: item.id, specimenType, collectedAt: new Date().toISOString() } }), "Specimen collected.");
  }

  async function receiveSpecimen(accept: boolean) {
    let reason = "";
    if (!accept) {
      reason = window.prompt("Specimen rejection reason (required)") ?? "";
      if (!reason.trim()) return;
    }
    await run(accept ? "receive" : "reject", () => api(`/specimens/${specimen?.id}`, { method: "PATCH", body: { status: accept ? "received" : "rejected", reason } }), accept ? "Specimen received." : "Specimen rejected.");
  }

  async function createResult(event: FormEvent) {
    event.preventDefault();
    await run("result", () => api("/lab-results", {
      method: "POST",
      body: {
        orderItemId: item.id,
        valueNum: valueNum === "" ? null : Number(valueNum),
        valueText,
        unitCode,
        referenceRange,
        interpretation,
        critical,
        status: clinician ? resultStatus : "preliminary",
      },
    }), "Laboratory result recorded.");
  }

  async function finalizeResult() {
    if (!result) return;
    await run("finalize", () => api(`/lab-results/${result.id}/finalize`, { method: "POST", body: { expectedVersion: result.version, note: "" } }), "Result finalized.");
  }

  async function correctResult(event: FormEvent) {
    event.preventDefault();
    if (!result) return;
    await run("correct", () => api(`/lab-results/${result.id}/correct`, {
      method: "POST",
      body: {
        valueNum: valueNum === "" ? null : Number(valueNum),
        valueText,
        unitCode,
        referenceRange,
        interpretation,
        critical,
        changeReason,
        expectedVersion: result.version,
      },
    }), "Result corrected with a new version.");
  }

  async function communicate(event: FormEvent) {
    event.preventDefault();
    if (!result) return;
    await run("comm", () => api(`/lab-results/${result.id}/critical-communications`, { method: "POST", body: { recipientUserId: recipient, method: commMethod, notes: commNotes } }), "Critical result communication recorded.");
  }

  async function registerStudy(event: FormEvent) {
    event.preventDefault();
    await run("study", () => api("/imaging-studies", { method: "POST", body: { orderItemId: item.id, modality, bodySite, accession, pacsState } }), "Imaging study registered.");
  }

  async function createReport(event: FormEvent) {
    event.preventDefault();
    await run("report", () => api("/diagnostic-reports", {
      method: "POST",
      body: { orderItemId: item.id, studyId: item.imagingStudy?.id ?? null, findings, impression, critical: reportCritical, status: reportStatus },
    }), "Diagnostic report recorded.");
  }

  async function correctReport(event: FormEvent) {
    event.preventDefault();
    if (!item.latestReport) return;
    await run("correctReport", () => api(`/diagnostic-reports/${item.latestReport!.id}/correct`, {
      method: "POST",
      body: { findings, impression, critical: reportCritical, changeReason, expectedVersion: item.latestReport!.version },
    }), "Report corrected with a new version.");
  }

  return (
    <Card title={item.name} description={`${item.status}${item.specimenType ? ` · ${item.specimenType}` : ""}`}>
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <div className="mv-stack">
        {specimen ? <div className="mv-note"><div className="mv-spread"><strong>Specimen · {specimen.specimen_type}</strong><Badge tone={specimen.status === "received" ? "success" : specimen.status === "rejected" ? "danger" : "warning"}>{specimen.status}</Badge></div>{specimen.rejection_reason ? <div className="mv-small">{specimen.rejection_reason}</div> : null}</div> : null}
        {lab && (!specimen || specimen.status === "rejected") && (laboratory || clinician || roles.includes("nurse")) ? (
          <form className="mv-stack" onSubmit={collectSpecimen}>
            <Field label="Specimen type" htmlFor={`specimen-${item.id}`}><Input id={`specimen-${item.id}`} value={specimenType} onChange={(event) => setSpecimenType(event.target.value)} required /></Field>
            <Button type="submit" size="sm" disabled={action.busy !== null || !specimenType.trim()}>{action.busy === "specimen" ? "Collecting…" : "Record specimen collection"}</Button>
          </form>
        ) : null}
        {specimen?.status === "collected" && laboratory ? (
          <div className="mv-row"><Button size="sm" onClick={() => void receiveSpecimen(true)} disabled={action.busy !== null}>Receive specimen</Button><Button size="sm" variant="ghost" onClick={() => void receiveSpecimen(false)} disabled={action.busy !== null}>Reject specimen</Button></div>
        ) : null}
        {result ? (
          <div className="mv-note">
            <div className="mv-spread"><strong>Result v{result.version}</strong><Badge tone={result.critical ? "danger" : result.status === "final" ? "success" : "warning"}>{result.status}{result.critical ? " · critical" : ""}</Badge></div>
            <div>{result.value_text ?? result.value_num ?? "—"} {result.unit_code ?? ""}{result.reference_range ? <span className="mv-small mv-muted"> (ref {result.reference_range})</span> : null}</div>
            <div className="mv-small mv-muted">Interpretation: {result.interpretation}</div>
            {result.status === "preliminary" && clinician ? <Button size="sm" variant="secondary" onClick={() => void finalizeResult()} disabled={action.busy !== null}>Finalize result</Button> : null}
          </div>
        ) : null}
        {lab && specimen?.status === "received" && !result ? (
          <form className="mv-stack" onSubmit={createResult}>
            <div className="mv-form-grid">
              <Field label="Numeric value" htmlFor={`num-${item.id}`}><Input id={`num-${item.id}`} type="number" step="any" value={valueNum} onChange={(event) => setValueNum(event.target.value)} /></Field>
              <Field label="Text value" htmlFor={`text-${item.id}`}><Input id={`text-${item.id}`} value={valueText} onChange={(event) => setValueText(event.target.value)} /></Field>
              <Field label="Unit" htmlFor={`unit-${item.id}`}><Input id={`unit-${item.id}`} value={unitCode} onChange={(event) => setUnitCode(event.target.value)} /></Field>
              <Field label="Reference range" htmlFor={`ref-${item.id}`}><Input id={`ref-${item.id}`} value={referenceRange} onChange={(event) => setReferenceRange(event.target.value)} /></Field>
              <Field label="Interpretation"><Select value={interpretation} onChange={(event) => setInterpretation(event.target.value)}><option value="indeterminate">Indeterminate</option><option value="normal">Normal</option><option value="abnormal">Abnormal</option><option value="critical">Critical</option></Select></Field>
              {clinician ? <Field label="Result status"><Select value={resultStatus} onChange={(event) => setResultStatus(event.target.value as "preliminary" | "final")}><option value="preliminary">Preliminary</option><option value="final">Final (clinician verified)</option></Select></Field> : null}
            </div>
            <label className="mv-check"><input type="checkbox" checked={critical} onChange={(event) => setCritical(event.target.checked)} /> Flag as critical</label>
            <Button type="submit" size="sm" disabled={action.busy !== null || (!valueText && !valueNum)}>{action.busy === "result" ? "Recording…" : "Record result"}</Button>
          </form>
        ) : null}
        {result?.status === "final" && clinician ? (
          <details className="mv-note">
            <summary>Correct result</summary>
            <form className="mv-stack" onSubmit={correctResult}>
              <div className="mv-form-grid">
                <Field label="Numeric value"><Input type="number" step="any" value={valueNum} onChange={(event) => setValueNum(event.target.value)} /></Field>
                <Field label="Text value"><Input value={valueText} onChange={(event) => setValueText(event.target.value)} /></Field>
                <Field label="Unit"><Input value={unitCode} onChange={(event) => setUnitCode(event.target.value)} /></Field>
                <Field label="Reference range"><Input value={referenceRange} onChange={(event) => setReferenceRange(event.target.value)} /></Field>
                <Field label="Interpretation"><Select value={interpretation} onChange={(event) => setInterpretation(event.target.value)}><option value="indeterminate">Indeterminate</option><option value="normal">Normal</option><option value="abnormal">Abnormal</option><option value="critical">Critical</option></Select></Field>
              </div>
              <label className="mv-check"><input type="checkbox" checked={critical} onChange={(event) => setCritical(event.target.checked)} /> Critical</label>
              <Field label="Change reason (required)"><Textarea value={changeReason} onChange={(event) => setChangeReason(event.target.value)} required minLength={10} /></Field>
              <Button type="submit" size="sm" variant="secondary" disabled={action.busy !== null || changeReason.trim().length < 10}>{action.busy === "correct" ? "Correcting…" : "Save correction"}</Button>
            </form>
          </details>
        ) : null}
        {result?.critical && result.status === "final" ? (
          <details className="mv-note">
            <summary>Record critical-result communication</summary>
            <form className="mv-stack" onSubmit={communicate}>
              <MemberPicker value={recipient} onChange={setRecipient} label="Recipient" />
              <Field label="Method"><Select value={commMethod} onChange={(event) => setCommMethod(event.target.value)}><option value="phone">Phone</option><option value="in-person">In person</option><option value="secure-message">Secure message</option></Select></Field>
              <Field label="Notes"><Textarea value={commNotes} onChange={(event) => setCommNotes(event.target.value)} maxLength={2000} /></Field>
              <Button type="submit" size="sm" disabled={action.busy !== null || !recipient}>{action.busy === "comm" ? "Recording…" : "Record communication"}</Button>
            </form>
          </details>
        ) : null}

        {imaging && (radiology || clinician || roles.includes("nurse")) && !item.imagingStudy ? (
          <form className="mv-stack" onSubmit={registerStudy}>
            <div className="mv-form-grid">
              <Field label="Modality" htmlFor={`mod-${item.id}`} hint="Synthetic metadata only; no DICOMweb connection is implied."><Input id={`mod-${item.id}`} value={modality} onChange={(event) => setModality(event.target.value)} required /></Field>
              <Field label="Body site"><Input value={bodySite} onChange={(event) => setBodySite(event.target.value)} required /></Field>
              <Field label="Accession"><Input value={accession} onChange={(event) => setAccession(event.target.value)} /></Field>
              <Field label="PACS state" hint="DICOMweb/PACS is unavailable, so no PACS state can be claimed."><Select value={pacsState} onChange={(event) => setPacsState(event.target.value)}><option value="not-configured">Not configured</option><option value="pending" disabled>Pending (requires PACS)</option><option value="reconciled" disabled>Reconciled (requires PACS)</option><option value="quarantined" disabled>Quarantined (requires PACS)</option></Select></Field>
            </div>
            <Button type="submit" size="sm" disabled={action.busy !== null || !bodySite.trim()}>{action.busy === "study" ? "Registering…" : "Register imaging study"}</Button>
          </form>
        ) : null}
        {item.imagingStudy ? <div className="mv-note"><strong>{item.imagingStudy.modality} · {item.imagingStudy.body_site}</strong><div className="mv-small mv-muted">PACS {item.imagingStudy.pacs_state}{item.imagingStudy.accession ? ` · accession ${item.imagingStudy.accession}` : ""}</div></div> : null}
        {item.latestReport ? (
          <div className="mv-note">
            <div className="mv-spread"><strong>Report v{item.latestReport.version}</strong><Badge tone={item.latestReport.critical ? "danger" : item.latestReport.status === "final" ? "success" : "warning"}>{item.latestReport.status}</Badge></div>
            <p><strong>Findings:</strong> {item.latestReport.findings}</p>
            <p><strong>Impression:</strong> {item.latestReport.impression}</p>
            {item.latestReport.status === "final" && radiology ? (
              <details>
                <summary>Correct report</summary>
                <form className="mv-stack" onSubmit={correctReport}>
                  <Field label="Findings"><Textarea value={findings} onChange={(event) => setFindings(event.target.value)} required minLength={2} /></Field>
                  <Field label="Impression"><Textarea value={impression} onChange={(event) => setImpression(event.target.value)} required minLength={2} /></Field>
                  <label className="mv-check"><input type="checkbox" checked={reportCritical} onChange={(event) => setReportCritical(event.target.checked)} /> Critical</label>
                  <Field label="Change reason (required)"><Textarea value={changeReason} onChange={(event) => setChangeReason(event.target.value)} required minLength={10} /></Field>
                  <Button type="submit" size="sm" variant="secondary" disabled={action.busy !== null || changeReason.trim().length < 10}>Save correction</Button>
                </form>
              </details>
            ) : null}
          </div>
        ) : null}
        {imaging && radiology && !item.latestReport ? (
          <form className="mv-stack" onSubmit={createReport}>
            <Field label="Findings" htmlFor={`findings-${item.id}`}><Textarea id={`findings-${item.id}`} value={findings} onChange={(event) => setFindings(event.target.value)} required minLength={2} /></Field>
            <Field label="Impression" htmlFor={`impression-${item.id}`}><Textarea id={`impression-${item.id}`} value={impression} onChange={(event) => setImpression(event.target.value)} required minLength={2} /></Field>
            <div className="mv-form-grid">
              <Field label="Report status"><Select value={reportStatus} onChange={(event) => setReportStatus(event.target.value as "preliminary" | "final")}><option value="preliminary">Preliminary</option><option value="final">Final</option></Select></Field>
            </div>
            <label className="mv-check"><input type="checkbox" checked={reportCritical} onChange={(event) => setReportCritical(event.target.checked)} /> Critical report</label>
            <Button type="submit" size="sm" disabled={action.busy !== null || findings.trim().length < 2 || impression.trim().length < 2}>{action.busy === "report" ? "Saving…" : "Save report"}</Button>
          </form>
        ) : null}
        {!lab && !imaging ? <EmptyState title="Other order" description="No diagnostic-specific workflow is available for this order type." /> : null}
      </div>
    </Card>
  );
}
