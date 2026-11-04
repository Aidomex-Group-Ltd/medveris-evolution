import type { ReactNode } from "react";
import { Badge } from "@medveris/ui";
import "./PricingPage.css";

const cents = (value: number | null | undefined, currency = "USD") =>
  value == null ? "—" : `${currency} ${(value / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const PLATFORM_KIT = [
  ["Core clinical", "registration, visits, triage, observations, care plans, follow-ups and referrals"],
  ["Point of sale", "cash, card and mobile-money sales with receipts"],
  ["Price list", "owned catalogue of services, procedures, supplies and pharmacy items"],
  ["Staff seats", "included per plan before per-seat add-ons apply"],
  ["Storage", "included flat kit with per-plan allowance"],
  ["Workers AI", "in-platform AI assistance included on every plan"],
] as const;

const PLANS = [
  { code: "basic", name: "Basic", description: "Low-consumption accounts", monthlyPriceMinor: 1500, storageGb: 10, seats: 10, usageOverages: false, features: ["core-clinical", "point-of-sale", "price-list"], contractRequired: false },
  { code: "standard", name: "Standard", description: "Medium-consumption accounts", monthlyPriceMinor: 3000, storageGb: 50, seats: 50, usageOverages: false, features: ["core-clinical", "point-of-sale", "price-list"], contractRequired: false },
  { code: "professional", name: "Professional", description: "High-consumption accounts", monthlyPriceMinor: 10000, storageGb: 200, seats: 250, usageOverages: false, features: ["core-clinical", "point-of-sale", "price-list"], contractRequired: false },
  { code: "enterprise", name: "Enterprise", description: "Custom kit with a contract", monthlyPriceMinor: null, storageGb: null, seats: null, usageOverages: true, features: ["core-clinical", "point-of-sale", "price-list"], contractRequired: true },
];

function Logo({ text }: { text: string }) {
  return (
    <a href="/" className="pricing-logo" aria-label="Medveris home">
      <span className="pricing-logo-mark">
        <img src="/logo.png" alt="" width={40} height={40} decoding="async" />
      </span>
      <span className="pricing-logo-text">Medveris</span>
    </a>
  );
}

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      {open ? <path d="m6 6 12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
    </svg>
  );
}

export function PricingPage() {
  // Intentional illustrative catalog for the public pricing page.
  // The active plan catalogue for signed-in accounts lives in the billing console:
  // subscription_plans (draft/approved) via /platform/billing/plans, and the
  // facility price list via /platform/price-lists. Prices here are fixed tier
  // examples for marketing, not live contract prices.
  const approved = PLANS.filter((plan) => plan.monthlyPriceMinor != null && !plan.contractRequired);
  const draft = PLANS.filter((plan) => plan.contractRequired);

  return (
    <div className="pricing">
      <a href="#main" className="pricing-skip">Skip to content</a>

      <div className="pricing-backdrop" aria-hidden="true">
        <img
          src="/images/landing/consultation-736.webp"
          alt=""
          width={736}
          height={490}
          decoding="async"
          style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "50% 38%" }}
        />
      </div>

      <header className="pricing-header">
        <div className="pricing-shell pricing-header-inner">
          <Logo />
          <nav className="pricing-site-nav" aria-label="Information">
            <a href="/about">About</a>
            <a href="/directory">Provider directory</a>
            <a href="/pricing" aria-current="page">Pricing</a>
            <a href="/help">Help &amp; support</a>
            <a href="/contacts">Contact</a>
          </nav>
          <div className="pricing-header-cta">
            <a href="/login" className="pricing-btn pricing-btn--outline">Sign in</a>
            <a href="/register?type=facility" className="pricing-btn pricing-btn--primary">Get Started</a>
            <button
              type="button"
              className="pricing-menu-btn"
              aria-expanded={false}
              aria-controls="pricing-nav"
              aria-label="Open menu"
            >
              <MenuIcon open={false} />
            </button>
          </div>
        </div>
      </header>

      <main id="main" className="pricing-main">
        <header className="pricing-hero">
          <div className="pricing-shell pricing-hero-inner">
            <div className="pricing-hero-copy">
              <p className="pricing-eyebrow">Platform pricing</p>
              <h1>One platform, three fixed prices.</h1>                <p className="pricing-lead">
                Medveris gives every account the same full kit: core clinical, point of sale, the price list, staff
                seats, storage and in-platform AI assistance. Prices are flat per month, set in USD, and are reusable
                by every workspace one account pays for.
              </p>
              <div className="pricing-actions">
                <a className="pricing-btn pricing-btn--primary pricing-btn--lg" href="#plans">
                  Compare plans
                </a>
                <a className="pricing-btn pricing-btn--outline pricing-btn--lg" href="#sign-up">
                  Start a free trial
                </a>
              </div>
              <p className="pricing-small pricing-muted" style={{ marginTop: "18px" }}>
                Free 7-day trial on the Basic plan. No onboarding fee, and measured use is never charged until the
                plan is accepted.
              </p>
            </div>

            <div className="pricing-hero-visual" aria-hidden="true">
              <div className="pricing-shell" style={{ padding: "24px" }}>
                <div className="pricing-row" style={{ gap: "12px", flexWrap: "wrap" }}>
                  {PLATFORM_KIT.map(([label, text]) => (
                    <div key={label} className="pricing-card pricing-card--dense" style={{ flex: "1 1 220px" }}>
                      <p className="pricing-metric">{label}</p>
                      <p className="pricing-small pricing-muted">{text}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </header>

        <section className="pricing-shell">
          <div className="pricing-stack">
            <div className="pricing-grid pricing-grid--2">
              <PricingCard
                title="Plan at a glance"
                description="Every approved plan carries the full kit. Choose by monthly price, then add seats above the included allowance."
              >
                <div className="pricing-table-wrap">
                  <table className="pricing-table">
                    <thead>
                      <tr>
                        <th scope="col">Plan</th>
                        <th scope="col">Price</th>
                        <th scope="col">Included seats</th>
                        <th scope="col">Storage</th>
                        <th scope="col">Best for</th>
                      </tr>
                    </thead>
                    <tbody>
                      {approved.map((plan) => (
                        <tr key={plan.code}>
                          <td><strong className="pricing-plan-name">{plan.name}</strong></td>
                          <td className="pricing-money">{cents(plan.monthlyPriceMinor)} / month</td>
                          <td className="pricing-small">{plan.name === "Basic" ? "10" : plan.name === "Standard" ? "50" : plan.name === "Professional" ? "250" : "custom"}</td>
                          <td className="pricing-small">{plan.name === "Basic" ? "10 GB" : plan.name === "Standard" ? "50 GB" : plan.name === "Professional" ? "200 GB" : "custom"}</td>
                          <td className="pricing-small">{plan.description}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </PricingCard>

              <PricingCard
                title="Choose a price by month"
                description="The cheapest paid plan starts with a free trial. Higher plans are quoted at the same flat monthly rate with a custom contract."
              >
                <div className="pricing-form-grid">
                  <div className="pricing-field">
                    <label className="pricing-field__label" htmlFor="pricing-plan">Plan</label>
                    <select id="pricing-plan" aria-describedby="pricing-plan-hint">
                      <option value="">Select a plan…</option>
                      {approved.map((plan) => (
                        <option key={plan.code} value={plan.code}>
                          {plan.name} — {cents(plan.monthlyPriceMinor)} / month
                        </option>
                      ))}
                    </select>
                    <p id="pricing-plan-hint" className="pricing-field__hint">Start a free trial on the Basic plan, or choose a higher tier to see the same flat monthly price.</p>
                  </div>
                  <div className="pricing-form-actions">
                    <a className="pricing-btn pricing-btn--primary" href="#sign-up">
                      Start free trial
                    </a>
                  </div>
                </div>
                <div className="pricing-note" style={{ marginTop: "16px" }}>
                  <p><strong>What’s included</strong></p>
                  <p className="pricing-small pricing-muted">
                    Every plan includes the full platform kit — core clinical, point of sale, the price list, staff
                    seats up to the plan allowance, storage up to the plan allowance, and in-platform Workers AI
                    assistance. There is no per-seat AI price and no AI allowance tier; AI is part of the flat plan,
                    not a separate line item.
                  </p>
                </div>
              </PricingCard>
            </div>

            <PricingCard
              title="Flat kit, no per-visit price"
              description="A per-service charge is only added for the volume you actually use. Every plan includes the full platform kit, so upgrading never removes a feature."
            >
              <div className="pricing-table-wrap">
                <table className="pricing-table">
                  <thead>
                    <tr>
                      <th scope="col">Included kit</th>
                      <th scope="col">Basic</th>
                      <th scope="col">Standard</th>
                      <th scope="col">Professional</th>
                    </tr>
                  </thead>
                  <tbody>
                    {PLATFORM_KIT.map(([label]) => (
                      <tr key={label}>
                        <td>{label}</td>
                        {["Basic", "Standard", "Professional"].map((planName) => (
                          <td key={planName} className="pricing-small">
                            {planName === "Basic" ? "10 seats" : planName === "Standard" ? "50 seats" : "250 seats"}</td>
                          <td key={planName} className="pricing-small">
                            {planName === "Basic" ? "10 GB" : planName === "Standard" ? "50 GB" : "200 GB"}</td>
                        ))}
                      </tr>
                    ))}
                    <tr>
                      <td>Storage</td>
                      <td>10 GB</td>
                      <td>50 GB</td>
                      <td>200 GB</td>
                    </tr>
                    <tr>
                      <td>Monthly price</td>
                      <td className="pricing-money">$15.00</td>
                      <td className="pricing-money">$30.00</td>
                      <td className="pricing-money">$100.00</td>
                    </tr>
                    <tr>
                      <td>Usage</td>
                      <td colSpan={3} className="pricing-small pricing-muted">
                        Any measured use is billed at the plan allowance and approved rates; nothing is charged
                        during the trial.
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </PricingCard>
          </div>
        </section>

        <section id="plans" className="pricing-shell">
          <div className="pricing-stack">
            <div className="pricing-grid pricing-grid--3">
              {approved.map((plan) => (
                <PricingCard
                  key={plan.code}
                  title={plan.name}
                  description={`${cents(plan.monthlyPriceMinor)} per month`}
                  className={plan.code === "basic" ? "pricing-plan-card--featured" : ""}
                >
                  <dl className="pricing-stack">
                    {PLATFORM_KIT.map(([feature, text]) => (
                      <div key={feature} className="pricing-spread">
                        <dt>{feature}</dt>
                        <dd className="pricing-small">{text}</dd>
                      </div>
                    ))}
                    <div className="pricing-spread">
                      <dt>Usage</dt>
                      <dd className="pricing-small">
                        {plan.usageOverages
                          ? "Overages billed at the approved rate above the plan allowance."
                          : "Flat price with no usage charges. Grow into a higher tier before anything changes."}
                      </dd>
                    </div>
                    <div className="pricing-spread">
                      <dt>Features</dt>
                      <dd className="pricing-small">Full platform kit — core clinical, point of sale, price list, staff seats, storage and in-platform Workers AI.</dd>
                    </div>
                    {plan.contractRequired ? (
                      <div className="pricing-spread">
                        <dt>pricing</dt>
                        <dd className="pricing-small">Contract required — custom seats and storage allowance.</dd>
                      </div>
                    ) : null}
                  </dl>
                  <div className="pricing-row" style={{ marginTop: "16px" }}>
                    {!plan.contractRequired ? (
                      <a className="pricing-btn pricing-btn--primary" href="#sign-up">
                        Start free trial
                      </a>
                    ) : (
                      <a className="pricing-btn pricing-btn--outline" href="#contact">
                        Request a contract
                      </a>
                    )}
                  </div>
                </PricingCard>
              ))}
            </div>              <PricingCard
                title="Availability"
                description="Flat prices are fixed by policy. They only take effect once a plan version is approved, and a draft price never appears on a bill."
              >
                <div className="pricing-stack">
                  {approved.map((plan) => (
                    <div key={plan.code} className="pricing-row" style={{ gap: "12px" }}>
                      <div className="pricing-metric" style={{ flex: "none" }}>{cents(plan.monthlyPriceMinor)}</div>
                      <div>
                        <strong className="pricing-audience-name">{plan.name}</strong>
                        <p className="pricing-small pricing-muted">
                          {plan.code === "basic"
                            ? "Standard trial. $0.50 per day reference."
                            : plan.code === "standard"
                              ? "Medium-consumption profile."
                              : "High-consumption profile. $100.00/month with a custom kit."}
                        </p>
                      </div>
                      <Badge tone="success">approved</Badge>
                    </div>
                  ))}
                {draft.map((plan) => (
                  <div key={plan.code} className="pricing-row" style={{ gap: "12px" }}>
                    <div className="pricing-metric" style={{ flex: "none" }}>{cents(plan.monthlyPriceMinor)}</div>
                    <div>
                      <strong className="pricing-audience-name">{plan.name}</strong>
                      <p className="pricing-small pricing-muted">Pricing awaiting approval. The price is not active until a separate approval is recorded.</p>
                    </div>
                    <Badge tone="warning">draft</Badge>
                  </div>
                ))}
                {ILLUSTRATIVE_NOTICE}
              </div>
            </PricingCard>
          </div>
        </section>

        <section id="measure" className="pricing-shell">
          <div className="pricing-stack">
            <PricingCard
              title="What is measured"
              description="Measured use is counted once per workspace per day, per resource, and appears in billing notices before it is charged."
            >
              <div className="pricing-table-wrap">
                <table className="pricing-table">
                  <thead>
                    <tr>
                      <th scope="col">Resource</th>
                      <th scope="col">How it is counted</th>
                      <th scope="col">Billable when</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ["Stored files", "Daily snapshot of uploaded file bytes", "Over the plan storage allowance"],
                      ["Active staff accounts", "Daily snapshot of active memberships", "Over the plan staff-seat allowance"],
                      ["API compute time", "Server-measured wall time of authenticated requests", "Available on request"],
                      ["Network traffic", "Response and request bytes of authenticated requests", "Available on request"],
                    ].map(([resource, how, when]) => (
                      <tr key={resource}>
                        <td><strong>{resource}</strong></td>
                        <td className="pricing-small">{how}</td>
                        <td className="pricing-small">{when}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </PricingCard>

            <PricingCard
              title="Who this is for"
              description="These prices are shown to facility owners, administrators and platform operators. Workspace staff see their own plan, usage and invoice inside the subscription screen."
            >
              <div className="pricing-audience">
                <div className="pricing-audience-row">
                  <div className="pricing-metric" style={{ flex: "none" }}>$15</div>
                  <div>
                    <strong className="pricing-audience-name">Basic</strong>
                    <p className="pricing-audience-desc">Low-consumption accounts. 10 staff seats, 10 GB storage, in-platform AI.</p>
                  </div>
                  <Badge tone="success">approved</Badge>
                </div>
                <div className="pricing-audience-row">
                  <div className="pricing-metric" style={{ flex: "none" }}>$30</div>
                  <div>
                    <strong className="pricing-audience-name">Standard</strong>
                    <p className="pricing-audience-desc">Medium-consumption accounts. 50 staff seats, 50 GB storage, in-platform AI.</p>
                  </div>
                  <Badge tone="success">approved</Badge>
                </div>
                <div className="pricing-audience-row">
                  <div className="pricing-metric" style={{ flex: "none" }}>$100</div>
                  <div>
                    <strong className="pricing-audience-name">Professional</strong>
                    <p className="pricing-audience-desc">High-consumption accounts. 250 staff seats, 200 GB storage, in-platform AI.</p>
                  </div>
                  <Badge tone="success">approved</Badge>
                </div>
                <div className="pricing-audience-row">
                  <div className="pricing-metric" style={{ flex: "none" }}>Custom</div>
                  <div>
                    <strong className="pricing-audience-name">Enterprise</strong>
                    <p className="pricing-audience-desc">Custom kit with a contract. Bespoke staff seats, storage and AI allowance.</p>
                  </div>
                  <Badge tone="warning">contract required</Badge>
                </div>
              </div>
            </PricingCard>
          </div>
        </section>

        <section id="ask" className="pricing-shell">
          <div className="pricing-shell pricing-hero-inner">
            <div className="pricing-hero-copy">
              <h2>Every workspace behind one account sees the same price.</h2>
              <p className="pricing-lead">
                A billing account can pay for many workspaces, and a workspace can belong to one organization.
                Prices are set on the account, not on a person, so installation crews and mobile-money collection
                run on the same rate as every other workspace in the account.
              </p>
              <div className="pricing-actions">
                <a className="pricing-btn pricing-btn--primary pricing-btn--lg" href="#sign-up">
                  Start a free trial
                </a>
                <a className="pricing-btn pricing-btn--outline pricing-btn--lg" href="#contact">
                  Talk to finance
                </a>
              </div>
            </div>
          </div>
        </section>

        <section id="contact" className="pricing-shell">
          <div className="pricing-stack">
            <PricingCard
              title="Request a contract or review the current account price"
              description="Contract pricing is set per contract. Platform operations can approve, restage or retire plan versions so a draft price never reaches a bill."
              actions={
                <a className="pricing-btn pricing-btn--primary" href="#sign-up">
                  Start a free trial
                </a>
              }
            >
              <div className="pricing-stack">                  <div className="pricing-row" style={{ gap: "12px" }}>
                    <div className="pricing-metric" style={{ flex: "none" }}>$15.00</div>
                    <div>
                      <strong className="pricing-audience-name">Basic</strong>
                      <p className="pricing-small pricing-muted">10 staff seats · 10 GB storage · in-platform AI</p>
                    </div>
                  </div>
                  <div className="pricing-row" style={{ gap: "12px" }}>
                    <div className="pricing-metric" style={{ flex: "none" }}>$30.00</div>
                    <div>
                      <strong className="pricing-audience-name">Standard</strong>
                      <p className="pricing-small pricing-muted">50 staff seats · 50 GB storage · in-platform AI</p>
                    </div>
                  </div>
                  <div className="pricing-row" style={{ gap: "12px" }}>
                    <div className="pricing-metric" style={{ flex: "none" }}>$100.00</div>
                    <div>
                      <strong className="pricing-audience-name">Professional</strong>
                      <p className="pricing-small pricing-muted">250 staff seats · 200 GB storage · in-platform AI</p>
                    </div>
                  </div>
                <div className="pricing-note">
                  <p className="pricing-small pricing-muted">
                    <strong>Need a price on request?</strong> Enterprise and custom contracts are quoted per contract,
                    not per plan. Contact Medveris finance to set a staff-seat and storage allowance on the account.
                  </p>
                </div>
              </div>
            </PricingCard>
          </div>
        </section>
      </main>

      <footer className="pricing-footer">
        <div className="pricing-shell">
          <div className="pricing-footer-grid">
            <div className="pricing-footer-brand">
              <Logo text="" />
              <p>One digital health platform. Every level of care.</p>
              <p className="pricing-footer-price">
                <strong>$0.50 per day</strong> for providers &middot; Patients free
              </p>
            </div>
            <nav className="pricing-footer-col" aria-label="Product">
              <h2>Product</h2>
              <a href="/about">Platform</a>
              <a href="/directory">Provider directory</a>
              <a href="/portal">Patient portal</a>
              <a href="#sign-up">Start a trial</a>
            </nav>
            <nav className="pricing-footer-col" aria-label="Company">
              <h2>Company</h2>
              <a href="/about">About</a>
              <a href="/help">Help &amp; support</a>
              <a href="/contacts">Contact</a>
            </nav>
            <div className="pricing-footer-col">
              <h2>Contact</h2>
              <a href="tel:+256709998327">+256 709 998 327</a>
              <a href="mailto:support@medveris.online">support@medveris.online</a>
              <a href="https://wa.me/256709998327" target="_blank" rel="noreferrer">WhatsApp</a>
              <a href="https://www.medveris.online" target="_blank" rel="noreferrer">www.medveris.online</a>
            </div>
          </div>
          <div className="pricing-footer-bottom">
            <p>© {new Date().getFullYear()} Aidomex Group Ltd. All rights reserved.</p>
            <p>One digital health platform. Every level of care.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}

function PricingCard({
  title,
  description,
  actions,
  children,
  className = "",
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`pricing-card ${className}`}>
      <header className="pricing-card__header">
        <div>
          {title ? <h2 className="pricing-card__title">{title}</h2> : null}
          {description ? <p className="pricing-card__description">{description}</p> : null}
        </div>
        {actions ? <div className="pricing-card__actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

const ILLUSTRATIVE_NOTICE = (
  <p className="pricing-note" style={{ marginTop: "16px" }}>
    <strong>Illustrative prices.</strong> The public prices below show the published tier structure.
    The exact active price for an account is set on its subscription plan, managed by platform operators
    in the billing console. Staff see their live plan, usage and invoices in the subscription screen.
  </p>
);
