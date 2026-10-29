import { createSign, generateKeyPairSync, X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import { maskMsisdn, normalizeUgandaMsisdn } from "@medveris/domain";
import { loadConfig, YO_ENDPOINTS } from "../../apps/api/src/config.js";
import {
  buildYoRequest,
  createYoClient,
  parseFailureNotification,
  parsePaymentNotification,
  parseYoResponse,
  spkiFromCertificate,
  verifyFailureNotification,
  verifyPaymentNotification,
  yoConfigProblems,
  yoOutcome,
} from "../../apps/api/src/integrations/yo.js";

/** Self-signed synthetic certificate, used only to check certificate parsing; it signs nothing. */
const SYNTHETIC_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDQzCCAiugAwIBAgIULGBBlsuYkw26MRlyDohwOZfmZQIwDQYJKoZIhvcNAQEL
BQAwMTEvMC0GA1UEAwwmTWVkdmVyaXMgc3ludGhldGljIFlvIHRlc3QgY2VydGlm
aWNhdGUwHhcNMjYxMDI5MTIwNzU5WhcNMzYxMDI2MTIwNzU5WjAxMS8wLQYDVQQD
DCZNZWR2ZXJpcyBzeW50aGV0aWMgWW8gdGVzdCBjZXJ0aWZpY2F0ZTCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBAJct9Ws+bgSsCqM9para8evlh/xlTWle
FF/GaIQ+wauA/kIHIPdR0DHmeHIMB1dc5GUiTwYUV/tTZS0WvddtKTb3NJ7yUQ/y
1WtrRNj84kGynX79iCeXkjjH9892yZnzZ9gqx4oRl/lTjP4IxYgwmthVlr7xTunS
DfCGnf8MXfY5yMTcbJdNpIUXlvYE7MZr5REPobutVZ2LRzgBjbAJ16GfQLXoOdDA
+F8f3Qc1UZyHqEzHQi8FRtGT5I7VIY9/jmNqSxV4LEJQPmwVUOfrSMkQkcjPI58p
WPJgRftF0L8HqiMavfUkD4cwzNpiwOvvAfuYnoCoPravAgoHOBZNgoECAwEAAaNT
MFEwHQYDVR0OBBYEFLgzkxAd72J6wefQF7ewTAWPBL7CMB8GA1UdIwQYMBaAFLgz
kxAd72J6wefQF7ewTAWPBL7CMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQEL
BQADggEBADZBTxktqVlQAKDZT597QVHpKcZln0sxchB0mBtjV4zBJlr8nFHU1WvX
P6bDP3HvbNCIwcKFgvpYWSAHbUeuFPlBkPJQNC25FUIzVYr5Up60UAczZVoaJ9Ao
oD5CET50qwNaxKqAqqplAsTvcpHf9WkA1Yikef2fJJeP4FFvGS5q9XWrUlp83KTm
L0km0UKgUU8QNaOrjfWfn3CwsgDxVamz392tZB8eFdjBo87w1iTc5HELWqTGWylX
AGdKNWBvDhOaF8NQj+2fCL1PCM65h/77E0Cu/yDiImZ3nqS2SpTzvTHkxk562u+1
Nxq1vm4urFVsHHeEach12c45yDMjrcI=
-----END CERTIFICATE-----`;

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

function yoSign(data: string): string {
  const signer = createSign("RSA-SHA1");
  signer.update(data);
  return signer.sign(keys.privateKey).toString("base64");
}

function config(env: Record<string, string> = {}) {
  return loadConfig({ APP_ENV: "test", APP_ORIGIN: "http://localhost:5173", ...env });
}

function der(pem: string): Uint8Array {
  return new Uint8Array(Buffer.from(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64"));
}

describe("Yo! Payments adapter", () => {
  it("builds the documented AutoCreate XML and escapes values", () => {
    const xml = buildYoRequest({ username: "user&1", password: "p<w>" }, "acdepositfunds", [["NonBlocking", "TRUE"], ["Account", "256772123456"], ["Narrative", "Bill <INV-1> & co"], ["ExternalReference", null]]);
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><AutoCreate><Request><APIUsername>user&amp;1</APIUsername><APIPassword>p&lt;w&gt;</APIPassword>'
      + "<Method>acdepositfunds</Method><NonBlocking>TRUE</NonBlocking><Account>256772123456</Account><Narrative>Bill &lt;INV-1&gt; &amp; co</Narrative></Request></AutoCreate>");
  });

  it("parses pending, succeeded, refused and gateway-level error answers", () => {
    const pending = parseYoResponse("<?xml version=\"1.0\"?><AutoCreate><Response><Status>OK</Status><StatusCode>1</StatusCode><TransactionStatus>PENDING</TransactionStatus><TransactionReference>abc</TransactionReference></Response></AutoCreate>");
    expect(pending).toMatchObject({ status: "OK", statusCode: 1, transactionStatus: "PENDING", transactionReference: "abc" });
    expect(yoOutcome(pending)).toBe("pending");
    const succeeded = parseYoResponse("<AutoCreate><Response><Status>OK</Status><StatusCode>0</StatusCode><TransactionStatus>SUCCEEDED</TransactionStatus><Amount>5000</Amount><MNOTransactionReferenceId>MNO1</MNOTransactionReferenceId></Response></AutoCreate>");
    expect(yoOutcome(succeeded)).toBe("succeeded");
    expect(succeeded.mnoTransactionReferenceId).toBe("MNO1");
    const refused = parseYoResponse("<AutoCreate><Response><Status>ERROR</Status><StatusCode>-22</StatusCode><StatusMessage>Insufficient balance</StatusMessage><ErrorMessage>Insufficient &amp; low</ErrorMessage></Response></AutoCreate>");
    expect(yoOutcome(refused)).toBe("failed");
    expect(refused.errorMessage).toBe("Insufficient & low");
    expect(yoOutcome(parseYoResponse("<AutoCreate><Response><Status>ERROR</Status><StatusCode>-1</StatusCode><TransactionStatus>INDETERMINATE</TransactionStatus></Response></AutoCreate>"))).toBe("indeterminate");
    const gateway = parseYoResponse("ybs_autocreate_status=ERROR&ybs_autocreate_message=Yo%21+Payments+AutoCreate+Subsystem%3A+Unauthorized+API+Method%3A+%28%29");
    expect(gateway.status).toBe("ERROR");
    expect(gateway.errorMessage).toContain("Unauthorized API Method");
  });

  it("sends deposits once to the primary endpoint and retries status checks on the backup", async () => {
    const production = config({ YO_MODE: "production", YO_API_USERNAME: "u", YO_API_PASSWORD: "p", YO_PUBLIC_KEY: publicPem });
    expect(production.yo.apiUrl).toBe(YO_ENDPOINTS.production);
    expect(production.yo.backupApiUrl).toBe(YO_ENDPOINTS.productionBackup);
    const urls: string[] = [];
    const client = createYoClient(production.yo, async (url, init) => {
      urls.push(url);
      expect((init?.headers as Record<string, string>)["content-type"]).toBe("text/xml");
      if (url === YO_ENDPOINTS.production) throw new TypeError("network down");
      return new Response("<AutoCreate><Response><Status>OK</Status><StatusCode>0</StatusCode><TransactionStatus>SUCCEEDED</TransactionStatus></Response></AutoCreate>");
    });
    await expect(client.depositFunds({ msisdn: "256772123456", amount: 1000, narrative: "n", externalReference: "MV-1" })).rejects.toThrow(/could not be reached/);
    expect(urls).toEqual([YO_ENDPOINTS.production]);
    const status = await client.checkStatus({ externalReference: "MV-1" });
    expect(status.transactionStatus).toBe("SUCCEEDED");
    expect(urls).toEqual([YO_ENDPOINTS.production, YO_ENDPOINTS.production, YO_ENDPOINTS.productionBackup]);
  });

  it("verifies instant and failure notifications with RSA-SHA1 and rejects tampering", async () => {
    const fields = { date_time: "2026-10-29 10:00:00", amount: "15000", narrative: "Payment for bill INV-1", network_ref: "MP123", external_ref: "MV-ABC", msisdn: "256772123456" };
    const signature = yoSign(fields.date_time + fields.amount + fields.narrative + fields.network_ref + fields.external_ref + fields.msisdn);
    const form = new URLSearchParams({ ...fields, signature });
    expect(await verifyPaymentNotification(publicPem, parsePaymentNotification(form))).toBe(true);
    const tampered = new URLSearchParams({ ...fields, amount: "150000", signature });
    expect(await verifyPaymentNotification(publicPem, parsePaymentNotification(tampered))).toBe(false);
    expect(await verifyPaymentNotification(publicPem, parsePaymentNotification(new URLSearchParams({ ...fields, signature: "not base64!" })))).toBe(false);

    const failure = new URLSearchParams({ failed_transaction_reference: "MV-ABC", transaction_init_date: "2026-10-29 10:00:00", verification: yoSign("MV-ABC2026-10-29 10:00:00") });
    expect(await verifyFailureNotification(publicPem, parseFailureNotification(failure))).toBe(true);
    failure.set("failed_transaction_reference", "MV-OTHER");
    expect(await verifyFailureNotification(publicPem, parseFailureNotification(failure))).toBe(false);
  });

  it("extracts the public key from Yo!'s X.509 certificate format", () => {
    const expected = new X509Certificate(SYNTHETIC_CERTIFICATE).publicKey.export({ type: "spki", format: "der" });
    expect(Buffer.from(spkiFromCertificate(der(SYNTHETIC_CERTIFICATE))).equals(expected)).toBe(true);
  });

  it("reports what is missing and refuses unsafe modes", () => {
    const disabled = config();
    expect(disabled.yo.mode).toBe("disabled");
    expect(yoConfigProblems(disabled)).toContain("YO_MODE is disabled");
    const sandbox = config({ YO_MODE: "sandbox" });
    expect(sandbox.yo.apiUrl).toBe(YO_ENDPOINTS.sandbox);
    expect(yoConfigProblems(sandbox).join(" ")).toMatch(/YO_API_USERNAME.*YO_PUBLIC_KEY/);
    expect(() => config({ YO_MODE: "live" })).toThrow(/YO_MODE/);
  });

  it("normalises Ugandan mobile numbers and masks them", () => {
    expect(normalizeUgandaMsisdn("0772 123 456")).toBe("256772123456");
    expect(normalizeUgandaMsisdn("+256 701-234567")).toBe("256701234567");
    expect(normalizeUgandaMsisdn("772123456")).toBe("256772123456");
    expect(normalizeUgandaMsisdn("0412 123456")).toBeNull();
    expect(normalizeUgandaMsisdn("2547221234567")).toBeNull();
    expect(maskMsisdn("256772123456")).toBe("2567•••••456");
  });
});
