import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Badge, Button, Card, Dialog, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Tabs, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { useQuery } from "../lib/useQuery";
import { useAction } from "../lib/useAction";
import { formatDateTime } from "../lib/format";

/**
 * Dedicated Observability Support Center. Platform operators only, reachable only at
 * /support-center — it is deliberately absent from every navigation area. All mutations
 * require a platform operator session with verified two-step verification and are audited.
 */

type Span = "24h" | "7d";
type TabId = "telemetry" | "alerting" | "ticketing" | "reporting";

interface SecurityEvents {
  generatedAt: string;
  span: string;
  totals: { events: number; denied: number };
  events: Array<{ action: string; decision: string | null; reasonCode: string | null; events: number }>;
}

interface AlertItem {
  id: string;
  kind: string;
  severity: string;
  title: string;
  externalRef: string;
  since: string | null;
}

interface Ticket {
  id: string;
  source: string;
  externalRef: string | null;
  category: string;
  severity: string;
  status: string;
  title: string;
  summary: string;
  resolution: string | null;
  assigneeUserId: string | null;
  openedBy: string;
  openedAt: string;
  acknowledgedAt: string | null;
  assignedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
}

interface TicketEvent {
  id: string;
  actorUserId: string | null;
  action: string;
  note: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface ReportingSummary {
  span: string;
  incidents: { byStatus: Array<{ status: string; count: number }>; bySeverity: Array<{ severity: string; count: number }>; byCategory: Array<{ category: string; count: number }> };
  lifecycle: { avgMinutesToAcknowledge: number | null; avgMinutesToClose: number | null };
  operatorActivity: Array<{ actorUserId: string; events: number }>;
}

function severityTone(severity: string): "danger" | "warning" | "info" | "neutral" {
  if (severity === "sev1" || severity === "sev2") return "danger";
  if (severity === "sev3") return "warning";
  return "info";
}

export function SupportCenterPage() {
  const [tab, setTab] = useState<TabId>("telemetry");
  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow="Restricted operations"
        title="Observability Support Center"
        description="Platform-operator incident response: telemetry, alerts, ticket lifecycle and reporting. Not part of facility or patient navigation; every action is audited."
      />
      <Tabs
        label="Support center modules"
        value={tab}
        onChange={(value) => setTab(value as TabId)}
        options={[
          { value: "telemetry", label: "Telemetry" },
          { value: "alerting", label: "Alerting" },
          { value: "ticketing", label: "Ticketing" },
          { value: "reporting", label: "Reporting" },
        ]}
      />
      {tab === "telemetry" ? <TelemetryModule /> : null}
      {tab === "alerting" ? <AlertingModule /> : null}
      {tab === "ticketing" ? <TicketingModule /> : null}
      {tab === "reporting" ? <ReportingModule /> : null}
    </div>
  );
}

function TelemetryModule() {
  const [span, setSpan] = useState<Span>("24h");
  const query = useQuery<SecurityEvents>(`/platform/observability/security-events?span=${span}`);
  const data = query.data;
  return (
    <Card title="Security and auth telemetry" description="Counts-only rollups of security-relevant audit events over the selected window. WAF and Bot signals remain in the Cloudflare dashboard."
      actions={<Select aria-label="Time window" value={span} onChange={(event) => setSpan(event.target.value as Span)}><option value="24h">24 hours</option><option value="7d">7 days</option></Select>}>
      {query.loading ? <LoadingState label="Loading telemetry" /> : query.error ? <ErrorState message={query.error} onRetry={query.reload} /> : !data ? <EmptyState title="No telemetry" description="The security-events rollup returned no data." /> : (
        <div className="mv-stack">
          <p className="mv-small">Generated {formatDateTime(data.generatedAt)} · {data.totals.events} event(s) · {data.totals.denied} denied</p>
          <Table head={["Action", "Decision", "Reason", "Events"]} caption="Security events by action">
            {data.events.length === 0 ? <tr><td colSpan={4}>No security-relevant events in the window.</td></tr> : data.events.map((row) => (
              <tr key={`${row.action}-${row.decision}-${row.reasonCode}`}>
                <td><code>{row.action}</code></td>
                <td>{row.decision ?? "—"}</td>
                <td>{row.reasonCode ?? "—"}</td>
                <td className="mv-money">{row.events.toLocaleString()}</td>
              </tr>
            ))}
          </Table>
        </div>
      )}
    </Card>
  );
}

