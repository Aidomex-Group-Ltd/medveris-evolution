import type { AppConfig, IntegrationMode } from "../config.js";
import { AppError } from "../lib/errors.js";
import { dicomwebConfigProblems } from "./dicomweb.js";
import { paymentsConfigProblems } from "./livepay.js";

export type { IntegrationMode };

export type IntegrationState =
  | "available"
  | "sandbox"
  | "degraded"
  | "unavailable"
  | "disabled"
  | "not_requested"
  | "misconfigured"
  | "verification_failed";

export type IntegrationId = "dicomweb" | "lab" | "pharmacy" | "telemedicine" | "devices" | "ai" | "payments" | "publicHealth" | "ehmis" | "nhfr" | "ledgerAnchoring";

interface IntegrationDefinition {
  id: IntegrationId;
  name: string;
  /** Environment flag that requests the integration. A request alone never makes it available. */
  flag: string;
  baseline: "unavailable" | "not_requested";
  baselineReason: string;
  requiredConfiguration: string[];
  prerequisites: string[];
  capabilities: string[];
  effectWhileUnavailable: string;
  remediation: string;
  /** Present for implemented adapters: what keeps the configured connection from being usable. */
  configurationProblems?: (config: AppConfig) => string[];
  /**
   * The adapter is enabled per deployment but each facility proves its own eligibility, mapping and
   * connection; `available` here never means that any facility is connected.
   */
  facilityScoped?: boolean;
  /** Implemented adapter that is usable once requested and fully configured; each transaction is reconciled with the provider. */
  availableWhenConfigured?: boolean;
  /** Reason shown for a configured, available adapter; defaults to the payments wording. */
  availableReason?: (config: AppConfig) => string;
  /** Configuration problems specific to the sandbox adapter; empty means the simulated adapter is ready. */
  sandboxConfigurationProblems?: (config: AppConfig) => string[];
}

/** Latest conformance run for the configured endpoint, as stored in integration_verifications. */
export interface VerificationRecord {
  outcome: "passed" | "failed";
  finishedAt: string;
  /** First failed check, when the run failed. */
  failure: string | null;
  /** Mode the endpoint was in when the run executed. A sandbox run never makes an integration live-available. */
  mode: IntegrationMode;
}

export type VerificationLookup = Partial<Record<IntegrationId, VerificationRecord | null>>;

export interface IntegrationStatus {
  id: IntegrationId;
  name: string;
  state: IntegrationState;
  /** off | sandbox | live for this deployment. Sandbox is never reported as available. */
  mode: IntegrationMode;
  /** Plain-language, UI-ready description of the mode, prefixed with SANDBOX / LIVE / UNAVAILABLE. */
  modeLabel: string;
  reason: string;
  requested: boolean;
  enabledForEnvironment: boolean;
  adapterImplemented: boolean;
  requiredConfiguration: string[];
  missingPrerequisites: string[];
  lastSuccessfulVerificationAt: string | null;
  lastVerificationOutcome: "never-verified" | "passed" | "failed" | "expired";
  capabilities: Array<{ capability: string; status: IntegrationState }>;
  effectWhileUnavailable: string;
  remediation: string;
}

/**
 * Integrations whose live connection is implemented in this release, plus the conformance-run store
 * they share. Each one reports `available` only when it is requested, fully configured and (where a
 * conformance run is required) has a passing, unexpired run against the configured endpoint.
 */
export const IMPLEMENTED_ADAPTERS: ReadonlySet<IntegrationId> = new Set<IntegrationId>(["dicomweb", "payments", "telemedicine", "ledgerAnchoring", "ai"]);

/** Integrations with a sandbox adapter. Sandbox state is reachable only through these, and never in production. */
export const SANDBOX_ADAPTERS: ReadonlySet<IntegrationId> = new Set<IntegrationId>([
  "dicomweb", "payments", "telemedicine", "ai", "lab", "pharmacy", "devices", "ledgerAnchoring",
]);

/** Integrations that need a passing, unexpired conformance run before they report available. */
export const VERIFICATION_REQUIRED: ReadonlySet<IntegrationId> = new Set<IntegrationId>(["dicomweb", "ai"]);

