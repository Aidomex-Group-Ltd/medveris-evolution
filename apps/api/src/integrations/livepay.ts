/**
 * LivePay (livepay.me) mobile money collections.
 *
 * LivePay exposes a REST API authenticated with a Bearer API key: POST /collect-money raises a
 * payment prompt on the payer's phone, GET /transaction-status confirms the outcome, and webhooks
 * report the same outcome asynchronously. LivePay has no test mode — its "sandbox" playground calls
 * the real endpoints with real money — so LivePay is only ever a live adapter here, and every
 * transaction is confirmed by a status check before it is posted.
 */

import type { AppConfig, LivePayConfig } from "../config.js";
import { yoConfigProblems } from "./yo.js";

export function livepayConfigProblems(config: Pick<AppConfig, "payments">): string[] {
  const livepay = config.payments.livepay;
  const problems: string[] = [];
  if (!livepay.apiKey) problems.push("LIVEPAY_API_KEY is not set (Worker secret), so LivePay cannot authenticate");
  if (!livepay.accountNumber) problems.push("LIVEPAY_ACCOUNT_NUMBER is not set, so collections cannot name the receiving account");
  if (!livepay.baseUrl) problems.push("LIVEPAY_BASE_URL is not set");
  return problems;
}

/** Configuration problems for the selected mobile money provider. */
export function paymentsConfigProblems(config: Pick<AppConfig, "payments" | "yo" | "appEnv">): string[] {
  if (config.payments.provider === "livepay") return livepayConfigProblems(config);
  return yoConfigProblems(config);
}

export interface LivePayCollectRequest {
  /** Invoice or checkout reference the payer sees. */
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
  message: string;
}

/** The request never reached LivePay, or no usable answer came back; the outcome is unknown. */
export class LivePayTransportError extends Error {
  readonly retryable = true;
}

export type LivePayFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface LivePayClient {
  collect(request: LivePayCollectRequest): Promise<LivePayCollectResult>;
  checkStatus(reference: string): Promise<LivePayCollectResult>;
}

export function createLivePayClient(settings: LivePayConfig, fetchImpl: LivePayFetch = fetch): LivePayClient {
  const call = async (path: string, body: Record<string, unknown>, method: "POST" | "GET" = "POST"): Promise<Record<string, unknown>> => {
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
        body: method === "POST" ? JSON.stringify(body) : undefined,
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
    const statusRaw = String(payload.status ?? payload.transaction_status ?? "").toLowerCase();
    const status: LivePayCollectResult["status"] = statusRaw.includes("success") || statusRaw === "paid" ? "succeeded"
      : statusRaw.includes("fail") || statusRaw.includes("cancel") ? "failed"
      : success ? "pending" : "indeterminate";
    return {
      status,
      reference: String(payload.customer_reference ?? payload.reference ?? fallbackReference),
      internalReference: payload.internal_reference == null ? null : String(payload.internal_reference),
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
    async checkStatus(reference) {
      const query = new URLSearchParams({ reference, accountNumber: settings.accountNumber ?? "" });
      const payload = await call(`/transaction-status?${query.toString()}`, {}, "GET");
      return toResult(payload, reference);
    },
  };
}
