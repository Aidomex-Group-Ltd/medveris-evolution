import { parseShardTopology, type ShardTopology } from "@medveris/db";
import type { FxConfig } from "./integrations/fx.js";
import type { AiModelConfig } from "@medveris/ai";

/**
 * How an integration is connected in this deployment. `live` talks to a real provider endpoint,
 * `sandbox` runs a simulated or local adapter that only ever produces synthetic data, and `off`
 * means nothing was requested. Sandbox is never reported as available anywhere in the product.
 */
export type IntegrationMode = "off" | "sandbox" | "live";

/** Environment variables whose sandbox value is hard-blocked when APP_ENV=production. */
export const SANDBOX_MODE_ENV_VARS = [
  "UPLOAD_SCAN_MODE",
  "AI_MODE",
  "DICOMWEB_MODE",
  "TELEMEDICINE_MODE",
  "LAB_MODE",
  "PHARMACY_MODE",
  "DEVICES_MODE",
  "LEDGER_ANCHOR_MODE",
  "TERMINOLOGY_MODE",
  "YO_MODE",
] as const;

/**
 * Sandbox adapters are refused at startup in production, before any other work: a simulated
 * adapter must never be able to boot in the environment where real patient data lives.
 */
export function refuseSandboxInProduction(env: Record<string, string | undefined>, appEnv: string): void {
  if (appEnv !== "production") return;
  for (const name of SANDBOX_MODE_ENV_VARS) {
    const value = (env[name] ?? "").trim();
    const sandboxValue = name === "YO_MODE" ? value === "sandbox" || value === "mock" : value === "sandbox";
    if (sandboxValue) {
      throw new Error(`${name}=${value} is not allowed in production; sandbox adapters are hard-blocked when APP_ENV=production`);
    }
  }
}

function modeVar(env: EnvLike, name: string, fallback: IntegrationMode = "live"): IntegrationMode {
  const raw = (env[name] ?? "").trim() || fallback;
  if (raw !== "off" && raw !== "sandbox" && raw !== "live") throw new Error(`${name} must be off, sandbox or live`);
  return raw;
}

/** ERPNEXT_MODE must be off or live; there is no Medveris ERPNext simulator. */
function erpnextMode(mode: string | undefined): IntegrationMode {
  const raw = (mode ?? "").trim() || "off";
  if (raw !== "off" && raw !== "live") throw new Error("ERPNEXT_MODE must be off or live");
  return raw as IntegrationMode;
}

/** YO_MODE=disabled is off, YO_MODE=mock is the local mock gateway (sandbox); Yo!'s own sandbox and production endpoints are real provider connections. */
function yoIntegrationMode(mode: string): IntegrationMode {
  if (mode === "disabled") return "off";
  if (mode === "mock") return "sandbox";
  return "live";
}

export interface AppConfig {
  appEnv: string;
  origin: string;
  sessionSecret: string;
  sessionTtlMinutes: number;
  auditSigningKey: string;
  auditSigningKeyId: string;
  mfaEncryptionKey: string;
  csrfHeader: string;
  emailAdapter: "local" | "resend";
  emailFrom: string;
  mailSinkDir: string;
  resendApiKey: string | null;
  /** Optional operator inbox for redacted operational alerts (dead-lettered jobs). Never carries patient data. */
  operatorAlertEmail: string | null;
  storageAdapter: "local" | "r2";
  localUploadDir: string;
  maxUploadBytes: number;
  terminologyMode: "synthetic" | "sandbox" | "production" | "local-reference" | "unavailable";
  terminologyProviderUrl: string | null;
  terminologyProviderToken: string | null;
  terminologyTimeoutMs: number;
  snomedEditionUri: string | null;
  loincRelease: string | null;
  fhirExternalWritesEnabled: boolean;
  fhirBulkExportEnabled: boolean;
  emergencyOverrideMinutes: number;
  /** Facility policy for acknowledging critical imaging findings; requires clinical governance approval. */
  radiologyCriticalAckMinutes: number;
  emergencyReviewDueHours: number;
  devShowTotpSecrets: boolean;
  /** The scheduled job imports public content from the official sources in content_sources. */
  contentFeedsEnabled: boolean;
  map: {
    renderer: "leaflet";
    providerState: "disabled" | "osm" | "configured";
    tileUrl: string | null;
    attribution: string;
    minZoom: number;
    maxZoom: number;
    geolocationEnabled: boolean;
    geocodingEnabled: boolean;
    routingEnabled: boolean;
  };
  directory: {
    defaultCountry: string;
    maxRadiusKm: number;
    maxResults: number;
    sponsoredListingsEnabled: boolean;
  };
  promotions: {
    paymentProvider: string | null;
    webhookSecret: string | null;
  };
  integrations: {
    tokenTtlMinutes: number;
  };
  features: Record<string, boolean>;
  /** Per-integration connection mode derived from the *_MODE environment variables; the feature flag still gates everything. */
  modes: Record<string, IntegrationMode>;
  /** Upload malware scanning. `signature` keeps the pre-existing local signature check only. */
  uploadScan: UploadScanConfig;
  /** Ollama endpoint used as the sandbox AI adapter in local Node development. */
  ollama: OllamaConfig;
  /** Jitsi media provider for telehealth sessions. */
  telemedicine: TelemedicineConfig;
  /** Simulator gateway settings shared by the lab, pharmacy and device sandbox adapters. */
  lab: SimulatorGatewayConfig;
  pharmacy: SimulatorGatewayConfig;
  devices: SimulatorGatewayConfig;
  /** Ledger anchoring: local append-only sandbox anchor or the OpenTimestamps live adapter. */
  ledgerAnchor: LedgerAnchorConfig;
  /** Mobile money provider selection: Yo! (default) or LivePay. */
  payments: PaymentsConfig;
  /** Optional AI suggestor / CDS provider that is only used when the AI integration is available and configured. */
  ai: AiConfig;
  /** AI model configuration used by clinical inference jobs. */
  aiModel: AiModelConfig;
  /** PACS connection; problems are reported through the integration registry, never at startup. */
  dicomweb: DicomwebConfig;
  erpnext: ErpnextConfig;
  /** Deployment-level gate for the facility-scoped eHMIS/DHIS2 connector. */
  ehmis: EhmisConfig;
  /** Yo! Payments mobile money collections for point-of-sale bills. */
  yo: YoConfig;
  billing: BillingConfig;
  /** Self-service subscription pricing and the rate used to convert USD to UGX at checkout. */
  subscription: SubscriptionConfig;
  /** Exchange rates for converting facility prices; never applied at billing time. */
  fx: FxConfig;
  database: {
    /** Replica reads need an explicit opt-in plus a HYPERDRIVE_REPLICA binding. */
    replicaEnabled: boolean;
    replicaMaxLagMs: number;
    /** After a write, the session reads from the primary for this long. */
    readYourWritesMs: number;
    replicaHealthTtlMs: number;
    replicaHealthTimeoutMs: number;
  };
  shardTopology: ShardTopology;
  cache: {
    /** Bump to invalidate every Worker-cache key without a deployment. */
    keyEpoch: string;
  };
  observability: {
    requestLogSampleRate: number;
  };
  /** Read-only Cloudflare API used by the platform observability dashboard; disabled until configured. */
  cloudflare: {
    enabled: boolean;
    /** Token is a Worker secret in staging/production; never logged or returned by the API. */
    apiToken: string | null;
    accountId: string | null;
    timeoutMs: number;
    cacheTtlMs: number;
  };
  /** Platform-operator grant workflow. */
  platformRoles: {
    /** Default grant duration when the request does not specify one. */
    defaultGrantHours: number;
    /** Maximum grant duration allowed, even when the request asks for longer. */
    maxGrantHours: number;
    /** A session is treated as recently MFA-verified when it verified within this many seconds. */
    recentMfaSeconds: number;
    /** In production, the platform is considered understaffed below this many active operators. */
    minActiveOperators: number;
    /** Legacy direct-elevate endpoint stays reachable only in these environments. */
    legacyElevateEnvironments: string[];
  };
  realtime: {
    enabled: boolean;
    /** Origins allowed to open WebSockets; always includes APP_ORIGIN. */
    allowedOrigins: string[];
    /** Outbox event types delivered as real-time notifications; clinical types need explicit approval. */
    eventTypes: string[];
    ticketTtlSeconds: number;
    /** Connections are closed after this and must re-authenticate through a new ticket. */
    maxConnectionSeconds: number;
  };
  rateLimit: {
    overrides: RateLimitOverride[];
    trustForwardedFor: boolean;
  };
  jobs: {
    relayBatchSize: number;
    perTenantBatchLimit: number;
  };
}

