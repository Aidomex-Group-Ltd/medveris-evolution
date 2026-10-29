import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Tabs, Textarea } from "@medveris/ui";
import { RequestStatusBadge } from "../components/WorkflowBadges";
import { api, errorMessage } from "../lib/api";
import { formatDateTime, formatMoney } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";
import { departmentLabel } from "../lib/workspace";
import type { RecommendationStatus } from "../lib/types";

interface Invoice { id: string; number: string; patientId: string; encounterId: string | null; currency: string; status: string; notes: string | null; createdAt: string; publicId: string; givenName: string; familyName: string }
interface Item { id: string; description: string; quantity: string | number; unitPrice: string | number; amount: string | number; source: "manual" | "recommendation" | "supply"; recommendationStatus: RecommendationStatus | null; targetDepartment: string | null }
interface Payment { id: string; amount: string | number; method: string; reference: string | null; notes: string | null; receivedAt: string; reversedAt: string | null; reversalReason: string | null; receivedByName: string; reversedByName: string | null; receiptNumber: string | null; changeDue: string | number | null }
interface Claim { id: string; insurer: string; coverAmount: string | number; notes: string | null; createdAt: string }
interface Refund { id: string; paymentId: string; amount: string | number; currency: string; method: string; reference: string | null; reason: string; receiptNumber: string; refundedAt: string; refundedByName: string }
interface MobileMoney { id: string; amount: string | number; msisdn: string; status: "initiated" | "pending" | "succeeded" | "failed" | "indeterminate"; statusDetail: string | null; paymentId: string | null; createdAt: string; completedAt: string | null; providerMode: string }
interface Totals { status: string; currency: string; total: number; paid: number; balance: number }
interface Detail {
  invoice: Invoice; items: Item[]; payments: Payment[]; refunds: Refund[]; claims: Claim[]; mobileMoney: MobileMoney[]; totals: Totals;
  paymentOptions: { cash: boolean; mobileMoney: boolean; mobileMoneyMode: string; mobileMoneyReason: string };
}
interface MobileMoneyView {
  request: { id: string; amount: number; msisdn: string; status: MobileMoney["status"]; statusDetail: string | null; paymentId: string | null; receiptNumber: string | null; mode: string };
  invoice: Totals | null;
}

type Method = "cash" | "mobile-money" | "other";

