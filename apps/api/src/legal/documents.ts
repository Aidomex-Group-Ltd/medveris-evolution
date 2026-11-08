/**
 * Versioned Medveris legal documents.
 *
 * These texts are the versioned source of truth bundled with the Worker. A version is never edited
 * in place: a material change is a new version (and a matching row in `legal_documents`), so every
 * acceptance record keeps pointing at the exact document the person saw. The texts are written for
 * the Ugandan deployment and are explicitly marked as requiring review by qualified counsel before
 * production reliance; this file is not legal advice.
 */

export type LegalKind = "terms" | "privacy";

export interface LegalSection {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
}

export interface LegalDocument {
  kind: LegalKind;
  version: string;
  title: string;
  effectiveAt: string;
  /** The release must not claim counsel review this document has not had. */
  reviewStatus: "counsel-review-required" | "counsel-reviewed";
  summary: string;
  sections: LegalSection[];
}

export const LEGAL_REVIEW_NOTICE =
  "This version is published for the Medveris implementation pilot. It must be reviewed and approved by qualified Ugandan counsel before it is relied on as the final legal terms. It is not legal advice.";

const TERMS: LegalDocument = {
  kind: "terms",
  version: "1.0",
  title: "Medveris Terms of Service",
  effectiveAt: "2026-11-08T00:00:00.000Z",
  reviewStatus: "counsel-review-required",
  summary: "The agreement between Aidomex Group Ltd and each person or organisation that uses Medveris.",
  sections: [
    {
      heading: "1. Agreement and operator",
      paragraphs: [
        "Medveris is operated by Aidomex Group Ltd, P.O. Box 118472, Wakiso, Uganda (\"Aidomex\", \"we\", \"us\"). These Terms govern your use of the Medveris application, website and related services (the \"Service\").",
        "By creating an account, joining a workspace or using the Service you agree to these Terms and acknowledge the Medveris Privacy Notice. If you do not agree, do not use the Service.",
      ],
    },
    {
      heading: "2. Eligibility and accounts",
      bullets: [
        "You must be at least 18 years old and able to enter into a binding contract.",
        "Give accurate information and keep it current. Account-sharing is not permitted unless we agree in writing.",
        "Keep your password, authenticator and recovery codes confidential. Tell us promptly about unauthorised use.",
        "A workspace owner is responsible for the memberships, roles and unit scopes they grant. Access is limited to the organisation and unit recorded for each membership.",
      ],
    },
    {
      heading: "3. The Service",
      paragraphs: [
        "Medveris provides tools for care coordination, clinical records, appointments, diagnostics, pharmacy, billing and related administrative workflows. Features depend on the workspace type, the modules enabled for the workspace and the permissions granted to your membership.",
        "Some features depend on third-party services or regulatory authorisation and may remain unavailable. The Service is not an emergency service and must not be used as the only channel for urgent care.",
      ],
    },
    {
      heading: "4. Clinical responsibility and no medical advice to patients",
      paragraphs: [
        "Medveris supports health professionals; it does not replace professional judgement. Information, alerts, calculations and decision-support output may be incomplete, delayed or wrong and must be reviewed by a qualified professional.",
        "Patient-facing content is informational and is not a diagnosis, prescription or treatment plan. In an emergency, contact local emergency services or go to the nearest health facility.",
      ],
    },
    {
      heading: "5. Acceptable use and security",
      bullets: [
        "Do not access records, workspaces or units you are not authorised to access, including by sharing sessions or credentials.",
        "Do not submit false, misleading or fraudulent clinical, identity, billing or payment information.",
        "Do not probe, scan or test the security of the Service without written permission, introduce malware, scrape at scale or interfere with other users.",
        "Do not use the Service to harass, impersonate or discriminate against any person.",
        "Report suspected security incidents promptly so containment and notification obligations can be assessed.",
      ],
    },
    {
      heading: "6. Customer content and data ownership",
      paragraphs: [
        "As between you and Aidomex, the organisation or patient that owns a record retains ownership of the content it submits. You grant Aidomex a limited licence to host, process, transmit and display that content only to operate, secure and support the Service, comply with law and follow your instructions.",
        "You confirm that you have the authority and any necessary consent to submit the content, including health information about another person.",
      ],
    },
    {
      heading: "7. Subscriptions, fees and renewal",
      bullets: [
        "Workspace plans are billed in USD and collected in the UGX equivalent disclosed at checkout using the exchange rate and rounding shown before payment.",
        "Renewal is manual unless a future version expressly states otherwise. Nothing is charged automatically, and access continues to the end of the paid period.",
        "A mobile-money prompt is not proof of payment. A checkout is settled only when the payment provider confirms the exact amount and currency disclosed.",
        "Cancellation stops a new period; it does not by itself refund a completed period. Refund requests are reviewed under the applicable law and the records of the transaction.",
        "Taxes, if any, are disclosed or handled as required by law.",
      ],
    },
    {
      heading: "8. Third-party services",
      paragraphs: [
        "The Service uses infrastructure and payment, messaging and integration providers. Their services may be subject to their own terms and availability. We remain responsible for our own obligations and require processors to protect data they handle for us.",
      ],
    },
    {
      heading: "9. Availability, changes and suspension",
      paragraphs: [
        "We aim for reliable operation but do not guarantee uninterrupted availability. Maintenance, security incidents, provider outages or events outside our control may interrupt the Service.",
        "We may change, suspend or withdraw features. We may suspend a workspace for non-payment, security risk, unlawful use or breach of these Terms, while preserving records as required by law and the Privacy Notice.",
      ],
    },
    {
      heading: "10. Disclaimers and liability",
      paragraphs: [
        "To the extent permitted by law, the Service is provided \"as is\" and \"as available\", without implied warranties of fitness, accuracy or non-infringement. Nothing excludes rights that Ugandan consumer law does not allow to be excluded.",
        "To the extent permitted by law, Aidomex is not liable for indirect or consequential loss, loss of profit or goodwill, or a health outcome caused by reliance on information without professional review. Liability for death or personal injury caused by negligence, fraud or any other liability that cannot lawfully be limited is not excluded.",
        "The precise liability cap and carve-outs require counsel review for the jurisdictions in which Medveris operates.",
      ],
    },
    {
      heading: "11. Termination and surviving terms",
      paragraphs: [
        "You may stop using the Service and request closure of your account. We may terminate access for a material breach, unlawful use or where required by law.",
        "On termination, access ends. Records are retained, exported or deleted as described in the Privacy Notice and applicable health-records law. Terms that by their nature survive termination continue to apply.",
      ],
    },
    {
      heading: "12. Governing law and disputes",
      paragraphs: [
        "These Terms are governed by the laws of the Republic of Uganda. We ask you to raise a concern with us first so it can be resolved informally.",
        "If a dispute is not resolved, the forum, seat and procedure must be confirmed by counsel. This version records the intent to use a Ugandan forum and does not create an arbitration agreement beyond what applicable law permits.",
      ],
    },
    {
      heading: "13. Changes and contact",
      paragraphs: [
        "We may publish a new version of these Terms. For a material change we will give notice and, where required, ask you to accept the new version before continuing. A new version never overwrites the record of what you previously accepted.",
        "Contact: Aidomex Group Ltd, P.O. Box 118472, Wakiso, Uganda · support@medveris.ug.",
      ],
    },
  ],
};