export interface BillingConfig {
  /**
   * What a subscription that is not in good standing changes. "off": nothing is shown or enforced;
   * "notify": states, reminders and banners only; "enforce": growth and analytics features pause too.
   * Patient records and care workflows are never restricted in any mode.
   */
  enforcement: "off" | "notify" | "enforce";
  /** Server-side measurement of API compute time and traffic per workspace. */
  usageMetering: boolean;
}

export interface SubscriptionConfig {
  /** What the subscription buys, shown beside the price. Configurable so the product can be named. */
  productDescription: string;
  /** Smallest UGX collection attempted; Yo! collects whole shillings and small prompts are uneconomic. */
  minUgx: number;
  /**
   * Operator-configured USD/UGX rate used only when no live provider is configured or reachable.
   * It is disclosed as a configured rate, never presented as a market rate, and never hardcoded here.
   */
  fxFallbackUsdUgx: number | null;
  /** A provider rate older than this is refused rather than priced. */
  fxMaxAgeMinutes: number;
}

export interface AiConfig {
  /** Provider base URL for AI note suggestions and CDS jobs. Must be HTTPS outside local development and tests. */
  baseUrl: string | null;
  /** Provider token used as a Bearer credential. Worker secret in staging/production. */
  token: string | null;
  /** Ollama HTTP Basic Auth username for the live Ollama provider. Worker secret in staging/production. */
  ollamaUsername: string | null;
  /** Ollama HTTP Basic Auth password for the live Ollama provider. Worker secret in staging/production. */
  ollamaPassword: string | null;
}

export function aiConfig(env: EnvLike, appEnv: string): AiConfig {
  const rawUrl = (env.AI_BASE_URL ?? "").trim();
  let baseUrl: string | null = rawUrl || null;
  if (baseUrl) {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error("AI_BASE_URL must be an absolute URL");
    }
    if (url.protocol !== "https:" && !LOCAL_ONLY_ENVIRONMENTS.has(appEnv)) {
      throw new Error("AI_BASE_URL must use HTTPS outside local development and tests");
    }
    baseUrl = url.origin.replace(/\/+$/, "");
  }
  const token = (env.AI_TOKEN ?? "").trim() || null;
  const ollamaUsername = (env.OLLAMA_USERNAME ?? "").trim() || null;
  const ollamaPassword = (env.OLLAMA_PASSWORD ?? "").trim() || null;
  return { baseUrl, token, ollamaUsername, ollamaPassword };
}

export interface UploadScanConfig {
  /** off: the pre-existing local signature check only; sandbox: EICAR stub scanner; live: ClamAV through clamd. */
  mode: IntegrationMode;
  /** clamd INSTREAM endpoint. Defaults to 127.0.0.1:3310 in local development and tests. */
  clamdAddress: string;
  timeoutMs: number;
}

