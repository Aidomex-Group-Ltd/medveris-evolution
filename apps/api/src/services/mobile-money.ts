import type { Tx } from "@medveris/db";
import { maskMsisdn, roundMoney } from "@medveris/domain";
import type { AppConfig } from "../config.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { NotFoundError } from "../lib/errors.js";
import type { YoOutcome } from "../integrations/yo.js";
import { receiptNumber, refreshInvoice } from "./billing.js";

export type MobileMoneyStatus = "initiated" | "pending" | "succeeded" | "failed" | "indeterminate";

export interface MobileMoneyEvidence {
  kind: "initiate" | "ipn" | "failure-notification" | "status-check";
  /** Applying the same evidence twice is a no-op, e.g. Yo! retrying a notification. */
  dedupeKey: string;
  outcome: YoOutcome;
  signatureVerified: boolean | null;
  providerStatus: string | null;
  providerReference?: string | null;
  networkReference?: string | null;
  /** Amount the provider says was collected; a success without a matching amount is never posted. */
  confirmedAmount?: number | null;
  /** Currency the provider reported, when it reports one; a mismatch is never posted. */
  confirmedCurrency?: string | null;
  detail?: Record<string, unknown>;
  payloadDigest?: string | null;
  statusMessage?: string | null;
}

export interface MobileMoneyActor {
  kind: "staff" | "system";
  userId: string | null;
  roles: string[];
  correlationId?: string | null;
  ipAddress?: string | null;
}

export interface MobileMoneyResult {
  status: MobileMoneyStatus;
  applied: boolean;
  duplicate: boolean;
  paymentId: string | null;
}

const UNRESOLVED: readonly MobileMoneyStatus[] = ["initiated", "pending", "indeterminate"];

/**
 * Applies one piece of provider evidence to a mobile money request and, when it confirms collection,
 * posts exactly one payment against the bill and reconciles the bill's status. A later failure never
 * undoes a confirmed payment; a confirmation arriving after a failure is still posted, because the payer
 * was debited, and is flagged for the cashier.
 */
