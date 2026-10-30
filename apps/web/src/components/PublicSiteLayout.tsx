import type { ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { BrandMark } from "./BrandMark";
import { COMPANY, LAUNCH_RISK_ITEMS } from "../content/company";

const links = [
  { to: "/about", label: "About us" },
  { to: "/help", label: "Help & support" },
  { to: "/help#launch-risks", label: `Launch risks (${LAUNCH_RISK_ITEMS.length})` },
  { to: "/contacts", label: "Contacts" },
];

/** Shared header and footer for public information pages. */
export function PublicSiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mv-public">
      <header className="mv-public__header">
        <Link to="/" className="mv-brand" aria-label="Medveris home">
          <BrandMark />
          <span>Medveris<small>Independent, affordable &amp; Secure</small></span>
        </Link>
        <nav aria-label="Information">
          {links.map((link) => <NavLink key={link.to} to={link.to}>{link.label}</NavLink>)}
          <NavLink to="/login">Sign in</NavLink>
        </nav>
      </header>
      <main className="mv-public__main">{children}</main>
      <SiteFooter />
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="mv-public__footer">
      <div className="mv-stack" style={{ gap: 6 }}>
        <strong>{COMPANY.product}</strong>
        <span className="mv-small">{COMPANY.attribution}</span>
        <span className="mv-small mv-muted">{COMPANY.supportHours}</span>
      </div>
      <div className="mv-stack" style={{ gap: 6 }}>
        <a href={COMPANY.phoneHref}>Call {COMPANY.phone}</a>
        <a href={`https://wa.me/${COMPANY.whatsappNumber}`} target="_blank" rel="noreferrer">WhatsApp {COMPANY.phone}</a>
        <a href={COMPANY.emailHref}>{COMPANY.email}</a>
      </div>
      <nav aria-label="Company">
        <Link to="/about">About us</Link>
        <Link to="/help">Help &amp; support</Link>
        <Link to="/contacts">Contacts</Link>
        <Link to="/register">Create an account</Link>
      </nav>
    </footer>
  );
}