const PRIVACY: LegalDocument = {
  kind: "privacy",
  version: "1.0",
  title: "Medveris Privacy Notice",
  effectiveAt: "2026-11-08T00:00:00.000Z",
  reviewStatus: "counsel-review-required",
  summary: "What personal and health data Medveris processes, why, who receives it and the choices available to you.",
  sections: [
    {
      heading: "1. Controller and contact",
      paragraphs: [
        "Aidomex Group Ltd, P.O. Box 118472, Wakiso, Uganda is the controller of personal data processed through Medveris for the purposes described here. Privacy contact: privacy@medveris.ug.",
        "Where a health facility or organisation uses Medveris to run its own service, that organisation may also be a controller of the records it creates. Its own notices and retention rules may apply alongside this one.",
      ],
    },
    {
      heading: "2. Scope",
      paragraphs: [
        "This notice covers the Medveris website, application, patient portal and the operational records created by staff workspaces. It does not cover third-party sites or services that Medveris links to.",
      ],
    },
    {
      heading: "3. Data we collect",
      bullets: [
        "Account and identity data: name, email, phone, password hash, profession, employer, workspace membership, role and unit scope.",
        "Clinical and operational data entered by authorised staff or by you: appointments, encounters, notes, observations, diagnoses, orders, prescriptions, results, referrals, documents and billing records.",
        "Payment data: the mobile-money number you provide, the amount and currency, provider references and reconciliation records. Full payment credentials are held by the payment provider, not by Medveris.",
        "Technical and security data: IP address, device and browser information, session and audit records, error and performance telemetry. Logs are designed not to contain clinical content or secrets.",
        "Legal acceptance records: the document type, version, digest, timestamp, actor and, where applicable, workspace.",
        "Optional data: marketing preferences and cookie choices, which are separate from Terms acceptance and from clinical consent.",
      ],
    },
    {
      heading: "4. Why we process data and legal bases",
      bullets: [
        "To create and secure accounts, authenticate users, enforce roles and unit boundaries, and provide the Service: performance of a contract and our legitimate interests in security.",
        "To provide clinical and administrative features requested by a facility or patient: performance of a contract and, for health data, explicit consent or another lawful basis recognised by the Data Protection and Privacy Act, 2019.",
        "To detect fraud, abuse and unauthorised access; to audit access; and to meet legal obligations: legal obligation and legitimate interests.",
        "To improve reliability and fix defects using aggregated or de-identified telemetry where practicable: legitimate interests.",
        "To send service, security and subscription notices: contract and legitimate interests. Marketing requires separate consent and can be withdrawn at any time.",
      ],
    },
    {
      heading: "5. Health data and consent",
      paragraphs: [
        "Health information is sensitive personal data. It is processed only with explicit consent or another lawful basis, for the purposes of care, treatment, administration, safety or as required by law.",
        "Clinical consent, patient data-sharing consent, marketing consent, cookie preferences and acceptance of these Terms are separate choices. Accepting the Terms does not authorise marketing or the sharing of a patient record.",
        "Consent can be withdrawn using the options in the Service or by contacting us. Withdrawal does not affect processing already carried out, and some features may stop working.",
      ],
    },
    {
      heading: "6. Sharing and processors",
      bullets: [
        "Infrastructure and service providers that host, store, transmit or secure data on our instructions, including cloud hosting, database, object storage, email and telemetry providers.",
        "Payment providers used to collect subscription or invoice payments, which receive the amount, currency, reference and mobile-money number needed to process the payment.",
        "Health professionals and facilities only where authorised by the patient, by the facility relationship, by referral or by law, and limited to the minimum necessary data.",
        "Authorities, courts, regulators and professional advisers where required by law or necessary to protect rights, safety and security.",
        "A successor entity in a merger or transfer, subject to equivalent protections.",
      ],
    },
    {
      heading: "7. International transfers",
      paragraphs: [
        "Medveris runs on a global edge and cloud infrastructure, so data may be processed outside Uganda. We use contractual and organisational safeguards intended to provide protection at least equivalent to that required by Ugandan law, and assess transfers before they occur.",
      ],
    },
    {
      heading: "8. Retention",
      bullets: [
        "Account data: while the account is active, then deleted or anonymised within a defined period after closure, subject to legal holds.",
        "Health records: for the period required by applicable health-records law and the facility's retention policy, then securely deleted or archived.",
        "Legal acceptance records: retained to demonstrate which version was accepted and when, including after account closure.",
        "Payment and reconciliation records: retained as required for tax, accounting and dispute resolution.",
        "Security and audit logs: retained for a defined operational period and then deleted, unless needed for an investigation.",
      ],
    },
    {
      heading: "9. Security and breach notification",
      paragraphs: [
        "We use encryption in transit, hashed or encrypted credentials, least-privilege access, row-level tenant and unit boundaries, audit logging, rate limiting and monitoring. No system is perfectly secure.",
        "If a breach is likely to affect personal data, we assess it and notify the Personal Data Protection Office and affected individuals as required by law, without concealing the incident.",
      ],
    },
    {
      heading: "10. Your rights and complaints",
      bullets: [
        "Access a copy of your personal data and information about its processing.",
        "Correct inaccurate or incomplete data.",
        "Request deletion where there is no lawful basis to keep it.",
        "Object to or restrict certain processing, including direct marketing.",
        "Withdraw consent where processing relies on it.",
        "Complain to the Personal Data Protection Office under NITA-U if you believe your rights have been violated.",
      ],
      },
    {
      heading: "11. Cookies and local storage",
      paragraphs: [
        "The Service uses essential cookies and browser storage to keep you signed in, protect against cross-site request forgery and remember security preferences. Non-essential analytics or marketing storage is used only with the choice you make, and can be changed later.",
      ],
    },
    {
      heading: "12. Children",
      paragraphs: [
        "Accounts are intended for people aged 18 and over. A child's health record may be created by an authorised health professional or caregiver in the course of care; it is not a self-service child account. If you believe a child's data was collected without the required authority, contact us so it can be reviewed.",
      ],
    },
    {
      heading: "13. Changes and contact",
      paragraphs: [
        "We may publish a new version of this notice. For a material change we will give notice and, where required, ask you to acknowledge the new version. Previous acknowledgements remain recorded.",
        "Contact privacy@medveris.ug or Aidomex Group Ltd, P.O. Box 118472, Wakiso, Uganda.",
      ],
    },
  ],
};

export const LEGAL_DOCUMENTS: readonly LegalDocument[] = Object.freeze([TERMS, PRIVACY]);

/** Fixed ids let acceptance records reference the exact document row without a runtime lookup race. */
export const LEGAL_DOCUMENT_IDS: Readonly<Record<LegalKind, string>> = Object.freeze({
  terms: "a1000000-0000-4000-8000-000000000001",
  privacy: "a1000000-0000-4000-8000-000000000002",
});

export function currentLegalDocument(kind: LegalKind): LegalDocument {
  const document = LEGAL_DOCUMENTS.find((candidate) => candidate.kind === kind);
  if (!document) throw new Error(`No bundled legal document for ${kind}`);
  return document;
}

/** Stable digest over the exact published content; acceptance rows store this value. */
export async function legalDocumentDigest(document: LegalDocument): Promise<string> {
  const { kind, version, title, effectiveAt, reviewStatus, summary, sections } = document;
  const canonical = JSON.stringify({ kind, version, title, effectiveAt, reviewStatus, summary, sections });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
