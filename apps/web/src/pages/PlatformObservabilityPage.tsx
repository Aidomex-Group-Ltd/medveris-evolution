import { useState } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, Notice, PageHeader, Select, Table, Tabs } from "@medveris/ui";
import { formatDateTime } from "../lib/format";
import { useQuery } from "../lib/useQuery";

type Span = "1h" | "6h" | "24h" | "7d";
type TabId = "overview" | "api-metrics" | "workers" | "logs" | "traces" | "jobs" | "integrations" | "security";

interface Envelope<T> {
  ok: boolean;
  data: T | null;
  error: string | null;
  source: string;
  fetchedAt: string;
  stale: boolean;
  timeRange: { start: string; end: string; span: string };
}

interface OverviewData {
  generatedAt: string;
  span: string;
  configured: boolean;
  cache: { ttlMs: number; entries: number };
  local: {
    database: string;
    replica: { state: string; lagMs: number | null; reason: string | null };
    breakers: Array<{ name: string; state: string }>;
    latency: { count: number; p50: number | null; p95: number | null; p99: number | null };
    features: Record<string, boolean>;
  };
  cloudflare: {
    scripts: Envelope<Array<{ id: string; title: string; modified_on: string }>>;
    invocations: Envelope<Array<{ scriptName: string | null; invocationCount: number; errorCount: number; durationP99Ms: number | null; cpuTimeP99Ms: number | null; outcomeCounts: Record<string, number> }>>;
  };
}

interface WorkersData {
  generatedAt: string;
  span: string;
  configured: boolean;
  scripts: Envelope<Array<{ id: string; title: string; modified_on: string; usage_model?: string }>>;
  invocations: Envelope<Array<{ scriptName: string | null; invocationCount: number; errorCount: number; durationP99Ms: number | null; cpuTimeP99Ms: number | null; outcomeCounts: Record<string, number> }>>;
}

interface ApiMetricsData {
  generatedAt: string;
  span: string;
  configured: boolean;
  local: { latency: { count: number; p50: number | null; p95: number | null; p99: number | null }; scope: string };
  cloudflare: Envelope<Array<Record<string, unknown> & { requests?: number; date?: string | null; clientCountryName?: string | null }>>;
}

interface LogsData {
  generatedAt: string;
  span: string;
  configured: boolean;
  note: string;
  cloudflare: Envelope<Array<{ timestamp: string; level: string; event: string | null; route: string | null; message: string | null }>>;
}

interface TracesData {
  generatedAt: string;
  span: string;
  configured: boolean;
  note: string;
  cloudflare: Envelope<Array<{ traceId: string; rootRoute: string | null; startedAt: string; durationMs: number | null; spanCount: number }>>;
}

interface JobsData {
  generatedAt: string;
  source: string;
  outbox: Array<{ status: string; events: number; oldestSeconds: number; maxAttempts: number }>;
  relay: { batchSize: number; perTenantBatchLimit: number };
}

interface IntegrationsData {
  generatedAt: string;
  source: string;
  integrations: Array<{ id: string; name: string; state: string; reason: string; requested: boolean; adapterImplemented: boolean; lastVerificationOutcome: string; lastSuccessfulVerificationAt: string | null }>;
}

interface SecurityData {
  generatedAt: string;
  source: string;
  note: string;
  rateLimit: { trustForwardedFor: boolean; distributed: boolean; overrideCount: number };
  breakers: Array<{ name: string; state: string }>;
  latency: { count: number; p50: number | null; p95: number | null; p99: number | null };
}

