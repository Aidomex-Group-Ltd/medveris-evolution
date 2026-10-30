import { useState } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Field, LoadingState, Notice, PageHeader, Select, Table } from "@medveris/ui";
import { api } from "../lib/api";
import { SubscriptionCheckoutPanel } from "../components/SubscriptionCheckoutPanel";
import { formatDate, formatDateTime } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";

interface StatusSummary {
  status: string | null;
  label: string;
  accessMode?: string;
  trialEndsAt?: string | null;
  trialDaysRemaining?: number | null;
}
interface BillingStatus {
  enforcement: string;
  accessMode: string;
  restrictedCapabilities: string[];
  billing: StatusSummary & { canManage?: boolean; accountKind?: string };
}
interface PlanRule {
  resource: string; name: string; unit: string; treatment: string;
  includedQuantity: number | null; limitQuantity: number | null; unitRateMinor: number | null; rateUnitQuantity: number;
}
interface Plan {
  id: string; code: string; version: number; name: string; description: string; status: string;
  currency: string; monthlyPriceMinor: number | null; maxMonthlyChargeMinor: number | null;
  usageOverages: boolean; features: string[]; contractRequired: boolean; rules?: PlanRule[];
}
interface Notification { id: string; kind: string; title: string; body: string; createdAt: string; readAt: string | null }
interface SubscriptionEvent { event: string; fromStatus: string | null; toStatus: string | null; detail: unknown; occurredAt: string; actorKind: string; actorName: string | null }
interface Invoice { id: string; number: string; kind: string; periodStart: string; periodEnd: string; totalMinor: number; status: string; issuedAt: string; dueAt: string; paidAt: string | null }
interface Overview {
  account: { id: string; kind: string; name: string; canManage: boolean; workspaces: Array<{ id: string; name: string }> };
  subscription: {
    status: string; label: string; accessMode: string; id: string; version: number; plan: Plan;
    trialStartedAt: string | null; trialEndsAt: string | null; currentPeriodStart: string | null; currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean; pendingPlan: { id: string; name: string; monthlyPriceMinor: number } | null;
  };
  enforcement: string;
  usage: {
    periodStart: string; resources: Array<{ resource: string; name: string; unit: string; treatment: string; quantity: number; includedQuantity: number | null; limitQuantity: number | null }>;
    byWorkspace: Array<{ tenantId: string; name: string; resource: string; quantity: number }>;
    unverifiedEvents: number; projectedChargeMinor: number | null;
    estimate: { baseMinor: number; usageMinor: number; totalMinor: number; eligible: boolean; reasons: string[] } | null;
  };
  recommendation: { recommendedName: string; estimatedMonthlyMinor: number | null; explanation: string | null } | null;
  plans: Plan[];
  invoices: Invoice[];
  notifications: Notification[];
  events: SubscriptionEvent[];
}
interface Quote {
  change: "start" | "upgrade" | "downgrade";
  plan: { id: string; code: string; version: number; name: string; monthlyPriceMinor: number; currency: string };
  effective: "trial-end" | "now" | "period-end";
  effectiveAt: string | null;
  firstChargeMinor: number;
  prorationMinor: number;
  disclosure: string;
  disclosureDigest: string;
}