export const INTEGRATIONS: readonly IntegrationDefinition[] = Object.freeze([
  {
    id: "dicomweb",
    name: "DICOMweb / PACS",
    flag: "FEATURE_DICOMWEB",
    baseline: "unavailable",
    baselineReason: "No PACS is enabled for this environment (FEATURE_DICOMWEB is not set)",
    requiredConfiguration: ["DICOMWEB_BASE_URL (HTTPS)", "DICOMWEB_AUTH with DICOMWEB_USERNAME/DICOMWEB_PASSWORD or DICOMWEB_BEARER_TOKEN", "network access from the Worker to the PACS"],
    prerequisites: ["passing QIDO-RS/WADO-RS conformance run against the configured PACS", "authorization review"],
    capabilities: ["study search", "image retrieval"],
    effectWhileUnavailable: "Studies hold metadata only; no PACS study is searched, linked, retrieved or displayed.",
    remediation: "Configure the PACS DICOMweb URL and credentials, set FEATURE_DICOMWEB=true, then run the conformance verification as a platform operator.",
    configurationProblems: dicomwebConfigProblems,
  },
  {
    id: "lab",
    name: "Laboratory (LIS / analyzer)",
    flag: "FEATURE_LAB",
    baseline: "unavailable",
    baselineReason: "No LIS or analyzer interface is configured",
    requiredConfiguration: ["LIS/analyzer endpoint", "message specification", "test and unit mappings"],
    prerequisites: ["laboratory adapter implementation", "order/result exchange tests including duplicates, invalid messages and corrections"],
    capabilities: ["electronic order transmission", "analyzer result import"],
    effectWhileUnavailable: "Internal laboratory orders, specimens and manually entered results work; nothing is sent to or received from an external LIS or analyzer.",
    remediation: "Agree the LIS interface specification, implement the adapter and pass exchange tests in a non-production environment.",
    sandboxConfigurationProblems: (config) => config.lab.gatewaySecret
      ? []
      : ["LAB_GATEWAY_SECRET is not set (32+ characters), so signed simulator messages cannot be verified"],
  },
  {
    id: "pharmacy",
    name: "Pharmacy (external prescribing / dispensing)",
    flag: "FEATURE_PHARMACY",
    baseline: "unavailable",
    baselineReason: "No external prescribing or dispensing system is configured",
    requiredConfiguration: ["external pharmacy endpoint", "catalogue mapping"],
    prerequisites: ["pharmacy adapter implementation", "clinically approved medication safety rules", "authorized non-production integration tests"],
    capabilities: ["external prescription transmission", "external dispensing confirmation"],
    effectWhileUnavailable: "Internal pharmacy records and stock movements work; no prescription is transmitted to, or confirmed by, an external system.",
    remediation: "Approve the external pharmacy interface and safety rules, implement the adapter and verify it in a non-production environment.",
    sandboxConfigurationProblems: (config) => config.pharmacy.gatewaySecret
      ? []
      : ["PHARMACY_GATEWAY_SECRET is not set (32+ characters), so signed simulator messages cannot be verified"],
  },
  {
    id: "telemedicine",
    name: "Telemedicine media",
    flag: "FEATURE_TELEMEDICINE",
    baseline: "unavailable",
    baselineReason: "No media provider, consent configuration or privacy review is in place",
    requiredConfiguration: ["media provider credentials", "room/token service"],
    prerequisites: ["media adapter implementation", "consent and privacy review", "tested connection lifecycle"],
    capabilities: ["video session", "media join link"],
    effectWhileUnavailable: "Telehealth session records, consent and outcomes can be recorded; joining a media session is blocked.",
    remediation: "Select and contract a media provider, implement the adapter and pass connection-lifecycle tests.",
    configurationProblems: (config) => config.telemedicine.baseUrl
      ? []
      : ["JITSI_BASE_URL is not set, so no Jitsi server hosts live telehealth rooms"],
    sandboxConfigurationProblems: () => [],
  },
  {
    id: "devices",
    name: "Device gateway",
    flag: "FEATURE_DEVICES",
    baseline: "unavailable",
    baselineReason: "No device gateway with verified device identity and provenance is configured",
    requiredConfiguration: ["device gateway endpoint", "device identity credentials"],
    prerequisites: ["gateway adapter implementation", "patient association, unit, timestamp and provenance checks"],
    capabilities: ["automated device observations"],
    effectWhileUnavailable: "Device registry and mappings can be maintained; no observation is stored as device-originated.",
    remediation: "Provide a supported device gateway, implement the adapter and verify provenance and unit handling.",
    sandboxConfigurationProblems: (config) => config.devices.gatewaySecret
      ? []
      : ["DEVICES_GATEWAY_SECRET is not set (32+ characters), so signed simulator messages cannot be verified"],
  },
  {
    id: "ai",
    name: "AI assistance",
    flag: "FEATURE_AI",
    baseline: "unavailable",
    baselineReason: "No validated model, intended-use statement or clinical evaluation is approved",
    requiredConfiguration: [
      "model provider credentials",
      "for the live Ollama path: AI_BASE_URL (HTTPS outside local development), AI_MODEL, and Ollama HTTP Basic Auth credentials (OLLAMA_USERNAME and OLLAMA_PASSWORD as Worker secrets)",
      "for the sandbox path: OLLAMA_URL and OLLAMA_MODEL (local development only; refused in production)",
    ],
    prerequisites: ["provider adapter implementation", "risk assessment and privacy review", "clinically approved evaluation", "human-oversight workflow", "verified connection to the configured model provider"],
    capabilities: ["clinical decision support jobs"],
    effectWhileUnavailable: "No AI job can be submitted and no clinical inference is produced.",
    remediation: "Complete the model validation, risk and privacy reviews, then configure and verify the provider adapter.",
    // The AI integration becomes available only after a passing verification run against the
    // configured live endpoint (like DICOMweb). A sandbox run makes it usable for development,
    // never live-available. Each job still records its own provider, model, status and output digest.
    availableReason: (config) => {
      if (config.ai.baseUrl) {
        return `Configured to use Ollama at ${new URL(config.ai.baseUrl).host}; model ${config.aiModel.model}; every output is decision support only and must be reviewed by a qualified clinician`;
      }
      return `Configured to use ${config.aiModel.model}; every output is decision support only and must be reviewed by a qualified clinician`;
    },
    configurationProblems: aiConfigProblems,
    sandboxConfigurationProblems: (config) => config.ollama.url
      ? []
      : ["OLLAMA_URL is not set, so the sandbox Ollama adapter has no model to call"],
  },
  {
    id: "payments",
    name: "Mobile money payments",
    flag: "FEATURE_PAYMENTS",
    baseline: "unavailable",
    baselineReason: "Mobile money is not enabled for this environment (FEATURE_PAYMENTS is not set)",
    requiredConfiguration: [
      "PAYMENT_PROVIDER (livepay is primary; yo stays disabled until its production access is verified)",
      "LivePay: LIVEPAY_API_KEY and LIVEPAY_WEBHOOK_SECRET (Worker secrets), LIVEPAY_ACCOUNT_NUMBER and LIVEPAY_WEBHOOK_URL",
      "Yo!: YO_MODE, YO_API_USERNAME and YO_API_PASSWORD (Worker secrets), YO_PUBLIC_KEY and YO_NOTIFICATION_BASE_URL",
    ],
    prerequisites: ["provider business account with collections enabled", "notification URL reachable from the provider"],
    capabilities: ["mobile money collection prompt", "signed payment notifications", "status reconciliation"],
    effectWhileUnavailable: "Bills and cash payments work; mobile money prompts cannot be sent and no payment is treated as provider-confirmed.",
    remediation: "Configure the selected provider in a non-production environment, verify collect/status/webhook behaviour with mocks or a genuinely non-transactional sandbox, then enable FEATURE_PAYMENTS.",
    configurationProblems: paymentsConfigProblems,
    availableWhenConfigured: true,
    availableReason: (config) => config.payments.provider === "livepay"
      ? "Configured for LivePay; every payment is confirmed by a transaction-status check before it is posted"
      : `Configured for ${config.yo.mode}; every payment is confirmed by a verified notification or a status check before it is posted`,
  },
  {
    id: "publicHealth",
    name: "Public health reporting",
    flag: "FEATURE_PUBLIC_HEALTH",
    baseline: "unavailable",
    baselineReason: "No approved receiving authority or interface specification is configured",
    requiredConfiguration: ["receiving authority endpoint", "submission credentials"],
    prerequisites: ["submission adapter implementation", "validated terminology mappings", "acknowledgement handling"],
    capabilities: ["external report submission"],
    effectWhileUnavailable: "Aggregate reports can be prepared and reviewed locally; nothing is submitted externally.",
    remediation: "Obtain the authority's interface specification and approval, implement the adapter and verify acknowledgements.",
  },
  {
    id: "ehmis",
    name: "eHMIS / DHIS2 aggregate reporting",
    flag: "FEATURE_EHMIS",
    baseline: "not_requested",
    baselineReason: "Live DHIS2 submission is not requested for this deployment (FEATURE_EHMIS is not set); facilities can still prepare, validate and export HMIS reports",
    requiredConfiguration: [
      "EHMIS_DEPLOYMENT_AUTHORIZATION_REF (Ministry of Health EMRS certification or written authorization for this deployment)",
      "EHMIS_CREDENTIALS_KEY (32+ characters, Worker secret)",
      "EHMIS_ALLOWED_HOSTS (DHIS2 hosts facilities may connect to)",
    ],
    prerequisites: ["Ministry of Health authorization for this deployment", "per-facility eligibility verified by a platform operator", "per-facility passing connection test"],
    capabilities: ["HMIS dataset submission (dataValueSets)", "dry-run validation", "connection test"],
    effectWhileUnavailable: "HMIS periods can be generated, validated, approved and exported for manual entry; nothing is sent to eHMIS/DHIS2.",
    remediation: "Obtain Ministry of Health authorization for the deployment, record its reference in EHMIS_DEPLOYMENT_AUTHORIZATION_REF, set the credential key and allowed hosts, then verify each facility.",
    configurationProblems: ehmisConfigProblems,
    facilityScoped: true,
  },
  {
    id: "nhfr",
    name: "National Health Facility Registry",
    flag: "FEATURE_NHFR",
    baseline: "unavailable",
    baselineReason: "No approved NHFR interface specification, endpoint or credentials are configured",
    requiredConfiguration: ["approved NHFR interface specification", "endpoint", "credentials"],
    prerequisites: ["NHFR adapter implementation", "Ministry of Health approval", "conformance testing"],
    capabilities: ["facility identity lookup", "facility record synchronisation"],
    effectWhileUnavailable: "NHFR IDs are entered manually and shown as recorded, not verified against the registry.",
    remediation: "Obtain the Ministry's NHFR interface specification and approval, implement and verify the adapter.",
  },
  {
    id: "ledgerAnchoring",
    name: "Ledger anchoring",
    flag: "FEATURE_LEDGER_ANCHORING",
    baseline: "not_requested",
    baselineReason: "External anchoring has not been requested; integrity checkpoints are local and unanchored",
    requiredConfiguration: ["anchoring service endpoint"],
    prerequisites: ["approved anchoring design and privacy assessment", "independent verification procedure"],
    capabilities: ["external checkpoint anchoring"],
    effectWhileUnavailable: "Audit checkpoints are signed locally and labelled unanchored; no external immutability is claimed.",
    remediation: "Obtain explicit approval for anchoring, define the committed data and verification procedure, then implement the adapter.",
    configurationProblems: () => [],
    sandboxConfigurationProblems: () => [],
  },
]);