function AlertingModule() {
  const alerts = useQuery<{ alerts: AlertItem[] }>("/support-center/alerts");
  const action = useAction();
  const [ticketFor, setTicketFor] = useState<AlertItem | null>(null);
  const [severity, setSeverity] = useState<"sev1" | "sev2" | "sev3" | "sev4">("sev3");
  const [category, setCategory] = useState<"availability" | "infrastructure" | "confidentiality" | "integrity" | "auth" | "clinical-sync" | "other">("infrastructure");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");

  useEffect(() => {
    setTitle(ticketFor ? ticketFor.title : "");
    setSummary(ticketFor ? `Opened from alert ${ticketFor.externalRef}. ${ticketFor.title}` : "");
    setSeverity((ticketFor?.severity as "sev2" | "sev3") ?? "sev3");
  }, [ticketFor]);

  async function openTicket(event: FormEvent) {
    event.preventDefault();
    if (!ticketFor) return;
    const ok = await action.run("open-ticket", async () => {
      await api("/support-center/tickets", {
        method: "POST",
        body: { title, summary, category, severity, source: "alert", externalRef: ticketFor.externalRef },
      });
      alerts.reload();
      setTicketFor(null);
      return "Incident ticket opened.";
    });
    if (ok) action.reset();
  }

  return (
    <Card title="Derived alerts" description="Signals derived from open high-severity tickets and background-job dead letters. Open a ticket directly from any alert.">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      {alerts.loading ? <LoadingState label="Loading alerts" /> : alerts.error ? <ErrorState message={alerts.error} onRetry={alerts.reload} /> : !alerts.data?.alerts.length ? (
        <Notice tone="info" title="No active alerts">No high-severity open tickets and no dead-lettered job events. Derived alerts appear here automatically.</Notice>
      ) : (
        <Table head={["Severity", "Kind", "Alert", "Since", ""]} caption="Active alerts">
          {alerts.data.alerts.map((alert) => (
            <tr key={alert.id}>
              <td><Badge tone={severityTone(alert.severity)}>{alert.severity}</Badge></td>
              <td>{alert.kind}</td>
              <td>{alert.title}</td>
              <td>{alert.since ? formatDateTime(alert.since) : "—"}</td>
              <td><Button variant="secondary" size="sm" onClick={() => setTicketFor(alert)}>Open ticket</Button></td>
            </tr>
          ))}
        </Table>
      )}
      <Dialog open={ticketFor !== null} onClose={() => setTicketFor(null)} title="Open incident ticket" description="The alert reference is attached so duplicate tickets are refused while one is open.">
        {ticketFor ? (
          <form className="mv-stack" onSubmit={(event) => void openTicket(event)}>
            <Field label="Title" htmlFor="alert-title"><Input id="alert-title" value={title} onChange={(event) => setTitle(event.target.value)} required minLength={8} maxLength={200} /></Field>
            <Field label="Summary" htmlFor="alert-summary" hint="What happened, blast radius and what you already checked."><Textarea id="alert-summary" value={summary} onChange={(event) => setSummary(event.target.value)} required minLength={20} maxLength={4000} /></Field>
            <div className="mv-grid mv-grid--2">
              <Field label="Severity" htmlFor="alert-severity"><Select id="alert-severity" value={severity} onChange={(event) => setSeverity(event.target.value as typeof severity)}><option value="sev1">sev1</option><option value="sev2">sev2</option><option value="sev3">sev3</option><option value="sev4">sev4</option></Select></Field>
              <Field label="Category" htmlFor="alert-category"><Select id="alert-category" value={category} onChange={(event) => setCategory(event.target.value as typeof category)}><option value="infrastructure">infrastructure</option><option value="availability">availability</option><option value="integrity">integrity</option><option value="confidentiality">confidentiality</option><option value="auth">auth</option><option value="clinical-sync">clinical-sync</option><option value="other">other</option></Select></Field>
            </div>
            <Button type="submit" variant="danger" busy={action.busy === "open-ticket"}>Open ticket</Button>
          </form>
        ) : null}
      </Dialog>
    </Card>
  );
}

