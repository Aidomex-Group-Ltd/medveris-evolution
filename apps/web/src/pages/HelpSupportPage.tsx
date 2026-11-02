import { Link } from "react-router-dom";
import { Card, PageHeader } from "@medveris/ui";
import { PublicSiteLayout } from "../components/PublicSiteLayout";
import { COMPANY } from "../content/company";

export function HelpSupportPage() {
  return (
    <PublicSiteLayout>
      <div className="mv-stack">
        <PageHeader
          eyebrow="Help & support"
          title="Get help with your Medveris workspace"
          description="Support is staffed by Aidomex Group Ltd. The guide below is general information, not legal advice."
        />

        <div className="mv-grid mv-grid--2">
          <Card title="Contact support">
            <p className="mv-small">Calls and WhatsApp: <a href={COMPANY.phoneHref}>{COMPANY.phone}</a></p>
            <p className="mv-small">Email: <a href={COMPANY.emailHref}>{COMPANY.email}</a></p>
            <p className="mv-small mv-muted">{COMPANY.supportHours}</p>
            <p className="mv-small"><Link to="/contacts">Use the enquiry form</Link> to send the details through WhatsApp.</p>
          </Card>
          <Card title="Before you contact us">
            <ul className="mv-small">
              <li>Sign in and check the banner on the workspace overview for subscription state.</li>
              <li>For a payment, keep the Yo! confirmation message and the UGX amount.</li>
              <li>For a clinical record, note the facility, the patient's public ID and the time.</li>
              <li>Never send patient names, identifiers or clinical notes by WhatsApp or email.</li>
            </ul>
          </Card>
        </div>
      </div>
    </PublicSiteLayout>
  );
}
