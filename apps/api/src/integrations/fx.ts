import type { FetchLike } from "./dhis2.js";

/** A conversion rate: 1 unit of `base` buys `rate` units of `quote`, as published by the provider at `providerTimestamp`. */
export interface FxQuote {
  base: string;
  quote: string;
  rate: number;
  provider: string;
  providerTimestamp: Date;
}

export interface FxProvider {
  readonly name: string;
  rate(base: string, quote: string): Promise<FxQuote>;
}

export class FxUnavailableError extends Error {}

export interface FxConfig {
  provider: "none" | "openexchangerates";
  apiKey: string | null;
  /** How long a fetched rate stays locked for the administrator to confirm. */
  lockMinutes: number;
  timeoutMs: number;
}

/**
 * Open Exchange Rates `latest.json` (https://docs.openexchangerates.org/reference/latest-json). Rates are
 * relative to USD, the only base available on every plan, so a cross rate is quote/base. The key is sent
 * as the documented `app_id` query parameter and never logged.
 */
export function openExchangeRates(apiKey: string, timeoutMs: number, transport: FetchLike = fetch): FxProvider {
  return {
    name: "openexchangerates",
    async rate(base, quote) {
      const url = new URL("https://openexchangerates.org/api/latest.json");
      url.searchParams.set("app_id", apiKey);
      url.searchParams.set("symbols", [...new Set([base, quote, "USD"])].join(","));
      let response: Response;
      try {
        response = await transport(url.toString(), { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        throw new FxUnavailableError("The exchange rate provider could not be reached");
      }
      if (!response.ok) throw new FxUnavailableError(`The exchange rate provider answered ${response.status}`);
      const body = await response.json().catch(() => null) as { timestamp?: number; base?: string; rates?: Record<string, number> } | null;
      const rates = body?.rates ?? {};
      const baseRate = base === body?.base ? 1 : rates[base];
      const quoteRate = quote === body?.base ? 1 : rates[quote];
      if (!body?.timestamp || body.base !== "USD" || !baseRate || !quoteRate || baseRate <= 0 || quoteRate <= 0) {
        throw new FxUnavailableError(`The exchange rate provider has no ${base}/${quote} rate`);
      }
      return { base, quote, rate: Number((quoteRate / baseRate).toPrecision(12)), provider: "openexchangerates", providerTimestamp: new Date(body.timestamp * 1000) };
    },
  };
}

export function createFxProvider(config: FxConfig, transport?: FetchLike): FxProvider | null {
  if (config.provider === "openexchangerates" && config.apiKey) return openExchangeRates(config.apiKey, config.timeoutMs, transport);
  return null;
}
