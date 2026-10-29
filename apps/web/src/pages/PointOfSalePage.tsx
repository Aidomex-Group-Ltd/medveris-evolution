import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, Notice, PageHeader, Table } from "@medveris/ui";
import { BillingBadge, RequestStatusBadge, VisitStateBadge } from "../components/WorkflowBadges";
import { api } from "../lib/api";
import { formatDateTime, formatMoney } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";
import { departmentLabel } from "../lib/workspace";
import type { BillingStatus, RecommendationStatus, VisitBoardEntry } from "../lib/types";

interface BillableLine {
  kind: "recommendation" | "supply";
  id: string;
  description: string;
  quantity: number;
  status: RecommendationStatus | null;
  department: string | null;
  billingStatus: BillingStatus;
  code: string | null;
  unitPrice: number | null;
  currency: string | null;
  amount: number | null;
  priced: boolean;
  invoice: { id: string; number: string } | null;
}

interface Billable {
  encounter: { id: string; state: string; openedAt: string; patient: { id: string; publicId: string; givenName: string; familyName: string } };
  recommendations: BillableLine[];
  supplies: BillableLine[];
  invoices: Array<{ id: string; number: string; status: string; currency: string; createdAt: string; total: number; paid: number; balance: number }>;
}

/** Till: choose a visit, add its recommended, completed and supplied work to the bill, then take payment. */
export function PointOfSalePage() {
  const [params, setParams] = useSearchParams();
  const encounterId = params.get("encounter");
  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Billing" title="Point of sale" description="Bill a visit from its requests and supplied items, then take cash or mobile money. Each item is charged once." />
      {encounterId ? <VisitBill encounterId={encounterId} onClose={() => setParams({})} /> : <VisitPicker onPick={(id) => setParams({ encounter: id })} />}
    </div>
  );
}

