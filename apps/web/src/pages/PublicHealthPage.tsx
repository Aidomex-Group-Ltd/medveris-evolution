import { useState, type FormEvent } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Table, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { formatDate, formatDateTime, todayInput } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";

interface AggregateCell { key: string; count: number | null }
interface Aggregate { total: number | null; suppressedCells: number; bySex: AggregateCell[]; byAgeBand: AggregateCell[]; caseDefinitionVersion: string; minCell: number; generatedAt: string }
interface Report { id: string; title: string; periodStart: string; periodEnd: string; conditionCode: string | null; caseDefinitionVersion: string; minCell: number; status: string; version: number; aggregate: Aggregate; createdAt: string; reviewedAt: string | null; releasedAt: string | null; releasedTo: string | null; programmeName: string | null; createdByName: string }

export function PublicHealthPage() {
  const reports = useQuery<{ reports: Report[] }>("/public-health/reports");
  const action = useAction();
  const [title, setTitle] = useState("");
  const [periodStart, setPeriodStart] = useState(todayInput());
  const [periodEnd, setPeriodEnd] = useState(todayInput());
  const [caseVersion, setCaseVersion] = useState("v1");
  const [minCell, setMinCell] = useState("5");
  const [conditionSystem, setConditionSystem] = useState("");
  const [conditionCode, setConditionCode] = useState("");

  async function create(event: FormEvent) {
    event.preventDefault();
    await action.run("create", async () => {
      await api("/public-health/reports", {
        method: "POST",
        body: { title, periodStart, periodEnd, conditionSystem, conditionCode, caseDefinitionVersion: caseVersion, minCell: Number(minCell) },
      });
      setTitle("");
      reports.reload();
      return "Aggregate report generated. Review it before release.";
    });
  }

  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Public health" title="Aggregate reporting" description="Reports contain aggregate counts only. Small cells below the configured minimum are suppressed; no identifiable data is released here." />
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title="Generate aggregate report" description="Counts are derived from recorded conditions for the selected period. A case-definition version is required.">
        <form className="mv-stack" onSubmit={create}>
          <div className="mv-form-grid">
            <Field label="Title" htmlFor="ph-title"><Input id="ph-title" value={title} onChange={(event) => setTitle(event.target.value)} required minLength={3} /></Field>
            <Field label="Period start" htmlFor="ph-start"><Input id="ph-start" type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} required /></Field>
            <Field label="Period end" htmlFor="ph-end"><Input id="ph-end" type="date" min={periodStart} value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} required /></Field>
            <Field label="Case definition version" htmlFor="ph-version"><Input id="ph-version" value={caseVersion} onChange={(event) => setCaseVersion(event.target.value)} required /></Field>
            <Field label="Minimum cell size" htmlFor="ph-min"><Input id="ph-min" type="number" min={2} max={100} value={minCell} onChange={(event) => setMinCell(event.target.value)} required /></Field>
            <Field label="Condition system URL" htmlFor="ph-system"><Input id="ph-system" type="url" value={conditionSystem} onChange={(event) => setConditionSystem(event.target.value)} /></Field>
            <Field label="Condition code" htmlFor="ph-code"><Input id="ph-code" value={conditionCode} onChange={(event) => setConditionCode(event.target.value)} /></Field>
          </div>
          <Button type="submit" disabled={action.busy !== null || !title || periodEnd < periodStart}>{action.busy === "create" ? "Generating…" : "Generate report"}</Button>
        </form>
      </Card>
      <Card title="Reports">
        {reports.loading ? <LoadingState /> : reports.error ? <ErrorState message={reports.error} onRetry={reports.reload} /> : !reports.data?.reports.length ? <EmptyState title="No reports" description="Generate an aggregate report above." /> : (
          <div className="mv-stack">
            {reports.data.reports.map((report) => <ReportCard key={report.id} report={report} onDone={reports.reload} />)}
          </div>
        )}
      </Card>
    </div>
  );
}

