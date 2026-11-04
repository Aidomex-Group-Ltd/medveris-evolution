import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { COMPANY, whatsappLink } from "../../content/company";
import "./landing.css";

const ROUTES = {
  signIn: "/login",
  facilitySignUp: "/register?type=facility",
  patientPortal: "/portal",
  about: "/about",
  directory: "/directory",
  help: "/help",
  contacts: "/contacts",
} as const;

const PROVIDER_WHATSAPP = whatsappLink("Hello Medveris, I would like to bring my facility online.");

const NAV = [
  { label: "Platform", href: "#platform" },
  { label: "Solutions", to: ROUTES.directory },
  { label: "Pricing", href: "#pricing" },
  { label: "About", to: ROUTES.about },
] as const;

const ICON_PATHS = {
  arrow: ["M5 12h14", "m13 6 6 6-6 6"],
  cloud: ["M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1A4.5 4.5 0 0 1 17 18H7Z"],
  link: [
    "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1",
    "M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1",
  ],
  coins: [
    "M9 5c2.8 0 5 1.1 5 2.5S11.8 10 9 10 4 8.9 4 7.5 6.2 5 9 5Z",
    "M4 7.5v4c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5v-4",
    "M14 12c2.8 0 5 1.1 5 2.5S16.8 17 14 17s-5-1.1-5-2.5",
    "M9 14.5V18c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5v-4",
  ],
} as const;

type IconName = keyof typeof ICON_PATHS;

const BENEFITS = [
  { title: "Cloud-Based", text: "Secure & Reliable", icon: "cloud" },
  { title: "Connected Care", text: "Better Outcomes", icon: "link" },
  { title: "Affordable", text: "For Every Facility", icon: "coins" },
] as const satisfies ReadonlyArray<{ title: string; text: string; icon: IconName }>;

const LEVELS = [
  { title: "Pharmacies", text: "Dispense, stock and till in the same record as the prescription." },
  { title: "Clinics & health centres", text: "Registration, visits and billing built for small, busy teams." },
  { title: "Hospitals & referral", text: "Wards, theatre and specialist care that follow the patient across sites." },
] as const;

/** Full-page backdrop: an AI-assisted theatre scene that sets the tone behind the whole page. */
const BACKDROP_PHOTO = {
  src: "/images/landing/theatre-1280.webp",
  srcSet: "/images/landing/theatre-768.webp 768w, /images/landing/theatre-1280.webp 1280w",
  width: 1280,
  height: 964,
} as const;

/** Hero visual: a clinician working in a bright, everyday clinic. */
const HERO_PHOTO = {
  src: "/images/landing/consultation-736.webp",
  srcSet: "/images/landing/consultation-440.webp 440w, /images/landing/consultation-736.webp 736w",
  width: 736,
  height: 490,
  alt: "A smiling doctor working on a laptop at a bright clinic desk",
} as const;

/** Body visual: a pharmacy interior that blends into the page background. */
const BODY_PHOTO = {
  src: "/images/landing/pharmacy-474.webp",
  width: 474,
  height: 364,
} as const;

function Icon({ name, size = 24 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[name].map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}

function Logo({ light = false }: { light?: boolean }) {
  return (
    <Link to="/" className={`mv-logo${light ? " mv-logo--light" : ""}`} aria-label="Medveris home">
      <span className="mv-logo-mark">
        <img src="/logo.png" alt="" width={48} height={48} decoding="async" />
      </span>
      <span className="mv-logo-text">Medveris</span>
    </Link>
  );
}

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      {open ? <path d="m6 6 12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
    </svg>
  );
}