const SPAN_OPTIONS: { value: Span; label: string }[] = [
  { value: "1h", label: "Last hour" },
  { value: "6h", label: "Last 6 hours" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
];

function envelopeNote(envelope: Envelope<unknown> | null | undefined): string | null {
  if (!envelope) return null;
  if (envelope.stale) return "Showing the last successful snapshot; the latest Cloudflare refresh failed.";
  if (!envelope.ok && envelope.error) return envelope.error;
  return null;
}

function EnvelopeBadge({ envelope }: { envelope: Envelope<unknown> | null | undefined }) {
  if (!envelope) return null;
  if (envelope.stale) return <Badge tone="warning">stale</Badge>;
  if (!envelope.ok) return <Badge tone="danger">unavailable</Badge>;
  return <Badge tone="success">live</Badge>;
}

export function PlatformObservabilityPage() {
  const [tab, setTab] = useState<TabId>("overview");
  const [span, setSpan] = useState<Span>("1h");
  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow="Platform operations"
        title="Observability"
        description="Cloudflare Workers Logs, traces and metrics, plus this deployment's outbox and integration health. The Cloudflare API token stays on the server; no patient data is shown."
        actions={
          <Select aria-label="Time range" value={span} onChange={(event) => setSpan(event.target.value as Span)}>
            {SPAN_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select>
        }
      />
      <Tabs
        label="Observability sections"
        value={tab}
        onChange={setTab}
        options={[
          { value: "overview", label: "Overview" },
          { value: "api-metrics", label: "API metrics" },
          { value: "workers", label: "Workers" },
          { value: "logs", label: "Logs" },
          { value: "traces", label: "Traces" },
          { value: "jobs", label: "Jobs and queues" },
          { value: "integrations", label: "Integrations" },
          { value: "security", label: "Security" },
        ]}
      />
      {tab === "overview" ? <OverviewTab span={span} /> : null}
      {tab === "api-metrics" ? <ApiMetricsTab span={span} /> : null}
      {tab === "workers" ? <WorkersTab span={span} /> : null}
      {tab === "logs" ? <LogsTab span={span} /> : null}
      {tab === "traces" ? <TracesTab span={span} /> : null}
      {tab === "jobs" ? <JobsTab /> : null}
      {tab === "integrations" ? <IntegrationsTab /> : null}
      {tab === "security" ? <SecurityTab /> : null}
    </div>
  );
}

function OverviewTab({ span }: { span: Span }) {
  const query = useQuery<OverviewData>(`/platform/observability/overview?span=${span}`);
  if (query.loading) return <LoadingState />;
  if (query.error) return <ErrorState message={query.error} onRetry={query.reload} />;
  if (!query.data) return null;
  const data = query.data;
  const inv = data.cloudflare.invocations;
  const scripts = data.cloudflare.scripts;
  return (
    <div className="mv-stack">
      {!data.configured ? (
        <Notice tone="warning" title="Cloudflare observability is not configured">
          Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID as Worker secrets, then enable CLOUDFLARE_OBSERVABILITY_ENABLED. Local counters below are always live.
        </Notice>
      ) : null}
      <Card title="Local instance" description={`Generated ${formatDateTime(data.generatedAt)} · span ${data.span}`}>
        <div className="mv-row">
          <Badge tone={data.local.database === "reachable" ? "success" : "danger"}>database {data.local.database}</Badge>
          <Badge tone={data.local.replica.state === "healthy" || data.local.replica.state === "absent" ? "success" : "warning"}>replica {data.local.replica.state}</Badge>
          <Badge tone={data.local.features.cloudflareObservability ? "success" : "neutral"}>cloudflare {data.local.features.cloudflareObservability ? "configured" : "unavailable"}</Badge>
        </div>
        <p className="mv-small mv-muted">
          Latency p50 {data.local.latency.p50 ?? "—"} ms · p95 {data.local.latency.p95 ?? "—"} ms · p99 {data.local.latency.p99 ?? "—"} ms · cache entries {data.cache.entries} · TTL {Math.round(data.cache.ttlMs / 1000)}s
        </p>
        <Table head={["Breaker", "State"]} caption="Dependency breakers">
          {data.local.breakers.map((breaker) => (
            <tr key={breaker.name}>
              <td>{breaker.name}</td>
              <td><Badge tone={breaker.state === "closed" ? "success" : breaker.state === "open" ? "danger" : "warning"}>{breaker.state}</Badge></td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card
        title="Workers invocations"
        description={`Cloudflare account roll-ups for the selected span. ${envelopeNote(inv) ?? ""}`}
        actions={<div className="mv-row"><EnvelopeBadge envelope={inv} /><Button size="sm" variant="ghost" onClick={query.reload}>Refresh</Button></div>}
      >
        {!inv.ok || !inv.data?.length ? <EmptyState title="No invocation data" description={envelopeNote(inv) ?? "Cloudflare returned no Workers invocations for this span. Ensure Workers Observability is enabled for the account."} /> : (
          <Table head={["Script", "Invocations", "Errors", "CPU p99", "Duration p99"]} caption="Workers invocations">
            {inv.data.map((row) => (
              <tr key={row.scriptName ?? "unknown"}>
                <td>{row.scriptName ?? "unknown"}</td>
                <td className="mv-money">{row.invocationCount.toLocaleString()}</td>
                <td className="mv-money">{row.errorCount.toLocaleString()}</td>
                <td className="mv-money">{row.cpuTimeP99Ms != null ? `${Math.round(row.cpuTimeP99Ms)} ms` : "—"}</td>
                <td className="mv-money">{row.durationP99Ms != null ? `${Math.round(row.durationP99Ms)} ms` : "—"}</td>
              </tr>
            ))}
          </Table>
        )}
        {scripts.ok && scripts.data?.length ? (
          <p className="mv-small mv-muted">{scripts.data.length} Worker script(s) registered on this account.</p>
        ) : null}
      </Card>
    </div>
  );
}

function ApiMetricsTab({ span }: { span: Span }) {
  const query = useQuery<ApiMetricsData>(`/platform/observability/api-metrics?span=${span}`);
  if (query.loading) return <LoadingState />;
  if (query.error) return <ErrorState message={query.error} onRetry={query.reload} />;
  if (!query.data) return null;
  const data = query.data;
  const metrics = data.cloudflare;
  return (
    <div className="mv-stack">
      <Card title="Local request latency" description={data.local.scope}>
        <p className="mv-small">
          p50 {data.local.latency.p50 ?? "—"} ms · p95 {data.local.latency.p95 ?? "—"} ms · p99 {data.local.latency.p99 ?? "—"} ms · samples {data.local.latency.count}
        </p>
      </Card>
      <Card title="Cloudflare HTTP metrics" description={envelopeNote(metrics) ?? `Account-wide requests for span ${data.span}.`} actions={<EnvelopeBadge envelope={metrics} />}>
        {!metrics.ok || !metrics.data?.length ? (
          <EmptyState title="No Cloudflare metrics" description={envelopeNote(metrics) ?? "No HTTP request groups were returned for this span."} />
        ) : (
          <Table head={["Date", "Country", "Requests", "Cached", "Bytes"]} caption="Cloudflare HTTP request metrics">
            {metrics.data.slice(0, 20).map((row, index) => (
              <tr key={`${row.date ?? "x"}-${row.clientCountryName ?? "x"}-${index}`}>
                <td>{row.date ?? "—"}</td>
                <td>{row.clientCountryName ?? "—"}</td>
                <td className="mv-money">{Number(row.requests ?? 0).toLocaleString()}</td>
                <td className="mv-money">{Number(row.cachedRequests ?? 0).toLocaleString()}</td>
                <td className="mv-money">{Number(row.bytes ?? 0).toLocaleString()}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function WorkersTab({ span }: { span: Span }) {
  const query = useQuery<WorkersData>(`/platform/observability/workers?span=${span}`);
  if (query.loading) return <LoadingState />;
  if (query.error) return <ErrorState message={query.error} onRetry={query.reload} />;
  if (!query.data) return null;
  const data = query.data;
  return (
    <div className="mv-stack">
      <Card title="Registered scripts" description={envelopeNote(data.scripts) ?? "Workers on this Cloudflare account."} actions={<EnvelopeBadge envelope={data.scripts} />}>
        {!data.scripts.ok || !data.scripts.data?.length ? (
          <EmptyState title="No scripts" description={envelopeNote(data.scripts) ?? "No Workers scripts were returned."} />
        ) : (
          <Table head={["Script", "ID", "Modified", "Usage model"]} caption="Workers scripts">
            {data.scripts.data.map((script) => (
              <tr key={script.id}>
                <td><strong>{script.title}</strong></td>
                <td className="mv-small mv-muted">{script.id}</td>
                <td>{formatDateTime(script.modified_on)}</td>
                <td>{script.usage_model ?? "—"}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="Invocation outcomes" description={envelopeNote(data.invocations) ?? `Aggregated outcomes for span ${data.span}.`} actions={<EnvelopeBadge envelope={data.invocations} />}>
        {!data.invocations.ok || !data.invocations.data?.length ? (
          <EmptyState title="No invocations" description={envelopeNote(data.invocations) ?? "No Workers invocations were returned for this span."} />
        ) : (
          <Table head={["Script", "Invocations", "Errors", "Outcomes"]} caption="Workers outcomes">
            {data.invocations.data.map((row) => (
              <tr key={row.scriptName ?? "unknown"}>
                <td>{row.scriptName ?? "unknown"}</td>
                <td className="mv-money">{row.invocationCount.toLocaleString()}</td>
                <td className="mv-money">{row.errorCount.toLocaleString()}</td>
                <td className="mv-small">{Object.entries(row.outcomeCounts).map(([outcome, count]) => `${outcome}: ${count}`).join(" · ") || "—"}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function LogsTab({ span }: { span: Span }) {
  const query = useQuery<LogsData>(`/platform/observability/logs?span=${span}`);
  if (query.loading) return <LoadingState />;
  if (query.error) return <ErrorState message={query.error} onRetry={query.reload} />;
  if (!query.data) return null;
  const data = query.data;
  const logs = data.cloudflare;
  return (
    <div className="mv-stack">
      <Notice tone="info" title="Privacy">{data.note}</Notice>
      <Card title="Workers log roll-ups" description={envelopeNote(logs) ?? `Invocation-level summary for span ${data.span}.`} actions={<EnvelopeBadge envelope={logs} />}>
        {!logs.ok || !logs.data?.length ? (
          <EmptyState title="No log roll-ups" description={envelopeNote(logs) ?? "No Workers invocations were returned for this span."} />
        ) : (
          <Table head={["Timestamp", "Level", "Script", "Message"]} caption="Workers log roll-ups">
            {logs.data.slice(0, 50).map((row, index) => (
              <tr key={`${row.timestamp}-${index}`}>
                <td>{formatDateTime(row.timestamp)}</td>
                <td><Badge tone={row.level === "error" ? "danger" : "neutral"}>{row.level}</Badge></td>
                <td>{row.route ?? "—"}</td>
                <td className="mv-small">{row.message ?? "—"}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function TracesTab({ span }: { span: Span }) {
  const query = useQuery<TracesData>(`/platform/observability/traces?span=${span}`);
  if (query.loading) return <LoadingState />;
  if (query.error) return <ErrorState message={query.error} onRetry={query.reload} />;
  if (!query.data) return null;
  const data = query.data;
  const traces = data.cloudflare;
  return (
    <div className="mv-stack">
      <Notice tone="info" title="Roll-ups only">{data.note}</Notice>
      <Card title="Trace summaries" description={envelopeNote(traces) ?? `Duration shape for span ${data.span}.`} actions={<EnvelopeBadge envelope={traces} />}>
        {!traces.ok || !traces.data?.length ? (
          <EmptyState title="No traces" description={envelopeNote(traces) ?? "No Workers invocations were returned for this span."} />
        ) : (
          <Table head={["Started", "Script", "Invocations", "Max duration"]} caption="Trace roll-ups">
            {traces.data.map((row) => (
              <tr key={row.traceId}>
                <td>{formatDateTime(row.startedAt)}</td>
                <td>{row.rootRoute ?? "—"}</td>
                <td className="mv-money">{row.spanCount.toLocaleString()}</td>
                <td className="mv-money">{row.durationMs != null ? `${Math.round(row.durationMs)} ms` : "—"}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function JobsTab() {
  const query = useQuery<JobsData>("/platform/observability/jobs");
  if (query.loading) return <LoadingState />;
  if (query.error) return <ErrorState message={query.error} onRetry={query.reload} />;
  if (!query.data) return null;
  const data = query.data;
  return (
    <div className="mv-stack">
      <Card title="Outbox backlog" description={`Relay batch size ${data.relay.batchSize} · per-tenant limit ${data.relay.perTenantBatchLimit} · source ${data.source}`}>
        {!data.outbox.length ? (
          <EmptyState title="Outbox is clear" description="No pending or failed outbox events were returned by app.outbox_backlog()." />
        ) : (
          <Table head={["Status", "Events", "Oldest (s)", "Max attempts"]} caption="Outbox backlog">
            {data.outbox.map((row) => (
              <tr key={row.status}>
                <td><Badge tone={row.status === "failed" ? "danger" : row.status === "pending" ? "warning" : "neutral"}>{row.status}</Badge></td>
                <td className="mv-money">{row.events.toLocaleString()}</td>
                <td className="mv-money">{row.oldestSeconds}</td>
                <td className="mv-money">{row.maxAttempts}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function IntegrationsTab() {
  const query = useQuery<IntegrationsData>("/platform/observability/integrations");
  if (query.loading) return <LoadingState />;
  if (query.error) return <ErrorState message={query.error} onRetry={query.reload} />;
  if (!query.data) return null;
  return (
    <div className="mv-stack">
      <Card title="Integration adapters" description="Adapter state from this deployment's registry; a passing conformance run is required before an implemented adapter is available.">
        {!query.data.integrations.length ? (
          <EmptyState title="No integrations" description="The integration registry is empty for this deployment." />
        ) : (
          <Table head={["Integration", "State", "Requested", "Verification", "Reason"]} caption="Integration status">
            {query.data.integrations.map((row) => (
              <tr key={row.id}>
                <td><strong>{row.name}</strong><div className="mv-small mv-muted">{row.id}</div></td>
                <td><Badge tone={row.state === "available" ? "success" : row.state === "disabled" || row.state === "not_requested" ? "neutral" : "warning"}>{row.state}</Badge></td>
                <td>{row.requested ? "yes" : "no"}</td>
                <td>{row.lastVerificationOutcome}</td>
                <td className="mv-small">{row.reason}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function SecurityTab() {
  const query = useQuery<SecurityData>("/platform/observability/security");
  if (query.loading) return <LoadingState />;
  if (query.error) return <ErrorState message={query.error} onRetry={query.reload} />;
  if (!query.data) return null;
  const data = query.data;
  return (
    <div className="mv-stack">
      <Notice tone="info" title="Scope">{data.note}</Notice>
      <Card title="Rate limiting and breakers" description={`Source ${data.source}`}>
        <div className="mv-row">
          <Badge tone={data.rateLimit.distributed ? "success" : "neutral"}>distributed rate limit {data.rateLimit.distributed ? "on" : "off"}</Badge>
          <Badge tone={data.rateLimit.trustForwardedFor ? "warning" : "success"}>trust X-Forwarded-For {data.rateLimit.trustForwardedFor ? "on" : "off"}</Badge>
          <Badge tone="neutral">{data.rateLimit.overrideCount} override(s)</Badge>
        </div>
        <p className="mv-small mv-muted">Request latency p50 {data.latency.p50 ?? "—"} ms · p95 {data.latency.p95 ?? "—"} ms · p99 {data.latency.p99 ?? "—"} ms</p>
        <Table head={["Breaker", "State"]} caption="Dependency breakers">
          {data.breakers.map((breaker) => (
            <tr key={breaker.name}>
              <td>{breaker.name}</td>
              <td><Badge tone={breaker.state === "closed" ? "success" : breaker.state === "open" ? "danger" : "warning"}>{breaker.state}</Badge></td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
