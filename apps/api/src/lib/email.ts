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
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, text: message.text }),
    });
    if (!response.ok) {
      return { delivered: false, adapter: "resend", detail: `Provider returned HTTP ${response.status}` };
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
