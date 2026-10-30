/** Verified company and support details, kept in one place so every page and test uses the same values. */
export const COMPANY = {
  product: "Medveris",
  legalName: "Aidomex Group Ltd",
  attribution: "A product of Aidomex Group Ltd.",
  phone: "+256 709 998 327",
  phoneHref: "tel:+256709998327",
  whatsappNumber: "256709998327",
  email: "support@medveris.online",
  emailHref: "mailto:support@medveris.online",
  supportHours: "Monday to Saturday, 8:00–18:00 East Africa Time",
} as const;

export function whatsappLink(message: string): string {
  return `https://wa.me/${COMPANY.whatsappNumber}?text=${encodeURIComponent(message)}`;
}

export interface EnquiryInput {
  name: string;
  organisation: string;
  email: string;
  message: string;
}

/** Builds the WhatsApp enquiry text. The form hands this to WhatsApp; nothing is stored by the site. */
export function enquiryMessage(input: EnquiryInput): string {
  return [
    `Hello ${COMPANY.legalName} (${COMPANY.product}) support,`,
    "",
    input.message.trim(),
    "",
    `Name: ${input.name.trim()}`,
    input.organisation.trim() ? `Organisation: ${input.organisation.trim()}` : null,
    `Reply email: ${input.email.trim()}`,
  ].filter((line) => line !== null).join("\n");
}

export interface LaunchRiskItem {
  id: string;
  title: string;
  exposure: string;
  action: string;
  sources: Array<{ label: string; href: string }>;
}

/**
 * Plain-language launch-risk guidance drawn from six published enforcement areas. Amounts are
 * examples that depend on the facts and the court or agency's assessment; they are not automatic
 * charges, and this is general information rather than legal advice.
 */
export const LAUNCH_RISK_ITEMS: readonly LaunchRiskItem[] = [
  {
    id: "coppa",
    title: "Children's privacy and COPPA",
    exposure: "COPPA can apply to a service directed to children, or to a service that has actual knowledge it collects personal information from children under 13. The FTC's stated maximum civil penalty is USD 53,088 per violation; whether a violation exists, how many are counted and what is assessed depend on the facts.",
    action: "Decide before launch whether children can use the service. If they can, collect only what is needed, obtain verifiable parental consent where required, and write a children's privacy notice.",
    sources: [{ label: "FTC COPPA guidance", href: "https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions" }],
  },
  {
    id: "fonts",
    title: "Third-party fonts and visitor IP addresses",
    exposure: "In one Munich I case (2022), a court awarded EUR 100 because a Google Fonts request disclosed a visitor's IP address to a third party. That was a specific decision on those facts under the GDPR; it is not a charge that applies automatically to every website, and awards vary.",
    action: "Self-host fonts and avoid third-party requests that receive a visitor's IP address before consent. Record the lawful basis for any third-party request you keep.",
    sources: [{ label: "Court decision (Munich I, 2022)", href: "https://www.gesetze-bayern.de/Content/Document/Y-300-Z-BECKRS-B-2022-N-612" }],
  },
  {
    id: "session-replay",
    title: "Session-replay tools and privacy claims",
    exposure: "California Penal Code section 637.2 provides a civil remedy of USD 5,000 per violation or three times actual damages, whichever is greater, for certain invasions of privacy. A recorded session is not automatically one violation, and a court decides whether the conduct is covered and how damages are measured.",
    action: "Do not load session-replay or heatmap tools without review. Mask sensitive fields, disclose the tool accurately, and never claim that no recording occurs if it does.",
    sources: [{ label: "California Penal Code section 637.2", href: "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PEN&sectionNum=637.2." }],
  },
  {
    id: "email",
    title: "Unsubscribe requirements for commercial email",
    exposure: "The FTC says each separate email that violates the CAN-SPAM Act may carry a penalty of up to USD 53,088. The requirements depend on the type of email, so transactional service messages and commercial promotion are treated differently.",
    action: "Separate transactional mail from commercial mail, include a working unsubscribe path in commercial messages, honour opt-outs promptly, and keep the sender identity and address accurate.",
    sources: [{ label: "FTC CAN-SPAM compliance guide", href: "https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business" }],
  },
  {
    id: "renewal",
    title: "Clear subscription renewal terms and cancellation",
    exposure: "California's automatic-renewal law (Business and Professions Code section 17602) requires clear renewal terms, affirmative consent before charging, and a reasonably accessible way to cancel. The obligation is to disclose and obtain consent correctly; it does not mean that every renewal automatically becomes a refunded gift.",
    action: "Show the amount, interval and renewal date before payment, keep consent evidence, never renew silently, and make cancellation as easy as sign-up. Medveris uses manual renewal, so no charge occurs without a new approved payment prompt.",
    sources: [{ label: "California Business and Professions Code section 17602", href: "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=BPC&sectionNum=17602." }],
  },
  {
    id: "dmca",
    title: "Rights and takedown handling for user-uploaded images",
    exposure: "Registering a DMCA agent for USD 6 is relevant to certain online service providers seeking safe-harbour protection; it is not a universal fee every app must pay. Statutory damages for copyright infringement can reach USD 150,000 per work for willful infringement, at the court's discretion, and only where the work is registered and the claim succeeds.",
    action: "Put a takedown process and repeat-infringer policy in place before accepting user images, keep accurate records, and assess whether the safe-harbour conditions apply to your service.",
    sources: [
      { label: "DMCA agent FAQ", href: "https://copyright.gov/dmca-directory/faq.html" },
      { label: "Copyright damages law (17 U.S.C. chapter 5)", href: "https://www.copyright.gov/title17/92chap5.html" },
    ],
  },
];

export const LEGAL_DISCLAIMER = "This is general information, not legal advice. Obligations and remedies depend on the jurisdiction, the product design and the specific facts. Amounts stated are maximums or examples and are not automatic fines. Recheck the linked primary sources and the current amounts before publishing or relying on them.";
