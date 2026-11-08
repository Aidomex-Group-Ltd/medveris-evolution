/**
 * LivePay (livepay.me) mobile money collections.
 *
 * LivePay exposes a REST API authenticated with a Bearer API key: POST /collect-money raises a
 * payment prompt on the payer's phone, GET /transaction-status confirms the outcome, and webhooks
 * report the same outcome asynchronously. LivePay has no test mode — its "sandbox" playground calls
 * the real endpoints with real money — so LivePay is only ever a live adapter here, and every
 * transaction is confirmed by a status check or a verified webhook before it is posted.
 *
 * Source: https://docs.livepay.me/request-money, /transaction-status and /webhooks (reviewed
 * 2026-11-08). Two details that are easy to get wrong:
 *  - transaction-status requires accountNumber, currency and reference;
 *  - a reference is at most 30 characters and must not contain spaces.
 */

import { hmacHex } from "@medveris/auth";
import type { AppConfig, LivePayConfig } from "../config.js";
import { yoConfigProblems } from "./yo.js";

export function livepayConfigProblems(config: Pick<AppConfig, "payments">): string[] {
  const livepay = config.payments.livepay;
  const problems: string[] = [];
  if (!livepay.apiKey) problems.push("LIVEPAY_API_KEY is not set (Worker secret), so LivePay cannot authenticate");
  if (!livepay.accountNumber) problems.push("LIVEPAY_ACCOUNT_NUMBER is not set, so collections cannot name the receiving account");
  if (!livepay.baseUrl) problems.push("LIVEPAY_BASE_URL is not set");
  if (!livepay.webhookUrl) problems.push("LIVEPAY_WEBHOOK_URL is not set");
  if (!livepay.webhookSecret) problems.push("LIVEPAY_WEBHOOK_SECRET is not set (Worker secret), so webhook signatures cannot be verified");
  return problems;
}

/** Configuration problems for the selected mobile money provider. */
export function paymentsConfigProblems(config: Pick<AppConfig, "payments" | "yo" | "appEnv">): string[] {
  if (config.payments.provider === "livepay") return livepayConfigProblems(config);
  return yoConfigProblems(config);
}

export interface LivePayCollectRequest {
  /** Invoice or checkout reference the payer sees. At most 30 characters, no spaces. */
  reference: string;
  phoneNumber: string;
  amount: number;
  currency: string;
  description: string;
}

export interface LivePayCollectResult {
  status: "pending" | "succeeded" | "failed" | "indeterminate";
  reference: string;
  internalReference: string | null;
  /** Amount reported by the provider, when the response carries one. */
  amount: number | null;
  /** Currency reported by the provider, when the response carries one. */
  currency: string | null;
  message: string;
}

/** The request never reached LivePay, or no usable answer came back; the outcome is unknown. */
export class LivePayTransportError extends Error {
  readonly retryable = true;
}

export type LivePayFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface LivePayClient {
  collect(request: LivePayCollectRequest): Promise<LivePayCollectResult>;
  checkStatus(reference: string, currency?: string): Promise<LivePayCollectResult>;
}

