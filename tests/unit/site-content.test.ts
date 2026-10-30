import { describe, expect, it } from "vitest";
import { COMPANY, enquiryMessage, LAUNCH_RISK_ITEMS, LEGAL_DISCLAIMER, whatsappLink } from "../../apps/web/src/content/company.js";

describe("company contact details", () => {
  it("publishes the verified phone, WhatsApp, email and attribution", () => {
    expect(COMPANY.phone).toBe("+256 709 998 327");
    expect(COMPANY.phoneHref).toBe("tel:+256709998327");
    expect(COMPANY.whatsappNumber).toBe("256709998327");
    expect(COMPANY.email).toBe("support@medveris.online");
    expect(COMPANY.emailHref).toBe("mailto:support@medveris.online");
    expect(COMPANY.attribution).toBe("A product of Aidomex Group Ltd.");
  });

  it("builds working WhatsApp and enquiry links", () => {
    expect(whatsappLink("Hello there")).toBe("https://wa.me/256709998327?text=Hello%20there");
    const message = enquiryMessage({ name: "Amina", organisation: "Kampala Clinic", email: "amina@example.com", message: "We would like a demo." });
    expect(message).toContain("Amina");
    expect(message).toContain("Kampala Clinic");
    expect(message).toContain("amina@example.com");
    expect(message).toContain("We would like a demo.");
    expect(whatsappLink(message).startsWith("https://wa.me/256709998327?text=")).toBe(true);
  });
});

describe("six-point launch-risk guide", () => {
  it("covers all six topics in order", () => {
    expect(LAUNCH_RISK_ITEMS.map((item) => item.id)).toEqual(["coppa", "fonts", "session-replay", "email", "renewal", "dmca"]);
  });

  it("states each amount as a maximum or case outcome, not an automatic fine", () => {
    const text = LAUNCH_RISK_ITEMS.map((item) => item.exposure).join(" ");
    expect(text).toContain("USD 53,088");
    expect(text).toContain("EUR 100");
    expect(text).toContain("USD 5,000 per violation or three times actual damages");
    expect(text).toContain("USD 6");
    expect(text).toContain("USD 150,000 per work");
    expect(text.toLowerCase()).toContain("not automatically");
    expect(text).toContain("specific decision");
  });

  it("links every item to its primary source", () => {
    const hrefs = LAUNCH_RISK_ITEMS.flatMap((item) => item.sources.map((source) => source.href));
    expect(hrefs).toEqual(expect.arrayContaining([
      "https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions",
      "https://www.gesetze-bayern.de/Content/Document/Y-300-Z-BECKRS-B-2022-N-612",
      "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PEN&sectionNum=637.2.",
      "https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business",
      "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=BPC&sectionNum=17602.",
      "https://copyright.gov/dmca-directory/faq.html",
      "https://www.copyright.gov/title17/92chap5.html",
    ]));
    for (const href of hrefs) expect(href.startsWith("https://")).toBe(true);
  });

  it("shows a general-information disclaimer", () => {
    expect(LEGAL_DISCLAIMER).toContain("not legal advice");
    expect(LEGAL_DISCLAIMER).toContain("depend on the jurisdiction");
    expect(LEGAL_DISCLAIMER).toContain("not automatic fines");
  });
});