function verificationAge(record: VerificationRecord): number {
  return Date.now() - Date.parse(record.finishedAt);
}

export function ehmisConfigProblems(config: AppConfig): string[] {
  const problems: string[] = [];
  if (!config.ehmis.deploymentAuthorizationReference) problems.push("EHMIS_DEPLOYMENT_AUTHORIZATION_REF is not set, so no Ministry of Health authorization is recorded for this deployment");
  if (!config.ehmis.credentialsKey) problems.push("EHMIS_CREDENTIALS_KEY is not set (32+ characters), so facility credentials cannot be stored");
  if (!config.ehmis.allowedHosts.length && !["development", "test"].includes(config.appEnv)) problems.push("EHMIS_ALLOWED_HOSTS is empty");
  return problems;
}

/** Configuration problems for the live Ollama AI provider path. The sandbox path has its own problems below the sandbox line. */
export function aiConfigProblems(config: AppConfig): string[] {
  const problems: string[] = [];
  if (!config.features.ai) return problems;
  const mode = config.modes.ai;
  if (mode === "sandbox") {
    // Sandbox problems are reported through sandboxConfigurationProblems, not here.
    return problems;
  }
  if (!config.ai.baseUrl) {
    problems.push("AI_BASE_URL is not set for the live AI provider");
    return problems;
  }
  if (config.appEnv === "production" && !config.ai.baseUrl.startsWith("https://")) {
    problems.push("AI_BASE_URL must use HTTPS in production");
  }
  if (!config.ai.ollamaUsername || !config.ai.ollamaPassword) {
    problems.push("OLLAMA_USERNAME and OLLAMA_PASSWORD are required for the live Ollama path; AI_TOKEN alone is not sufficient");
  }
  if (config.ai.token) {
    problems.push("AI_TOKEN is set but the live Ollama path uses Ollama HTTP Basic Auth (OLLAMA_USERNAME / OLLAMA_PASSWORD); remove AI_TOKEN or select a different AI_MODE/provider");
  }
  if (!config.aiModel.model) {
    problems.push("AI_MODEL is not set for the live AI provider");
  }
  return problems;
}