const cents = (value: number | null | undefined, currency = "USD") =>
  value == null ? "—" : `${currency} ${(value / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const statusTone = (status: string) =>
  status === "active" || status === "trialing" ? "success"
    : status === "suspended" || status === "trial_expired" ? "danger"
      : status === "restricted" || status === "past_due" ? "warning" : "neutral";

export function SubscriptionPage() {
  const status = useQuery<BillingStatus>("/billing/status");
  if (status.loading && !status.data) return <LoadingState label="Loading subscription" variant="page" />;
  if (status.error || !status.data) return <ErrorState message={status.error ?? "Subscription not available"} onRetry={status.reload} />;
  const billing = status.data.billing;
  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Account" title="Subscription and usage" description="Your plan, free trial, measured use and invoices. Patient records are never deleted when a payment is overdue." />
      <Notice tone={billing.accessMode === "restricted" ? "warning" : "info"} title={billing.label}>
        {status.data.enforcement === "enforce" && billing.accessMode !== "full"
          ? `Some capabilities are paused: ${status.data.restrictedCapabilities.join(", ") || "billing-sensitive actions"}. Clinical records remain available.`
          : status.data.enforcement === "notify"
            ? "Billing status is shown for information during staging; capabilities are not paused."
            : "Full access is available."}
        {billing.trialEndsAt ? ` The free trial ends on ${formatDate(billing.trialEndsAt)}${billing.trialDaysRemaining != null ? ` (${billing.trialDaysRemaining} day${billing.trialDaysRemaining === 1 ? "" : "s"} left)` : ""}.` : ""}
      </Notice>
      {billing.canManage ? <Manageable overviewRefresh={status.reload} /> : (
        <Card title="Billing details">
          <p className="mv-muted">A workspace owner or administrator can see the plan, usage and invoices.</p>
        </Card>
      )}
      <Notice tone="info" title="Free onboarding">
        Creating a workspace is free and starts a trial. There is no onboarding fee; choose a paid plan only when you are ready, and review the exact terms before accepting.
      </Notice>
    </div>
  );
}

function Manageable({ overviewRefresh }: { overviewRefresh: () => void }) {
  const overview = useQuery<Overview>("/billing/overview");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [planId, setPlanId] = useState("");
  const action = useAction();
  if (overview.loading && !overview.data) return <LoadingState label="Loading plan and usage" variant="page" />;
  if (overview.error || !overview.data) {
    const message = overview.error ?? "Billing overview not available";
    return <ErrorState message={message.includes("no subscription") ? "This account has no subscription yet. Contact Medveris support to have billing enabled." : message} onRetry={overview.reload} />;
  }
  const data = overview.data;
  const subscription = data.subscription;
  const choosable = data.plans.filter((plan) => plan.code !== "trial" && plan.status === "approved" && plan.monthlyPriceMinor != null && !plan.contractRequired && plan.id !== subscription.plan.id);

  async function getQuote() {
    if (!planId) {
      action.setError("Choose a plan to review.");
      return;
    }
    setQuote(null);
    await action.run("quote", async () => {
      const result = await api<{ quote: Quote }>("/billing/subscription/quote", { method: "POST", body: { planId } });
      setQuote(result.quote);
    });
  }

  async function accept() {
    if (!quote) return;
    await action.run("accept", async () => {
      const result = await api<{ invoice: { number: string } | null }>("/billing/subscription/accept", {
        method: "POST",
        body: { planId: quote.plan.id, disclosureDigest: quote.disclosureDigest, accept: true },
      });
      setQuote(null);
      setPlanId("");
      overview.reload();
      overviewRefresh();
      return result.invoice ? `Plan accepted. Invoice ${result.invoice.number} was issued.` : "Plan change scheduled. Your current plan continues until the effective date.";
    });
  }

  async function cancel() {
    const reason = window.prompt("Why are you cancelling? (at least 3 characters). You keep access until the end of the paid month.");
    if (reason === null) return;
    if (reason.trim().length < 3) {
      action.setError("Give a cancellation reason of at least 3 characters.");
      return;
    }
    await action.run("cancel", async () => {
      await api("/billing/subscription/cancel", { method: "POST", body: { reason: reason.trim() } });
      overview.reload();
      overviewRefresh();
      return "Subscription cancelled at the end of the current period.";
    });
  }

  async function resume() {
    await action.run("resume", async () => {
      await api("/billing/subscription/resume", { method: "POST" });
      overview.reload();
      overviewRefresh();
      return "Subscription resumed.";
    });
  }

  async function markRead(id: string) {
    await action.run(id, async () => {
      await api(`/billing/notifications/${id}/read`, { method: "POST" });
      overview.reload();
    });
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <SubscriptionCheckoutPanel />
      <div className="mv-grid mv-grid--3">
        <Card title="Current plan" description={data.account.name}>
          <p className="mv-metric">{subscription.plan.name}</p>
          <div className="mv-row">
            <Badge tone={statusTone(subscription.status)}>{subscription.label}</Badge>
            <span className="mv-small mv-muted">{cents(subscription.plan.monthlyPriceMinor)} / month</span>
          </div>
          {subscription.trialEndsAt ? <p className="mv-small mv-muted">Trial ends {formatDate(subscription.trialEndsAt)}</p> : null}
          {subscription.pendingPlan ? <Notice tone="info">Starts {subscription.pendingPlan.name} ({cents(subscription.pendingPlan.monthlyPriceMinor)} / month) when the current period ends.</Notice> : null}
        </Card>
        <Card title="This period" description={subscription.currentPeriodStart ? `${formatDate(subscription.currentPeriodStart)} – ${formatDate(subscription.currentPeriodEnd)}` : "No current period"}>
          <p className="mv-metric">{data.usage.projectedChargeMinor == null ? "—" : cents(data.usage.projectedChargeMinor)}</p>
          <p className="mv-small mv-muted">{subscription.status === "trialing" ? "Trial use is measured but never charged." : "Projected charge, including measured use."}</p>
          {data.recommendation ? <p className="mv-small">Suggested: <strong>{data.recommendation.recommendedName}</strong>{data.recommendation.estimatedMonthlyMinor != null ? ` at ${cents(data.recommendation.estimatedMonthlyMinor)}` : ""}. {data.recommendation.explanation}</p> : null}
        </Card>
        <Card title="Account">
          <p className="mv-small mv-muted">{data.account.kind} · {data.account.workspaces.length} workspace{data.account.workspaces.length === 1 ? "" : "s"}</p>
          <p className="mv-small">{data.account.workspaces.map((workspace) => workspace.name).join(", ")}</p>
          <div className="mv-row">
            {subscription.status === "cancelled" ? <Button size="sm" onClick={() => void resume()} disabled={action.busy !== null}>Resume</Button> : (
              <Button size="sm" variant="secondary" onClick={() => void cancel()} disabled={action.busy !== null}>Cancel at period end</Button>
            )}
          </div>
        </Card>
      </div>

      <Card title="Measured use" description={`Events counted from ${formatDate(data.usage.periodStart)}. Unverified events: ${data.usage.unverifiedEvents}.`}>
        {!data.usage.resources.length ? <EmptyState title="No usage measured yet" description="Use of the workspace is measured automatically." /> : (
          <Table head={["Resource", "Treatment", "Measured", "Included", "Limit"]} caption="Measured use for this period">
            {data.usage.resources.map((resource) => (
              <tr key={resource.resource}>
                <td>{resource.name}<div className="mv-small mv-muted mv-id">{resource.resource}</div></td>
                <td className="mv-small">{resource.treatment}</td>
                <td className="mv-money">{resource.quantity.toLocaleString()} {resource.unit}</td>
                <td className="mv-money">{resource.includedQuantity ?? "—"}</td>
                <td className="mv-money">{resource.limitQuantity ?? "—"}</td>
              </tr>
            ))}
          </Table>
        )}
        {data.usage.byWorkspace.length > 1 ? (
          <Table head={["Workspace", "Resource", "Quantity"]} caption="Use by workspace">
            {data.usage.byWorkspace.map((row) => <tr key={`${row.tenantId}-${row.resource}`}><td>{row.name}</td><td>{row.resource}</td><td className="mv-money">{row.quantity.toLocaleString()}</td></tr>)}
          </Table>
        ) : null}
      </Card>

      <Card title="Change plan" description="Review the exact terms before anything changes. A higher price never starts without your confirmation.">
        <div className="mv-form-grid">
          <Field label="Plan" htmlFor="subscription-plan" hint="Finished trials end automatically; choose a paid plan to continue.">
            <Select id="subscription-plan" value={planId} onChange={(event) => { setPlanId(event.target.value); setQuote(null); }}>
              <option value="">Choose a plan</option>
              {choosable.map((plan) => <option key={plan.id} value={plan.id}>{plan.name} — {cents(plan.monthlyPriceMinor)} / month</option>)}
            </Select>
          </Field>
          <div className="mv-row" style={{ alignItems: "flex-end" }}>
            <Button onClick={() => void getQuote()} disabled={!planId || action.busy !== null}>{action.busy === "quote" ? "Fetching terms…" : "Review terms"}</Button>
          </div>
        </div>
        {quote ? (
          <div className="mv-note mv-stack">
            <h3 className="mv-h3">Terms to accept</h3>
            <p>{quote.disclosure}</p>
            <p className="mv-small mv-muted">Effective {quote.effective === "now" ? "immediately" : quote.effective === "trial-end" ? `when the trial ends${quote.effectiveAt ? ` on ${formatDate(quote.effectiveAt)}` : ""}` : `at the end of the period${quote.effectiveAt ? ` on ${formatDate(quote.effectiveAt)}` : ""}`}. First charge {cents(quote.firstChargeMinor)}. Proration {cents(quote.prorationMinor)}.</p>
            <div className="mv-row">
              <Button onClick={() => void accept()} disabled={action.busy !== null}>{action.busy === "accept" ? "Accepting…" : `Accept ${quote.plan.name}`}</Button>
              <Button variant="ghost" onClick={() => setQuote(null)} disabled={action.busy !== null}>Dismiss</Button>
            </div>
          </div>
        ) : null}
        <Table head={["Plan", "Price", "Status", "Features"]} caption="Plans">
          {data.plans.filter((plan) => plan.code !== "trial").map((plan) => (
            <tr key={plan.id}>
              <td><strong>{plan.name}</strong><div className="mv-small mv-muted">{plan.description}</div></td>
              <td className="mv-money">{cents(plan.monthlyPriceMinor)}{plan.maxMonthlyChargeMinor != null ? <div className="mv-small mv-muted">Capped at {cents(plan.maxMonthlyChargeMinor)}</div> : null}</td>
              <td><Badge tone={plan.status === "approved" ? "success" : plan.contractRequired ? "warning" : "neutral"}>{plan.contractRequired ? "contract required" : plan.status}</Badge></td>
              <td className="mv-small">{(plan.features ?? []).join(", ") || "—"}{plan.usageOverages ? <div className="mv-muted">Usage overages billed at approved rates</div> : null}</td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card title="Invoices and notices">
        {data.notifications.length ? (
          <div className="mv-stack">
            {data.notifications.map((notification) => (
              <div key={notification.id} className="mv-note">
                <div className="mv-spread">
                  <strong>{notification.title}</strong>
                  <span className="mv-small mv-muted">{formatDateTime(notification.createdAt)}</span>
                </div>
                <p className="mv-small">{notification.body}</p>
                {!notification.readAt ? <Button size="sm" variant="ghost" onClick={() => void markRead(notification.id)} disabled={action.busy !== null}>Mark read</Button> : <Badge tone="neutral">read</Badge>}
              </div>
            ))}
          </div>
        ) : null}
        {!data.invoices.length ? <EmptyState title="No invoices" description="Invoices for subscription charges appear here." /> : (
          <Table head={["Invoice", "Period", "Total", "Status", "Due"]} caption="Subscription invoices">
            {data.invoices.map((invoice) => (
              <tr key={invoice.id}>
                <td><strong>{invoice.number}</strong><div className="mv-small mv-muted">{invoice.kind}</div></td>
                <td className="mv-small">{formatDate(invoice.periodStart)} – {formatDate(invoice.periodEnd)}</td>
                <td className="mv-money">{cents(invoice.totalMinor)}</td>
                <td><Badge tone={invoice.status === "paid" ? "success" : invoice.status === "void" ? "neutral" : invoice.status === "open" ? "warning" : "info"}>{invoice.status}</Badge></td>
                <td className="mv-small">{formatDate(invoice.dueAt)}{invoice.paidAt ? <div className="mv-muted">paid {formatDate(invoice.paidAt)}</div> : null}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Account history">
        {!data.events.length ? <EmptyState title="No subscription changes yet" description="Plan changes and trial events appear here." /> : (
          <Table head={["When", "Event", "Change", "Actor"]} caption="Subscription history">
            {data.events.map((event, index) => (
              <tr key={`${event.occurredAt}-${index}`}>
                <td className="mv-small">{formatDateTime(event.occurredAt)}</td>
                <td>{event.event}</td>
                <td className="mv-small">{event.fromStatus ?? "—"} → {event.toStatus ?? "—"}</td>
                <td className="mv-small">{event.actorName ?? event.actorKind}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