function uploadScanConfig(env: EnvLike, appEnv: string): UploadScanConfig {
  // There is no feature flag for scanning, and before this mode existed only the local signature
  // check ran, so an unset UPLOAD_SCAN_MODE stays `off` rather than silently demanding clamd.
  const mode = modeVar(env, "UPLOAD_SCAN_MODE", "off");
  const clamdAddress = (env.CLAMD_ADDRESS ?? "").trim() || (LOCAL_ONLY_ENVIRONMENTS.has(appEnv) ? "127.0.0.1:3310" : "");
  if (mode === "live" && !clamdAddress) throw new Error("UPLOAD_SCAN_MODE=live requires CLAMD_ADDRESS (host:port of clamd)");
  if (clamdAddress && !/^[a-zA-Z0-9._-]+(:\d{1,5})?$/.test(clamdAddress)) throw new Error("CLAMD_ADDRESS must be host or host:port");
  return { mode, clamdAddress, timeoutMs: Math.max(1_000, Math.min(integer(env.UPLOAD_SCAN_TIMEOUT_MS, 10_000), 60_000)) };
}

export interface OllamaConfig {
  /** Ollama server used as the sandbox AI adapter; http is allowed outside production because sandbox mode is refused there. */
  url: string | null;
  model: string;
  timeoutMs: number;
}

function ollamaConfig(env: EnvLike, appEnv: string): OllamaConfig {
  const raw = (env.OLLAMA_URL ?? "").trim().replace(/\/+$/, "");
  let url: string | null = raw || null;
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("OLLAMA_URL must be an absolute URL");
    }
    if (parsed.protocol !== "https:" && appEnv === "production") throw new Error("OLLAMA_URL must use HTTPS in production");
    url = parsed.origin;
  }
  return { url, model: (env.OLLAMA_MODEL ?? "").trim() || "llama3.2", timeoutMs: Math.max(1_000, Math.min(integer(env.OLLAMA_TIMEOUT_MS, 60_000), 300_000)) };
}

export interface TelemedicineConfig {
  mode: IntegrationMode;
  /** Jitsi server that hosts generated rooms. Required for live mode; sandbox defaults to the public meet.jit.si. */
  baseUrl: string | null;
}

function telemedicineConfig(env: EnvLike, appEnv: string): TelemedicineConfig {
  const mode = modeVar(env, "TELEMEDICINE_MODE");
  const raw = (env.JITSI_BASE_URL ?? "").trim().replace(/\/+$/, "");
  let baseUrl: string | null = raw || null;
  if (baseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error("JITSI_BASE_URL must be an absolute URL");
    }
    if (parsed.protocol !== "https:" && !LOCAL_ONLY_ENVIRONMENTS.has(appEnv)) throw new Error("JITSI_BASE_URL must use HTTPS outside local development and tests");
    baseUrl = parsed.origin;
  }
  return { mode, baseUrl };
}

export interface SimulatorGatewayConfig {
  mode: IntegrationMode;
  /** Shared HMAC secret the simulator gateway signs its messages with; required before a sandbox gateway is usable. */
  gatewaySecret: string | null;
}

function simulatorGatewayConfig(env: EnvLike, prefix: "LAB" | "PHARMACY" | "DEVICES"): SimulatorGatewayConfig {
  const secret = (env[`${prefix}_GATEWAY_SECRET`] ?? "").trim();
  return { mode: modeVar(env, `${prefix}_MODE`), gatewaySecret: secret.length >= 32 ? secret : null };
}

export interface LedgerAnchorConfig {
  mode: IntegrationMode;
  /** Directory the local append-only sandbox anchor appends to; never claimed as an external anchor. */
  anchorDir: string;
}

function ledgerAnchorConfig(env: EnvLike): LedgerAnchorConfig {
  return { mode: modeVar(env, "LEDGER_ANCHOR_MODE"), anchorDir: (env.LEDGER_ANCHOR_DIR ?? "").trim() || ".data/anchors" };
}

export interface LivePayConfig {
  /** LivePay API key (Bearer credential). Worker secret in staging and production. */
  apiKey: string | null;
  /** LivePay business account number, e.g. LP2305443309. */
  accountNumber: string | null;
  /** Upstream API root, e.g. https://livepay.me/api. Never the inbound webhook URL. */
  baseUrl: string;
  /** Inbound URL LivePay posts to; the exact string is also part of the webhook signature. */
  webhookUrl: string;
  /** HMAC-SHA256 key for X-Webhook-Signature. Worker secret in staging and production. */
  webhookSecret: string | null;
  timeoutMs: number;
}

export interface PaymentsConfig {
  /** yo: the Yo! Payments XML API (default). livepay: the LivePay REST API. LivePay has no test mode, so it is always live. */
  provider: "yo" | "livepay";
  livepay: LivePayConfig;
}

function paymentsConfig(env: EnvLike, appEnv: string): PaymentsConfig {
  const provider = (env.PAYMENT_PROVIDER ?? "yo").trim() || "yo";
  if (provider !== "yo" && provider !== "livepay") throw new Error("PAYMENT_PROVIDER must be yo or livepay");
  const rawUrl = (env.LIVEPAY_BASE_URL ?? "https://livepay.me/api").trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("LIVEPAY_BASE_URL must be an absolute URL");
  }
  if (parsed.protocol !== "https:" && !LOCAL_ONLY_ENVIRONMENTS.has(appEnv)) throw new Error("LIVEPAY_BASE_URL must use HTTPS");
  // The inbound webhook is a different URL from the upstream API root. It defaults to this
  // deployment's own origin so no environment can accidentally sign against another host.
  const origin = (env.APP_ORIGIN ?? "http://localhost:5173").trim().replace(/\/+$/, "");
  const rawWebhookUrl = (env.LIVEPAY_WEBHOOK_URL ?? `${origin}/api/v1/public/payments/livepay/webhook`).trim();
  let webhook: URL;
  try {
    webhook = new URL(rawWebhookUrl);
  } catch {
    throw new Error("LIVEPAY_WEBHOOK_URL must be an absolute URL");
  }
  if (webhook.protocol !== "https:" && !LOCAL_ONLY_ENVIRONMENTS.has(appEnv)) throw new Error("LIVEPAY_WEBHOOK_URL must use HTTPS");
  return {
    provider,
    livepay: {
      apiKey: (env.LIVEPAY_API_KEY ?? "").trim() || null,
      accountNumber: (env.LIVEPAY_ACCOUNT_NUMBER ?? "").trim() || null,
      baseUrl: rawUrl,
      webhookUrl: webhook.toString(),
      webhookSecret: (env.LIVEPAY_WEBHOOK_SECRET ?? "").trim() || null,
      timeoutMs: Math.max(1_000, Math.min(integer(env.LIVEPAY_TIMEOUT_MS, 20_000), 120_000)),
    },
  };
}
/**
 * ERPNext/Frappe HRMS integration (Stage 4). Server-side only. `off` means nothing was requested;
 * `live` talks to a real ERPNext site (local deployment in dev, licensed instance in hosting).
 * There is deliberately no `sandbox`: the only supported targets are a real ERPNext API.
 * Credentials are read from env at boot and are never logged, exported, or returned to clients.
 */
