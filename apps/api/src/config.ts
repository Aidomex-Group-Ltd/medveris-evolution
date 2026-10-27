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
  terminologyMode: "synthetic" | "production";
  terminologyProviderUrl: string | null;
  terminologyProviderToken: string | null;
  terminologyTimeoutMs: number;
  snomedEditionUri: string | null;
  loincRelease: string | null;
  fhirExternalWritesEnabled: boolean;
  fhirBulkExportEnabled: boolean;
  emergencyOverrideMinutes: number;
  emergencyReviewDueHours: number;
  devShowTotpSecrets: boolean;
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

export function loadConfig(env: EnvLike = process.env): AppConfig {
  const appEnv = env.APP_ENV ?? env.NODE_ENV ?? "development";
  const sessionSecret = env.SESSION_SECRET ?? "";
  const auditSigningKey = env.AUDIT_SIGNING_KEY ?? "";
  const mfaEncryptionKey = env.MFA_ENCRYPTION_KEY ?? "";
  if (appEnv !== "test") {
    if (sessionSecret.length < 24) throw new Error("SESSION_SECRET must be at least 24 characters");
    if (auditSigningKey.length < 24) throw new Error("AUDIT_SIGNING_KEY must be at least 24 characters");
    if (mfaEncryptionKey.length < 24) throw new Error("MFA_ENCRYPTION_KEY must be at least 24 characters");
  }
  const origin = env.APP_ORIGIN ?? (appEnv === "development" ? "http://localhost:5173" : "");
  if (!origin) throw new Error("APP_ORIGIN is required outside local development");
  const terminologyMode = (env.TERMINOLOGY_MODE ?? "synthetic") === "production" ? "production" : "synthetic";
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
    sessionSecret: sessionSecret || "test-session-secret-test-session-secret",
    sessionTtlMinutes: integer(env.SESSION_TTL_MINUTES, 480),
    auditSigningKey: auditSigningKey || "test-audit-signing-key-test-audit-signing-key",
    auditSigningKeyId: env.AUDIT_SIGNING_KEY_ID ?? "local-dev-key-1",
    mfaEncryptionKey: mfaEncryptionKey || "test-mfa-encryption-key-test-mfa-encryption-key",
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
    emergencyReviewDueHours: integer(env.EMERGENCY_REVIEW_DUE_HOURS, 24),
    devShowTotpSecrets: bool(env.DEV_SHOW_TOTP_SECRETS, false),
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
