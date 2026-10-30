import { Hono, type Context } from "hono";
import { sha256Hex } from "@medveris/auth";
import { withAnonymous, withContext } from "@medveris/db";
import {
  parseFailureNotification,
  parsePaymentNotification,
  verifyFailureNotification,
  verifyPaymentNotification,
} from "../integrations/yo.js";
import { auditMeta } from "../lib/http.js";
import { enforceRateLimit, requestAddress } from "../lib/rate-limit.js";
import { applyMobileMoneyEvidence, type MobileMoneyActor } from "../services/mobile-money.js";
import { applyCheckoutEvidence } from "../services/subscription-checkout.js";
import type { AppEnv } from "../types.js";

/**
 * Yo! Payments notifications. No session: each notification is trusted only after its RSA-SHA1 signature
 * verifies against the configured Yo! public certificate, and is then applied inside the workspace that
 * issued the reference, under that workspace's row-level security. Retries are acknowledged and ignored.
 */
export const paymentCallbackRoutes = new Hono<AppEnv>();

async function formBody(c: Context<AppEnv>): Promise<{ raw: string; form: URLSearchParams }> {
  const raw = await c.req.text();
  return { raw, form: new URLSearchParams(raw) };
}

async function requestFor(c: Context<AppEnv>, reference: string): Promise<{ tenantId: string; requestId: string } | null> {
  const sql = c.get("deps").sql;
  const [row] = await withAnonymous(sql, async (tx) => tx`select app.mobile_money_request_tenant(${reference}) as tenant_id`);
  const tenantId = (row?.tenantId as string | null) ?? null;
  if (!tenantId) return null;
  const [request] = await withContext(sql, { actorKind: "system", tenantId }, async (tx) => tx`
    select id from mobile_money_requests where tenant_id = ${tenantId} and (external_reference = ${reference} or provider_reference = ${reference})
     order by (external_reference = ${reference}) desc limit 1
  `);
  return request ? { tenantId, requestId: String(request.id) } : null;
}

function systemActor(c: Context<AppEnv>): MobileMoneyActor {
  const meta = auditMeta(c);
  return { kind: "system", userId: null, roles: [], correlationId: meta.correlationId, ipAddress: meta.ipAddress };
}

function notConfigured(c: Context<AppEnv>) {
  return c.json({ error: { code: "not_configured", message: "Yo! notifications are not configured for this deployment" } }, 503);
}

paymentCallbackRoutes.post("/public/payments/yo/notifications", async (c) => {
  await enforceRateLimit(c, "payments.callback", requestAddress(c));
  const { config } = c.get("deps");
  if (!config.yo.publicKeyPem || config.yo.mode === "disabled") return notConfigured(c);
  const { raw, form } = await formBody(c);
  const notification = parsePaymentNotification(form);
  if (!notification.externalRef || !notification.signature) {
    return c.json({ error: { code: "validation_error", message: "Notification is missing external_ref or signature" } }, 400);
  }
  if (!(await verifyPaymentNotification(config.yo.publicKeyPem, notification))) {
    console.warn(JSON.stringify({ event: "yo_notification_rejected", reason: "invalid_signature", correlationId: auditMeta(c).correlationId }));
    return c.json({ error: { code: "invalid_signature", message: "Notification signature verification failed" } }, 403);
  }
  const target = await requestFor(c, notification.externalRef);
  if (!target) return c.json({ error: { code: "not_found", message: "Unknown payment reference" } }, 404);
  const amount = Number(notification.amount.replace(/,/g, ""));
  const result = await withContext(c.get("deps").sql, { actorKind: "system", tenantId: target.tenantId }, async (tx) => {
    const [request] = await tx`select msisdn from mobile_money_requests where id = ${target.requestId}`;
    const payer = notification.msisdn.replace(/\D/g, "");
    return applyMobileMoneyEvidence(tx, config, target.tenantId, target.requestId, {
      kind: "ipn",
      dedupeKey: `ipn:${notification.networkRef || await sha256Hex(raw)}`,
      outcome: "succeeded",
      signatureVerified: true,
      providerStatus: "SUCCEEDED",
      networkReference: notification.networkRef || null,
      // Yo! notifications carry no currency; the account collects UGX only, which the request already enforces.
      confirmedAmount: notification.amount && Number.isFinite(amount) ? amount : null,
      payloadDigest: await sha256Hex(raw),
      detail: { notifiedAt: notification.dateTime, payerMatches: Boolean(request) && String(request!.msisdn) === payer },
    }, systemActor(c));
  });
  return c.json({ ok: true, status: result.status, duplicate: result.duplicate });
});

/** Resolves a subscription checkout reference to the workspace the callback must run in. */
async function checkoutFor(c: Context<AppEnv>, reference: string): Promise<{ tenantId: string; checkoutId: string } | null> {
  const sql = c.get("deps").sql;
  const [row] = await withAnonymous(sql, async (tx) => tx`select app.subscription_checkout_tenant(${reference}) as tenant_id`);
  const tenantId = (row?.tenantId as string | null) ?? null;
  if (!tenantId) return null;
  const [checkout] = await withContext(sql, { actorKind: "system", tenantId }, async (tx) => tx`
    select id from subscription_checkouts where billing_account_id in (select billing_account_id from tenants where id = ${tenantId})
      and (external_reference = ${reference} or provider_reference = ${reference})
     order by (external_reference = ${reference}) desc limit 1
  `);
  return checkout ? { tenantId, checkoutId: String(checkout.id) } : null;
}