export interface ErpnextConfig {
  /** ERPNext site root, without trailing slash, e.g. http://127.0.0.1:8069. */
  baseUrl: string | null;
  /** Frappe API token pair of the dedicated service account ("key:secret"). */
  apiKey: string | null;
  apiSecret: string | null;
  timeoutMs: number;
  /** ERPNext Company record this Medveris tenant maps to (set after mapping is approved). */
  company: string | null;
}

export interface DicomwebConfig {

  /** DICOMweb service root (QIDO-RS and WADO-RS), without a trailing slash. */
  baseUrl: string | null;
  auth: "none" | "basic" | "bearer";
  username: string | null;
  password: string | null;
  bearerToken: string | null;
  timeoutMs: number;
  /** Largest rendered image relayed to a browser. */
  maxImageBytes: number;
  /** A successful conformance run older than this no longer makes the PACS available. */
  verificationMaxAgeDays: number;
}

export interface EhmisConfig {
  /** FEATURE_EHMIS: the operator asks for live DHIS2 submission in this deployment. */
  requested: boolean;
  /**
   * Reference to the Ministry of Health authorization or certification under which this deployment may
   * submit to eHMIS/DHIS2, as recorded by the operator. Without it, live submission is refused.
   */
  deploymentAuthorizationReference: string | null;
  /** Server-side key that encrypts per-facility DHIS2 credentials at rest. */
  credentialsKey: string | null;
  /** Hosts a facility may point its DHIS2 base URL at; empty refuses live connections outside development and tests. */
  allowedHosts: string[];
  timeoutMs: number;
}

export interface YoConfig {
  /** disabled: no request is sent; mock: the local mock gateway (sandbox, refused in production); sandbox: Yo! test system; production: live collections. */
  mode: "disabled" | "sandbox" | "mock" | "production";
  /** Yo! Payments API endpoint (task.php). Defaults to the documented endpoint for the mode. */
  apiUrl: string | null;
  /** Secondary production endpoint, used only for idempotent status checks. */
  backupApiUrl: string | null;
  username: string | null;
  password: string | null;
  /** Yo! public certificate (or its public key) in PEM, used to verify payment notifications. */
  publicKeyPem: string | null;
  /** Public origin Yo! posts notifications to. */
  notificationBaseUrl: string;
  timeoutMs: number;
}

/** Documented Yo! Payments API endpoints (Yo! Payments API specification and the YoPaymentsPHP library). */
export const YO_ENDPOINTS = Object.freeze({
  sandbox: "https://sandbox.yo.co.ug/services/yopaymentsdev/task.php",
  production: "https://paymentsapi1.yo.co.ug/ybs/task.php",
  productionBackup: "https://paymentsapi2.yo.co.ug/ybs/task.php",
});

function yoConfig(env: EnvLike, appEnv: string, origin: string): YoConfig {
  const raw = (env.YO_MODE ?? "disabled").trim() || "disabled";
  if (raw !== "disabled" && raw !== "sandbox" && raw !== "mock" && raw !== "production") throw new Error("YO_MODE must be disabled, sandbox, mock or production");
  if ((raw === "sandbox" || raw === "mock") && appEnv === "production") throw new Error(`YO_MODE=${raw} is not allowed in production; use production or disabled`);
  const https = (name: string, value: string | undefined): string | null => {
    const trimmed = (value ?? "").trim();
    if (!trimmed) return null;
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error(`${name} must be an absolute URL`);
    }
    // The mock gateway is a local process with no real credentials; it is refused in production.
    if (url.protocol !== "https:" && !LOCAL_ONLY_ENVIRONMENTS.has(appEnv) && raw !== "mock") throw new Error(`${name} must use HTTPS`);
    return trimmed.replace(/\/+$/, "");
  };
  const apiUrl = https("YO_API_URL", env.YO_API_URL) ?? (raw === "sandbox" ? YO_ENDPOINTS.sandbox : raw === "production" ? YO_ENDPOINTS.production : null);
  const backupApiUrl = https("YO_BACKUP_API_URL", env.YO_BACKUP_API_URL) ?? (raw === "production" && !env.YO_API_URL ? YO_ENDPOINTS.productionBackup : null);
  const notificationBaseUrl = https("YO_NOTIFICATION_BASE_URL", env.YO_NOTIFICATION_BASE_URL) ?? origin;
  const pem = (env.YO_PUBLIC_KEY ?? "").replace(/\\n/g, "\n").trim();
  return {
    mode: raw,
    apiUrl,
    backupApiUrl,
    username: env.YO_API_USERNAME?.trim() || null,
    password: env.YO_API_PASSWORD || null,
    publicKeyPem: pem || null,
    notificationBaseUrl,
    timeoutMs: Math.max(5_000, Math.min(integer(env.YO_TIMEOUT_MS, 30_000), 120_000)),
  };
}

export interface RateLimitOverride {
  policy: string;
  /** Multiplies the policy limit; bounded to 0.1–10. */
  factor: number;
  expiresAt: string;
  reason: string;
}

