import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge, Button, Card, DataList, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { formatDateTime, formatMoney } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";

interface Invoice { id: string; number: string; patientId: string; encounterId: string | null; currency: string; status: string; notes: string | null; createdAt: string; publicId: string; givenName: string; familyName: string }
interface Item { id: string; description: string; quantity: string | number; unitPrice: string | number; amount: string | number }
interface Payment { id: string; amount: string | number; method: string; reference: string | null; notes: string | null; receivedAt: string; reversedAt: string | null; reversalReason: string | null; receivedByName: string; reversedByName: string | null }
interface Claim { id: string; insurer: string; coverAmount: string | number; notes: string | null; createdAt: string }
interface Detail { invoice: Invoice; items: Item[]; payments: Payment[]; claims: Claim[] }

export function InvoiceDetailPage() {
  const { id = "" } = useParams();
  const detail = useQuery<Detail>(id ? `/invoices/${id}` : null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");
  const [reference, setReference] = useState("");
  const [paymentNotes, setPaymentNotes] = useState("");
  const [reversalReason, setReversalReason] = useState<Record<string, string>>({});
  const [insurer, setInsurer] = useState("");
  const [coverAmount, setCoverAmount] = useState("");
  const [claimNotes, setClaimNotes] = useState("");
  const action = useAction();

  if (detail.loading) return <LoadingState label="Loading invoice" />;
  if (detail.error || !detail.data) return <ErrorState message={detail.error ?? "Invoice not found"} onRetry={detail.reload} />;
  const { invoice, items, payments, claims } = detail.data;
  const total = items.reduce((sum, item) => sum + Number(item.amount), 0);
  const paid = payments.filter((payment) => !payment.reversedAt).reduce((sum, payment) => sum + Number(payment.amount), 0);

  async function receivePayment(event: FormEvent) {
    event.preventDefault();
    await action.run("payment", async () => {
      await api(`/invoices/${invoice.id}/payments`, { method: "POST", body: { invoiceId: invoice.id, amount: Number(amount), method, reference, notes: paymentNotes } });
      setAmount("");
      setReference("");
      setPaymentNotes("");
      detail.reload();
      return "Payment recorded.";
    });
  }

  async function reverse(payment: Payment) {
    const reason = reversalReason[payment.id] ?? "";
    if (reason.trim().length < 10) {
      action.setError("A reversal reason of at least 10 characters is required.");
      return;
    }
    if (!window.confirm("Reverse this payment? The original payment record is retained.")) return;
    await action.run(payment.id, async () => {
      await api(`/payments/${payment.id}/reverse`, { method: "POST", body: { reason } });
      detail.reload();
      return "Payment reversed.";
    });
  }

  async function createClaim(event: FormEvent) {
    event.preventDefault();
    await action.run("claim", async () => {
      await api("/claims", { method: "POST", body: { invoiceId: invoice.id, insurer, coverAmount: Number(coverAmount), notes: claimNotes } });
      setInsurer("");
      setCoverAmount("");
      setClaimNotes("");
      detail.reload();
      return "Claim prepared.";
    });
  }

  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Finance" title={invoice.number} description={`${invoice.givenName} ${invoice.familyName} · ${invoice.publicId}`} actions={<Link className="mv-button mv-button--ghost mv-button--sm" to="/finance">Back to finance</Link>} />
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <div className="mv-grid mv-grid--2">
        <Card title="Invoice">
          <DataList items={[
            { label: "Status", value: <Badge tone={invoice.status === "paid" ? "success" : invoice.status === "part-paid" ? "warning" : invoice.status === "void" ? "neutral" : "info"}>{invoice.status}</Badge> },
            { label: "Currency", value: invoice.currency },
            { label: "Total", value: formatMoney(total, invoice.currency) },
            { label: "Paid", value: formatMoney(paid, invoice.currency) },
            { label: "Balance", value: formatMoney(total - paid, invoice.currency) },
            { label: "Created", value: formatDateTime(invoice.createdAt) },
          ]} />
          {invoice.notes ? <p className="mv-note">{invoice.notes}</p> : null}
        </Card>
        <Card title="Record payment" description={invoice.status === "void" ? "Void invoices cannot accept payments." : "No online payment gateway is configured; record manual receipts only."}>
          <form className="mv-stack" onSubmit={receivePayment}>
            <div className="mv-form-grid">
              <Field label="Amount" htmlFor="payment-amount"><Input id="payment-amount" type="number" min={0.01} step="any" value={amount} onChange={(event) => setAmount(event.target.value)} required /></Field>
              <Field label="Method"><Select value={method} onChange={(event) => setMethod(event.target.value)}><option value="cash">Cash</option><option value="bank-transfer">Bank transfer</option><option value="mobile-money">Mobile money</option><option value="manual">Manual</option></Select></Field>
              <Field label="Reference" htmlFor="payment-reference"><Input id="payment-reference" value={reference} onChange={(event) => setReference(event.target.value)} /></Field>
            </div>
            <Field label="Notes" htmlFor="payment-notes"><Textarea id="payment-notes" value={paymentNotes} onChange={(event) => setPaymentNotes(event.target.value)} /></Field>
            <Button type="submit" disabled={action.busy !== null || invoice.status === "void" || Number(amount) <= 0}>{action.busy === "payment" ? "Recording…" : "Record payment"}</Button>
          </form>
        </Card>
      </div>
      <Card title="Invoice lines">
        <Table head={["Description", "Quantity", "Unit price", "Amount"]} caption="Invoice lines">
          {items.map((item) => <tr key={item.id}><td>{item.description}</td><td>{item.quantity}</td><td>{formatMoney(item.unitPrice, invoice.currency)}</td><td>{formatMoney(item.amount, invoice.currency)}</td></tr>)}
        </Table>
      </Card>
      <Card title="Payments">
        {!payments.length ? <EmptyState title="No payments" description="Record a payment above." /> : (
          <Table head={["Amount", "Method", "Received", "Status", ""]} caption="Payments">
            {payments.map((payment) => (
              <tr key={payment.id}>
                <td>{formatMoney(payment.amount, invoice.currency)}</td>
                <td>{payment.method}{payment.reference ? <div className="mv-small mv-muted">{payment.reference}</div> : null}</td>
                <td className="mv-small">{formatDateTime(payment.receivedAt)}<div className="mv-muted">{payment.receivedByName}</div></td>
                <td>{payment.reversedAt ? <div><Badge tone="danger">reversed</Badge><div className="mv-small mv-muted">{payment.reversalReason}</div></div> : <Badge tone="success">active</Badge>}</td>
                <td>{!payment.reversedAt && invoice.status !== "void" ? (
                  <div className="mv-stack" style={{ gap: 4 }}>
                    <Input aria-label={`Reversal reason for ${payment.id}`} placeholder="Reversal reason" value={reversalReason[payment.id] ?? ""} onChange={(event) => setReversalReason((prev) => ({ ...prev, [payment.id]: event.target.value }))} />
                    <Button size="sm" variant="ghost" onClick={() => void reverse(payment)} disabled={action.busy !== null}>Reverse</Button>
                  </div>
                ) : null}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="Claims" description="Claims prepare cover information only; no insurer integration is configured.">
        {!claims.length ? <EmptyState title="No claims" description="Prepare a claim if the invoice is covered by an insurer." /> : (
          <Table head={["Insurer", "Cover amount", "Notes", "Created"]} caption="Claims">
            {claims.map((claim) => <tr key={claim.id}><td>{claim.insurer}</td><td>{formatMoney(claim.coverAmount, invoice.currency)}</td><td className="mv-small">{claim.notes}</td><td className="mv-small">{formatDateTime(claim.createdAt)}</td></tr>)}
          </Table>
        )}
        <form className="mv-stack" onSubmit={createClaim} style={{ marginTop: 16 }}>
          <div className="mv-form-grid">
            <Field label="Insurer" htmlFor="claim-insurer"><Input id="claim-insurer" value={insurer} onChange={(event) => setInsurer(event.target.value)} required minLength={2} /></Field>
            <Field label="Cover amount" htmlFor="claim-cover"><Input id="claim-cover" type="number" min={0.01} step="any" value={coverAmount} onChange={(event) => setCoverAmount(event.target.value)} required /></Field>
          </div>
          <Field label="Claim notes" htmlFor="claim-notes"><Textarea id="claim-notes" value={claimNotes} onChange={(event) => setClaimNotes(event.target.value)} /></Field>
          <Button type="submit" variant="secondary" disabled={action.busy !== null || invoice.status === "void" || !insurer || Number(coverAmount) <= 0}>{action.busy === "claim" ? "Preparing…" : "Prepare claim"}</Button>
        </form>
      </Card>
    </div>
  );
}
