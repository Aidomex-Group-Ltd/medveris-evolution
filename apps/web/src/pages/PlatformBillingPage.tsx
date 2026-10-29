import { useState, type FormEvent } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { formatDate, formatDateTime } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";

interface Account {
  id: string; kind: string; name: string; createdAt: string;
  subscriptionId: string | null; status: string | null; trialEndsAt: string | null; currentPeriodEnd: string | null;
  planName: string | null; workspaces: number; openMinor: number;
}
interface Invoice {
  id: string; number: string; kind: string; periodStart: string; periodEnd: string; totalMinor: number; status: string;
  dueAt: string; paymentAttempts: number; paidMinor: number;
}
interface Payment {
  id: string; amountMinor: number; currency: string; method: string; status: string; providerReference: string | null;
  failureReason: string | null; receiptNumber: string | null; recordedAt: string; refundedMinor: number; refundedAt: string | null; refundReason: string | null;
}
interface InvoiceDetail { invoice: Invoice; lines: Array<{ kind: string; description: string; quantity: number; unitAmountMinor: number; amountMinor: number }>; payments: Payment[]; accountName: string }
interface Plan { id: string; code: string; version: number; name: string; status: string; monthlyPriceMinor: number | null; contractRequired: boolean }

const cents = (value: number | null | undefined, currency = "USD") =>
  value == null ? "—" : `${currency} ${(value / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const statusTone = (status: string | null) =>
  status === "active" || status === "trialing" ? "success"
    : status === "suspended" || status === "trial_expired" ? "danger"
      : status === "restricted" || status === "past_due" ? "warning" : "neutral";

export function PlatformBillingPage() {
  const [status, setStatus] = useState("");
  const accounts = useQuery<{ accounts: Account[] }>(`/platform/billing/accounts${status ? `?status=${status}` : ""}`);
  const [selected, setSelected] = useState<Account | null>(null);
  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Platform operations" title="Billing accounts" description="Subscriptions, invoices and recorded payments across workspaces. Patient data is never shown here." />
      {selected ? <AccountPanel account={selected} onClose={() => { setSelected(null); accounts.reload(); }} /> : (
        <Card title="Accounts" actions={<Select aria-label="Filter accounts by subscription status" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">All statuses</option>
          <option value="trialing">Trialing</option>
          <option value="active">Active</option>
          <option value="trial_expired">Trial expired</option>
          <option value="past_due">Past due</option>
          <option value="restricted">Restricted</option>
          <option value="suspended">Suspended</option>
          <option value="cancelled">Cancelled</option>
        </Select>}>
          {accounts.loading ? <LoadingState /> : accounts.error ? <ErrorState message={accounts.error} onRetry={accounts.reload} /> : !accounts.data?.accounts.length ? <EmptyState title="No accounts" description="No billing accounts match this filter." /> : (
            <Table head={["Account", "Plan", "Status", "Workspaces", "Open balance", ""]} caption="Billing accounts">
              {accounts.data.accounts.map((account) => (
                <tr key={account.id}>
                  <td><strong>{account.name}</strong><div className="mv-small mv-muted">{account.kind} · created {formatDate(account.createdAt)}</div></td>
                  <td>{account.planName ?? "—"}{account.trialEndsAt ? <div className="mv-small mv-muted">trial ends {formatDate(account.trialEndsAt)}</div> : null}</td>
                  <td><Badge tone={statusTone(account.status)}>{account.status ?? "none"}</Badge></td>
                  <td className="mv-money">{account.workspaces}</td>
                  <td className="mv-money">{cents(account.openMinor)}</td>
                  <td><Button size="sm" onClick={() => setSelected(account)}>Open</Button></td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}
      <PlansCard />
    </div>
  );
}

function AccountPanel({ account, onClose }: { account: Account; onClose: () => void }) {
  const invoices = useQuery<{ invoices: Invoice[] }>(`/platform/billing/accounts/${account.id}/invoices`);
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const action = useAction();

  async function changeStatus(actionName: "suspend" | "reinstate" | "grant-trial") {
    const reason = window.prompt(`Reason for ${actionName.replace("-", " ")} (at least 5 characters). This never touches patient data.`);
    if (reason === null) return;
    if (reason.trim().length < 5) {
      action.setError("Give a reason of at least 5 characters.");
      return;
    }
    if (!account.subscriptionId) {
      action.setError("This account has no subscription.");
      return;
    }
    await action.run(actionName, async () => {
      const result = await api<{ status: string }>(`/platform/billing/subscriptions/${account.subscriptionId}/status`, {
        method: "POST", body: { action: actionName, reason: reason.trim() },
      });
      return `Subscription is now ${result.status}.`;
    });
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title={account.name} description={`${account.kind} · ${account.workspaces} workspace(s)`} actions={<Button variant="ghost" size="sm" onClick={onClose}>Back to accounts</Button>}>
        <div className="mv-row">
          <Badge tone={statusTone(account.status)}>{account.status ?? "no subscription"}</Badge>
          {account.planName ? <span>{account.planName}</span> : null}
          {account.currentPeriodEnd ? <span className="mv-small mv-muted">period ends {formatDate(account.currentPeriodEnd)}</span> : null}
        </div>
        <div className="mv-row" style={{ marginTop: 12 }}>
          <Button size="sm" variant="secondary" onClick={() => void changeStatus("suspend")} disabled={action.busy !== null || account.status === "cancelled"}>Suspend</Button>
          <Button size="sm" variant="secondary" onClick={() => void changeStatus("reinstate")} disabled={action.busy !== null || account.status !== "suspended"}>Reinstate</Button>
          <Button size="sm" variant="ghost" onClick={() => void changeStatus("grant-trial")} disabled={action.busy !== null}>Grant trial</Button>
        </div>
      </Card>
      <Card title="Invoices">
        {invoices.loading ? <LoadingState /> : invoices.error ? <ErrorState message={invoices.error} onRetry={invoices.reload} /> : !invoices.data?.invoices.length ? <EmptyState title="No invoices" description="Subscription invoices for this account appear here." /> : (
          <Table head={["Invoice", "Period", "Total", "Paid", "Status", "Due", ""]} caption="Account invoices">
            {invoices.data.invoices.map((invoice) => (
              <tr key={invoice.id}>
                <td><strong>{invoice.number}</strong><div className="mv-small mv-muted">{invoice.kind}</div></td>
                <td className="mv-small">{formatDate(invoice.periodStart)} – {formatDate(invoice.periodEnd)}</td>
                <td className="mv-money">{cents(invoice.totalMinor)}</td>
                <td className="mv-money">{cents(invoice.paidMinor)}</td>
                <td><Badge tone={invoice.status === "paid" ? "success" : invoice.status === "void" ? "neutral" : invoice.status === "open" ? "warning" : "info"}>{invoice.status}</Badge></td>
                <td className="mv-small">{formatDate(invoice.dueAt)}</td>
                <td><Button size="sm" variant={invoiceId === invoice.id ? "secondary" : "primary"} onClick={() => setInvoiceId(invoiceId === invoice.id ? null : invoice.id)} disabled={invoice.status === "void"}>{invoiceId === invoice.id ? "Close" : "Manage"}</Button></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {invoiceId ? <InvoicePanel invoiceId={invoiceId} onChanged={invoices.reload} /> : null}
    </div>
  );
}

function InvoicePanel({ invoiceId, onChanged }: { invoiceId: string; onChanged: () => void }) {
  const detail = useQuery<InvoiceDetail>(`/platform/billing/invoices/${invoiceId}`);
  if (detail.loading && !detail.data) return <LoadingState label="Loading invoice" variant="page" />;
  if (detail.error || !detail.data) return <ErrorState message={detail.error ?? "Invoice not found"} onRetry={detail.reload} />;
  return (
    <Card title={`Invoice ${detail.data.invoice.number}`} description={`${detail.data.accountName} · ${cents(detail.data.invoice.totalMinor)}`}>
      {detail.data.lines.length ? (
        <Table head={["Line", "Quantity", "Unit", "Amount"]} caption="Invoice lines">
          {detail.data.lines.map((line, index) => (
            <tr key={index}><td>{line.description}<div className="mv-small mv-muted">{line.kind}</div></td><td className="mv-money">{line.quantity}</td><td className="mv-money">{cents(line.unitAmountMinor)}</td><td className="mv-money">{cents(line.amountMinor)}</td></tr>
          ))}
        </Table>
      ) : null}
      <PaymentForm invoiceId={invoiceId} onRecorded={() => { detail.reload(); onChanged(); }} />
      {detail.data.payments.length ? (
        <Table head={["Recorded", "Amount", "Method", "Status", "Reference", ""]} caption="Recorded payments">
          {detail.data.payments.map((payment) => (
            <tr key={payment.id}>
              <td className="mv-small">{formatDateTime(payment.recordedAt)}</td>
              <td className="mv-money">{cents(payment.amountMinor, payment.currency)}{payment.refundedMinor ? <div className="mv-small mv-muted">refunded {cents(payment.refundedMinor, payment.currency)}</div> : null}</td>
              <td>{payment.method}</td>
              <td><Badge tone={payment.status === "succeeded" ? "success" : payment.status === "refunded" ? "neutral" : "danger"}>{payment.status}</Badge>{payment.failureReason ? <div className="mv-small mv-muted">{payment.failureReason}</div> : null}</td>
              <td className="mv-small">{payment.providerReference ?? "—"}{payment.receiptNumber ? <div className="mv-muted">{payment.receiptNumber}</div> : null}</td>
              <td>{payment.status === "succeeded" && payment.refundedMinor < payment.amountMinor ? <RefundButton payment={payment} onRefunded={() => { detail.reload(); onChanged(); }} /> : null}</td>
            </tr>
          ))}
        </Table>
      ) : <EmptyState title="No payments recorded" description="Record a bank transfer or terminal payment above." />}
    </Card>
  );
}

function PaymentForm({ invoiceId, onRecorded }: { invoiceId: string; onRecorded: () => void }) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("bank-transfer");
  const [status, setStatus] = useState<"succeeded" | "failed">("succeeded");
  const [reference, setReference] = useState("");
  const [failureReason, setFailureReason] = useState("");
  const action = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(amount.trim())) {
      action.setError("Enter an amount such as 15 or 15.50.");
      return;
    }
    if (reference.trim().length < 2 || (status === "failed" && failureReason.trim().length < 3)) {
      action.setError("A reference is required; a failed payment also needs a reason.");
      return;
    }
    await action.run("payment", async () => {
      await api(`/platform/billing/invoices/${invoiceId}/payments`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: { amount: amount.trim(), method, status, reference: reference.trim(), ...(status === "failed" ? { failureReason: failureReason.trim() } : {}) },
      });
      setAmount(""); setReference(""); setFailureReason("");
      onRecorded();
      return status === "succeeded" ? "Payment recorded and invoice settled if fully covered." : "Failed attempt recorded. Nothing was deleted.";
    });
  }

  return (
    <form className="mv-stack mv-note" onSubmit={submit}>
      {action.error ? <ErrorState title="Not recorded" message={action.error} /> : null}
      <div className="mv-form-grid">
        <Field label="Amount (USD)" htmlFor="platform-payment-amount"><Input id="platform-payment-amount" value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="15.00" /></Field>
        <Field label="Method" htmlFor="platform-payment-method"><Select id="platform-payment-method" value={method} onChange={(event) => setMethod(event.target.value)}>
          <option value="bank-transfer">Bank transfer</option><option value="card">Card terminal</option><option value="mobile-money">Mobile money</option><option value="cash">Cash</option><option value="other">Other</option>
        </Select></Field>
        <Field label="Outcome" htmlFor="platform-payment-status"><Select id="platform-payment-status" value={status} onChange={(event) => setStatus(event.target.value as "succeeded" | "failed")}><option value="succeeded">Succeeded</option><option value="failed">Failed</option></Select></Field>
        <Field label="Reference" htmlFor="platform-payment-reference"><Input id="platform-payment-reference" value={reference} onChange={(event) => setReference(event.target.value)} maxLength={200} /></Field>
      </div>
      {status === "failed" ? <Field label="Failure reason" htmlFor="platform-payment-failure"><Textarea id="platform-payment-failure" value={failureReason} onChange={(event) => setFailureReason(event.target.value)} maxLength={500} /></Field> : null}
      <div><Button type="submit" disabled={action.busy !== null}>{action.busy ? "Recording…" : "Record payment"}</Button></div>
    </form>
  );
}

function RefundButton({ payment, onRefunded }: { payment: Payment; onRefunded: () => void }) {
  const action = useAction();
  async function refund() {
    const remaining = (payment.amountMinor - payment.refundedMinor) / 100;
    const amount = window.prompt(`Amount to refund (up to ${remaining.toFixed(2)}):`, remaining.toFixed(2));
    if (amount === null) return;
    const reason = window.prompt("Reason for the refund (at least 5 characters):");
    if (reason === null) return;
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(amount.trim()) || reason.trim().length < 5) {
      action.setError("Enter a valid amount and a reason of at least 5 characters.");
      return;
    }
    await action.run("refund", async () => {
      await api(`/platform/billing/payments/${payment.id}/refund`, { method: "POST", body: { amount: amount.trim(), reason: reason.trim() } });
      onRefunded();
      return "Refund recorded.";
    });
  }
  return (
    <div>
      <Button size="sm" variant="ghost" onClick={() => void refund()} disabled={action.busy !== null}>Refund</Button>
      {action.error ? <div className="mv-small" style={{ color: "var(--mv-danger)" }}>{action.error}</div> : null}
    </div>
  );
}

function PlansCard() {
  const plans = useQuery<{ plans: Plan[] }>("/platform/billing/plans");
  const action = useAction();
  async function approve(plan: Plan) {
    const reference = window.prompt(`Approval reference for ${plan.name} v${plan.version} (at least 5 characters):`);
    if (reference === null) return;
    if (reference.trim().length < 5) {
      action.setError("An approval reference of at least 5 characters is required.");
      return;
    }
    await action.run(plan.id, async () => {
      await api(`/platform/billing/plans/${plan.id}/approve`, { method: "POST", body: { approvalReference: reference.trim() } });
      plans.reload();
      return `${plan.name} v${plan.version} approved.`;
    });
  }
  if (plans.loading && !plans.data) return <LoadingState />;
  if (plans.error) return <ErrorState message={plans.error} onRetry={plans.reload} />;
  return (
    <Card title="Plans" description="A draft price does not take effect until a separate approval is recorded.">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      {!plans.data?.plans.length ? <EmptyState title="No plans" description="Create a draft plan version to begin." /> : (
        <Table head={["Plan", "Version", "Price", "Status", ""]} caption="Subscription plans">
          {plans.data.plans.map((plan) => (
            <tr key={plan.id}>
              <td>{plan.name}<div className="mv-small mv-muted mv-id">{plan.code}</div></td>
              <td>v{plan.version}</td>
              <td className="mv-money">{cents(plan.monthlyPriceMinor)}{plan.contractRequired ? <div className="mv-small mv-muted">contract required</div> : null}</td>
              <td><Badge tone={plan.status === "approved" ? "success" : plan.status === "draft" ? "warning" : "neutral"}>{plan.status}</Badge></td>
              <td>{plan.status === "draft" && plan.monthlyPriceMinor != null ? <Button size="sm" onClick={() => void approve(plan)} disabled={action.busy !== null}>Approve</Button> : null}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