type EnvLike = Record<string, string | undefined>;

function fraction(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function list(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

/**
 * Overrides are deployment configuration, so every change is in the Worker version history.
 * Expired or malformed entries are rejected at startup rather than silently ignored.
 */
export function parseRateLimitOverrides(raw: string | undefined, now = Date.now()): RateLimitOverride[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("RATE_LIMIT_OVERRIDES must be a JSON array");
  }
  if (!Array.isArray(parsed)) throw new Error("RATE_LIMIT_OVERRIDES must be a JSON array");
  return parsed.map((entry, index) => {
    const item = entry as Partial<RateLimitOverride>;
    const expires = Date.parse(String(item.expiresAt ?? ""));
    if (typeof item.policy !== "string" || !/^[a-z][a-z0-9.-]{1,60}$/.test(item.policy)) throw new Error(`RATE_LIMIT_OVERRIDES[${index}].policy is invalid`);
    if (typeof item.factor !== "number" || item.factor < 0.1 || item.factor > 10) throw new Error(`RATE_LIMIT_OVERRIDES[${index}].factor must be between 0.1 and 10`);
    if (!Number.isFinite(expires) || expires <= now) throw new Error(`RATE_LIMIT_OVERRIDES[${index}].expiresAt must be a future time`);
    if (expires - now > 7 * 86_400_000) throw new Error(`RATE_LIMIT_OVERRIDES[${index}] may last at most 7 days`);
    if (typeof item.reason !== "string" || item.reason.trim().length < 10) throw new Error(`RATE_LIMIT_OVERRIDES[${index}].reason must explain the override`);
    return { policy: item.policy, factor: item.factor, expiresAt: new Date(expires).toISOString(), reason: item.reason.trim() };
  });
}

function allowedOrigins(raw: string | undefined, origin: string, appEnv: string): string[] {
  const origins = new Set([origin]);
  for (const candidate of list(raw)) origins.add(validatedOrigin(candidate, appEnv));
  return [...origins];
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value == null || value === "") return fallback;
  return value === "true" || value === "1";
}

function integer(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const TEST_SESSION_SECRET = "test-session-secret-test-session-secret";
const TEST_AUDIT_SIGNING_KEY = "test-audit-signing-key-test-audit-signing-key";
const TEST_MFA_ENCRYPTION_KEY = "test-mfa-encryption-key-test-mfa-encryption-key";
const LOCAL_ONLY_ENVIRONMENTS = new Set(["development", "test"]);

const TERMINOLOGY_MODES = ["synthetic", "sandbox", "production", "local-reference", "unavailable"] as const;

function isTerminologyMode(value: string): value is AppConfig["terminologyMode"] {
  return (TERMINOLOGY_MODES as readonly string[]).includes(value);
}

function requireSecret(name: string, value: string): void {
  if (value.length < 24) throw new Error(`${name} must be at least 24 characters`);
  if (/replace-with|changeme|placeholder/i.test(value) || value.startsWith("test-")) {
    throw new Error(`${name} is a placeholder or test value; generate it with npm run secrets:local`);
  }
}

function validatedOrigin(raw: string, appEnv: string): string {
  if (/REPLACE_WITH/i.test(raw)) throw new Error("APP_ORIGIN still contains a placeholder");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("APP_ORIGIN must be an absolute URL");
  }
  if (url.origin !== raw.replace(/\/$/, "")) throw new Error("APP_ORIGIN must be an origin without a path, query or fragment");
  if (!LOCAL_ONLY_ENVIRONMENTS.has(appEnv) && url.protocol !== "https:") {
    throw new Error("APP_ORIGIN must use HTTPS outside local development and tests");
  }
  return url.origin;
}

