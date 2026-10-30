import { useState, type FormEvent } from "react";
import { Button, Card, Field, Input, Notice, PageHeader, Textarea } from "@medveris/ui";
import { PublicSiteLayout } from "../components/PublicSiteLayout";
import { COMPANY, enquiryMessage, whatsappLink } from "../content/company";

export function ContactsPage() {
  const [name, setName] = useState("");
  const [organisation, setOrganisation] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);

  /**
   * The enquiry is handed to WhatsApp, which opens with the message ready to send. The site does not
   * store it. If WhatsApp is unavailable, the email link below carries the same details.
   */
  function submit(event: FormEvent) {
    event.preventDefault();
    const text = enquiryMessage({ name, organisation, email, message });
    window.open(whatsappLink(text), "_blank", "noopener,noreferrer");
    setSent(true);
  }

  return (
    <PublicSiteLayout>
      <div className="mv-stack">
        <PageHeader
          eyebrow="Contacts"
          title="Talk to Aidomex Group Ltd"
          description="Support for Medveris facilities, billing and onboarding."
        />
        <div className="mv-grid mv-grid--3">
          <Card title="Call us">
            <p className="mv-metric" style={{ fontSize: "1.15rem" }}><a href={COMPANY.phoneHref}>{COMPANY.phone}</a></p>
            <p className="mv-small mv-muted">{COMPANY.supportHours}</p>
          </Card>
          <Card title="WhatsApp">
            <p><a href={`https://wa.me/${COMPANY.whatsappNumber}`} target="_blank" rel="noreferrer">Message {COMPANY.phone}</a></p>
            <p className="mv-small mv-muted">Fastest for onboarding and payment questions. Do not send patient information.</p>
          </Card>
          <Card title="Email">
            <p><a href={COMPANY.emailHref}>{COMPANY.email}</a></p>
            <p className="mv-small mv-muted">For invoices, account changes and written requests.</p>
          </Card>
        </div>

        <Card title="Project enquiry" description="Send a short message through WhatsApp. Nothing is stored on this site.">
          {sent ? (
            <Notice tone="success" title="WhatsApp opened">
              Send the prepared message from WhatsApp. If it did not open, <a href={COMPANY.emailHref}>email {COMPANY.email}</a> instead.
              <div style={{ marginTop: 10 }}><Button variant="secondary" size="sm" onClick={() => setSent(false)}>Edit the enquiry</Button></div>
            </Notice>
          ) : (
            <form className="mv-stack" onSubmit={submit}>
              <div className="mv-form-grid">
                <Field label="Your name" htmlFor="contact-name">
                  <Input id="contact-name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required />
                </Field>
                <Field label="Organisation" htmlFor="contact-organisation" hint="Optional">
                  <Input id="contact-organisation" value={organisation} onChange={(event) => setOrganisation(event.target.value)} autoComplete="organization" />
                </Field>
                <Field label="Reply email" htmlFor="contact-email">
                  <Input id="contact-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
                </Field>
              </div>
              <Field label="How can we help?" htmlFor="contact-message">
                <Textarea id="contact-message" rows={5} value={message} onChange={(event) => setMessage(event.target.value)} required maxLength={1200} />
              </Field>
              <div className="mv-row">
                <Button type="submit">Send on WhatsApp</Button>
                <a className="mv-small" href={COMPANY.emailHref}>or email us</a>
              </div>
              <p className="mv-small mv-muted">Do not include patient names, identifiers, clinical notes or payment credentials.</p>
            </form>
          )}
        </Card>

        <Notice tone="info" title={COMPANY.attribution}>
          {COMPANY.legalName} · Calls and WhatsApp {COMPANY.phone} · {COMPANY.email}
        </Notice>
      </div>
    </PublicSiteLayout>
  );
}
