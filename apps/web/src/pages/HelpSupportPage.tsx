import { Link } from "react-router-dom";
import { Card, Notice, PageHeader } from "@medveris/ui";
import { PublicSiteLayout } from "../components/PublicSiteLayout";
import { COMPANY, LAUNCH_RISK_ITEMS, LEGAL_DISCLAIMER } from "../content/company";

export function HelpSupportPage() {
  return (
    <PublicSiteLayout>
      <div className="mv-stack">
        <PageHeader
          eyebrow="Help & support"
          title="Get help, and check six launch risks before you publish"
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

        <section id="launch-risks" className="mv-stack" aria-labelledby="launch-risk-heading">
          <h2 id="launch-risk-heading" className="mv-h2">Six launch risks, with the primary sources</h2>
          <p className="mv-small mv-muted">
            Each amount below is a maximum or a case outcome that depends on the facts. None of them is an
            automatic fine, and a court or agency decides whether a violation exists.
          </p>
          <Notice tone="warning" title="General information, not legal advice">
            {LEGAL_DISCLAIMER}
          </Notice>
          {LAUNCH_RISK_ITEMS.map((item, index) => (
            <Card key={item.id} title={`${index + 1}. ${item.title}`}>
              <div className="mv-stack">
                <div>
                  <strong className="mv-small">What the rule covers</strong>
                  <p>{item.exposure}</p>
                </div>
                <div>
                  <strong className="mv-small">What to do before launch</strong>
                  <p>{item.action}</p>
                </div>
                <div className="mv-small">
                  <strong>Primary sources:</strong>{" "}
                  {item.sources.map((source, sourceIndex) => (
                    <span key={source.href}>
                      {sourceIndex ? " · " : ""}
                      <a href={source.href} target="_blank" rel="noreferrer">{source.label}</a>
                    </span>
                  ))}
                </div>
              </div>
            </Card>
          ))}
          <p className="mv-small mv-muted">
            Recheck every linked source and current amount before publishing. Laws and agency guidance change,
            and a decision in one jurisdiction does not bind another.
          </p>
        </section>
      </div>
    </PublicSiteLayout>
  );
}
