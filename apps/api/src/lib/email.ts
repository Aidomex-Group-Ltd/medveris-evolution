import { breakerFor, CircuitOpenError, metric, retry, TimeoutError, withTimeout } from "@medveris/platform";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailResult {
  delivered: boolean;
  adapter: string;
  detail: string;
}

export interface EmailAdapter {
  send(message: EmailMessage): Promise<EmailResult>;
}

class ProviderStatusError extends Error {
  constructor(readonly status: number, readonly reason: string) {
    super(`Provider returned HTTP ${status}${reason}`);
  }
}

const SEND_TIMEOUT_MS = 10_000;

/** Network failures, timeouts, 429 and 5xx may be retried: the Idempotency-Key makes a repeat send harmless. */
function retryableSend(error: unknown): boolean {
  if (error instanceof ProviderStatusError) return error.status === 429 || error.status >= 500;
  return !(error instanceof CircuitOpenError);
}

export class ResendEmailAdapter implements EmailAdapter {
  constructor(
    private readonly apiKey: string | null,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly sleep?: (ms: number) => Promise<void>,
  ) {}

  async send(message: EmailMessage): Promise<EmailResult> {
    if (!this.apiKey) return { delivered: false, adapter: "resend", detail: "RESEND_API_KEY is not configured" };
    const breaker = breakerFor("email.resend", {
      failureThreshold: 5,
      resetTimeoutMs: 30_000,
      isFailure: (error) => !(error instanceof ProviderStatusError) || error.status === 429 || error.status >= 500,
    });
    const idempotencyKey = crypto.randomUUID();
    const started = Date.now();
    try {
      const data = await retry(
        () => breaker.execute(() => withTimeout("email.resend", SEND_TIMEOUT_MS, async (signal) => {
          const response = await this.fetchImpl("https://api.resend.com/emails", {
            method: "POST",
            headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", "idempotency-key": idempotencyKey },
            body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, text: message.text }),
            signal,
          });
          if (!response.ok) {
            const error = (await response.json().catch(() => null)) as { message?: unknown } | null;
            throw new ProviderStatusError(response.status, typeof error?.message === "string" ? `: ${error.message.slice(0, 200)}` : "");
          }
          return (await response.json().catch(() => ({}))) as { id?: string };
        })),
        { attempts: 3, baseDelayMs: 250, maxDelayMs: 2000, retryable: retryableSend, sleep: this.sleep },
      );
      metric("dependency.call", 1, { dependency: "email.resend", outcome: "ok", ms: Date.now() - started });
      return { delivered: true, adapter: "resend", detail: data.id ?? "accepted-by-provider" };
    } catch (error) {
      metric("dependency.call", 1, { dependency: "email.resend", outcome: "error", ms: Date.now() - started });
      if (error instanceof ProviderStatusError) return { delivered: false, adapter: "resend", detail: error.message };
      if (error instanceof CircuitOpenError) return { delivered: false, adapter: "resend", detail: "Provider temporarily unavailable (circuit open)" };
      const name = error instanceof TimeoutError ? "TimeoutError" : error instanceof Error ? error.name : "unknown error";
      return { delivered: false, adapter: "resend", detail: `Provider unreachable (${name})` };
    }
  }
}

export class UnconfiguredEmailAdapter implements EmailAdapter {
  async send(): Promise<EmailResult> {
    return { delivered: false, adapter: "unconfigured", detail: "No email provider is configured" };
  }
}