function ReportCard({ report, onDone }: { report: Report; onDone: () => void }) {
  const action = useAction();
  const [reviewNote, setReviewNote] = useState("");
  const [recipient, setRecipient] = useState("");
  const [purpose, setPurpose] = useState("");
  const [releaseNote, setReleaseNote] = useState("");

  async function review(decision: "reviewed" | "rejected") {
    await action.run("review", async () => {
      await api(`/public-health/reports/${report.id}/review`, { method: "POST", body: { decision, note: reviewNote, expectedVersion: report.version } });
      onDone();
      return `Report ${decision}.`;
    });
  }

  async function release(event: FormEvent) {
    event.preventDefault();
    await action.run("release", async () => {
      await api(`/public-health/reports/${report.id}/release`, { method: "POST", body: { recipient, purpose, note: releaseNote } });
      onDone();
      return "Report release recorded.";
    });
  }

  return (
    <div className="mv-note">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <div className="mv-spread">
        <div><strong>{report.title}</strong><div className="mv-small mv-muted">{formatDate(report.periodStart)} – {formatDate(report.periodEnd)} · {report.caseDefinitionVersion} · min cell {report.minCell}</div></div>
        <Badge tone={report.status === "released" ? "success" : report.status === "reviewed" ? "info" : report.status === "rejected" ? "danger" : "warning"}>{report.status}</Badge>
      </div>
      <div className="mv-small mv-muted">Generated {formatDateTime(report.createdAt)} by {report.createdByName}{report.conditionCode ? ` · condition ${report.conditionCode}` : ""}</div>
      <Table head={["Stratum", "Count"]} caption={`Aggregate for ${report.title}`}>
        <tr><td><strong>Total</strong></td><td>{report.aggregate.total ?? "suppressed"}</td></tr>
        {report.aggregate.byAgeBand.map((cell) => <tr key={`age-${cell.key}`}><td>Age {cell.key}</td><td>{cell.count ?? "suppressed"}</td></tr>)}
        {report.aggregate.bySex.map((cell) => <tr key={`sex-${cell.key}`}><td>Sex {cell.key}</td><td>{cell.count ?? "suppressed"}</td></tr>)}
      </Table>
      <div className="mv-small mv-muted">{report.aggregate.suppressedCells} suppressed small cell(s).</div>
      {report.status === "draft" ? (
        <div className="mv-stack mv-note" style={{ marginTop: 8 }}>
          <Field label="Review note (required)" htmlFor={`review-note-${report.id}`}><Textarea id={`review-note-${report.id}`} value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} required minLength={5} /></Field>
          <div className="mv-row"><Button size="sm" onClick={() => void review("reviewed")} disabled={action.busy !== null || reviewNote.trim().length < 5}>Mark reviewed</Button><Button size="sm" variant="ghost" onClick={() => void review("rejected")} disabled={action.busy !== null || reviewNote.trim().length < 5}>Reject</Button></div>
        </div>
      ) : null}
      {report.status === "reviewed" ? (
        <form className="mv-stack mv-note" onSubmit={release} style={{ marginTop: 8 }}>
          <div className="mv-form-grid">
            <Field label="Recipient" htmlFor={`recipient-${report.id}`}><Input id={`recipient-${report.id}`} value={recipient} onChange={(event) => setRecipient(event.target.value)} required minLength={2} /></Field>
            <Field label="Purpose" htmlFor={`purpose-${report.id}`}><Input id={`purpose-${report.id}`} value={purpose} onChange={(event) => setPurpose(event.target.value)} required minLength={5} /></Field>
          </div>
          <Field label="Release note" htmlFor={`release-note-${report.id}`}><Textarea id={`release-note-${report.id}`} value={releaseNote} onChange={(event) => setReleaseNote(event.target.value)} /></Field>
          <Button size="sm" type="submit" disabled={action.busy !== null || !recipient || purpose.trim().length < 5}>{action.busy === "release" ? "Releasing…" : "Record release"}</Button>
        </form>
      ) : null}
      {report.releasedAt ? <div className="mv-small mv-muted">Released {formatDateTime(report.releasedAt)} to {report.releasedTo}.</div> : null}
    </div>
  );
}
