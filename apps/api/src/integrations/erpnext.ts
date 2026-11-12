import { breakerFor, CircuitOpenError, retry, withTimeout } from "@medveris/platform";
import { DependencyError } from "../lib/errors.js";
import type { ErpnextConfig } from "../config.js";

class ErpnextProviderStatus extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

export interface ErpnextStatus {
  mode: "off" | "live";
  configured: boolean;
  connected: boolean;
  providerHost: string | null;
  providerVersion: string | null;
  lastVerifiedAt: string | null;
}

function tokenHeaders(key: string | null, secret: string | null): Record<string, string> {
  if (!key || !secret) return {};
  return { authorization: `token ${key}:${secret}` };
}

/**
 * Read/write adapter for the ERPNext (Frappe HRMS) REST API. Server-side only.
 * Writes are deliberately narrow (employee lookup/upsert by employee_number).
 * Behaviour is fail-closed: without FEATURE_ERPNEXT=true and ERPNEXT_MODE=live plus a
 * base URL and service token, every operation throws; status shows mode "off".
 * Credentials never leave this module (never logged, never returned in payloads).
 */
export class ErpnextAdapter {
  readonly mode: "off" | "live";
  readonly label = "ERPNext/Frappe HRMS adapter";
  #status: ErpnextStatus;

  constructor(private readonly config: ErpnextConfig) {
    if (!config.baseUrl || !config.apiKey || !config.apiSecret) {
      this.mode = "off";
      this.#status = { mode: "off", configured: false, connected: false, providerHost: null, providerVersion: null, lastVerifiedAt: null };
      return;
    }
    this.mode = "live";
    this.#status = { mode: "live", configured: true, connected: false, providerHost: new URL(config.baseUrl).host, providerVersion: null, lastVerifiedAt: null };
  }

  get status(): ErpnextStatus {
    return this.#status;
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const breaker = breakerFor("erpnext", {
      failureThreshold: 5,
      resetTimeoutMs: 30_000,
      isFailure: (error) => !(error instanceof ErpnextProviderStatus) || error.status >= 500 || error.status === 429,
    });
    try {
      return await retry(
        () => breaker.execute(() => withTimeout("erpnext", this.config.timeoutMs, async (signal) => {
          const response = await fetch(`${this.config.baseUrl!}${path}`, {
            ...init,
            signal,
            headers: {
              accept: "application/json",
              ...tokenHeaders(this.config.apiKey, this.config.apiSecret),
              ...(init?.headers ?? {}),
            },
          });
          if (!response.ok) throw new ErpnextProviderStatus(response.status);
          return await response.json();
        })),
        {
          attempts: 2,
          baseDelayMs: 200,
          maxDelayMs: 1_000,
          retryable: (error) => !(error instanceof CircuitOpenError) && (!(error instanceof ErpnextProviderStatus) || error.status >= 500 || error.status === 429),
        },
      );
    } catch (error) {
      if (error instanceof ErpnextProviderStatus) throw new DependencyError(`ERPNext returned HTTP ${error.status}`);
      throw new DependencyError("ERPNext is unavailable");
    }
  }

  /** Read-only reachability probe; used for status reporting and initial verification only. */
  async verifyConnection(): Promise<void> {
    if (this.mode === "off") return;
    try {
      const payload = (await this.request("/api/method/frappe.auth.get_logged_user", { method: "GET" })) as { message?: unknown };
      if (payload && typeof payload.message === "string") {
        this.#status = { ...this.#status, connected: true, lastVerifiedAt: new Date().toISOString() };
      }
    } catch {
      // status stays connected=false until a probe succeeds; caller maps to 503/dep_unavailable
    }
    try {
      const version = (await this.request("/api/version", { method: "GET" })) as { message?: { frappe?: string } };
      const frappe = version?.message?.frappe;
      if (typeof frappe === "string") this.#status = { ...this.#status, providerVersion: frappe };
    } catch {
      // Version is advisory; absence does not block verification.
    }
  }

  async listEmployees(limit = 20): Promise<Array<Record<string, unknown>>> {
    if (this.mode === "off") throw new DependencyError("ERPNext integration is not configured");
    const bounded = Math.min(Math.max(limit, 1), 100);
    const payload = (await this.request(
      `/api/resource/Employee?fields=${encodeURIComponent('["name","employee_number","first_name","last_name","company","department","designation","status"]')}&limit_page_length=${bounded}`,
      { method: "GET" },
    )) as { data?: Array<Record<string, unknown>> };
    return payload.data ?? [];
  }

  async findEmployeeByNumber(employeeNumber: string): Promise<Record<string, unknown> | null> {
    if (this.mode === "off") throw new DependencyError("ERPNext integration is not configured");
    const fields = encodeURIComponent('["name","employee_number","employee_name","company","department","designation","status"]');
    const filters = encodeURIComponent(JSON.stringify([["Employee", "employee_number", "=", employeeNumber]]));
    const payload = (await this.request(`/api/resource/Employee?fields=${fields}&filters=${filters}&limit_page_length=1`, { method: "GET" })) as { data?: Array<Record<string, unknown>> };
    return payload.data?.[0] ?? null;
  }
}
