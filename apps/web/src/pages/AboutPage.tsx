import { Link } from "react-router-dom";
import { Card, Notice, PageHeader } from "@medveris/ui";
import { PublicSiteLayout } from "../components/PublicSiteLayout";
import { COMPANY } from "../content/company";

export function AboutPage() {
  return (
    <PublicSiteLayout>
      <div className="mv-stack">
        <PageHeader
          eyebrow="About us"
          title="Care records that facilities own and patients can trust"
          description={`${COMPANY.product} is a clinical workspace for independent facilities, laboratories, pharmacies and clinics.`}
        />
        <div className="mv-grid mv-grid--2">
          <Card title="Why we build it">
            <p>
              Smaller facilities are often asked to choose between paper that cannot follow the patient and
              hospital software priced for a hospital. {COMPANY.product} gives an independent clinic, laboratory,
              imaging centre or drug shop a complete record, billing and reporting workspace at a price it can
              plan for.
            </p>
            <p className="mv-small mv-muted">
              Records stay in the facility that created them. Cross-facility sharing needs the patient's consent,
              and every access is auditable.
            </p>
          </Card>
          <Card title="How it is built">
            <ul className="mv-small">
              <li>One patient identity across participating facilities, with no silent merges.</li>
              <li>Signed clinical notes and reasoned amendments instead of overwritten history.</li>
              <li>Audit, outbox and integrity checkpoints on every command path.</li>
              <li>Mobile-money billing and receipts for the front desk.</li>
              <li>Reporting for departments, organizations and public-health returns.</li>
            </ul>
          </Card>
          <Card title="Safety and privacy">
            <p className="mv-small">
              Every environment currently holds synthetic data only. Clinical validation, legal review and
              licensing remain separate approvals — this software does not claim them. Patient records are never
              deleted because a subscription payment is late.
            </p>
            <p className="mv-small"><Link to="/help#launch-risks">Review the launch-risk guidance before publishing publicly.</Link></p>
          </Card>
          <Card title="Talk to us">
            <p className="mv-small">Support is provided by {COMPANY.legalName}.</p>
            <div className="mv-stack" style={{ gap: 6 }}>
              <a href={COMPANY.phoneHref}>Call {COMPANY.phone}</a>
              <a href={`https://wa.me/${COMPANY.whatsappNumber}`} target="_blank" rel="noreferrer">WhatsApp {COMPANY.phone}</a>
              <a href={COMPANY.emailHref}>{COMPANY.email}</a>
              <Link to="/contacts">Send an enquiry</Link>
            </div>
            <p className="mv-small mv-muted">{COMPANY.supportHours}</p>
          </Card>
        </div>
        <Notice tone="info" title={COMPANY.attribution}>
          {COMPANY.product} is built and supported by {COMPANY.legalName}. Call or WhatsApp {COMPANY.phone}, or email {COMPANY.email}.
        </Notice>
      </div>
    </PublicSiteLayout>
  );
}
