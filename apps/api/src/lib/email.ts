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

export class ResendEmailAdapter implements EmailAdapter {
  constructor(
    private readonly apiKey: string | null,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<EmailResult> {
    if (!this.apiKey) return { delivered: false, adapter: "resend", detail: "RESEND_API_KEY is not configured" };
    let response: Response;
    try {
      response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, text: message.text }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      return { delivered: false, adapter: "resend", detail: `Provider unreachable (${error instanceof Error ? error.name : "unknown error"})` };
    }
    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as { message?: unknown } | null;
      const reason = typeof error?.message === "string" ? `: ${error.message.slice(0, 200)}` : "";
      return { delivered: false, adapter: "resend", detail: `Provider returned HTTP ${response.status}${reason}` };
    }
    const data = (await response.json()) as { id?: string };
    return { delivered: true, adapter: "resend", detail: data.id ?? "accepted-by-provider" };
  }
}

export class UnconfiguredEmailAdapter implements EmailAdapter {
  async send(): Promise<EmailResult> {
    return { delivered: false, adapter: "unconfigured", detail: "No email provider is configured" };
  }
}