function VisitPicker({ onPick }: { onPick: (id: string) => void }) {
  const board = useQuery<{ visits: VisitBoardEntry[] }>("/visits/board");
  const open = useQuery<{ invoices: Array<{ id: string; number: string; givenName: string; familyName: string; total: string | number; paid: string | number; currency: string; status: string; createdAt: string }> }>("/invoices?status=part-paid");
  const visits = board.data?.visits ?? [];
  const toCollect = visits.filter((visit) => visit.billing.unbilledRequests + visit.billing.unbilledSupplies + visit.billing.unpaidRequests > 0 || (visit.billing.balance ?? 0) > 0);
  return (
    <>
      <Card title="Visits with charges to collect" description="Open visits and today's visits with unbilled items or a balance.">
        {board.loading ? <LoadingState /> : board.error ? <ErrorState message={board.error} onRetry={board.reload} /> : !toCollect.length ? (
          <EmptyState title="Nothing to collect" description="When a department or clinician records billable work for a visit, it appears here." action={<Link to="/visits">See all visits</Link>} />
        ) : (
          <Table head={["Patient", "Visit", "To bill", "Balance", ""]} caption="Visits to bill">
            {toCollect.map((visit) => (
              <tr key={visit.id}>
                <td><strong>{visit.patient.givenName} {visit.patient.familyName}</strong><div className="mv-small mv-muted mv-id">{visit.patient.publicId}</div></td>
                <td><VisitStateBadge state={visit.state} /><div className="mv-small mv-muted">{formatDateTime(visit.openedAt)}</div></td>
                <td>{visit.billing.unbilledRequests + visit.billing.unbilledSupplies ? <Badge tone="warning">{visit.billing.unbilledRequests + visit.billing.unbilledSupplies} not billed</Badge> : <span className="mv-small mv-muted">—</span>}</td>
                <td className="mv-money">{visit.billing.balance != null ? formatMoney(visit.billing.balance) : "—"}</td>
                <td><Button size="sm" onClick={() => onPick(visit.id)}>Open</Button></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {open.data?.invoices.length ? (
        <Card title="Part-paid bills">
          <Table head={["Bill", "Patient", "Balance", ""]} caption="Part-paid bills">
            {open.data.invoices.map((invoice) => (
              <tr key={invoice.id}>
                <td>{invoice.number}<div className="mv-small mv-muted">{formatDateTime(invoice.createdAt)}</div></td>
                <td>{invoice.givenName} {invoice.familyName}</td>
                <td className="mv-money">{formatMoney(Number(invoice.total) - Number(invoice.paid), invoice.currency)}</td>
                <td><Link className="mv-button mv-button--secondary mv-button--sm" to={`/finance/invoices/${invoice.id}`}>Take payment</Link></td>
              </tr>
            ))}
          </Table>
        </Card>
      ) : null}
    </>
  );
}

function VisitBill({ encounterId, onClose }: { encounterId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const billable = useQuery<Billable>(`/encounters/${encounterId}/billable`);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const action = useAction();
  const lines = useMemo(() => [...(billable.data?.recommendations ?? []), ...(billable.data?.supplies ?? [])], [billable.data]);
  const unbilled = lines.filter((line) => line.billingStatus === "unbilled");

  useEffect(() => {
    setSelected(new Set(unbilled.map((line) => `${line.kind}:${line.id}`)));
  }, [billable.data]);

  if (billable.loading && !billable.data) return <LoadingState label="Loading the visit's charges" variant="page" />;
  if (billable.error || !billable.data) return <ErrorState message={billable.error ?? "Visit not found"} onRetry={billable.reload} />;
  const data = billable.data;
  const chosen = unbilled.filter((line) => selected.has(`${line.kind}:${line.id}`));
  const unpriced = unbilled.filter((line) => !line.priced);
  const currency = chosen[0]?.currency ?? data.invoices[0]?.currency ?? "UGX";
  const subtotal = chosen.reduce((sum, line) => sum + (line.amount ?? 0), 0);
  const openInvoice = data.invoices.find((invoice) => invoice.status === "open" || invoice.status === "part-paid");

  function toggle(line: BillableLine) {
    const key = `${line.kind}:${line.id}`;
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  async function waiveSelected() {
    if (!chosen.length) {
      action.setError("Select the unbilled items to waive.");
      return;
    }
    const reason = window.prompt("Why are these items being waived? They stay visible on the visit and the waiver is audited. (at least 5 characters)");
    if (reason === null) return;
    if (reason.trim().length < 5) {
      action.setError("Give a waiver reason of at least 5 characters.");
      return;
    }
    await action.run("waive", async () => {
      const result = await api<{ requests: number; supplies: number }>(`/encounters/${encounterId}/waive`, {
        method: "POST",
        body: {
          recommendationIds: chosen.filter((line) => line.kind === "recommendation").map((line) => line.id),
          supplyUsageIds: chosen.filter((line) => line.kind === "supply").map((line) => line.id),
          reason: reason.trim(),
        },
      });
      setSelected(new Set());
      billable.reload();
      return `${result.requests + result.supplies} item(s) waived with a reason.`;
    });
  }

  async function addToBill() {
    let target: string | null = null;
    const ok = await action.run("bill", async () => {
      const result = await api<{ invoice: { id: string; number: string } | null; added: number; skipped: Array<{ description: string; reason: string }> }>(`/encounters/${encounterId}/bill`, {
        method: "POST",
        body: {
          recommendationIds: chosen.filter((line) => line.kind === "recommendation").map((line) => line.id),
          supplyUsageIds: chosen.filter((line) => line.kind === "supply").map((line) => line.id),
        },
      });
      target = result.invoice?.id ?? null;
      billable.reload();
      const skipped = result.skipped.length ? ` Skipped: ${result.skipped.map((row) => `${row.description} (${row.reason})`).join("; ")}.` : "";
      return result.added ? `${result.added} item(s) added to bill ${result.invoice?.number}.${skipped}` : `Nothing was added.${skipped}`;
    });
    if (ok && target) navigate(`/finance/invoices/${target}`);
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card
        title={`${data.encounter.patient.givenName} ${data.encounter.patient.familyName}`}
        description={`${data.encounter.patient.publicId} · visit opened ${formatDateTime(data.encounter.openedAt)}`}
        actions={<Button variant="ghost" size="sm" onClick={onClose}>Choose another visit</Button>}
      >
        <div className="mv-row" style={{ marginBottom: 12 }}>
          <Badge tone={unpriced.length ? "warning" : "success"}>{unpriced.length} item{unpriced.length === 1 ? "" : "s"} unpriced</Badge>
          <Badge tone={unbilled.length ? "warning" : "success"}>{unbilled.length} item{unbilled.length === 1 ? "" : "s"} unbilled</Badge>
          <span className="mv-small mv-muted">Every item must end up billed, waived with a reason or cancelled.</span>
        </div>
        {!lines.length ? <EmptyState title="No billable work recorded" description="Requests from the consultation or department, and supplied items, appear here." /> : (
          <Table head={["", "Item", "Status", "Qty", "Amount", "Bill"]} caption="Billable items for this visit">
            {lines.map((line) => {
              const key = `${line.kind}:${line.id}`;
              const selectable = line.billingStatus === "unbilled";
              return (
                <tr key={key}>
                  <td>{line.billingStatus === "unbilled" ? <input type="checkbox" aria-label={`Bill ${line.description}`} checked={selected.has(key)} disabled={!selectable} onChange={() => toggle(line)} /> : null}</td>
                  <td>
                    <strong>{line.description}</strong>
                    <div className="mv-small mv-muted">{line.kind === "supply" ? "Supplied item" : `Requested · ${departmentLabel(line.department ?? "other")}`}{line.code ? ` · ${line.code}` : ""}</div>
                    {!line.priced && line.billingStatus === "unbilled" ? <div className="mv-small" style={{ color: "var(--mv-warning)" }}>Not on the price list. <Link to="/price-list">Add a price</Link> or bill it as a manual line.</div> : null}
                  </td>
                  <td>{line.status ? <RequestStatusBadge status={line.status} /> : <Badge tone="neutral">Supplied</Badge>}</td>
                  <td>{line.quantity}</td>
                  <td className="mv-money">{line.amount != null ? formatMoney(line.amount, line.currency ?? currency) : "—"}</td>
                  <td>{line.invoice ? <Link to={`/finance/invoices/${line.invoice.id}`}>{line.invoice.number}</Link> : null} <BillingBadge status={line.billingStatus} /></td>
                </tr>
              );
            })}
          </Table>
        )}
        {unbilled.length ? (
          <div className="mv-spread" style={{ marginTop: 14 }}>
            <span>Selected: <strong className="mv-money">{formatMoney(subtotal, currency)}</strong> ({chosen.length} item{chosen.length === 1 ? "" : "s"}){openInvoice ? ` · added to ${openInvoice.number}` : " · a new bill will be opened"}</span>
            <div className="mv-row">
              <Button variant="secondary" onClick={() => void waiveSelected()} disabled={!chosen.length || action.busy !== null}>{action.busy === "waive" ? "Waiving…" : "Waive selected"}</Button>
              <Button onClick={() => void addToBill()} disabled={!chosen.length || action.busy !== null}>{action.busy === "bill" ? "Adding…" : "Add to bill"}</Button>
            </div>
          </div>
        ) : null}
      </Card>
      {data.invoices.length ? (
        <Card title="Bills for this visit">
          <Table head={["Bill", "Total", "Paid", "Balance", "Status", ""]} caption="Bills for this visit">
            {data.invoices.map((invoice) => (
              <tr key={invoice.id}>
                <td>{invoice.number}</td>
                <td className="mv-money">{formatMoney(invoice.total, invoice.currency)}</td>
                <td className="mv-money">{formatMoney(invoice.paid, invoice.currency)}</td>
                <td className="mv-money"><strong>{formatMoney(invoice.balance, invoice.currency)}</strong></td>
                <td><Badge tone={invoice.status === "paid" ? "success" : invoice.status === "part-paid" ? "warning" : "info"}>{invoice.status}</Badge></td>
                <td><Link className="mv-button mv-button--primary mv-button--sm" to={`/finance/invoices/${invoice.id}`}>{invoice.balance > 0 ? "Take payment" : "View"}</Link></td>
              </tr>
            ))}
          </Table>
        </Card>
      ) : null}
    </div>
  );
}
