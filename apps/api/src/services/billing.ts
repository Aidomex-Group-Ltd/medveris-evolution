import type { Tx } from "@medveris/db";
import { billingStatusForInvoice, roundMoney } from "@medveris/domain";

export interface InvoiceTotals {
  status: string;
  currency: string;
  total: number;
  paid: number;
  refunded: number;
  balance: number;
}

/** Paid is the net of unreversed payments less refunds; refunds never alter the original payment. */
export async function invoiceTotals(tx: Tx, tenantId: string, invoiceId: string): Promise<InvoiceTotals | null> {
  const [row] = await tx`
    select i.status, i.currency,
      coalesce((select sum(ii.amount) from invoice_items ii where ii.invoice_id = i.id), 0) as total,
      coalesce((select sum(p.amount) from payments p where p.invoice_id = i.id and p.reversed_at is null), 0) as collected,
      coalesce((select sum(r.amount) from payment_refunds r where r.invoice_id = i.id), 0) as refunded
      from invoices i where i.id = ${invoiceId} and i.tenant_id = ${tenantId}
  `;
  if (!row) return null;
  const total = roundMoney(Number(row.total));
  const refunded = roundMoney(Number(row.refunded));
  const paid = roundMoney(Number(row.collected) - refunded);
  return { status: String(row.status), currency: String(row.currency), total, paid, refunded, balance: roundMoney(total - paid) };
}

/**
 * Recomputes an invoice's status from its lines and unreversed payments, then mirrors it onto the
 * recommendations and supply lines it charges, so department queues and reception see whether work is
 * paid without reading the bill itself.
 */
export async function refreshInvoice(tx: Tx, tenantId: string, invoiceId: string, actorUserId: string | null): Promise<InvoiceTotals | null> {
  const [locked] = await tx`select id, status from invoices where id = ${invoiceId} and tenant_id = ${tenantId} for update`;
  if (!locked) return null;
  const totals = await invoiceTotals(tx, tenantId, invoiceId);
  if (!totals) return null;
  if (locked.status !== "void") {
    const status = totals.paid >= totals.total && totals.total > 0 ? "paid" : totals.paid > 0 ? "part-paid" : "open";
    if (status !== locked.status) await tx`update invoices set status = ${status} where id = ${invoiceId}`;
    totals.status = status;
  }
  const billing = billingStatusForInvoice(totals.status);
  const changed = await tx`
    update care_recommendations r set billing_status = ${billing}, updated_at = now()
      from invoice_items ii
     where ii.invoice_id = ${invoiceId} and ii.recommendation_id = r.id and r.tenant_id = ${tenantId} and r.billing_status <> ${billing}
    returning r.id, r.status
  `;
  for (const row of changed) {
    await tx`
      insert into care_recommendation_events (id, tenant_id, recommendation_id, event, from_status, to_status, note, actor_user_id)
      values (${crypto.randomUUID()}, ${tenantId}, ${row.id}, 'payment-updated', ${row.status}, ${row.status}, ${`Bill ${billing}`}, ${actorUserId})
    `;
  }
  await tx`
    update care_supply_usages s set billing_status = ${billing}
      from invoice_items ii
     where ii.invoice_id = ${invoiceId} and ii.supply_usage_id = s.id and s.tenant_id = ${tenantId} and s.billing_status <> ${billing}
  `;
  return totals;
}

export function receiptNumber(now = new Date()): string {
  return `RCT-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

export function invoiceNumber(now = new Date()): string {
  return `INV-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
}