function TicketingModule() {
  const [status, setStatus] = useState<"all" | "open" | "in_progress" | "resolved" | "closed">("open");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const query = useQuery<{ tickets: Ticket[] }>(status === "all" ? "/support-center/tickets" : `/support-center/tickets?status=${status}`);
  const tickets = query.data?.tickets ?? [];

  return (
    <Card title="Incident tickets" description="Open → acknowledge → assign → investigate → resolve → close. Every step is time-stamped and audited."
      actions={<Select aria-label="Filter by status" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="open">Open</option><option value="in_progress">In progress</option><option value="resolved">Resolved</option><option value="closed">Closed</option><option value="all">All</option></Select>}>
      {query.loading ? <LoadingState label="Loading tickets" /> : query.error ? <ErrorState message={query.error} onRetry={query.reload} /> : tickets.length === 0 ? (
        <EmptyState title="No tickets" description="No incidents match this filter. Tickets open from the Alerting module or manually by an operator." />
      ) : (
        <Table head={["Severity", "Status", "Title", "Opened", ""]} caption="Incidents">
          {tickets.map((ticket) => (
            <tr key={ticket.id}>
              <td><Badge tone={severityTone(ticket.severity)}>{ticket.severity}</Badge></td>
              <td><Badge tone="neutral">{ticket.status}</Badge></td>
              <td>{ticket.title}</td>
              <td>{formatDateTime(ticket.openedAt)}</td>
              <td><Button variant="ghost" size="sm" onClick={() => setSelectedId(ticket.id)}>Open</Button></td>
            </tr>
          ))}
        </Table>
      )}
      {selectedId ? <TicketDetailDialog id={selectedId} onClose={() => setSelectedId(null)} onChanged={query.reload} /> : null}
    </Card>
  );
}

function TicketDetailDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const detail = useQuery<{ ticket: Ticket; events: TicketEvent[] }>(`/support-center/tickets/${id}`);
  const operators = useQuery<{ operators: Array<{ userId: string; grantedAt: string | null; expiresAt: string | null }> }>("/support-center/operators");
  const action = useAction();
  const [note, setNote] = useState("");
  const [assignee, setAssignee] = useState("");
  const [resolution, setResolution] = useState("");
  const ticket = detail.data?.ticket;

  async function act(label: string, path: string, body: unknown) {
    const ok = await action.run(label, async () => {
      await api(`/support-center/tickets/${id}/${path}`, { method: "POST", body });
      detail.reload();
      onChanged();
      return "Saved.";
    });
    if (ok) setNote("");
    return ok;
  }

  return (
    <Dialog open onClose={onClose} title={ticket?.title ?? "Ticket"} description={ticket ? `${ticket.category} · ${ticket.severity} · opened ${formatDateTime(ticket.openedAt)}` : undefined}>
      {detail.loading ? <LoadingState label="Loading ticket" /> : detail.error ? <ErrorState message={detail.error} onRetry={detail.reload} /> : !ticket ? null : (
        <div className="mv-stack">
          <Notice tone="info" title={`Status: ${ticket.status}`}>
            {ticket.summary}
            {ticket.resolution ? <p><strong>Resolution:</strong> {ticket.resolution}</p> : null}
          </Notice>
          {action.error ? <ErrorState message={action.error} /> : null}
          {action.message ? <Notice tone="success">{action.message}</Notice> : null}
          {ticket.status === "open" ? <Button variant="primary" busy={action.busy === "acknowledge"} onClick={() => void act("acknowledge", "acknowledge", {})}>Acknowledge</Button> : null}
          {ticket.status === "open" || ticket.status === "in_progress" ? (
            <div className="mv-stack">
              <Field label="Assign to operator" htmlFor="assignee"><Select id="assignee" value={assignee} onChange={(event) => setAssignee(event.target.value)}><option value="">Select operator…</option>{operators.data?.operators.map((operator) => <option key={operator.userId} value={operator.userId}>{operator.userId} {operator.expiresAt ? `(until ${new Date(operator.expiresAt).toLocaleDateString()})` : ""}</option>)}</Select></Field>
              <Button variant="secondary" disabled={!assignee} busy={action.busy === "assign"} onClick={() => void act("assign", "assign", { assigneeUserId: assignee })}>Assign</Button>
            </div>
          ) : null}
          {ticket.status !== "closed" ? (
            <div className="mv-stack">
              <Field label="Add note" htmlFor="note"><Textarea id="note" value={note} onChange={(event) => setNote(event.target.value)} minLength={2} maxLength={4000} /></Field>
              <Button variant="secondary" disabled={note.trim().length < 2} busy={action.busy === "notes"} onClick={() => void act("notes", "notes", { note })}>Add note</Button>
            </div>
          ) : null}
          {ticket.status === "open" || ticket.status === "in_progress" ? (
            <div className="mv-stack">
              <Field label="Resolution" htmlFor="resolution" hint="What fixed it and what to watch."><Textarea id="resolution" value={resolution} onChange={(event) => setResolution(event.target.value)} minLength={5} maxLength={4000} /></Field>
              <Button variant="primary" disabled={resolution.trim().length < 5} busy={action.busy === "resolve"} onClick={() => void act("resolve", "resolve", { resolution })}>Resolve</Button>
            </div>
          ) : null}
          {ticket.status === "resolved" ? <Button variant="danger" busy={action.busy === "close"} onClick={() => void act("close", "close", {})}>Close incident</Button> : null}
          <div>
            <p className="mv-small mv-muted">Timeline</p>
            <Table head={["When", "Action", "Detail"]} caption="Ticket timeline">
              {detail.data?.events.map((event) => (
                <tr key={event.id}><td>{formatDateTime(event.createdAt)}</td><td>{event.action}</td><td>{event.note ?? ""}</td></tr>
              ))}
            </Table>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function ReportingModule() {
  const [span, setSpan] = useState<"24h" | "7d" | "30d">("7d");
  const query = useQuery<ReportingSummary>(`/support-center/reporting/summary?span=${span}`);
  const data = query.data;
  const incidentsTotal = useMemo(() => data?.incidents.byStatus.reduce((sum, row) => sum + row.count, 0) ?? 0, [data]);
  return (
    <Card title="Incident reporting" description="Lifecycle and operator-activity aggregates. Counts only; no patient or tenant data."
      actions={<Select aria-label="Reporting window" value={span} onChange={(event) => setSpan(event.target.value as typeof span)}><option value="24h">24 hours</option><option value="7d">7 days</option><option value="30d">30 days</option></Select>}>
      {query.loading ? <LoadingState label="Loading report" /> : query.error ? <ErrorState message={query.error} onRetry={query.reload} /> : !data ? <EmptyState title="No report" description="No aggregates available yet." /> : (
        <div className="mv-stack">
          <p className="mv-small">{incidentsTotal} incident(s) in window · avg acknowledge {data.lifecycle.avgMinutesToAcknowledge != null ? `${Math.round(data.lifecycle.avgMinutesToAcknowledge)} min` : "—"} · avg close {data.lifecycle.avgMinutesToClose != null ? `${Math.round(data.lifecycle.avgMinutesToClose)} min` : "—"}</p>
          <Table head={["By status", "Count"]} caption="Incidents by status">
            {data.incidents.byStatus.map((row) => <tr key={row.status}><td>{row.status}</td><td className="mv-money">{row.count}</td></tr>)}
          </Table>
          <Table head={["By severity", "Count"]} caption="Incidents by severity">
            {data.incidents.bySeverity.map((row) => <tr key={row.severity}><td>{row.severity}</td><td className="mv-money">{row.count}</td></tr>)}
          </Table>
          <Table head={["By category", "Count"]} caption="Incidents by category">
            {data.incidents.byCategory.map((row) => <tr key={row.category}><td>{row.category}</td><td className="mv-money">{row.count}</td></tr>)}
          </Table>
          <Table head={["Operator", "Events"]} caption="Operator activity">
            {data.operatorActivity.length === 0 ? <tr><td colSpan={2}>No operator activity recorded.</td></tr> : data.operatorActivity.map((row) => <tr key={row.actorUserId}><td><code>{row.actorUserId}</code></td><td className="mv-money">{row.events}</td></tr>)}
          </Table>
        </div>
      )}
    </Card>
  );
}
