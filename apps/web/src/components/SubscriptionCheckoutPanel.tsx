import { useEffect, useState } from "react";
import { Badge, Button, Card, ErrorState, Field, Input, Notice, Select, Stack } from "@medveris/ui";
import { api, errorMessage } from "../lib/api";
import { formatDate, formatMoney } from "../lib/format";
import { useAction } from "../lib/useAction";
import { getPackageTier, staffLimitLabel, storageLabel, monthlyPriceUsdForPlan, PACKAGE_TIERS } from "@medveris/domain";
import { initialClassification, LevelFields, RegistrationFields, registrationsPayload, type ClassificationValue, type RegistrationValue } from "@medveris/domain";

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
  provider: string;
  providerMode: string;
}

const tone = (status: Checkout["status"]) =>
  status === "succeeded" ? "success" : status === "failed" ? "danger" : status === "cancelled" ? "neutral" : status === "indeterminate" ? "warning" : "info";

/**
 * Pays for one subscription period with a mobile-money prompt. The amount, period, exchange rate
 * and manual-renewal terms are shown before the prompt is sent. Nothing renews automatically, and
 * a browser redirect is never treated as proof of payment.
 */
export function SubscriptionCheckoutPanel() {
  const [interval, setInterval] = useState<Interval>("monthly");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [msisdn, setMsisdn] = useState("");
  const [consent, setConsent] = useState(false);
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [selectedPackage, setSelectedPackage] = useState<keyof typeof PACKAGE_TIERS | null>(null);
  const [organization, setOrganization] = useState<{ name: string; kind: string; ownership: string; district: string; city: string; classification: ClassificationValue }>({ name: "", kind: "clinic", ownership: "private-for-profit", district: "", city: "", classification: initialClassification() });
  const [classificationValue, setClassificationValue] = useState<ClassificationValue>(initialClassification());
  const [registrations, setRegistrations] = useState<RegistrationValue[]>([]);
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
    if (!selectedPackage) {
      action.setError("Choose a subscription package before paying.");
      return;
    }
    await action.run("pay", async () => {
      const result = await api<{ checkout: Checkout }>("/billing/subscription-checkout", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: { interval, msisdn, consent: true, selectedPackage: selectedPackage },
      });
      setCheckout(result.checkout);
      return "Approach the payment prompt on your phone. Nothing is marked paid until the provider confirms it.";
    });
  }

  async function check(): Promise<void> {
    if (!checkout) return;
    await action.run("check", async () => {
      const result = await api<{ checkout: Checkout }>(`/billing/subscription-checkout/${checkout.id}/check`, { method: "POST" });
      setCheckout(result.checkout);
      return result.checkout.status === "succeeded"
        ? `Payment confirmed by ${result.checkout.provider === "livepay" ? "LivePay" : "the payment provider"}.`
        : `Status: ${result.checkout.status}.`;
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

  const [selectedPackage, setSelectedPackage] = useState<keyof typeof PACKAGE_TIERS | null>(null);
const [packageQuote, setPackageQuote] = useState<Quote | null>(null);

const packageDescriptions: Record<keyof typeof PACKAGE_TIERS, string> = {
  basic: "Essential healthcare management for small facilities",
  standard: "Recommended for growing healthcare organizations",
  professional: "Comprehensive platform for large healthcare networks",
  enterprise: "Custom arrangement for enterprise healthcare organizations",
};

const packageStaffLimits: Record<keyof typeof PACKAGE_TIERS, string> = {
  basic: staffLimitLabel(PACKAGE_TIERS.basic.staffLimit),
  standard: staffLimitLabel(PACKAGE_TIERS.standard.staffLimit),
  professional: staffLimitLabel(PACKAGE_TIERS.professional.staffLimit),
  enterprise: staffLimitLabel(PACKAGE_TIERS.enterprise.staffLimit),
};

const packageStorageLabels: Record<keyof typeof PACKAGE_TIERS, string> = {
  basic: storageLabel(PACKAGE_TIERS.basic.storageGb),
  standard: storageLabel(PACKAGE_TIERS.standard.storageGb),
  professional: storageLabel(PACKAGE_TIERS.professional.storageGb),
  enterprise: storageLabel(PACKAGE_TIERS.enterprise.storageGb),
};

const packageMonthlyPrices: Record<keyof typeof PACKAGE_TIERS, number> = {
  basic: PACKAGE_TIERS.basic.monthlyPriceUsd,
  standard: PACKAGE_TIERS.standard.monthlyPriceUsd,
  professional: PACKAGE_TIERS.professional.monthlyPriceUsd,
  enterprise: PACKAGE_TIERS.enterprise.monthlyPriceUsd ?? 0,
};

async function loadPackageQuote(packageCode: keyof typeof PACKAGE_TIERS) {
  const tier = PACKAGE_TIERS[packageCode];
  const seats = tier.staffLimit;
  const amountUsdMinor = seats * SEAT_PRICE_USD_MINOR;
  const fx = await subscriptionExchangeRate(config, deps);
  const amountUgx = usdMinorToUgxMinor(amountUsdMinor, fx.rate);
  const disclosure = checkoutDisclosure({
    product: tier.name,
    seats,
    interval: interval,
    amountUgx,
    amountUsdMinor,
    periodStart: new Date(),
    periodEnd: addBillingInterval(new Date(), interval),
    rate: fx.rate,
    rateSource: fx.source,
    rateTimestamp: fx.providerTimestamp,
    minUgx: config.subscription.minUgx,
  });
  setPackageQuote({
    interval,
    seats,
    unitPriceUsdMinor: SEAT_PRICE_USD_MINOR,
    amountUsdMinor,
    amountUgx,
    fx: { base: "USD", quote: "UGX", rate: fx.rate, source: fx.source, providerTimestamp: fx.providerTimestamp?.toISOString() ?? null, recordedAt: new Date().toISOString(), rounding: "ceil-whole-shilling" },
    periodStart: new Date(),
    periodEnd: addBillingInterval(new Date(), interval),
    nextRenewalAt: addBillingInterval(new Date(), interval),
    renewalMode: "manual",
    product: tier.name,
    disclosure,
    minUgx: config.subscription.minUgx,
  });
}

function packageCard(packageCode: keyof typeof PACKAGE_TIERS) {
  const tier = PACKAGE_TIERS[packageCode];
  const isSelected = selectedPackage === packageCode;
  const price = packageMonthlyPrices[packageCode];
  return (
    <Card
      key={packageCode}
      className={isSelected ? "mv-package-card-selected" : ""}
      title={tier.name}
      description={tier.description}
    >
      <div className="mv-package-pricing">
        <div>{ugx(packageMonthlyPrices[packageCode] ?? 0)} / month</div>
        <div>{packageStaffLimits[packageCode]} staff</div>
        <div>{packageStorageLabels[packageCode]}</div>
      </div>
      <div className="mv-package-features">
        {tier.features.slice(0, 3).map((feature) => (
          <span key={feature} className="mv-package-feature">▸ {feature}</span>
        ))}
        {tier.features.length > 3 ? <span className="mv-small mv-muted">+ {tier.features.length - 3} more</span> : null}
      </div>
    </Card>
  );
}

/** Map a facility kind to the allowed service categories. */
function facilityCategories(kind: string): string[] {
  const map: Record<string, string[]> = {
    pharmacy: ["pharmacy"],
    drugshop: ["pharmacy"],
    laboratory: ["laboratory"],
    imaging: ["imaging"],
    dental: ["clinic"],
    medical: ["clinic"],
    hospital: ["hospital"],
    specialist: ["clinic"],
    healthcare: ["clinic"],
    network: ["clinic"],
  };
  return map[kind] ?? ["clinic"];
}

return (
    <Card
      title="Pay for a period with mobile money"
      description="USD 0.50 per active user for the period you choose, collected in its UGX equivalent through the configured payment provider. Renewal is manual — no automatic charge."
    >
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="info">{action.message}</Notice> : null}

      <Stack gap={16} className="mv-package-selection">
        {["basic", "standard", "professional", "enterprise"].map((code) => packageCard(code))}
        {selectedPackage ? (
          <div className="mv-package-details">
            <strong>Selected:</strong> {PACKAGE_TIERS[selectedPackage!.].name}
            <br />
            <strong>Staff limit:</strong> {packageStaffLimits[selectedPackage!]}
            <br />
            <strong>Storage:</strong> {packageStorageLabels[selectedPackage!]}
            <br />
            <strong>Monthly price:</strong> {ugx(packageMonthlyPrices[selectedPackage!])}
          </div>
        ) : null}
      </Stack>

      {/* Organization Registration Screen */}
      {selectedPackage == null ? (
        <Field label="Organization" htmlFor="org-name" hint="Name of your facility or organization.">
          <Input id="org-name" value={organization.name} onChange={(event) => setOrganization({ ...organization, name: event.target.value })} required minLength={2} maxLength={200} />
        </Field>
        <Field label="Facility type" htmlFor="org-kind" hint="Type of healthcare facility.">
          <Select id="org-kind" value={organization.kind} onChange={(event) => setOrganization({ ...organization, kind: event.target.value })}>
            <option value="clinic">Clinic</option><option value="hospital">Hospital</option>
            <option value="pharmacy">Pharmacy</option><option value="drugshop">Drug shop</option>
            <option value="laboratory">Laboratory</option>
            <option value="imaging">Imaging centre</option>
            <option value="dental">Dental clinic</option>
            <option value="medical">Medical clinic</option>
            <option value="hospital">Hospital</option>
            <option value="specialist">Specialist centre</option>
            <option value="network">Healthcare network</option>
          </Select>
        </Field>
        <Field label="Country" htmlFor="org-country" hint="Country of facility registration.">
          <Input id="org-country" value={"Uganda"} readOnly />
        </Field>
        <LevelFields value={classificationValue} onChange={setClassificationValue} idPrefix="reg" />
        <RegistrationFields category={facilityCategories(organization.kind)} value={registrations} onChange={setRegistrations} idPrefix="reg-reg" />
      ) : null}

      <div className="mv-form-grid">
        <Field label="Package" htmlFor="checkout-package" hint="Choose a subscription tier.">
          <Select id="checkout-package" value={selectedPackage ?? "standard"} onChange={(event) => {
            const code = event.target.value as keyof typeof PACKAGE_TIERS;
            setSelectedPackage(code);
            loadPackageQuote(code).then(() => setCheckout(null));
          }}>
            {["basic", "standard", "professional", "enterprise"].map((code) => (
              <option key={code} value={code}>
                {PACKAGE_TIERS[code].name} — {ugx(packageMonthlyPrices[code])} / month
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Billing period" htmlFor="checkout-interval" hint="The notice is live: the charge applies to the whole selected period.">
          <Select id="checkout-interval" value={interval} onChange={(event) => { setInterval(event.target.value as Interval); setCheckout(null); }}>
            {INTERVALS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select>
        </Field>
        <Field label="Active users" htmlFor="checkout-seats" hint="Every active member of this account's workspaces.">
          <Input id="checkout-seats" readOnly value={loading ? "…" : packageQuote?.seats ?? quote?.seats ?? "—"} />
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
