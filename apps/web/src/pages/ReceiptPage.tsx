import { Link, useParams } from "react-router-dom";
import { Badge, Button, Card, ErrorState, LoadingState, Notice } from "@medveris/ui";
import { formatDateTime, formatMoney } from "../lib/format";
import { useQuery } from "../lib/useQuery";

interface Receipt {
  number: string;
  facility: { name: string; city: string | null; district: string | null };
  invoiceNumber: string;
  currency: string;
  patient: { publicId: string; name: string };
  items: Array<{ description: string; quantity: number; unitPrice: number; amount: number }>;
  total: number;
  amount: number;
  method: string;
  reference: string | null;
  mobileMoney: { msisdn: string; mode: string } | null;
  amountTendered: number | null;
  change: number | null;
  balanceAfter: number;
  currentBalance: number | null;
  receivedAt: string;
  cashier: string;
  reversed: { at: string; reason: string } | null;
}

const METHOD_LABELS: Record<string, string> = { cash: "Cash", "mobile-money": "Mobile money", "bank-transfer": "Bank transfer", manual: "Other" };

export function ReceiptPage() {
  const { paymentId = "" } = useParams();
  const receipt = useQuery<{ receipt: Receipt }>(paymentId ? `/payments/${paymentId}/receipt` : null);
  if (receipt.loading) return <LoadingState label="Loading receipt" variant="page" />;
  if (receipt.error || !receipt.data) return <ErrorState message={receipt.error ?? "Receipt not found"} onRetry={receipt.reload} />;
  const r = receipt.data.receipt;
  return (
    <div className="mv-stack">
      <div className="mv-row mv-no-print">
        <Button onClick={() => window.print()}>Print receipt</Button>
        <Link className="mv-button mv-button--ghost mv-button--md" to="/pos">Back to till</Link>
      </div>
      {r.reversed ? <Notice tone="danger" title="Reversed">This payment was reversed on {formatDateTime(r.reversed.at)}: {r.reversed.reason}</Notice> : null}
      <Card className="mv-receipt">
        <div style={{ textAlign: "center" }}>
          <strong style={{ fontSize: "1.1rem" }}>{r.facility.name}</strong>
          {r.facility.city || r.facility.district ? <div className="mv-small mv-muted">{[r.facility.city, r.facility.district].filter(Boolean).join(", ")}</div> : null}
          <div style={{ marginTop: 8 }}><strong>Payment receipt</strong> <Badge tone={r.reversed ? "danger" : "success"}>{r.reversed ? "reversed" : "paid"}</Badge></div>
        </div>
        <table style={{ marginTop: 12 }}>
          <tbody>
            <tr><td>Receipt</td><td className="mv-id">{r.number}</td></tr>
            <tr><td>Bill</td><td>{r.invoiceNumber}</td></tr>
            <tr><td>Patient</td><td>{r.patient.name}<div className="mv-small mv-muted mv-id">{r.patient.publicId}</div></td></tr>
            <tr><td>Date</td><td>{formatDateTime(r.receivedAt)}</td></tr>
            <tr><td>Cashier</td><td>{r.cashier}</td></tr>
          </tbody>
        </table>
        <hr className="mv-divider" />
        <table>
          <tbody>
            {r.items.map((item, index) => (
              <tr key={index}><td>{item.description}{item.quantity !== 1 ? ` × ${item.quantity}` : ""}</td><td className="mv-money">{formatMoney(item.amount, r.currency)}</td></tr>
            ))}
            <tr><td><strong>Bill total</strong></td><td className="mv-money"><strong>{formatMoney(r.total, r.currency)}</strong></td></tr>
          </tbody>
        </table>
        <hr className="mv-divider" />
        <table>
          <tbody>
            <tr><td><strong>Amount paid</strong></td><td className="mv-money"><strong>{formatMoney(r.amount, r.currency)}</strong></td></tr>
            <tr><td>Method</td><td>{METHOD_LABELS[r.method] ?? r.method}{r.mobileMoney ? ` · ${r.mobileMoney.msisdn}${r.mobileMoney.mode === "sandbox" ? " (sandbox)" : ""}` : ""}</td></tr>
            {r.reference ? <tr><td>Transaction reference</td><td className="mv-id">{r.reference}</td></tr> : null}
            {r.amountTendered != null ? <tr><td>Cash tendered</td><td className="mv-money">{formatMoney(r.amountTendered, r.currency)}</td></tr> : null}
            {r.change != null ? <tr><td>Change</td><td className="mv-money">{formatMoney(r.change, r.currency)}</td></tr> : null}
            <tr><td>Balance after this payment</td><td className="mv-money">{formatMoney(r.balanceAfter, r.currency)}</td></tr>
          </tbody>
        </table>
        <p className="mv-small mv-muted" style={{ textAlign: "center", marginTop: 12 }}>Thank you.</p>
      </Card>
    </div>
  );
}