const MOBILE_STATUS: Record<MobileMoney["status"], { label: string; tone: "info" | "warning" | "success" | "danger" | "neutral" }> = {
  initiated: { label: "Sending prompt", tone: "info" },
  pending: { label: "Waiting for approval", tone: "warning" },
  succeeded: { label: "Paid", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  indeterminate: { label: "Unconfirmed", tone: "warning" },
};

const SOURCE_LABELS: Record<Item["source"], string> = { manual: "Manual line", recommendation: "Requested work", supply: "Supplied item" };

export function InvoiceDetailPage() {
  const { id = "" } = useParams();
  const detail = useQuery<Detail>(id ? `/invoices/${id}` : null);
  const [method, setMethod] = useState<Method>("cash");
  const action = useAction();
  const [lastReceipt, setLastReceipt] = useState<{ paymentId: string; receiptNumber: string; change: number | null } | null>(null);

  if (detail.loading && !detail.data) return <LoadingState label="Loading bill" variant="page" />;
  if (detail.error || !detail.data) return <ErrorState message={detail.error ?? "Bill not found"} onRetry={detail.reload} />;
  const { invoice, items, payments, refunds, claims, totals, paymentOptions } = detail.data;
  const currency = invoice.currency;
  const payable = invoice.status !== "void" && totals.balance > 0;
  const hasActivePayment = payments.some((payment) => !payment.reversedAt);
  const unresolvedMobile = detail.data.mobileMoney.find((row) => ["initiated", "pending", "indeterminate"].includes(row.status));

  async function removeLine(item: Item) {
    const reason = window.prompt(`Why is “${item.description}” being removed from this bill? (at least 10 characters)`);
    if (reason === null) return;
    if (reason.trim().length < 10) {
      action.setError("Give a reason of at least 10 characters.");
      return;
    }
    await action.run(item.id, async () => {
      await api(`/invoices/${invoice.id}/items/${item.id}/remove`, { method: "POST", body: { reason: reason.trim() } });
      detail.reload();
      return `${item.description} removed. ${item.source !== "manual" ? "It can be billed again from the visit." : ""}`;
    });
  }

  async function reverse(payment: Payment) {
    const reason = window.prompt("Reason for reversing this payment (at least 10 characters). The original record is kept.");
    if (reason === null) return;
    if (reason.trim().length < 10) {
      action.setError("A reversal reason of at least 10 characters is required.");
      return;
    }
    await action.run(payment.id, async () => {
      await api(`/payments/${payment.id}/reverse`, { method: "POST", body: { reason: reason.trim() } });
      detail.reload();
      return "Payment reversed.";
    });
  }

  async function refund(payment: Payment) {
    const already = refunds.filter((row) => row.paymentId === payment.id).reduce((sum, row) => sum + Number(row.amount), 0);
    const remaining = Number(payment.amount) - already;
    const amount = window.prompt(`Refund amount for this payment (up to ${formatMoney(remaining, currency)}). The original payment is kept.`, String(remaining));
    if (amount === null) return;
    const reason = window.prompt("Reason for the refund (at least 5 characters):");
    if (reason === null) return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0 || value > remaining || reason.trim().length < 5) {
      action.setError(`Enter an amount up to ${formatMoney(remaining, currency)} and a reason of at least 5 characters.`);
      return;
    }
    await action.run(`refund-${payment.id}`, async () => {
      const result = await api<{ refund: { receiptNumber: string } }>(`/payments/${payment.id}/refunds`, {
        method: "POST",
        body: { amount: value, method: payment.method, reason: reason.trim() },
      });
      detail.reload();
      return `Refund recorded. Receipt ${result.refund.receiptNumber}. Mobile money refunds are paid out outside Medveris.`;
    });
  }

  async function voidBill() {
    const reason = window.prompt("Why is this unpaid bill being voided? Its lines return to the visit so they can be billed again. (at least 5 characters)");
    if (reason === null) return;
    if (reason.trim().length < 5) {
      action.setError("Give a void reason of at least 5 characters.");
      return;
    }
    await action.run("void", async () => {
      await api(`/invoices/${invoice.id}/void`, { method: "POST", body: { reason: reason.trim() } });
      detail.reload();
      return "Bill voided. Its lines are available to bill again.";
    });
  }

  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow="Point of sale"
        title={`Bill ${invoice.number}`}
        description={`${invoice.givenName} ${invoice.familyName} · ${invoice.publicId}`}
        actions={<div className="mv-row">
          {invoice.encounterId ? <Link className="mv-button mv-button--secondary mv-button--sm" to={`/pos?encounter=${invoice.encounterId}`}>Visit charges</Link> : null}
          <Link className="mv-button mv-button--ghost mv-button--sm" to="/pos">Back to till</Link>
          {invoice.status !== "void" && totals.paid === 0 ? <Button size="sm" variant="ghost" onClick={() => void voidBill()} disabled={action.busy !== null}>{action.busy === "void" ? "Voiding…" : "Void unpaid bill"}</Button> : null}
        </div>}
      />
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      {lastReceipt ? (
        <Notice tone="success" title="Payment received">
          Receipt {lastReceipt.receiptNumber}{lastReceipt.change ? ` · give change ${formatMoney(lastReceipt.change, currency)}` : ""}. <Link to={`/finance/receipts/${lastReceipt.paymentId}`}>View or print receipt</Link>
        </Notice>
      ) : null}

      <div className="mv-pos-totals" aria-label="Bill totals">
        <div><span className="mv-small mv-muted">Bill total</span><strong className="mv-money">{formatMoney(totals.total, currency)}</strong></div>
        <div><span className="mv-small mv-muted">Amount paid</span><strong className="mv-money">{formatMoney(totals.paid, currency)}</strong></div>
        <div><span className="mv-small mv-muted">{totals.balance < 0 ? "Credit due to patient" : "Balance due"}</span><strong className="mv-money">{formatMoney(Math.abs(totals.balance), currency)}</strong></div>
        <div><span className="mv-small mv-muted">Status</span><strong><Badge tone={totals.status === "paid" ? "success" : totals.status === "part-paid" ? "warning" : totals.status === "void" ? "neutral" : "info"}>{totals.status}</Badge></strong></div>
      </div>
      {totals.balance < 0 ? <Notice tone="warning" title="Overpaid">Payments exceed the bill. Refund the difference and reverse or record it before closing the bill.</Notice> : null}

      {payable ? (
        <Card title="Take payment">
          <Tabs label="Payment method" value={method} onChange={setMethod} options={[
            { value: "cash", label: "Cash" },
            { value: "mobile-money", label: "Mobile money (Yo!)" },
            { value: "other", label: "Other" },
          ]} />
          <div style={{ marginTop: 14 }}>
            {method === "cash" ? (
              <CashForm invoiceId={invoice.id} balance={totals.balance} currency={currency} disabled={Boolean(unresolvedMobile)}
                onPaid={(result) => { setLastReceipt(result); detail.reload(); }} />
            ) : null}
            {method === "mobile-money" ? (
              paymentOptions.mobileMoney ? (
                <MobileMoneyForm invoiceId={invoice.id} balance={totals.balance} unresolved={unresolvedMobile ?? null} mode={paymentOptions.mobileMoneyMode}
                  onSettled={(result) => { if (result) setLastReceipt(result); detail.reload(); }} />
              ) : (
                <Notice tone="info" title="Mobile money is not available">{paymentOptions.mobileMoneyReason}. Take cash, or ask the administrator to configure Yo! Payments.</Notice>
              )
            ) : null}
            {method === "other" ? <OtherPaymentForm invoiceId={invoice.id} balance={totals.balance} onPaid={() => { action.setMessage("Payment recorded."); detail.reload(); }} /> : null}
          </div>
        </Card>
      ) : invoice.status === "void" ? <Notice tone="info">This bill is void and cannot take payments.</Notice> : totals.total > 0 ? <Notice tone="success" title="Fully paid">Nothing is due on this bill.</Notice> : null}

      <Card title="Bill lines" description="Requested work and supplied items link back to the visit; each is charged once.">
        {!items.length ? <EmptyState title="No lines" description="Add items from the visit at the till." /> : (
          <Table head={["Item", "Source", "Qty", "Unit price", "Amount", ""]} caption="Bill lines">
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.description}</td>
                <td className="mv-small">{SOURCE_LABELS[item.source] ?? item.source}{item.targetDepartment ? <div className="mv-muted">{departmentLabel(item.targetDepartment)}</div> : null}{item.recommendationStatus ? <div><RequestStatusBadge status={item.recommendationStatus} /></div> : null}</td>
                <td>{Number(item.quantity)}</td>
                <td className="mv-money">{formatMoney(item.unitPrice, currency)}</td>
                <td className="mv-money">{formatMoney(item.amount, currency)}</td>
                <td>{!hasActivePayment && !unresolvedMobile && invoice.status !== "void" ? <Button size="sm" variant="ghost" disabled={action.busy !== null} onClick={() => void removeLine(item)}>Remove</Button> : null}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Payments and receipts">
        {!payments.length && !detail.data.mobileMoney.length ? <EmptyState title="No payments yet" description="Payments and mobile money attempts appear here." /> : (
          <Table head={["Amount", "Method", "Received", "Status", ""]} caption="Payments">
            {payments.map((payment) => (
              <tr key={payment.id}>
                <td className="mv-money">{formatMoney(payment.amount, currency)}</td>
                <td>{payment.method}{payment.reference ? <div className="mv-small mv-muted">{payment.reference}</div> : null}</td>
                <td className="mv-small">{formatDateTime(payment.receivedAt)}<div className="mv-muted">{payment.receivedByName}</div></td>
                <td>{payment.reversedAt ? <div><Badge tone="danger">reversed</Badge><div className="mv-small mv-muted">{payment.reversalReason}</div></div> : <Badge tone="success">received</Badge>}</td>
                <td><div className="mv-row">
                  <Link className="mv-button mv-button--secondary mv-button--sm" to={`/finance/receipts/${payment.id}`}>Receipt{payment.receiptNumber ? ` ${payment.receiptNumber}` : ""}</Link>
                  {!payment.reversedAt && invoice.status !== "void" ? <Button size="sm" variant="ghost" onClick={() => void reverse(payment)} disabled={action.busy !== null}>Reverse</Button> : null}
                  {!payment.reversedAt && refunds.filter((row) => row.paymentId === payment.id).reduce((sum, row) => sum + Number(row.amount), 0) < Number(payment.amount) ? <Button size="sm" variant="ghost" onClick={() => void refund(payment)} disabled={action.busy !== null}>Refund</Button> : null}
                </div></td>
              </tr>
            ))}
            {detail.data.mobileMoney.filter((row) => row.status !== "succeeded").map((row) => (
              <tr key={row.id}>
                <td className="mv-money">{formatMoney(row.amount, currency)}</td>
                <td>mobile money<div className="mv-small mv-muted">{row.msisdn}{row.providerMode === "sandbox" ? " · sandbox" : ""}</div></td>
                <td className="mv-small">{formatDateTime(row.createdAt)}</td>
                <td><Badge tone={MOBILE_STATUS[row.status].tone}>{MOBILE_STATUS[row.status].label}</Badge>{row.statusDetail ? <div className="mv-small mv-muted">{row.statusDetail}</div> : null}</td>
                <td />
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {refunds.length ? (
        <Card title="Refunds" description="Append-only corrections. The original payments above are never changed.">
          <Table head={["Refund receipt", "Amount", "Method", "Reason", "Refunded"]} caption="Refunds">
            {refunds.map((row) => (
              <tr key={row.id}>
                <td className="mv-id">{row.receiptNumber}</td>
                <td className="mv-money">{formatMoney(row.amount, row.currency)}</td>
                <td>{row.method}{row.reference ? <div className="mv-small mv-muted">{row.reference}</div> : null}</td>
                <td>{row.reason}</td>
                <td className="mv-small">{formatDateTime(row.refundedAt)}<div className="mv-muted">{row.refundedByName}</div></td>
              </tr>
            ))}
          </Table>
        </Card>
      ) : null}

      <ClaimsCard invoiceId={invoice.id} currency={currency} claims={claims} disabled={invoice.status === "void"} onSaved={detail.reload} />
    </div>
  );
}

function CashForm({ invoiceId, balance, currency, disabled, onPaid }: { invoiceId: string; balance: number; currency: string; disabled: boolean; onPaid: (result: { paymentId: string; receiptNumber: string; change: number | null }) => void }) {
  const [amount, setAmount] = useState(String(balance));
  const [tendered, setTendered] = useState("");
  const [notes, setNotes] = useState("");
  const action = useAction();
  // One key per payment attempt: a double tap or a retried request records the payment once.
  const key = useRef(crypto.randomUUID());
  useEffect(() => setAmount(String(balance)), [balance]);
  const value = Number(amount);
  const given = tendered === "" ? null : Number(tendered);
  const change = given != null && Number.isFinite(given) && given >= value ? given - value : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!(value > 0) || value > balance) {
      action.setError(`Enter an amount between 1 and the balance of ${formatMoney(balance, currency)}.`);
      return;
    }
    if (given != null && given < value) {
      action.setError("The cash tendered is less than the amount being paid.");
      return;
    }
    await action.run("cash", async () => {
      const result = await api<{ payment: { id: string; receiptNumber: string; change: number | null } }>(`/invoices/${invoiceId}/cash`, {
        method: "POST", headers: { "idempotency-key": `cash-${key.current}` },
        body: { amount: value, amountTendered: given ?? undefined, notes },
      });
      key.current = crypto.randomUUID();
      setTendered("");
      setNotes("");
      onPaid({ paymentId: result.payment.id, receiptNumber: result.payment.receiptNumber, change: result.payment.change ?? null });
    });
  }

  return (
    <form className="mv-stack" onSubmit={submit}>
      {action.error ? <ErrorState title="Payment not recorded" message={action.error} /> : null}
      {disabled ? <Notice tone="warning">A mobile money prompt for this bill is still unresolved. Check its status before taking cash so the patient is not charged twice.</Notice> : null}
      <div className="mv-form-grid">
        <Field label="Amount to pay" htmlFor="cash-amount" hint={`Balance due ${formatMoney(balance, currency)}`}><Input id="cash-amount" type="number" inputMode="decimal" min={1} max={balance} step="any" value={amount} onChange={(event) => setAmount(event.target.value)} /></Field>
        <Field label="Cash tendered (optional)" htmlFor="cash-tendered" hint={change != null ? `Change: ${formatMoney(change, currency)}` : "Enter to calculate change"}><Input id="cash-tendered" type="number" inputMode="decimal" min={0} step="any" value={tendered} onChange={(event) => setTendered(event.target.value)} /></Field>
      </div>
      <Field label="Note (optional)" htmlFor="cash-notes"><Input id="cash-notes" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} /></Field>
      <Button type="submit" disabled={action.busy !== null || disabled}>{action.busy ? "Recording…" : `Receive ${formatMoney(value > 0 ? value : 0, currency)} cash`}</Button>
    </form>
  );
}

function MobileMoneyForm({ invoiceId, balance, unresolved, mode, onSettled }: {
  invoiceId: string; balance: number; unresolved: MobileMoney | null; mode: string;
  onSettled: (receipt: { paymentId: string; receiptNumber: string; change: null } | null) => void;
}) {
  const [phone, setPhone] = useState("");
  const [amount, setAmount] = useState(String(balance));
  const [view, setView] = useState<MobileMoneyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const polls = useRef(0);
  const settled = useRef(onSettled);
  settled.current = onSettled;
  const requestId = view?.request.id ?? unresolved?.id ?? null;
  const status = view?.request.status ?? unresolved?.status ?? null;

  useEffect(() => setAmount(String(balance)), [balance]);

  const check = useCallback(async (silent = false) => {
    if (!requestId) return;
    if (!silent) setBusy("check");
    try {
      const next = await api<MobileMoneyView>(`/mobile-money/${requestId}/check`, { method: "POST" });
      setView(next);
      setError(null);
      if (next.request.status === "succeeded" || next.request.status === "failed") {
        settled.current(next.request.status === "succeeded" && next.request.paymentId && next.request.receiptNumber
          ? { paymentId: next.request.paymentId, receiptNumber: next.request.receiptNumber, change: null } : null);
      }
    } catch (cause) {
      if (!silent) setError(errorMessage(cause));
    } finally {
      if (!silent) setBusy(null);
    }
  }, [requestId]);

  // While the payer is approving on their phone, ask Yo! every 6 seconds for up to 3 minutes.
  useEffect(() => {
    if (status !== "pending" && status !== "initiated") return;
    polls.current = 0;
    const timer = window.setInterval(() => {
      polls.current += 1;
      if (polls.current > 30) {
        window.clearInterval(timer);
        return;
      }
      void check(true);
    }, 6_000);
    return () => window.clearInterval(timer);
  }, [status, check]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const value = Number(amount);
    if (!(value > 0) || value > balance || !Number.isInteger(value)) {
      setError(`Enter whole shillings between 1 and ${formatMoney(balance, "UGX")}.`);
      return;
    }
    setBusy("send");
    setError(null);
    try {
      const next = await api<MobileMoneyView>(`/invoices/${invoiceId}/mobile-money`, {
        method: "POST", headers: { "idempotency-key": `momo-${key.current}` }, body: { msisdn: phone, amount: value },
      });
      key.current = crypto.randomUUID();
      setView(next);
      if (next.request.status === "succeeded" || next.request.status === "failed") onSettled(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  const current = view?.request ?? (unresolved ? { ...unresolved, amount: Number(unresolved.amount), receiptNumber: null, mode: unresolved.providerMode } : null);
  const showForm = !current || current.status === "failed" || current.status === "succeeded";

  return (
    <div className="mv-stack">
      {error ? <ErrorState title="Mobile money" message={error} /> : null}
      {mode === "sandbox" ? <Notice tone="warning">Yo! sandbox: no real money moves.</Notice> : null}
      {current && current.status !== "succeeded" ? (
        <div className="mv-note" aria-live="polite">
          <div className="mv-spread">
            <strong>{formatMoney(current.amount, "UGX")} from {current.msisdn}</strong>
            <Badge tone={MOBILE_STATUS[current.status].tone}>{MOBILE_STATUS[current.status].label}</Badge>
          </div>
          <p className="mv-small" style={{ margin: "6px 0" }}>
            {current.status === "pending" || current.status === "initiated" ? "Ask the payer to approve the prompt on their phone and enter their PIN. This updates automatically."
              : current.status === "indeterminate" ? "Yo! has not confirmed this payment yet. Check again before taking another payment; nothing is posted until it is confirmed."
                : current.statusDetail ?? "The payment did not go through. Nothing was charged; you can try again or take cash."}
          </p>
          {current.statusDetail && current.status !== "failed" ? <p className="mv-small mv-muted" style={{ margin: 0 }}>{current.statusDetail}</p> : null}
          {current.status !== "failed" ? <Button size="sm" variant="secondary" onClick={() => void check()} disabled={busy !== null}>{busy === "check" ? "Checking…" : "Check status now"}</Button> : null}
        </div>
      ) : null}
      {showForm ? (
        <form className="mv-stack" onSubmit={send}>
          <div className="mv-form-grid">
            <Field label="Payer's mobile number" htmlFor="momo-phone" hint="MTN or Airtel, e.g. 0772 123456"><Input id="momo-phone" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value)} maxLength={20} /></Field>
            <Field label="Amount (UGX)" htmlFor="momo-amount" hint={`Balance due ${formatMoney(balance, "UGX")}`}><Input id="momo-amount" type="number" inputMode="numeric" min={1} max={balance} step={1} value={amount} onChange={(event) => setAmount(event.target.value)} /></Field>
          </div>
          <Button type="submit" disabled={busy !== null || phone.trim().length < 9}>{busy === "send" ? "Sending prompt…" : "Send payment prompt"}</Button>
        </form>
      ) : null}
    </div>
  );
}

function OtherPaymentForm({ invoiceId, balance, onPaid }: { invoiceId: string; balance: number; onPaid: () => void }) {
  const [amount, setAmount] = useState(String(balance));
  const [method, setMethod] = useState("bank-transfer");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const action = useAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    const ok = await action.run("other", async () => {
      await api(`/invoices/${invoiceId}/payments`, { method: "POST", body: { invoiceId, amount: Number(amount), method, reference, notes } });
    });
    if (ok) {
      setReference("");
      setNotes("");
      onPaid();
    }
  }
  return (
    <form className="mv-stack" onSubmit={submit}>
      {action.error ? <ErrorState title="Payment not recorded" message={action.error} /> : null}
      <p className="mv-small mv-muted" style={{ margin: 0 }}>Record a payment received outside the till, such as a bank transfer. It is not confirmed with any provider.</p>
      <div className="mv-form-grid">
        <Field label="Amount" htmlFor="other-amount"><Input id="other-amount" type="number" min={0.01} step="any" value={amount} onChange={(event) => setAmount(event.target.value)} /></Field>
        <Field label="Method" htmlFor="other-method"><Select id="other-method" value={method} onChange={(event) => setMethod(event.target.value)}><option value="bank-transfer">Bank transfer</option><option value="manual">Other (manual)</option></Select></Field>
        <Field label="Reference" htmlFor="other-reference"><Input id="other-reference" value={reference} onChange={(event) => setReference(event.target.value)} maxLength={200} /></Field>
      </div>
      <Field label="Notes" htmlFor="other-notes"><Textarea id="other-notes" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} /></Field>
      <Button type="submit" variant="secondary" disabled={action.busy !== null || Number(amount) <= 0}>{action.busy ? "Recording…" : "Record payment"}</Button>
    </form>
  );
}

function ClaimsCard({ invoiceId, currency, claims, disabled, onSaved }: { invoiceId: string; currency: string; claims: Claim[]; disabled: boolean; onSaved: () => void }) {
  const [insurer, setInsurer] = useState("");
  const [coverAmount, setCoverAmount] = useState("");
  const [claimNotes, setClaimNotes] = useState("");
  const action = useAction();
  async function createClaim(event: FormEvent) {
    event.preventDefault();
    await action.run("claim", async () => {
      await api("/claims", { method: "POST", body: { invoiceId, insurer, coverAmount: Number(coverAmount), notes: claimNotes } });
      setInsurer("");
      setCoverAmount("");
      setClaimNotes("");
      onSaved();
      return "Claim prepared.";
    });
  }
  return (
    <Card title="Claims" description="Claims prepare cover information only; no insurer integration is configured.">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      {!claims.length ? <EmptyState title="No claims" description="Prepare a claim if the bill is covered by an insurer." /> : (
        <Table head={["Insurer", "Cover amount", "Notes", "Created"]} caption="Claims">
          {claims.map((claim) => <tr key={claim.id}><td>{claim.insurer}</td><td>{formatMoney(claim.coverAmount, currency)}</td><td className="mv-small">{claim.notes}</td><td className="mv-small">{formatDateTime(claim.createdAt)}</td></tr>)}
        </Table>
      )}
      <form className="mv-stack" onSubmit={createClaim} style={{ marginTop: 16 }}>
        <div className="mv-form-grid">
          <Field label="Insurer" htmlFor="claim-insurer"><Input id="claim-insurer" value={insurer} onChange={(event) => setInsurer(event.target.value)} required minLength={2} /></Field>
          <Field label="Cover amount" htmlFor="claim-cover"><Input id="claim-cover" type="number" min={0.01} step="any" value={coverAmount} onChange={(event) => setCoverAmount(event.target.value)} required /></Field>
        </div>
        <Field label="Claim notes" htmlFor="claim-notes"><Textarea id="claim-notes" value={claimNotes} onChange={(event) => setClaimNotes(event.target.value)} /></Field>
        <Button type="submit" variant="secondary" disabled={action.busy !== null || disabled || !insurer || Number(coverAmount) <= 0}>{action.busy === "claim" ? "Preparing…" : "Prepare claim"}</Button>
      </form>
    </Card>
  );
}