paymentCallbackRoutes.post("/public/payments/yo/failures", async (c) => {
  await enforceRateLimit(c, "payments.callback", requestAddress(c));
  const { config } = c.get("deps");
  if (!config.yo.publicKeyPem || config.yo.mode === "disabled") return notConfigured(c);
  const { raw, form } = await formBody(c);
  const notification = parseFailureNotification(form);
  if (!notification.failedTransactionReference || !notification.verification) {
    return c.json({ error: { code: "validation_error", message: "Notification is missing failed_transaction_reference or verification" } }, 400);
  }
  if (!(await verifyFailureNotification(config.yo.publicKeyPem, notification))) {
    console.warn(JSON.stringify({ event: "yo_failure_notification_rejected", reason: "invalid_signature", correlationId: auditMeta(c).correlationId }));
    return c.json({ error: { code: "invalid_signature", message: "Notification signature verification failed" } }, 403);
  }
  const target = await requestFor(c, notification.failedTransactionReference);
  if (!target) return c.json({ error: { code: "not_found", message: "Unknown payment reference" } }, 404);
  const result = await withContext(c.get("deps").sql, { actorKind: "system", tenantId: target.tenantId }, async (tx) =>
    applyMobileMoneyEvidence(tx, config, target.tenantId, target.requestId, {
      kind: "failure-notification",
      dedupeKey: `failure:${notification.failedTransactionReference}`,
      outcome: "failed",
      signatureVerified: true,
      providerStatus: "FAILED",
      payloadDigest: await sha256Hex(raw),
      statusMessage: "Yo! reported the payment as failed: the payer declined, cancelled or did not respond",
      detail: { initiatedAt: notification.transactionInitDate },
    }, systemActor(c)));
  return c.json({ ok: true, status: result.status, duplicate: result.duplicate });
});

/**
 * Subscription checkout notifications. Same signature verification as point-of-sale collections; the
 * checkout is settled only when Yo! confirms the exact UGX amount that was disclosed, and only once
 * per network reference. A browser redirect is never evidence of payment.
 */
paymentCallbackRoutes.post("/public/payments/yo/subscriptions", async (c) => {
  await enforceRateLimit(c, "payments.callback", requestAddress(c));
  const { config } = c.get("deps");
  if (!config.yo.publicKeyPem || config.yo.mode === "disabled") return notConfigured(c);
  const { raw, form } = await formBody(c);
  const notification = parsePaymentNotification(form);
  if (!notification.externalRef || !notification.signature) {
    return c.json({ error: { code: "validation_error", message: "Notification is missing external_ref or signature" } }, 400);
  }
  if (!(await verifyPaymentNotification(config.yo.publicKeyPem, notification))) {
    console.warn(JSON.stringify({ event: "yo_subscription_notification_rejected", reason: "invalid_signature", correlationId: auditMeta(c).correlationId }));
    return c.json({ error: { code: "invalid_signature", message: "Notification signature verification failed" } }, 403);
  }
  const target = await checkoutFor(c, notification.externalRef);
  if (!target) return c.json({ error: { code: "not_found", message: "Unknown subscription payment reference" } }, 404);
  const amount = Number(notification.amount.replace(/,/g, ""));
  const result = await withContext(c.get("deps").sql, { actorKind: "system", tenantId: target.tenantId }, async (tx) =>
    applyCheckoutEvidence(tx, config, target.checkoutId, {
      kind: "ipn",
      dedupeKey: `ipn:${notification.networkRef || await sha256Hex(raw)}`,
      outcome: "succeeded",
      providerStatus: "SUCCEEDED",
      networkReference: notification.networkRef || null,
      confirmedAmount: notification.amount && Number.isFinite(amount) ? amount : null,
      payloadDigest: await sha256Hex(raw),
      detail: { notifiedAt: notification.dateTime, externalReference: notification.externalRef },
    }, { kind: "system", userId: null, tenantId: target.tenantId }));
  return c.json({ ok: true, status: result.status, applied: result.applied, duplicate: result.duplicate });
});

paymentCallbackRoutes.post("/public/payments/yo/subscriptions/failures", async (c) => {
  await enforceRateLimit(c, "payments.callback", requestAddress(c));
  const { config } = c.get("deps");
  if (!config.yo.publicKeyPem || config.yo.mode === "disabled") return notConfigured(c);
  const { raw, form } = await formBody(c);
  const notification = parseFailureNotification(form);
  if (!notification.failedTransactionReference || !notification.verification) {
    return c.json({ error: { code: "validation_error", message: "Notification is missing failed_transaction_reference or verification" } }, 400);
  }
  if (!(await verifyFailureNotification(config.yo.publicKeyPem, notification))) {
    console.warn(JSON.stringify({ event: "yo_subscription_failure_rejected", reason: "invalid_signature", correlationId: auditMeta(c).correlationId }));
    return c.json({ error: { code: "invalid_signature", message: "Notification signature verification failed" } }, 403);
  }
  const target = await checkoutFor(c, notification.failedTransactionReference);
  if (!target) return c.json({ error: { code: "not_found", message: "Unknown subscription payment reference" } }, 404);
  const result = await withContext(c.get("deps").sql, { actorKind: "system", tenantId: target.tenantId }, async (tx) =>
    applyCheckoutEvidence(tx, config, target.checkoutId, {
      kind: "failure-notification",
      dedupeKey: `failure:${notification.failedTransactionReference}`,
      outcome: "failed",
      providerStatus: "FAILED",
      payloadDigest: await sha256Hex(raw),
      statusMessage: "Yo! reported the payment as failed: the payer declined, cancelled or did not respond. Nothing was charged by Medveris.",
      detail: { initiatedAt: notification.transactionInitDate },
    }, { kind: "system", userId: null, tenantId: target.tenantId }));
  return c.json({ ok: true, status: result.status, applied: result.applied, duplicate: result.duplicate });
});
