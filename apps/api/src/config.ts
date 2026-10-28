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
  storageAdapter: "local" | "r2";
  localUploadDir: string;
  maxUploadBytes: number;
  terminologyMode: "synthetic" | "production" | "unavailable";
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
}

type EnvLike = Record<string, string | undefined>;

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

const TERMINOLOGY_MODES = ["synthetic", "production", "unavailable"] as const;

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
  if (!isTerminologyMode(terminologyMode)) throw new Error("TERMINOLOGY_MODE must be synthetic, production or unavailable");
  if (terminologyMode === "synthetic" && appEnv === "production") {
    throw new Error("TERMINOLOGY_MODE=synthetic is not allowed in production; use production or unavailable");
  }
  const terminologyProviderUrl = env.TERMINOLOGY_PROVIDER_URL || null;
  if (terminologyMode === "production" && !terminologyProviderUrl) {
    throw new Error("TERMINOLOGY_MODE=production requires TERMINOLOGY_PROVIDER_URL");
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
  const minZoom = Math.max(0, Math.min(integer(env.MAP_MIN_ZOOM, 3), 22));
  const maxZoom = Math.max(minZoom, Math.min(integer(env.MAP_MAX_ZOOM, 19), 22));
  return {
    appEnv,
    origin,
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
      lab: bool(env.FEATURE_LAB, false),
      pharmacy: bool(env.FEATURE_PHARMACY, false),
      telemedicine: bool(env.FEATURE_TELEMEDICINE, false),
      devices: bool(env.FEATURE_DEVICES, false),
      ai: bool(env.FEATURE_AI, false),
      payments: bool(env.FEATURE_PAYMENTS, false),
      publicHealth: bool(env.FEATURE_PUBLIC_HEALTH, false),
      ledgerAnchoring: bool(env.FEATURE_LEDGER_ANCHORING, false),
    },
  };
}

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
