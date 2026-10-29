/**
 * Yo! Payments (Yo! Uganda) mobile money collections.
 *
 * Follows the Yo! Payments Business API specification and Yo!'s reference libraries
 * (github.com/YO-Uganda/YoPaymentsPHP, YoPaymentsPython):
 * - Requests are XML `<AutoCreate><Request>…</Request></AutoCreate>` POSTed to task.php with
 *   `Content-Type: text/xml` and `Content-transfer-encoding: text`.
 * - `acdepositfunds` with `NonBlocking=TRUE` prompts the payer's phone and returns PENDING with a
 *   TransactionReference; `actransactioncheckstatus` follows it up by TransactionReference or by the
 *   ExternalReference sent (PrivateTransactionReference).
 * - Instant payment notifications are form posts signed by Yo! with RSA-SHA1 over
 *   date_time + amount + narrative + network_ref + external_ref + msisdn; failure notifications sign
 *   failed_transaction_reference + transaction_init_date. Both verify against Yo!'s public certificate.
 */

import type { AppConfig, YoConfig } from "../config.js";
import type { FetchLike } from "./dhis2.js";

export type YoTransactionStatus = "SUCCEEDED" | "FAILED" | "PENDING" | "INDETERMINATE" | "";

export interface YoResponse {
  status: string;
  statusCode: number | null;
  statusMessage: string | null;
  transactionStatus: YoTransactionStatus;
  transactionReference: string | null;
  mnoTransactionReferenceId: string | null;
  errorMessage: string | null;
  errorMessageCode: string | null;
  amount: string | null;
  currencyCode: string | null;
}

/** The request never reached Yo!, or no usable answer came back; the outcome is unknown. */
export class YoTransportError extends Error {
  readonly retryable = true;
}

export function yoConfigProblems(config: Pick<AppConfig, "yo" | "appEnv">): string[] {
  const yo = config.yo;
  const problems: string[] = [];
  if (yo.mode === "disabled") problems.push("YO_MODE is disabled");
  if (!yo.apiUrl) problems.push("YO_API_URL is not set");
  if (!yo.username || !yo.password) problems.push("YO_API_USERNAME and YO_API_PASSWORD (Worker secrets) are not set");
  if (!yo.publicKeyPem) problems.push("YO_PUBLIC_KEY is not set, so payment notifications cannot be verified");
  else if (!/-----BEGIN (CERTIFICATE|PUBLIC KEY)-----/.test(yo.publicKeyPem)) problems.push("YO_PUBLIC_KEY must be a PEM certificate or public key");
  if (!["development", "test"].includes(config.appEnv) && !yo.notificationBaseUrl.startsWith("https://")) {
    problems.push("YO_NOTIFICATION_BASE_URL must be a public HTTPS origin Yo! can reach");
  }
  return problems;
}