export default function LandingPage() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [backdropFailed, setBackdropFailed] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  return (
    <div className="mv">
      <a href="#main" className="mv-skip">Skip to content</a>

      <div className="mv-backdrop" aria-hidden="true">
        {!backdropFailed ? (
          <img
            src={BACKDROP_PHOTO.src}
            srcSet={BACKDROP_PHOTO.srcSet}
            sizes="100vw"
            alt=""
            width={BACKDROP_PHOTO.width}
            height={BACKDROP_PHOTO.height}
            loading="eager"
            fetchPriority="high"
            decoding="async"
            onError={() => setBackdropFailed(true)}
          />
        ) : null}
      </div>

      <header className="mv-header">
        <div className="mv-shell mv-header-inner">
          <Logo />
          <nav id="mv-nav" className={`mv-site-nav${menuOpen ? " mv-site-nav--open" : ""}`} aria-label="Main">
            {NAV.map((item) =>
              "href" in item ? (
                <a key={item.label} href={item.href} onClick={() => setMenuOpen(false)}>{item.label}</a>
              ) : (
                <Link key={item.label} to={item.to} onClick={() => setMenuOpen(false)}>{item.label}</Link>
              ),
            )}
            <div className="mv-site-nav-auth">
              <Link to={ROUTES.signIn} className="mv-btn mv-btn--outline" onClick={() => setMenuOpen(false)}>Sign In</Link>
              <Link to={ROUTES.facilitySignUp} className="mv-btn mv-btn--primary" onClick={() => setMenuOpen(false)}>Get Started</Link>
            </div>
          </nav>
          <div className="mv-header-cta">
            <Link to={ROUTES.signIn} className="mv-btn mv-btn--outline">Sign In</Link>
            <Link to={ROUTES.facilitySignUp} className="mv-btn mv-btn--primary">Get Started</Link>
            <button
              type="button"
              className="mv-menu-btn"
              aria-expanded={menuOpen}
              aria-controls="mv-nav"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MenuIcon open={menuOpen} />
            </button>
          </div>
        </div>
      </header>

      <main id="main" className="mv-main">
        <section className="mv-hero">
          <div className="mv-shell mv-hero-inner">
            <div className="mv-hero-copy">
              <h1>
                One Digital Health Platform.
                <span>Every Level of Care.</span>
              </h1>
              <p className="mv-lead">Digitize your healthcare business with Medveris.</p>
              <div className="mv-actions">
                <Link to={ROUTES.facilitySignUp} className="mv-btn mv-btn--primary mv-btn--lg">
                  Get Started
                  <Icon name="arrow" size={18} />
                </Link>
                <Link to={ROUTES.about} className="mv-btn mv-btn--outline mv-btn--lg">Explore Platform</Link>
              </div>
            </div>

            <figure className="mv-hero-visual">
              <img
                src={HERO_PHOTO.src}
                srcSet={HERO_PHOTO.srcSet}
                sizes="(max-width: 980px) 92vw, 44vw"
                alt={HERO_PHOTO.alt}
                width={HERO_PHOTO.width}
                height={HERO_PHOTO.height}
                loading="eager"
                decoding="async"
              />
            </figure>
          </div>

          <div className="mv-shell mv-benefits-wrap">
            <ul id="platform" className="mv-benefits" aria-label="Why Medveris">
              {BENEFITS.map((benefit) => (
                <li key={benefit.title} className="mv-benefit">
                  <span className="mv-benefit-icon"><Icon name={benefit.icon} size={22} /></span>
                  <span className="mv-benefit-copy">
                    <strong>{benefit.title}</strong>
                    <small>{benefit.text}</small>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="mv-body" aria-labelledby="mv-body-title">
          <div className="mv-body-photo" aria-hidden="true">
            <img
              src={BODY_PHOTO.src}
              alt=""
              width={BODY_PHOTO.width}
              height={BODY_PHOTO.height}
              loading="lazy"
              decoding="async"
            />
          </div>

          <div className="mv-shell mv-body-inner">
            <div className="mv-body-copy">
              <p className="mv-eyebrow">Every level of care</p>
              <h2 id="mv-body-title">From the pharmacy counter to the referral hospital.</h2>
              <p className="mv-body-lead">
                Community pharmacies, clinics, health centres and hospitals run the same platform, so
                patients, stock, billing and records stay connected as care moves.
              </p>
              <Link to={ROUTES.directory} className="mv-btn mv-btn--outline">
                Browse the provider directory
                <Icon name="arrow" size={18} />
              </Link>
            </div>

            <ol className="mv-levels">
              {LEVELS.map((level, index) => (
                <li key={level.title} className="mv-level">
                  <span className="mv-level-index" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="mv-level-copy">
                    <strong>{level.title}</strong>
                    <small>{level.text}</small>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </section>
      </main>

      <footer className="mv-footer">
        <div className="mv-shell">
          <div className="mv-footer-grid">
            <div className="mv-footer-brand">
              <Logo light />
              <p>One digital health platform. Every level of care.</p>
              <p className="mv-footer-price">
                <strong>$0.50 per day</strong> for providers &middot; Patients free
              </p>
            </div>

            <nav className="mv-footer-col" aria-label="Product">
              <h2>Product</h2>
              <Link to={ROUTES.about}>Platform</Link>
              <Link to={ROUTES.directory}>Provider directory</Link>
              <Link to={ROUTES.patientPortal}>Patient portal</Link>
            </nav>

            <nav className="mv-footer-col" aria-label="Company">
              <h2>Company</h2>
              <Link to={ROUTES.about}>About</Link>
              <Link to={ROUTES.help}>Help &amp; support</Link>
              <Link to={ROUTES.contacts}>Contact</Link>
            </nav>

            <div className="mv-footer-col">
              <h2>Contact</h2>
              <a href={COMPANY.phoneHref}>{COMPANY.phone}</a>
              <a href={PROVIDER_WHATSAPP} target="_blank" rel="noreferrer">WhatsApp</a>
              <a href={COMPANY.emailHref}>{COMPANY.email}</a>
              <a href="https://www.medveris.online" target="_blank" rel="noreferrer">www.medveris.online</a>
            </div>
          </div>

          <div className="mv-footer-bottom">
            <p>© {new Date().getFullYear()} {COMPANY.legalName}. All rights reserved.</p>
            <p>{COMPANY.product} – Connected Care. Better Outcomes.</p>
          </div>
          <p className="mv-credit">
            Imagery supplied by Medveris.{" "}
            <a href="/images/healthcare/ATTRIBUTIONS.md">Photo credits</a>.
          </p>
        </div>
      </footer>
    </div>
  );
}