const OFF_LABEL = "UNAVAILABLE — not configured for this environment";

/** Environment variable that selects the mode for each integration, used in operator-facing text. */
const MODE_ENV_VARS: Partial<Record<IntegrationId, string>> = {
  dicomweb: "DICOMWEB_MODE", lab: "LAB_MODE", pharmacy: "PHARMACY_MODE", telemedicine: "TELEMEDICINE_MODE",
  devices: "DEVICES_MODE", ai: "AI_MODE", payments: "PAYMENT_PROVIDER", ledgerAnchoring: "LEDGER_ANCHOR_MODE",
};

function hostOf(url: string | null): string {
  if (!url) return "no endpoint configured";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Plain-language mode text for the UI. Every label starts with SANDBOX, LIVE or UNAVAILABLE so a
 * sandbox connection can never be read as a real one, whatever else the response contains.
 */
const MODE_LABELS: Readonly<Record<string, (config: AppConfig, mode: IntegrationMode) => string>> = {
  dicomweb: (config, mode) => mode === "sandbox"
    ? `SANDBOX — local Orthanc DICOMweb at ${hostOf(config.dicomweb.baseUrl)} seeded with public synthetic sample studies; simulated images only`
    : mode === "live" ? `LIVE — DICOMweb PACS at ${hostOf(config.dicomweb.baseUrl)}` : OFF_LABEL,
  payments: (config, mode) => mode === "sandbox"
    ? "SANDBOX — local mock Yo! gateway issuing synthetic prompts and signed test notifications; no real money moves and no revenue is recorded"
    : mode === "live"
      ? config.payments.provider === "livepay"
        ? "LIVE — real LivePay collections over the LivePay API; each transaction is confirmed by a transaction-status check before it is posted"
        : config.yo.mode === "sandbox"
          ? "LIVE — connected to the Yo! Payments provider sandbox, a real Yo! test endpoint; no real money moves"
          : "LIVE — real Yo! Payments collections, each confirmed by a verified notification or status check"
      : OFF_LABEL,
  ai: (config, mode) => mode === "sandbox"
    ? `SANDBOX — local Ollama model at ${config.ollama.url ?? "no OLLAMA_URL"}; synthetic prompts only and no patient data leaves the facility`
    : mode === "live" && config.ai.baseUrl
      ? `LIVE — Ollama model provider at ${new URL(config.ai.baseUrl).host}; decision support only, reviewed by a qualified clinician`
      : mode === "live"
        ? "LIVE — Cloudflare Workers AI binding; decision support only, reviewed by a qualified clinician"
        : OFF_LABEL,
  telemedicine: (config, mode) => mode === "sandbox"
    ? "SANDBOX — public meet.jit.si rooms with unguessable names; no contract, consent flow or privacy review covers this instance"
    : mode === "live" ? `LIVE — Jitsi server at ${hostOf(config.telemedicine.baseUrl)}` : OFF_LABEL,
  lab: (_config, mode) => mode === "sandbox"
    ? "SANDBOX — local simulator gateway producing synthetic HL7 v2 messages only; no external LIS is contacted"
    : OFF_LABEL,
  pharmacy: (_config, mode) => mode === "sandbox"
    ? "SANDBOX — local simulator gateway producing synthetic HL7 v2 messages only; no external pharmacy is contacted"
    : OFF_LABEL,
  devices: (_config, mode) => mode === "sandbox"
    ? "SANDBOX — local simulator gateway producing synthetic FHIR Observations only; no real device sends data"
    : OFF_LABEL,
  ledgerAnchoring: (_config, mode) => mode === "sandbox"
    ? "SANDBOX — local append-only anchor of integrity checkpoints; the checkpoint is not externally anchored"
    : mode === "live" ? "LIVE — OpenTimestamps anchoring of integrity checkpoints" : OFF_LABEL,
};

function modeLabelFor(config: AppConfig, definition: IntegrationDefinition, mode: IntegrationMode): string {
  const build = MODE_LABELS[definition.id];
  if (build) return build(config, mode);
  if (mode === "off") return OFF_LABEL;
  if (mode === "sandbox") return `SANDBOX — simulated local adapter for ${definition.name}; synthetic data only, never a real connection`;
  return `LIVE — real provider connection for ${definition.name}`;
}

/** The feature flag still gates everything: without it the mode is `off` no matter what the environment asks for. */
function resolveMode(config: AppConfig, definition: IntegrationDefinition): IntegrationMode {
  if (!config.features[definition.id]) return "off";
  return config.modes[definition.id] ?? "live";
}

function modeSwitchedOffReason(definition: IntegrationDefinition): string {
  const variable = MODE_ENV_VARS[definition.id] ?? `${definition.id.toUpperCase()}_MODE`;
  return `${variable}=off switches ${definition.name} off for this environment; nothing is sent to or received from an external system`;
}

function adapterImplementedFor(mode: IntegrationMode, id: IntegrationId): boolean {
  return mode === "sandbox" ? SANDBOX_ADAPTERS.has(id) : IMPLEMENTED_ADAPTERS.has(id);
}

function problemsFor(config: AppConfig, definition: IntegrationDefinition, mode: IntegrationMode): string[] {
  if (mode === "sandbox") return definition.sandboxConfigurationProblems?.(config) ?? definition.configurationProblems?.(config) ?? [];
  return definition.configurationProblems?.(config) ?? [];
}

function facilityScopedStatus(config: AppConfig, definition: IntegrationDefinition, mode: IntegrationMode, modeLabel: string): IntegrationStatus {
  const requested = Boolean(config.features[definition.id]);
  const problems = requested ? definition.configurationProblems?.(config) ?? [] : [];
  const state: IntegrationState = !requested ? definition.baseline : problems.length ? "misconfigured" : "available";
  const reason = !requested
    ? definition.baselineReason
    : problems.length
      ? problems.join("; ")
      : `Connector enabled for this deployment under the operator-recorded authorization "${config.ehmis.deploymentAuthorizationReference}". Each facility still needs verified eligibility and a passing connection test before it can submit.`;
  return {
    id: definition.id, name: definition.name, state, mode, modeLabel, reason, requested,
    enabledForEnvironment: state === "available",
    adapterImplemented: true,
    requiredConfiguration: definition.requiredConfiguration,
    missingPrerequisites: state === "available" ? ["per-facility eligibility verification", "per-facility connection test"] : [...definition.prerequisites],
    lastSuccessfulVerificationAt: null,
    lastVerificationOutcome: "never-verified",
    capabilities: definition.capabilities.map((capability) => ({ capability, status: state })),
    effectWhileUnavailable: definition.effectWhileUnavailable,
    remediation: definition.remediation,
  };
}

function configuredStatus(config: AppConfig, definition: IntegrationDefinition, mode: IntegrationMode, modeLabel: string): IntegrationStatus {
  const requested = Boolean(config.features[definition.id]);
  const problems = requested ? problemsFor(config, definition, mode) : [];
  const state: IntegrationState = !requested
    ? definition.baseline
    : problems.length
      ? "misconfigured"
      : mode === "off"
        ? "unavailable"
        : mode === "sandbox"
          ? "sandbox"
          : "available";
  const reason = !requested
    ? definition.baselineReason
    : problems.length
      ? problems.join("; ")
      : mode === "off"
        ? modeSwitchedOffReason(definition)
        : mode === "sandbox"
          ? `Sandbox adapter configured and usable for development. ${modeLabel}`
          : definition.availableReason?.(config)
            ?? `Configured for ${config.yo.mode}; every payment is confirmed by a verified notification or a status check before it is posted`;
  return {
    id: definition.id, name: definition.name, state, mode, modeLabel, reason, requested,
    enabledForEnvironment: state === "available",
    adapterImplemented: adapterImplementedFor(mode, definition.id),
    requiredConfiguration: definition.requiredConfiguration,
    missingPrerequisites: state === "available" ? [] : [...definition.prerequisites],
    lastSuccessfulVerificationAt: null,
    lastVerificationOutcome: "never-verified",
    capabilities: definition.capabilities.map((capability) => ({ capability, status: state })),
    effectWhileUnavailable: definition.effectWhileUnavailable,
    remediation: definition.remediation,
  };
}

function statusFor(config: AppConfig, definition: IntegrationDefinition, verification: VerificationRecord | null | undefined): IntegrationStatus {
  const mode = resolveMode(config, definition);
  const modeLabel = modeLabelFor(config, definition, mode);
  if (definition.facilityScoped) return facilityScopedStatus(config, definition, mode, modeLabel);
  if (definition.availableWhenConfigured) return configuredStatus(config, definition, mode, modeLabel);
  const requested = Boolean(config.features[definition.id]);
  const sandbox = mode === "sandbox";
  const adapterImplemented = adapterImplementedFor(mode, definition.id);
  const problems = requested ? problemsFor(config, definition, mode) : [];
  const needsVerification = VERIFICATION_REQUIRED.has(definition.id);
  let state: IntegrationState = definition.baseline;
  let reason = definition.baselineReason;
  let missingPrerequisites = IMPLEMENTED_ADAPTERS.has(definition.id) && needsVerification
    ? ["successful verification run"]
    : [...definition.prerequisites];
  let lastVerificationOutcome: IntegrationStatus["lastVerificationOutcome"] = "never-verified";
  let lastSuccessfulVerificationAt: string | null = null;
  if (requested && mode === "off") {
    if (problems.length) {
      state = "misconfigured";
      reason = problems.join("; ");
      missingPrerequisites = ["complete configuration"];
    } else {
      state = "unavailable";
      reason = modeSwitchedOffReason(definition);
      missingPrerequisites = [...definition.prerequisites];
    }
  } else if (requested && !adapterImplemented) {
    state = "misconfigured";
    reason = sandbox
      ? `${definition.flag} is set with the sandbox mode, but no sandbox adapter exists for ${definition.name} in this release; the flag is ignored`
      : `${definition.flag} is set, but no ${definition.name} adapter exists in this release; the flag is ignored`;
  } else if (requested && problems.length) {
    state = "misconfigured";
    reason = problems.join("; ");
    missingPrerequisites = ["complete configuration", "successful verification run"];
  } else if (requested && needsVerification) {
    const maxAgeMs = config.dicomweb.verificationMaxAgeDays * 86_400_000;
    if (!verification) {
      if (sandbox) {
        // A sandbox adapter is usable for development without a real verification run; it is
        // labelled sandbox so it can never be read as a live connection.
        state = "sandbox";
        reason = `Sandbox adapter configured and usable for development. ${modeLabel}`;
        missingPrerequisites = [];
      } else {
        state = "verification_failed";
        reason = "The adapter has never been verified against its configured endpoint";
      }
    } else if (verification.outcome === "failed") {
      state = "verification_failed";
      lastVerificationOutcome = "failed";
      reason = `The last verification (${verification.finishedAt}) failed: ${verification.failure ?? "see the verification record"}`;
    } else if (verificationAge(verification) > maxAgeMs) {
      state = "verification_failed";
      lastVerificationOutcome = "expired";
      lastSuccessfulVerificationAt = verification.finishedAt;
      reason = `The last successful verification (${verification.finishedAt}) is older than ${config.dicomweb.verificationMaxAgeDays} days`;
    } else if (verification.mode === "sandbox" || sandbox) {
      // A passing run against a sandbox endpoint makes the adapter usable, never live-available.
      state = "sandbox";
      lastVerificationOutcome = "passed";
      lastSuccessfulVerificationAt = verification.finishedAt;
      reason = `Conformance run passed at ${verification.finishedAt} against the sandbox endpoint. ${modeLabel}`;
      missingPrerequisites = [];
    } else {
      state = "available";
      lastVerificationOutcome = "passed";
      lastSuccessfulVerificationAt = verification.finishedAt;
      reason = `Verified against the configured endpoint at ${verification.finishedAt}`;
      missingPrerequisites = [];
    }
  } else if (requested) {
    state = sandbox ? "sandbox" : "available";
    reason = sandbox
      ? `Sandbox adapter configured and usable for development; synthetic data only. ${modeLabel}`
      : `Configured and usable. ${modeLabel}`;
    missingPrerequisites = [];
  }
  return {
    id: definition.id,
    name: definition.name,
    state,
    mode,
    modeLabel,
    reason,
    requested,
    enabledForEnvironment: state === "available",
    adapterImplemented,
    requiredConfiguration: definition.requiredConfiguration,
    missingPrerequisites,
    lastSuccessfulVerificationAt,
    lastVerificationOutcome,
    capabilities: definition.capabilities.map((capability) => ({ capability, status: state })),
    effectWhileUnavailable: definition.effectWhileUnavailable,
    remediation: definition.remediation,
  };
}

/** Without `verifications`, an implemented adapter is reported as never verified and is not available. */
export function listIntegrations(config: AppConfig, verifications: VerificationLookup = {}): IntegrationStatus[] {
  return INTEGRATIONS.map((definition) => statusFor(config, definition, verifications[definition.id]));
}

export function integrationStatus(config: AppConfig, id: IntegrationId, verification?: VerificationRecord | null): IntegrationStatus {
  const definition = INTEGRATIONS.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`Unknown integration ${id}`);
  return statusFor(config, definition, verification);
}