export function yoNotificationUrls(yo: YoConfig): { instant: string; failure: string } {
  return {
    instant: `${yo.notificationBaseUrl}/api/v1/public/payments/yo/notifications`,
    failure: `${yo.notificationBaseUrl}/api/v1/public/payments/yo/failures`,
  };
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function xmlUnescape(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

export function buildYoRequest(yo: Pick<YoConfig, "username" | "password">, method: string, fields: ReadonlyArray<[string, string | null | undefined]>): string {
  const body = fields
    .filter(([, value]) => value != null && value !== "")
    .map(([name, value]) => `<${name}>${xmlEscape(String(value))}</${name}>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><AutoCreate><Request><APIUsername>${xmlEscape(yo.username ?? "")}</APIUsername>`
    + `<APIPassword>${xmlEscape(yo.password ?? "")}</APIPassword><Method>${xmlEscape(method)}</Method>${body}</Request></AutoCreate>`;
}

function tag(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? xmlUnescape(match[1]!.trim()) : null;
}

/** Parses a Yo! response. The gateway answers malformed or unauthorised requests with a URL-encoded error line instead of XML. */
export function parseYoResponse(text: string): YoResponse {
  if (!text.includes("<Response>") && text.includes("ybs_autocreate_status=")) {
    const params = new URLSearchParams(text.trim());
    return {
      status: params.get("ybs_autocreate_status") ?? "ERROR", statusCode: null, statusMessage: params.get("ybs_autocreate_message"),
      transactionStatus: "", transactionReference: null, mnoTransactionReferenceId: null,
      errorMessage: params.get("ybs_autocreate_message"), errorMessageCode: null, amount: null, currencyCode: null,
    };
  }
  const response = /<Response>([\s\S]*)<\/Response>/.exec(text)?.[1];
  if (!response) throw new YoTransportError("Yo! returned a response without a Response element");
  const code = tag(response, "StatusCode");
  const transactionStatus = (tag(response, "TransactionStatus") ?? "").toUpperCase();
  return {
    status: (tag(response, "Status") ?? "").toUpperCase(),
    statusCode: code != null && /^-?\d+$/.test(code) ? Number(code) : null,
    statusMessage: tag(response, "StatusMessage"),
    transactionStatus: (["SUCCEEDED", "FAILED", "PENDING", "INDETERMINATE"].includes(transactionStatus) ? transactionStatus : "") as YoTransactionStatus,
    transactionReference: tag(response, "TransactionReference"),
    mnoTransactionReferenceId: tag(response, "MNOTransactionReferenceId"),
    errorMessage: tag(response, "ErrorMessage"),
    errorMessageCode: tag(response, "ErrorMessageCode"),
    amount: tag(response, "Amount"),
    currencyCode: tag(response, "CurrencyCode"),
  };
}

export type YoOutcome = "succeeded" | "failed" | "pending" | "indeterminate";

/** Maps a Yo! answer to the request's state. An ERROR without a transaction is a refusal; nothing was debited. */
export function yoOutcome(response: YoResponse): YoOutcome {
  if (response.transactionStatus === "SUCCEEDED") return "succeeded";
  if (response.transactionStatus === "FAILED") return "failed";
  if (response.transactionStatus === "INDETERMINATE") return "indeterminate";
  if (response.transactionStatus === "PENDING") return "pending";
  if (response.status === "ERROR") return "failed";
  if (response.status === "OK" && response.statusCode === 1) return "pending";
  return "indeterminate";
}

export interface DepositRequest {
  msisdn: string;
  amount: number;
  narrative: string;
  externalReference: string;
  providerReferenceText?: string;
}

export interface YoClient {
  depositFunds(request: DepositRequest): Promise<YoResponse>;
  checkStatus(reference: { transactionReference?: string | null; externalReference: string }): Promise<YoResponse>;
}

export function createYoClient(yo: YoConfig, fetchImpl: FetchLike = fetch): YoClient {
  async function post(url: string, xml: string): Promise<YoResponse> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "text/xml", "content-transfer-encoding": "text", accept: "text/xml" },
        body: xml,
        signal: AbortSignal.timeout(yo.timeoutMs),
      });
    } catch (error) {
      throw new YoTransportError(`Yo! could not be reached: ${(error as Error).name === "TimeoutError" ? "timed out" : "network error"}`);
    }
    const text = await response.text();
    if (!response.ok) throw new YoTransportError(`Yo! answered HTTP ${response.status}`);
    return parseYoResponse(text);
  }

  return {
    async depositFunds(request) {
      if (!yo.apiUrl) throw new YoTransportError("YO_API_URL is not configured");
      const urls = yoNotificationUrls(yo);
      const xml = buildYoRequest(yo, "acdepositfunds", [
        ["NonBlocking", "TRUE"],
        ["Account", request.msisdn],
        ["Amount", String(request.amount)],
        ["Narrative", request.narrative],
        ["ExternalReference", request.externalReference],
        ["ProviderReferenceText", request.providerReferenceText],
        ["InstantNotificationUrl", urls.instant],
        ["FailureNotificationUrl", urls.failure],
      ]);
      // Never resent to the backup endpoint: a second deposit request could prompt and debit the payer twice.
      return post(yo.apiUrl, xml);
    },
    async checkStatus(reference) {
      if (!yo.apiUrl) throw new YoTransportError("YO_API_URL is not configured");
      const xml = buildYoRequest(yo, "actransactioncheckstatus", [
        ["TransactionReference", reference.transactionReference ?? null],
        ["PrivateTransactionReference", reference.externalReference],
      ]);
      try {
        return await post(yo.apiUrl, xml);
      } catch (error) {
        if (!(error instanceof YoTransportError) || !yo.backupApiUrl) throw error;
        return post(yo.backupApiUrl, xml);
      }
    },
  };
}

// ---------------------------------------------------------------- notification signatures

function pemBody(pem: string): { label: string; der: Uint8Array } {
  const match = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(pem);
  if (!match) throw new Error("Not a PEM document");
  const binary = atob(match[2]!.replace(/\s+/g, ""));
  const der = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) der[index] = binary.charCodeAt(index);
  return { label: match[1]!, der };
}