export async function applyMobileMoneyEvidence(tx: Tx, config: AppConfig, tenantId: string, requestId: string, evidence: MobileMoneyEvidence, actor: MobileMoneyActor): Promise<MobileMoneyResult> {
  const [request] = await tx`
    select r.*, i.patient_id, i.number as invoice_number from mobile_money_requests r join invoices i on i.id = r.invoice_id
     where r.id = ${requestId} and r.tenant_id = ${tenantId} for update of r
  `;
  if (!request) throw new NotFoundError("Mobile money request not found");
  const current = String(request.status) as MobileMoneyStatus;
  const [seen] = await tx`select id from mobile_money_events where request_id = ${requestId} and dedupe_key = ${evidence.dedupeKey}`;
  if (seen) return { status: current, applied: false, duplicate: true, paymentId: (request.paymentId as string | null) ?? null };

  let next: MobileMoneyStatus = current;
  let outcome: "applied" | "ignored" | "rejected" = "ignored";
  let detail = evidence.statusMessage ?? null;
  const amount = Number(request.amount);
  if (evidence.outcome === "succeeded" && current !== "succeeded") {
    const currency = String(request.currency);
    if (evidence.confirmedAmount == null || !Number.isFinite(evidence.confirmedAmount)) {
      next = UNRESOLVED.includes(current) ? "indeterminate" : current;
      outcome = "rejected";
      detail = "Yo! reported success without an amount; not posted. Check the status again to reconcile.";
    } else if (roundMoney(evidence.confirmedAmount) !== roundMoney(amount)) {
      next = UNRESOLVED.includes(current) ? "indeterminate" : current;
      outcome = "rejected";
      detail = `Provider confirmed ${evidence.confirmedAmount} but ${amount} ${currency} was requested; not posted. Reconcile with Yo! before taking another payment.`;
    } else if (evidence.confirmedCurrency && evidence.confirmedCurrency.toUpperCase() !== currency) {
      next = UNRESOLVED.includes(current) ? "indeterminate" : current;
      outcome = "rejected";
      detail = `Provider confirmed ${evidence.confirmedCurrency} but the bill is in ${currency}; not posted. Reconcile with Yo!.`;
    } else {
      next = "succeeded";
      outcome = "applied";
      detail = current === "failed" ? "Confirmed by Yo! after it was reported failed; check the bill for an overpayment." : "Payment confirmed by Yo!";
    }
  } else if (evidence.outcome === "failed" && UNRESOLVED.includes(current)) {
    next = "failed";
    outcome = "applied";
    detail = evidence.statusMessage || "The payer declined, cancelled or did not approve the prompt in time";
  } else if (evidence.outcome === "pending" && current === "initiated") {
    next = "pending";
    outcome = "applied";
    detail = "Waiting for the payer to approve the prompt on their phone";
  } else if (evidence.outcome === "indeterminate" && (current === "initiated" || current === "pending")) {
    next = "indeterminate";
    outcome = "applied";
    detail = evidence.statusMessage || "Yo! has not resolved this transaction yet; check its status again before retrying";
  }

  await tx`
    insert into mobile_money_events (id, tenant_id, request_id, kind, dedupe_key, signature_verified, provider_status, outcome, payload_digest, detail)
    values (${crypto.randomUUID()}, ${tenantId}, ${requestId}, ${evidence.kind}, ${evidence.dedupeKey}, ${evidence.signatureVerified},
      ${evidence.providerStatus}, ${outcome}, ${evidence.payloadDigest ?? null}, ${tx.json({ ...(evidence.detail ?? {}), from: current, to: next } as never)})
  `;

  let paymentId = (request.paymentId as string | null) ?? null;
  if (next === "succeeded" && current !== "succeeded") {
    paymentId = crypto.randomUUID();
    const receipt = receiptNumber();
    const reference = evidence.networkReference || request.networkReference || evidence.providerReference || request.providerReference || null;
    await tx`
      insert into payments (id, tenant_id, invoice_id, amount, method, reference, notes, received_by, receipt_number, mobile_money_request_id)
      values (${paymentId}, ${tenantId}, ${request.invoiceId}, ${amount}, 'mobile-money', ${reference},
        ${`Yo! mobile money from ${maskMsisdn(String(request.msisdn))}`}, ${request.requestedBy}, ${receipt}, ${requestId})
    `;
    await refreshInvoice(tx, tenantId, String(request.invoiceId), actor.userId);
    await writeAudit(tx, config, {
      tenantId, actorKind: actor.kind, actorUserId: actor.userId, actorRoles: actor.roles,
      action: "payment.mobile-money.confirmed", subjectPatientId: String(request.patientId), resourceType: "Payment", resourceId: paymentId,
      correlationId: actor.correlationId ?? null, ipAddress: actor.ipAddress ?? null,
      metadata: { invoiceId: request.invoiceId, requestId, amount, provider: "yo", evidence: evidence.kind, receipt, lateConfirmation: current === "failed" },
    });
    await writeOutbox(tx, { tenantId, eventType: "payment.received", aggregateId: paymentId, payload: { invoiceId: request.invoiceId, amount, method: "mobile-money" } });
  } else if (outcome === "applied" && next !== current) {
    await writeAudit(tx, config, {
      tenantId, actorKind: actor.kind, actorUserId: actor.userId, actorRoles: actor.roles,
      action: `payment.mobile-money.${next}`, subjectPatientId: String(request.patientId), resourceType: "MobileMoneyRequest", resourceId: requestId,
      correlationId: actor.correlationId ?? null, ipAddress: actor.ipAddress ?? null,
      metadata: { invoiceId: request.invoiceId, from: current, to: next, evidence: evidence.kind },
    });
  }

  await tx`
    update mobile_money_requests set
      status = ${next},
      status_detail = ${detail ?? request.statusDetail},
      provider_reference = coalesce(provider_reference, ${evidence.providerReference ?? null}),
      network_reference = coalesce(${evidence.networkReference ?? null}, network_reference),
      payment_id = ${paymentId},
      completed_at = case when ${next}::text in ('succeeded','failed') and completed_at is null then now() else completed_at end,
      last_checked_at = case when ${evidence.kind}::text = 'status-check' then now() else last_checked_at end,
      check_count = check_count + case when ${evidence.kind}::text = 'status-check' then 1 else 0 end,
      updated_at = now()
     where id = ${requestId}
  `;
  return { status: next, applied: outcome === "applied", duplicate: false, paymentId };
}
