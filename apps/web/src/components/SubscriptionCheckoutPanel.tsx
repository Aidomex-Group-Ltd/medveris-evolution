import { useEffect, useState } from "react";
import { Badge, Button, Card, ErrorState, Field, Input, Notice, Select } from "@medveris/ui";
import { api, errorMessage } from "../lib/api";
import { formatDate } from "../lib/format";
import { useAction } from "../lib/useAction";

type Interval = "daily" | "weekly" | "monthly" | "quarterly" | "annually";

const INTERVALS: Array<{ value: Interval; label: string }> = [
  { value: "daily", label: "Daily — one day" },
  { value: "weekly", label: "Weekly — one week" },
  { value: "monthly", label: "Monthly — one month" },
  { value: "quarterly", label: "Quarterly — three months" },
  { value: "annually", label: "Annually — one year" },
];

interface Quote {
  interval: Interval;
  seats: number;
  unitPriceUsdMinor: number;
  amountUsdMinor: number;
  amountUgx: number;
  fx: { base: string; quote: string; rate: number; source: string; providerTimestamp: string | null; recordedAt: string; rounding: string };
  periodStart: string;
  periodEnd: string;
  nextRenewalAt: string;
  renewalMode: "manual";
  product: string;
  disclosure: string;
  minUgx: number;
}

interface Checkout {
  id: string;
  status: "pending" | "succeeded" | "failed" | "cancelled" | "indeterminate";
  interval: Interval;
  seats: number;
  amountUgx: number;
  amountUsdMinor: number;
  periodStart: string;
  periodEnd: string;
  nextRenewalAt: string;
  msisdn: string;
  statusDetail: string | null;
  failureReason: string | null;
  canCancel: boolean;
  disclosure: string;
}

const tone = (status: Checkout["status"]) =>
  status === "succeeded" ? "success" : status === "failed" ? "danger" : status === "cancelled" ? "neutral" : status === "indeterminate" ? "warning" : "info";

/**
 * Pays for one subscription period with a Yo! mobile-money prompt. The amount, period, exchange
 * rate and manual-renewal terms are shown before the prompt is sent. Nothing renews automatically.
 */