interface Tlv { tag: number; contentStart: number; end: number }

function readTlv(der: Uint8Array, offset: number): Tlv {
  const tagByte = der[offset];
  let lengthByte = der[offset + 1];
  if (tagByte === undefined || lengthByte === undefined) throw new Error("Truncated DER");
  let length = 0;
  let cursor = offset + 2;
  if (lengthByte & 0x80) {
    const count = lengthByte & 0x7f;
    if (count < 1 || count > 4) throw new Error("Unsupported DER length");
    for (let index = 0; index < count; index++) {
      lengthByte = der[cursor++];
      if (lengthByte === undefined) throw new Error("Truncated DER");
      length = length * 256 + lengthByte;
    }
  } else {
    length = lengthByte;
  }
  const end = cursor + length;
  if (end > der.length) throw new Error("Truncated DER");
  return { tag: tagByte, contentStart: cursor, end };
}

/** SubjectPublicKeyInfo of an X.509 certificate: tbsCertificate fields after version, serial, algorithm, issuer, validity and subject. */
export function spkiFromCertificate(der: Uint8Array): Uint8Array {
  const certificate = readTlv(der, 0);
  const tbs = readTlv(der, certificate.contentStart);
  let cursor = tbs.contentStart;
  let field = readTlv(der, cursor);
  if (field.tag === 0xa0) {
    cursor = field.end;
    field = readTlv(der, cursor);
  }
  cursor = field.end;
  for (let skip = 0; skip < 4; skip++) cursor = readTlv(der, cursor).end;
  const spki = readTlv(der, cursor);
  if (spki.tag !== 0x30) throw new Error("Certificate has no SubjectPublicKeyInfo");
  return der.slice(cursor, spki.end);
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function verificationKey(pem: string): Promise<CryptoKey> {
  let key = keyCache.get(pem);
  if (!key) {
    const { label, der } = pemBody(pem);
    const spki = label === "CERTIFICATE" ? spkiFromCertificate(der) : der;
    key = crypto.subtle.importKey("spki", spki as unknown as BufferSource, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-1" }, false, ["verify"]);
    keyCache.set(pem, key);
    key.catch(() => keyCache.delete(pem));
  }
  return key;
}

async function verifySignature(pem: string, data: string, base64Signature: string): Promise<boolean> {
  if (!base64Signature) return false;
  let signature: Uint8Array;
  try {
    const binary = atob(base64Signature.replace(/\s+/g, ""));
    signature = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) signature[index] = binary.charCodeAt(index);
  } catch {
    return false;
  }
  try {
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", await verificationKey(pem), signature as unknown as BufferSource, new TextEncoder().encode(data));
  } catch {
    return false;
  }
}

export interface YoPaymentNotification {
  dateTime: string;
  amount: string;
  narrative: string;
  networkRef: string;
  externalRef: string;
  msisdn: string;
  payerNames: string | null;
  signature: string;
}

export function parsePaymentNotification(form: URLSearchParams): YoPaymentNotification {
  return {
    dateTime: form.get("date_time") ?? "",
    amount: form.get("amount") ?? "",
    narrative: form.get("narrative") ?? "",
    networkRef: form.get("network_ref") ?? "",
    externalRef: form.get("external_ref") ?? "",
    msisdn: form.get("msisdn") ?? "",
    payerNames: form.get("payer_names"),
    signature: form.get("signature") ?? "",
  };
}

export function verifyPaymentNotification(pem: string, notification: YoPaymentNotification): Promise<boolean> {
  const data = notification.dateTime + notification.amount + notification.narrative + notification.networkRef + notification.externalRef + notification.msisdn;
  return verifySignature(pem, data, notification.signature);
}

export interface YoFailureNotification {
  failedTransactionReference: string;
  transactionInitDate: string;
  verification: string;
}

export function parseFailureNotification(form: URLSearchParams): YoFailureNotification {
  return {
    failedTransactionReference: form.get("failed_transaction_reference") ?? "",
    transactionInitDate: form.get("transaction_init_date") ?? "",
    verification: form.get("verification") ?? "",
  };
}

export function verifyFailureNotification(pem: string, notification: YoFailureNotification): Promise<boolean> {
  return verifySignature(pem, notification.failedTransactionReference + notification.transactionInitDate, notification.verification);
}