export function loadConfig(env: EnvLike = process.env): AppConfig {
  const appEnv = env.APP_ENV ?? env.NODE_ENV ?? "development";
  refuseSandboxInProduction(env, appEnv);
  const sessionSecret = env.SESSION_SECRET ?? "";
  const auditSigningKey = env.AUDIT_SIGNING_KEY ?? "";
  const mfaEncryptionKey = env.MFA_ENCRYPTION_KEY ?? "";
  if (appEnv !== "test") {
    requireSecret("SESSION_SECRET", sessionSecret);
    requireSecret("AUDIT_SIGNING_KEY", auditSigningKey);
    requireSecret("MFA_ENCRYPTION_KEY", mfaEncryptionKey);
    if (new Set([sessionSecret, auditSigningKey, mfaEncryptionKey]).size !== 3) {
      throw new Error("SESSION_SECRET, AUDIT_SIGNING_KEY and MFA_ENCRYPTION_KEY must be different values");
    }
  }
  if (bool(env.DEV_SHOW_TOTP_SECRETS, false) && !LOCAL_ONLY_ENVIRONMENTS.has(appEnv)) {
    throw new Error("DEV_SHOW_TOTP_SECRETS must be false outside local development and tests");
  }
  if (env.EMAIL_ADAPTER === "resend" && !LOCAL_ONLY_ENVIRONMENTS.has(appEnv)) {
    if (!env.RESEND_API_KEY?.startsWith("re_")) throw new Error("EMAIL_ADAPTER=resend requires RESEND_API_KEY");
    const sender = /<?([^<>\s]+@([^<>\s]+))>?\s*$/.exec(env.EMAIL_FROM ?? "");
    if (!sender || sender[2]!.endsWith(".local")) throw new Error("EMAIL_ADAPTER=resend requires EMAIL_FROM on a verified sending domain");
  }
  const rawOrigin = env.APP_ORIGIN ?? (appEnv === "development" ? "http://localhost:5173" : "");
  if (!rawOrigin) throw new Error("APP_ORIGIN is required outside local development");
  const origin = validatedOrigin(rawOrigin, appEnv);
  const terminologyMode = env.TERMINOLOGY_MODE || "synthetic";
  if (!isTerminologyMode(terminologyMode)) throw new Error("TERMINOLOGY_MODE must be synthetic, production, local-reference or unavailable (sandbox is allowed outside production)");
  if (terminologyMode === "synthetic" && appEnv === "production") {
    throw new Error("TERMINOLOGY_MODE=synthetic is not allowed in production; use production or unavailable");
  }
  const terminologyProviderUrl = env.TERMINOLOGY_PROVIDER_URL || null;
  if (terminologyMode === "production" && !terminologyProviderUrl) {
    throw new Error("TERMINOLOGY_MODE=production requires TERMINOLOGY_PROVIDER_URL");
  }
  if (terminologyMode === "sandbox" && !terminologyProviderUrl) {
    throw new Error("TERMINOLOGY_MODE=sandbox requires TERMINOLOGY_PROVIDER_URL (the local HAPI FHIR sandbox server)");
  }
  const mapProviderState = (env.MAP_TILE_PROVIDER ?? "osm") === "osm"
    ? "osm"
    : (env.MAP_TILE_PROVIDER ?? "osm") === "configured" ? "configured" : "disabled";
  const defaultTileUrl = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const defaultAttribution = "&copy; OpenStreetMap contributors";
  const tileUrl = mapProviderState === "disabled"
    ? null
    : (env.MAP_TILE_URL || (mapProviderState === "osm" ? defaultTileUrl : null));
  if (tileUrl && !tileUrl.startsWith("https://")) {
    throw new Error("MAP_TILE_URL must use HTTPS");
  }
  if (mapProviderState !== "disabled" && !tileUrl) {
    throw new Error("MAP_TILE_URL is required when the map tile provider is enabled");
  }
  const shardTopology = parseShardTopology(env.SHARD_TOPOLOGY);
  const realtimeEventTypes = list(env.REALTIME_EVENT_TYPES ?? DEFAULT_REALTIME_EVENT_TYPES.join(","));
  for (const type of realtimeEventTypes) {
    if (!/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/.test(type)) throw new Error(`REALTIME_EVENT_TYPES contains an invalid event type ${type}`);
  }
  const minZoom = Math.max(0, Math.min(integer(env.MAP_MIN_ZOOM, 3), 22));
  const maxZoom = Math.max(minZoom, Math.min(integer(env.MAP_MAX_ZOOM, 19), 22));
  const maxGrantHours = Math.max(1, Math.min(integer(env.PLATFORM_ROLE_MAX_GRANT_HOURS, 168), 24 * 30));
  const defaultGrantHours = Math.max(1, Math.min(integer(env.PLATFORM_ROLE_DEFAULT_GRANT_HOURS, 24), maxGrantHours));
  const legacyElevateEnvironments = list(env.PLATFORM_ROLE_LEGACY_ELEVATE_ENVIRONMENTS).map((value) => value.toLowerCase());
  if (legacyElevateEnvironments.includes("production")) {
    throw new Error("PLATFORM_ROLE_LEGACY_ELEVATE_ENVIRONMENTS must never include production");
  }
  const payments = paymentsConfig(env, appEnv);
  return {
    appEnv,
    origin,
    platformRoles: {
      defaultGrantHours,
      maxGrantHours,
      recentMfaSeconds: Math.max(30, integer(env.PLATFORM_ROLE_RECENT_MFA_SECONDS, 300)),
      minActiveOperators: Math.max(1, integer(env.PLATFORM_ROLE_MIN_ACTIVE_OPERATORS, 2)),
      legacyElevateEnvironments,
    },
    sessionSecret: sessionSecret || TEST_SESSION_SECRET,
    sessionTtlMinutes: integer(env.SESSION_TTL_MINUTES, 480),
    auditSigningKey: auditSigningKey || TEST_AUDIT_SIGNING_KEY,
    auditSigningKeyId: env.AUDIT_SIGNING_KEY_ID ?? "local-dev-key-1",
    mfaEncryptionKey: mfaEncryptionKey || TEST_MFA_ENCRYPTION_KEY,
    csrfHeader: (env.CSRF_HEADER ?? "x-medveris-csrf").toLowerCase(),
    emailAdapter: (env.EMAIL_ADAPTER ?? "local") === "resend" ? "resend" : "local",
    emailFrom: env.EMAIL_FROM ?? "Medveris <no-reply@medveris.local>",
    mailSinkDir: env.MAIL_SINK_DIR ?? ".mail-sink",
    resendApiKey: env.RESEND_API_KEY || null,
    operatorAlertEmail: env.OPERATOR_ALERT_EMAIL?.trim() || null,
    storageAdapter: (env.STORAGE_ADAPTER ?? "local") === "r2" ? "r2" : "local",
    localUploadDir: env.LOCAL_UPLOAD_DIR ?? ".data/uploads",
    maxUploadBytes: integer(env.MAX_UPLOAD_BYTES, 5 * 1024 * 1024),
    terminologyMode,
    terminologyProviderUrl,
    terminologyProviderToken: env.TERMINOLOGY_PROVIDER_TOKEN || null,
    terminologyTimeoutMs: integer(env.TERMINOLOGY_TIMEOUT_MS, 5000),
    snomedEditionUri: env.SNOMED_EDITION_URI || null,
    loincRelease: env.LOINC_RELEASE || null,
    fhirExternalWritesEnabled: bool(env.FHIR_EXTERNAL_WRITES_ENABLED, false),
    fhirBulkExportEnabled: bool(env.FHIR_BULK_EXPORT_ENABLED, false),
    emergencyOverrideMinutes: integer(env.EMERGENCY_OVERRIDE_MINUTES, 60),
    radiologyCriticalAckMinutes: Math.max(5, Math.min(integer(env.RADIOLOGY_CRITICAL_ACK_MINUTES, 60), 1440)),
    emergencyReviewDueHours: integer(env.EMERGENCY_REVIEW_DUE_HOURS, 24),
    devShowTotpSecrets: bool(env.DEV_SHOW_TOTP_SECRETS, false),
    contentFeedsEnabled: bool(env.CONTENT_FEEDS_ENABLED, false),
    map: {
      renderer: "leaflet",
      providerState: mapProviderState,
      tileUrl,
      attribution: env.MAP_ATTRIBUTION || defaultAttribution,
      minZoom,
      maxZoom,
      geolocationEnabled: bool(env.MAP_GEOLOCATION_ENABLED, true),
      geocodingEnabled: false,
      routingEnabled: false,
    },
    directory: {
      defaultCountry: env.DIRECTORY_DEFAULT_COUNTRY ?? "Uganda",
      maxRadiusKm: Math.max(1, Math.min(integer(env.DIRECTORY_MAX_RADIUS_KM, 500), 2000)),
      maxResults: Math.max(1, Math.min(integer(env.DIRECTORY_MAX_RESULTS, 100), 500)),
      sponsoredListingsEnabled: bool(env.DIRECTORY_SPONSORED_LISTINGS, true),
    },
    promotions: {
      paymentProvider: env.PROMOTION_PAYMENT_PROVIDER || null,
      webhookSecret: env.PROMOTION_WEBHOOK_SECRET || null,
    },
    integrations: {
      tokenTtlMinutes: Math.max(1, Math.min(integer(env.INTEGRATION_TOKEN_TTL_MINUTES, 15), 60)),
    },
    features: {
      dicomweb: bool(env.FEATURE_DICOMWEB, false),
      erpnext: bool(env.FEATURE_ERPNEXT, false),
      lab: bool(env.FEATURE_LAB, false),
      pharmacy: bool(env.FEATURE_PHARMACY, false),
      telemedicine: bool(env.FEATURE_TELEMEDICINE, false),
      devices: bool(env.FEATURE_DEVICES, false),
      ai: bool(env.FEATURE_AI, false),
      payments: bool(env.FEATURE_PAYMENTS, false),
      publicHealth: bool(env.FEATURE_PUBLIC_HEALTH, false),
      ledgerAnchoring: bool(env.FEATURE_LEDGER_ANCHORING, false),
      ehmis: bool(env.FEATURE_EHMIS, false),
      nhfr: bool(env.FEATURE_NHFR, false),
    },
    modes: {
      dicomweb: modeVar(env, "DICOMWEB_MODE"),
      erpnext: erpnextMode(env.ERPNEXT_MODE),
      lab: modeVar(env, "LAB_MODE"),
      pharmacy: modeVar(env, "PHARMACY_MODE"),
      telemedicine: modeVar(env, "TELEMEDICINE_MODE"),
      devices: modeVar(env, "DEVICES_MODE"),
      ai: modeVar(env, "AI_MODE"),
      payments: payments.provider === "livepay" ? "live" : yoIntegrationMode((env.YO_MODE ?? "disabled").trim() || "disabled"),
      publicHealth: "live",
      ehmis: "live",
      nhfr: "live",
      ledgerAnchoring: modeVar(env, "LEDGER_ANCHOR_MODE"),
    },
    uploadScan: uploadScanConfig(env, appEnv),
    ollama: ollamaConfig(env, appEnv),
    telemedicine: telemedicineConfig(env, appEnv),
    lab: simulatorGatewayConfig(env, "LAB"),
    pharmacy: simulatorGatewayConfig(env, "PHARMACY"),
    devices: simulatorGatewayConfig(env, "DEVICES"),
    ledgerAnchor: ledgerAnchorConfig(env),
    payments,
    ai: aiConfig(env, appEnv),
    aiModel: {
      provider: "workers-ai",
      model: (env.AI_MODEL ?? "").replace(/\/+$/, "").trim() || "workers-ai/llama-2-7b-chat-fp16",
      inputTokensMax: Math.max(64, integer(env.AI_INPUT_TOKENS_MAX, 4096)),
      timeoutMs: Math.max(1_000, Math.min(integer(env.AI_TIMEOUT_MS, 30_000), 300_000)),
    },
    ehmis: {
      requested: bool(env.FEATURE_EHMIS, false),
      deploymentAuthorizationReference: (env.EHMIS_DEPLOYMENT_AUTHORIZATION_REF ?? "").trim() || null,
      credentialsKey: env.EHMIS_CREDENTIALS_KEY && env.EHMIS_CREDENTIALS_KEY.length >= 32 ? env.EHMIS_CREDENTIALS_KEY : null,
      allowedHosts: (env.EHMIS_ALLOWED_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean),
      timeoutMs: Math.max(1_000, Math.min(integer(env.EHMIS_TIMEOUT_MS, 20_000), 60_000)),
    },
    yo: yoConfig(env, appEnv, origin),
    billing: {
      enforcement: env.BILLING_ENFORCEMENT === "off" || env.BILLING_ENFORCEMENT === "enforce" ? env.BILLING_ENFORCEMENT : "notify",
      usageMetering: bool(env.USAGE_METERING, true),
    },
    subscription: {
      productDescription: (env.SUBSCRIPTION_PRODUCT_DESCRIPTION ?? "").trim() || "Medveris workspace access for all modules enabled in the workspace",
      minUgx: Math.max(0, integer(env.SUBSCRIPTION_MIN_UGX, 500)),
      fxFallbackUsdUgx: (() => {
        const raw = (env.SUBSCRIPTION_FX_USD_UGX ?? "").trim();
        if (!raw) return null;
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0) throw new Error("SUBSCRIPTION_FX_USD_UGX must be a positive number when set");
        return value;
      })(),
      fxMaxAgeMinutes: Math.max(1, Math.min(integer(env.SUBSCRIPTION_FX_MAX_AGE_MINUTES, 1440), 10_080)),
    },
    fx: {
      provider: env.FX_PROVIDER === "openexchangerates" ? "openexchangerates" : "none",
      apiKey: env.FX_API_KEY?.trim() || null,
      lockMinutes: Math.max(1, Math.min(integer(env.FX_LOCK_MINUTES, 15), 60)),
      timeoutMs: Math.max(1_000, Math.min(integer(env.FX_TIMEOUT_MS, 8_000), 30_000)),
    },
    erpnext: {
      baseUrl: (env.ERPNEXT_BASE_URL ?? "").trim().replace(/\/+$/, "") || null,
      apiKey: env.ERPNEXT_API_KEY?.trim() || null,
      apiSecret: env.ERPNEXT_API_SECRET || null,
      timeoutMs: Math.max(1_000, Math.min(integer(env.ERPNEXT_TIMEOUT_MS, 10_000), 30_000)),
      company: env.ERPNEXT_COMPANY?.trim() || null,
    },
    dicomweb: {
      baseUrl: (env.DICOMWEB_BASE_URL ?? "").trim().replace(/\/+$/, "") || null,
      auth: env.DICOMWEB_AUTH === "basic" || env.DICOMWEB_AUTH === "bearer" ? env.DICOMWEB_AUTH : "none",
      username: env.DICOMWEB_USERNAME || null,
      password: env.DICOMWEB_PASSWORD || null,
      bearerToken: env.DICOMWEB_BEARER_TOKEN || null,
      timeoutMs: Math.max(1_000, Math.min(integer(env.DICOMWEB_TIMEOUT_MS, 15_000), 60_000)),
      maxImageBytes: Math.max(256 * 1024, Math.min(integer(env.DICOMWEB_MAX_IMAGE_BYTES, 20 * 1024 * 1024), 64 * 1024 * 1024)),
      verificationMaxAgeDays: Math.max(1, Math.min(integer(env.DICOMWEB_VERIFICATION_MAX_AGE_DAYS, 30), 365)),
    },
    database: {
      replicaEnabled: bool(env.DB_REPLICA_ENABLED, false),
      replicaMaxLagMs: Math.max(100, Math.min(integer(env.DB_REPLICA_MAX_LAG_MS, 5_000), 60_000)),
      readYourWritesMs: Math.max(1_000, Math.min(integer(env.DB_READ_YOUR_WRITES_MS, 15_000), 300_000)),
      replicaHealthTtlMs: Math.max(1_000, Math.min(integer(env.DB_REPLICA_HEALTH_TTL_MS, 5_000), 60_000)),
      replicaHealthTimeoutMs: Math.max(100, Math.min(integer(env.DB_REPLICA_HEALTH_TIMEOUT_MS, 1_000), 5_000)),
    },
    shardTopology,
    cache: {
      keyEpoch: /^[A-Za-z0-9._-]{1,32}$/.test(env.CACHE_KEY_EPOCH ?? "") ? env.CACHE_KEY_EPOCH! : "1",
    },
    observability: {
      requestLogSampleRate: fraction(env.REQUEST_LOG_SAMPLE_RATE, appEnv === "production" ? 0.1 : 1),
    },
    cloudflare: {
      enabled: bool(env.CLOUDFLARE_OBSERVABILITY_ENABLED, false),
      apiToken: env.CLOUDFLARE_API_TOKEN?.trim() || null,
      accountId: (env.CLOUDFLARE_ACCOUNT_ID ?? "").trim() || null,
      timeoutMs: Math.max(1_000, Math.min(integer(env.CLOUDFLARE_TIMEOUT_MS, 10_000), 30_000)),
      cacheTtlMs: Math.max(60_000, Math.min(integer(env.CLOUDFLARE_CACHE_TTL_MS, 60_000), 300_000)),
    },
    realtime: {
      enabled: bool(env.REALTIME_ENABLED, false),
      allowedOrigins: allowedOrigins(env.REALTIME_ALLOWED_ORIGINS, origin, appEnv),
      eventTypes: realtimeEventTypes,
      ticketTtlSeconds: Math.max(10, Math.min(integer(env.REALTIME_TICKET_TTL_SECONDS, 30), 120)),
      maxConnectionSeconds: Math.max(60, Math.min(integer(env.REALTIME_MAX_CONNECTION_SECONDS, 900), 3600)),
    },
    rateLimit: {
      overrides: parseRateLimitOverrides(env.RATE_LIMIT_OVERRIDES),
      // Only the Node server behind a proxy the operator controls may trust X-Forwarded-For.
      trustForwardedFor: LOCAL_ONLY_ENVIRONMENTS.has(appEnv) || bool(env.TRUST_FORWARDED_FOR, false),
    },
    jobs: {
      relayBatchSize: Math.max(1, Math.min(integer(env.JOBS_RELAY_BATCH_SIZE, 100), 500)),
      perTenantBatchLimit: Math.max(1, Math.min(integer(env.JOBS_PER_TENANT_BATCH_LIMIT, 25), 500)),
    },
  };
}

/** Non-clinical notifications only; clinical workflow events are added per deployment after approval. */
export const DEFAULT_REALTIME_EVENT_TYPES = ["content.published", "job.progress"] as const;

export function publicConfig(config: AppConfig) {
  return {
    appEnv: config.appEnv,
    terminologyMode: config.terminologyMode,
    features: config.features,
    fhir: {
      externalWritesEnabled: config.fhirExternalWritesEnabled,
      bulkExportEnabled: config.fhirBulkExportEnabled,
    },
    map: {
      renderer: config.map.renderer,
      providerState: config.map.providerState,
      tileUrl: config.map.tileUrl,
      attribution: config.map.attribution,
      minZoom: config.map.minZoom,
      maxZoom: config.map.maxZoom,
      geolocationEnabled: config.map.geolocationEnabled,
      geocodingEnabled: config.map.geocodingEnabled,
      routingEnabled: config.map.routingEnabled,
    },
    directory: config.directory,
    integrations: {
      oauthProfiles: ["oauth2-client-credentials", "smart-backend-services"],
      geocodingEnabled: false,
      routingEnabled: false,
    },
  };
}