export function SubscriptionCheckoutPanel() {
  const [interval, setInterval] = useState<Interval>("monthly");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [msisdn, setMsisdn] = useState("");
  const [consent, setConsent] = useState(false);
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const action = useAction();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setQuoteError(null);
    api<{ quote: Quote }>(`/billing/subscription-checkout/quote?interval=${interval}`)
      .then((result) => { if (!cancelled) setQuote(result.quote); })
      .catch((error) => { if (!cancelled) { setQuote(null); setQuoteError(errorMessage(error)); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [interval]);

  useEffect(() => {
    if (!checkout || !["pending", "indeterminate"].includes(checkout.status)) return;
    const timer = window.setInterval(() => {
      api<{ checkout: Checkout }>(`/billing/subscription-checkout/${checkout.id}`)
        .then((result) => setCheckout(result.checkout))
        .catch(() => undefined);
    }, 8000);
    return () => window.clearInterval(timer);
  }, [checkout?.id, checkout?.status]);

  async function pay(): Promise<void> {
    if (!consent) {
      action.setError("Read the amount, period and renewal terms, then tick the box before paying.");
      return;
    }
    await action.run("pay", async () => {
      const result = await api<{ checkout: Checkout }>("/billing/subscription-checkout", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: { interval, msisdn, consent: true },
      });
      setCheckout(result.checkout);
      return "Approach the payment prompt on your phone. Nothing is marked paid until Yo! confirms it.";
    });
  }

  async function check(): Promise<void> {
    if (!checkout) return;
    await action.run("check", async () => {
      const result = await api<{ checkout: Checkout }>(`/billing/subscription-checkout/${checkout.id}/check`, { method: "POST" });
      setCheckout(result.checkout);
      return result.checkout.status === "succeeded" ? "Payment confirmed by Yo!." : `Status: ${result.checkout.status}.`;
    });
  }

  async function cancel(): Promise<void> {
    if (!checkout) return;
    const reason = window.prompt("Why are you cancelling this payment prompt? (at least 3 characters)");
    if (reason === null) return;
    if (reason.trim().length < 3) {
      action.setError("Give a reason of at least 3 characters.");
      return;
    }
    await action.run("cancel", async () => {
      const result = await api<{ checkout: Checkout }>(`/billing/subscription-checkout/${checkout.id}/cancel`, {
        method: "POST", body: { reason: reason.trim() },
      });
      setCheckout(result.checkout);
      return "Prompt cancelled. You can start a new payment when you are ready.";
    });
  }

  const ugx = (value: number) => `UGX ${value.toLocaleString("en-UG")}`;
  const usd = (minor: number) => `USD ${(minor / 100).toFixed(2)}`;

  return (
    <Card
      title="Pay for a period with mobile money"
      description="USD 0.50 per active user for the period you choose, collected in its UGX equivalent. Renewal is manual — no automatic charge."
    >
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="info">{action.message}</Notice> : null}

      <div className="mv-form-grid">
        <Field label="Billing period" htmlFor="checkout-interval" hint="The notice is live: the charge applies to the whole selected period.">
          <Select id="checkout-interval" value={interval} onChange={(event) => { setInterval(event.target.value as Interval); setCheckout(null); }}>
            {INTERVALS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select>
        </Field>
        <Field label="Active users" htmlFor="checkout-seats" hint="Every active member of this account's workspaces.">
          <Input id="checkout-seats" readOnly value={loading ? "…" : quote?.seats ?? "—"} />
        </Field>
        <Field label="Pay from" htmlFor="checkout-msisdn" hint="MTN or Airtel mobile money number in Uganda.">
          <Input id="checkout-msisdn" inputMode="tel" autoComplete="tel" placeholder="0772 123456" value={msisdn} onChange={(event) => setMsisdn(event.target.value)} />
        </Field>
      </div>

      {loading ? <p className="mv-small mv-muted">Checking the current UGX rate and price…</p> : null}
      {quoteError ? (
        <Notice tone="warning" title="The UGX price cannot be shown right now">
          {quoteError} No payment prompt has been sent. Try again later or contact support.
        </Notice>
      ) : null}

      {quote ? (
        <div className="mv-stack">
          <div className="mv-note">
            <div className="mv-spread">
              <span><strong>{quote.seats}</strong> user{quote.seats === 1 ? "" : "s"} × {usd(quote.unitPriceUsdMinor)}</span>
              <strong style={{ fontSize: "1.2rem" }}>{ugx(quote.amountUgx)}</strong>
            </div>
            <p className="mv-small mv-muted">
              {usd(quote.amountUsdMinor)} at {quote.fx.rate.toLocaleString("en-US", { maximumFractionDigits: 4 })} UGX per USD ({quote.fx.source}
              {quote.fx.providerTimestamp ? `, published ${formatDate(quote.fx.providerTimestamp)}` : ", operator-configured"}, rounded up to whole shillings).
            </p>
            <p className="mv-small">
              Period <strong>{formatDate(quote.periodStart)} – {formatDate(quote.periodEnd)}</strong>. Next renewal <strong>{formatDate(quote.nextRenewalAt)}</strong> — manual, with a reminder.
            </p>
          </div>
          <p className="mv-checkout-terms">{quote.disclosure}</p>
          <label className="mv-consent">
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            <span>
              I have read the amount, the period and the renewal terms. I agree to be prompted to pay {ugx(quote.amountUgx)} for one {quote.interval === "daily" ? "day" : quote.interval === "weekly" ? "week" : quote.interval === "monthly" ? "month" : quote.interval === "quarterly" ? "quarter" : "year"} now.
            </span>
          </label>
          <div className="mv-row">
            <Button onClick={() => void pay()} disabled={!consent || msisdn.trim().length < 9 || action.busy !== null}>
              {action.busy === "pay" ? "Sending prompt…" : `Pay ${ugx(quote.amountUgx)} by mobile money`}
            </Button>
            <span className="mv-small mv-muted">You approve the charge on your phone. A browser redirect is never treated as payment.</span>
          </div>
        </div>
      ) : null}

      {checkout ? (
        <div className="mv-note mv-stack">
          <div className="mv-spread">
            <strong>Payment status</strong>
            <Badge tone={tone(checkout.status)}>{checkout.status}</Badge>
          </div>
          <p className="mv-small">
            {checkout.msisdn} · {ugx(checkout.amountUgx)} for one {checkout.interval} · access to {formatDate(checkout.periodEnd)}.
          </p>
          {checkout.statusDetail ? <p className="mv-small mv-muted">{checkout.statusDetail}</p> : null}
          {checkout.failureReason && !checkout.statusDetail ? <p className="mv-small mv-muted">{checkout.failureReason}</p> : null}
          <div className="mv-row">
            {["pending", "indeterminate"].includes(checkout.status) ? (
              <>
                <Button size="sm" variant="secondary" onClick={() => void check()} disabled={action.busy !== null}>
                  {action.busy === "check" ? "Checking…" : "Check status"}
                </Button>
                {checkout.canCancel ? (
                  <Button size="sm" variant="ghost" onClick={() => void cancel()} disabled={action.busy !== null}>Cancel prompt</Button>
                ) : null}
              </>
            ) : null}
            {checkout.status === "failed" || checkout.status === "cancelled" ? (
              <Button size="sm" variant="ghost" onClick={() => { setCheckout(null); setConsent(false); }}>Start again</Button>
            ) : null}
          </div>
          <p className="mv-small mv-muted">
            Nothing renews automatically. We will remind you before {formatDate(checkout.nextRenewalAt)}; you can pay the next period from this page.
          </p>
        </div>
      ) : null}
    </Card>
  );
}