export function createLivePayClient(settings: LivePayConfig, fetchImpl: LivePayFetch = fetch): LivePayClient {
  const call = async (path: string, body: Record<string, unknown> | null, method: "POST" | "GET" = "POST"): Promise<Record<string, unknown>> => {
    const url = `${settings.baseUrl.replace(/\/+$/, "")}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${settings.apiKey ?? ""}`,
        },
        body: method === "POST" && body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      throw new LivePayTransportError(`LivePay request failed: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 504) throw new LivePayTransportError("LivePay reported a payment service timeout");
    if (!response.ok) throw new LivePayTransportError(`LivePay answered with HTTP ${response.status}`);
    try {
      return await response.json() as Record<string, unknown>;
    } catch {
      throw new LivePayTransportError("LivePay returned a body that is not JSON");
    }
  };

  const toResult = (payload: Record<string, unknown>, fallbackReference: string): LivePayCollectResult => {
    const success = payload.success === true;
    const statusRaw = String(payload.status ?? payload.transaction_status ?? "").trim().toLowerCase();
    const status: LivePayCollectResult["status"] = /^(success|successful|paid|completed|complete)$/.test(statusRaw)
      ? "succeeded"
      : /^(fail|failed|cancel|cancelled|declined|error)$/.test(statusRaw) ? "failed"
      : /^(pending|processing|initiated|queued)$/.test(statusRaw) ? "pending"
      : success ? "pending" : "indeterminate";
    const amount = payload.amount == null ? null : Number(payload.amount);
    return {
      status,
      reference: String(payload.customer_reference ?? payload.reference ?? fallbackReference),
      internalReference: payload.internal_reference == null ? null : String(payload.internal_reference),
      amount: amount !== null && Number.isFinite(amount) ? amount : null,
      currency: payload.currency == null ? null : String(payload.currency),
      message: String(payload.message ?? payload.error ?? (success ? "ok" : "request failed")),
    };
  };

  return {
    async collect(request) {
      const payload = await call("/collect-money", {
        accountNumber: settings.accountNumber,
        phoneNumber: request.phoneNumber,
        amount: request.amount,
        currency: request.currency,
        reference: request.reference,
        description: request.description,
      });
      return toResult(payload, request.reference);
    },
    async checkStatus(reference, currency = "UGX") {
      const query = new URLSearchParams({
        accountNumber: settings.accountNumber ?? "",
        currency,
        reference,
      });
      const payload = await call(`/transaction-status?${query.toString()}`, null, "GET");
      return toResult(payload, reference);
    },
  };
}

// ---------------------------------------------------------------- webhook verification

export interface LivePayWebhookPayload {
  status: string;
  message?: string | null;
  customer_reference: string;
  internal_reference?: string | null;
  provider_transaction_id?: string | null;
  msisdn?: string | null;
  amount?: number | null;
  currency?: string | null;
  provider?: string | null;
  charge?: number | null;
  completed_at?: string | null;
}

/** Signatures older or newer than this are refused, so a captured request cannot be replayed later. */
export const LIVEPAY_WEBHOOK_TOLERANCE_SECONDS = 300;

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * Verifies `X-Webhook-Signature: t=<unix>,v=<hex>` exactly as LivePay documents it:
 * HMAC-SHA256(secret, webhook_url + timestamp + sorted params), where the signed params are
 * customer_reference, internal_reference and status joined as key+value in key order.
 */
export async function verifyLivePayWebhook(
  payload: LivePayWebhookPayload,
  signatureHeader: string | null | undefined,
  webhookUrl: string,
  secret: string | null,
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; reason: "missing-signature" | "malformed-signature" | "stale-timestamp" | "bad-signature" | "not-configured" }> {
  if (!secret) return { ok: false, reason: "not-configured" };
  if (!signatureHeader) return { ok: false, reason: "missing-signature" };
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((part) => {
      const [key, ...rest] = part.trim().split("=");
      return [key?.trim() ?? "", rest.join("=").trim()];
    }),
  );
  const timestamp = Number(parts.t);
  const received = String(parts.v ?? "").toLowerCase();
  if (!Number.isInteger(timestamp) || !/^[0-9a-f]{64}$/.test(received)) return { ok: false, reason: "malformed-signature" };
  if (Math.abs(now - timestamp * 1000) > LIVEPAY_WEBHOOK_TOLERANCE_SECONDS * 1000) return { ok: false, reason: "stale-timestamp" };
  const params: Array<[string, string]> = [
    ["customer_reference", String(payload.customer_reference ?? "")],
    ["internal_reference", String(payload.internal_reference ?? "")],
    ["status", String(payload.status ?? "")],
  ];
  params.sort((left, right) => left[0].localeCompare(right[0]));
  let signingString = `${webhookUrl}${timestamp}`;
  for (const [key, value] of params) signingString += `${key}${value}`;
  const expected = (await hmacHex(secret, signingString)).toLowerCase();
  return constantTimeEqual(received, expected) ? { ok: true } : { ok: false, reason: "bad-signature" };
}

/** Maps a LivePay webhook status to the checkout state machine's outcomes. */
export function livePayWebhookOutcome(status: string): "succeeded" | "failed" | "pending" | "indeterminate" {
  const normalized = status.trim().toLowerCase();
  if (/^(success|successful|paid|completed|complete)$/.test(normalized)) return "succeeded";
  if (/^(fail|failed|cancel|cancelled|declined|error)$/.test(normalized)) return "failed";
  if (/^(pending|processing|initiated|queued)$/.test(normalized)) return "pending";
  return "indeterminate";
}
