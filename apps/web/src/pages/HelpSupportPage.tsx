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

        <div id="pricing-details">
          <h2>Pricing details</h2>
          <p className="mv-small mv-muted">The three tiers are shown on the <Link to="/pricing">Pricing</Link> page. The full details are below. Prices are fixed tiers set in USD per month; the exact active price for an account is set on its subscription plan in the billing console.</p>
        </div>

        <div className="mv-grid mv-grid--2">
          <Card title="What's included on every plan">
            <ul className="mv-small">
              <li>Core clinical — registration, visits, triage, observations, care plans, follow-ups and referrals</li>
              <li>Point of sale — cash, card and mobile-money sales with receipts</li>
              <li>Price list — owned catalogue of services, procedures, supplies and pharmacy items</li>
              <li>Staff seats, storage and in-platform Workers AI assistance</li>
              <li>Every plan includes the full kit, so upgrading never removes a feature. There is no per-seat AI price and no AI allowance tier.</li>
            </ul>
          </Card>
          <Card title="The three tiers at a glance">
            <ul className="mv-small">
              <li><strong>Basic — USD 15/month</strong> — low-consumption accounts, 10 staff seats, 10 GB storage. Free 7-day trial, no onboarding fee.</li>
              <li><strong>Standard — USD 30/month</strong> — medium-consumption accounts, 50 staff seats, 50 GB storage.</li>
              <li><strong>Professional — USD 100/month</strong> — high-consumption accounts, 250 staff seats, 200 GB storage.</li>
              <li>Measured use is never charged until the plan is accepted, and nothing is charged during the trial.</li>
            </ul>
          </Card>
        </div>

        <div className="mv-grid mv-grid--2">
          <Card title="What is measured">
            <p className="mv-small">Measured use is counted once per workspace per day, per resource, and appears in billing notices before it is charged.</p>
            <ul className="mv-small">
              <li>Stored files — daily snapshot of uploaded file bytes, billable over the plan storage allowance.</li>
              <li>Active staff accounts — daily snapshot of active memberships, billable over the plan staff-seat allowance.</li>
              <li>API compute time and network traffic — server-measured wall time and bytes of authenticated requests, available on request.</li>
            </ul>
          </Card>
          <Card title="Accounts, workspaces and contracts">
            <ul className="mv-small">
              <li>One billing account can pay for many workspaces, and a workspace can belong to one organization. Prices are set on the account, not on a person.</li>
              <li>Workspace staff see their own plan, usage and invoice inside the subscription screen.</li>
              <li>Enterprise and custom contracts are quoted per contract (custom seats and storage), not per plan. Contact finance via <a href={COMPANY.emailHref}>{COMPANY.email}</a> to request one.</li>
              <li>Flat prices are fixed by policy and only take effect once a plan version is approved; a draft price never appears on a bill.</li>
            </ul>
          </Card>
        </div>

        <Card title="Illustrative prices">
          <p className="mv-small mv-muted">The public prices show the published tier structure. The exact active price for an account is set on its subscription plan, managed by platform operators in the billing console. Staff see their live plan, usage and invoices in the subscription screen.</p>
        </Card>
      </div>
    </PublicSiteLayout>
  );
}
