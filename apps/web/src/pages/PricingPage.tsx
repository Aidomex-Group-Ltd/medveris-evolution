import type { ReactNode } from "react";
import "./PricingPage.css";

const cents = (value: number | null | undefined, currency = "USD") =>
  value == null ? "—" : `${currency} ${(value / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const PLANS = [
  { code: "basic", name: "Basic", description: "Low-consumption accounts", monthlyPriceMinor: 1500, storageGb: 10, seats: 10, usageOverages: false, features: ["core-clinical", "point-of-sale", "price-list"], contractRequired: false },
  { code: "standard", name: "Standard", description: "Medium-consumption accounts", monthlyPriceMinor: 3000, storageGb: 50, seats: 50, usageOverages: false, features: ["core-clinical", "point-of-sale", "price-list"], contractRequired: false },
  { code: "advanced", name: "Professional", description: "High-consumption accounts", monthlyPriceMinor: 10000, storageGb: 200, seats: 250, usageOverages: false, features: ["core-clinical", "point-of-sale", "price-list"], contractRequired: false },
];

function Logo({ text: _text }: { text?: string }) {
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
              <h1>One platform, three fixed prices.</h1>
              <p className="pricing-lead">
                Every plan includes the full kit: core clinical, point of sale, the price list, staff seats,
                storage and in-platform AI assistance. Full details are on the Help &amp; support page.
              </p>
              <div className="pricing-actions">
                <a className="pricing-btn pricing-btn--primary pricing-btn--lg" href="#plans">
                  Compare plans
                </a>
                <a className="pricing-btn pricing-btn--outline pricing-btn--lg" href="/help">
                  Pricing details
                </a>
              </div>
              <p className="pricing-small pricing-muted" style={{ marginTop: "18px" }}>
                Free 7-day trial on the Basic plan. No onboarding fee.
              </p>
            </div>
          </div>
        </header>

        <section id="plans" className="pricing-shell">
          <div className="pricing-stack">
            <div className="pricing-grid pricing-grid--3">
              {PLANS.map((plan) => (
                <PricingCard
                  key={plan.code}
                  title={plan.name}
                  description={`${cents(plan.monthlyPriceMinor)} per month`}
                  className={plan.code === "basic" ? "pricing-plan-card--featured" : ""}
                >
                  <dl className="pricing-stack">
                    <div className="pricing-spread">
                      <dt>For</dt>
                      <dd className="pricing-small">{plan.description}</dd>
                    </div>
                    <div className="pricing-spread">
                      <dt>Seats</dt>
                      <dd className="pricing-small">{plan.seats} staff seats included</dd>
                    </div>
                    <div className="pricing-spread">
                      <dt>Storage</dt>
                      <dd className="pricing-small">{plan.storageGb} GB included</dd>
                    </div>
                    <div className="pricing-spread">
                      <dt>Includes</dt>
                      <dd className="pricing-small">Full platform kit with in-platform AI</dd>
                    </div>
                  </dl>
                  <div className="pricing-stack" style={{ marginTop: "16px" }}>
                    <a className="pricing-btn pricing-btn--primary" href="/register?type=facility">
                      Start free trial
                    </a>
                    <a className="pricing-btn pricing-btn--outline" href="/help#pricing-details">
                      What is included? →
                    </a>
                  </div>
                </PricingCard>
              ))}
            </div>
            <p className="pricing-small pricing-muted" style={{ textAlign: "center" }}>
              What is included, what is measured, and enterprise contracts are explained on the{" "}
              <a href="/help#pricing-details" style={{ color: "inherit", textDecoration: "underline" }}>Help &amp; support</a> page.
            </p>
          </div>
        </section>
      </main>

      <footer className="pricing-footer">
        <div className="pricing-shell">
          <div className="pricing-footer-grid">
            <div className="pricing-footer-brand">
              <Logo text="" />
              <p>One digital health platform. Every level of care.</p>
            </div>
            <nav className="pricing-footer-col" aria-label="Product">
              <h2>Product</h2>
              <a href="/about">Platform</a>
              <a href="/directory">Provider directory</a>
              <a href="/portal">Patient portal</a>
              <a href="/register?type=facility">Start a trial</a>
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