/** True only for a live, verified connection. A sandbox integration is deliberately never "available". */
export function isIntegrationAvailable(config: AppConfig, id: IntegrationId, verification?: VerificationRecord | null): boolean {
  return integrationStatus(config, id, verification).state === "available";
}

/**
 * Refuses the operation unless the integration can serve it. `sandbox` passes here — the caller is
 * told through the response mode/labels that the data is simulated — while every unconfigured or
 * misconfigured integration still fails closed with the same 503 as before.
 */
export function assertIntegrationAvailable(config: AppConfig, id: IntegrationId, operation: string, outcome: string, verification?: VerificationRecord | null): void {
  const status = integrationStatus(config, id, verification);
  if (!isIntegrationOperationalStatus(status)) throw new IntegrationUnavailableError(status, operation, outcome);
}

/** True when an operation can be served: a live connection or an explicitly labelled sandbox adapter. */
export function isIntegrationOperationalStatus(status: IntegrationStatus): boolean {
  return status.state === "available" || status.state === "sandbox";
}

/** True when an operation can be served: a live connection or an explicitly labelled sandbox adapter. */
export function isIntegrationOperational(config: AppConfig, id: IntegrationId, verification?: VerificationRecord | null): boolean {
  return isIntegrationOperationalStatus(integrationStatus(config, id, verification));
}

/** Typed refusal returned whenever an operation needs an integration that is neither live nor an opted-in sandbox adapter. */
export class IntegrationUnavailableError extends AppError {
  constructor(status: IntegrationStatus, operation: string, outcome: string) {
    super(503, "integration_unavailable", `${status.name} is ${status.state.replace("_", " ")}: ${outcome}`, {
      integration: status.id,
      operation,
      state: status.state,
      reason: status.reason,
      retryable: false,
      remediation: status.remediation,
    });
  }
}
