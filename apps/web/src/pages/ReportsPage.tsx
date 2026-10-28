import { useMemo, useState, type FormEvent } from "react";
import { Badge, Button, Card, DataList, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table } from "@medveris/ui";
import { ApiError, api, errorMessage } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useQuery } from "../lib/useQuery";

interface ReportInfo { id: string; title: string; description: string; category: string; sensitive: boolean; definitions: string[] }
interface ReportResult {
  metadata: { title: string; facility: string; from: string; to: string; timeZone: string; generatedAt: string; generatedBy: string; definitionVersion: string };
  columns: Array<{ key: string; label: string }>;
  definitions: string[];
  state: "ok" | "unavailable";
  rows: Array<Record<string, unknown>>;
  summary: Array<{ label: string; value: number | string | null; definition: string }>;
  notes: string[];
}

const PAGE_SIZE = 50;

function localDate(offsetDays = 0): string {
  const date = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Kampala" }).format(date);
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

export function ReportsPage() {
  const catalogue = useQuery<{ reports: ReportInfo[] }>("/reports");
  const [reportId, setReportId] = useState("");
  const [from, setFrom] = useState(localDate(-6));
  const [to, setTo] = useState(localDate());
  const [timeZone, setTimeZone] = useState("Africa/Kampala");
  const [result, setResult] = useState<ReportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const query = useMemo(() => new URLSearchParams({ from, to, timeZone }).toString(), [from, to, timeZone]);
  const grouped = useMemo(() => {
    const groups = new Map<string, ReportInfo[]>();
    for (const report of catalogue.data?.reports ?? []) groups.set(report.category, [...(groups.get(report.category) ?? []), report]);
    return [...groups.entries()];
  }, [catalogue.data]);

  async function run(event: FormEvent) {
    event.preventDefault();
    if (!reportId) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setPage(0);
    try {
      setResult(await api<ReportResult>(`/reports/${reportId}?${query}`));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function downloadCsv() {
    setError(null);
    try {
      const response = await fetch(`/api/v1/reports/${reportId}?${query}&format=csv`, { credentials: "same-origin", headers: { accept: "text/csv" } });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
        throw new ApiError(response.status, body?.error?.code ?? "request_failed", body?.error?.message ?? `Export failed (${response.status})`);
      }
      const blob = await response.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${reportId}-${from}-${to}.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  const selected = catalogue.data?.reports.find((report) => report.id === reportId);
  const rows = result?.rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) ?? [];

  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Reports" title="Facility and department reports" description="Every figure is calculated from stored records for your active facility. Reports you cannot see the source records for are not listed." />
      {catalogue.loading ? <LoadingState /> : catalogue.error ? <ErrorState message={catalogue.error} onRetry={catalogue.reload} /> : !catalogue.data?.reports.length ? (
        <EmptyState title="No reports for this role" description="Your active role has no reports. Switch facility context or ask an administrator." />
      ) : (
        <Card title="Run a report">
          <form className="mv-stack" onSubmit={run}>
            <Field label="Report"><Select value={reportId} onChange={(event) => { setReportId(event.target.value); setResult(null); }} required>
              <option value="">Select a report…</option>
              {grouped.map(([category, reports]) => (
                <optgroup key={category} label={category}>{reports.map((report) => <option key={report.id} value={report.id}>{report.title}</option>)}</optgroup>
              ))}
            </Select></Field>
            {selected ? <p className="mv-small mv-muted">{selected.description}{selected.sensitive ? " Viewing and exporting this report is audited." : ""}</p> : null}
            <div className="mv-form-grid">
              <Field label="From" htmlFor="report-from"><Input id="report-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} required /></Field>
              <Field label="To" htmlFor="report-to"><Input id="report-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} required /></Field>
              <Field label="Time zone" htmlFor="report-tz" hint="Days are counted in this time zone."><Input id="report-tz" value={timeZone} onChange={(event) => setTimeZone(event.target.value)} required /></Field>
            </div>
            <div className="mv-row">
              <Button type="submit" disabled={busy || !reportId}>{busy ? "Running…" : "Run report"}</Button>
              {result ? <Button type="button" variant="secondary" onClick={() => void downloadCsv()}>Download CSV</Button> : null}
              {result ? <Button type="button" variant="ghost" onClick={() => window.print()}>Print</Button> : null}
            </div>
          </form>
        </Card>
      )}
      {error ? <ErrorState message={error} /> : null}
      {result ? (
        <Card title={result.metadata.title} description={`${result.metadata.facility} · ${result.metadata.from} to ${result.metadata.to} (${result.metadata.timeZone}) · generated ${formatDateTime(result.metadata.generatedAt)} by ${result.metadata.generatedBy}`}>
          {result.state === "unavailable" ? <Notice tone="warning" title="Unavailable">These figures cannot be produced from the current data sources.</Notice> : null}
          {result.summary.length ? <DataList items={result.summary.map((item) => ({ label: item.label, value: <span title={item.definition}>{display(item.value)} <span className="mv-small mv-muted">— {item.definition}</span></span> }))} /> : null}
          {!result.rows.length ? <EmptyState title="No records in this period" description="The query ran successfully and found no matching records (a genuine zero)." /> : (
            <>
              <Table head={result.columns.map((column) => column.label)} caption={result.metadata.title}>
                {rows.map((row, index) => <tr key={index}>{result.columns.map((column) => <td key={column.key}>{display(row[column.key])}</td>)}</tr>)}
              </Table>
              {result.rows.length > PAGE_SIZE ? (
                <div className="mv-row">
                  <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
                  <span className="mv-small mv-muted">Rows {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, result.rows.length)} of {result.rows.length}</span>
                  <Button size="sm" variant="ghost" disabled={(page + 1) * PAGE_SIZE >= result.rows.length} onClick={() => setPage(page + 1)}>Next</Button>
                </div>
              ) : null}
            </>
          )}
          {result.notes.map((note) => <Badge key={note} tone="neutral">{note}</Badge>)}
          <details style={{ marginTop: 12 }}><summary className="mv-small">Definitions ({result.metadata.definitionVersion})</summary>
            <ul className="mv-small mv-muted">{result.definitions.map((definition) => <li key={definition}>{definition}</li>)}</ul>
          </details>
        </Card>
      ) : null}
    </div>
  );
}
