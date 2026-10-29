import type { AppConfig } from "../config.js";
import { AppError } from "../lib/errors.js";
import { dicomwebConfigProblems } from "./dicomweb.js";
import { yoConfigProblems } from "./yo.js";

export type IntegrationState =
  | "available"
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
}

/** Latest conformance run for the configured endpoint, as stored in integration_verifications. */
export interface VerificationRecord {
  outcome: "passed" | "failed";
  finishedAt: string;
  /** First failed check, when the run failed. */
  failure: string | null;
}

export type VerificationLookup = Partial<Record<IntegrationId, VerificationRecord | null>>;

export interface IntegrationStatus {
  id: IntegrationId;
  name: string;
  state: IntegrationState;
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
 * Integrations with an adapter in this release. Each one is `available` only when it is requested, fully
 * configured and has a passing, unexpired verification run against the configured endpoint.
 */
export const IMPLEMENTED_ADAPTERS: ReadonlySet<IntegrationId> = new Set(["dicomweb", "payments"]);

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
  },
  {
    id: "ai",
    name: "AI assistance",
    flag: "FEATURE_AI",
    baseline: "unavailable",
    baselineReason: "No validated model, intended-use statement or clinical evaluation is approved",
    requiredConfiguration: ["model provider credentials"],
    prerequisites: ["provider adapter implementation", "risk assessment and privacy review", "clinically approved evaluation", "human-oversight workflow"],
    capabilities: ["clinical decision support jobs"],
    effectWhileUnavailable: "No AI job can be submitted and no clinical inference is produced.",
    remediation: "Complete the model validation, risk and privacy reviews, then implement and evaluate the provider adapter.",
  },
  {
    id: "payments",
    name: "Mobile money (Yo! Payments)",
    flag: "FEATURE_PAYMENTS",
    baseline: "unavailable",
    baselineReason: "Mobile money is not enabled for this environment (FEATURE_PAYMENTS is not set)",
    requiredConfiguration: [
      "YO_MODE (sandbox or production)",
      "YO_API_USERNAME and YO_API_PASSWORD (Worker secrets)",
      "YO_PUBLIC_KEY (Yo! public certificate for the selected mode, PEM)",
      "YO_NOTIFICATION_BASE_URL (public HTTPS origin; defaults to APP_ORIGIN)",
    ],
    prerequisites: ["Yo! Payments business account with collections enabled", "notification URLs reachable from Yo!"],
    capabilities: ["mobile money collection prompt", "signed payment notifications", "status reconciliation"],
    effectWhileUnavailable: "Bills and cash payments work; mobile money prompts cannot be sent and no payment is treated as provider-confirmed.",
    remediation: "Set FEATURE_PAYMENTS=true, YO_MODE, the Yo! API credentials and public certificate, then take a sandbox payment end to end.",
    configurationProblems: yoConfigProblems,
    availableWhenConfigured: true,
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

function facilityScopedStatus(config: AppConfig, definition: IntegrationDefinition): IntegrationStatus {
  const requested = Boolean(config.features[definition.id]);
  const problems = requested ? definition.configurationProblems?.(config) ?? [] : [];
  const state: IntegrationState = !requested ? definition.baseline : problems.length ? "misconfigured" : "available";
  const reason = !requested
    ? definition.baselineReason
    : problems.length
      ? problems.join("; ")
      : `Connector enabled for this deployment under the operator-recorded authorization "${config.ehmis.deploymentAuthorizationReference}". Each facility still needs verified eligibility and a passing connection test before it can submit.`;
  return {
    id: definition.id, name: definition.name, state, reason, requested,
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

function configuredStatus(config: AppConfig, definition: IntegrationDefinition): IntegrationStatus {
  const requested = Boolean(config.features[definition.id]);
  const problems = requested ? definition.configurationProblems?.(config) ?? [] : [];
  const state: IntegrationState = !requested ? definition.baseline : problems.length ? "misconfigured" : "available";
  const reason = !requested
    ? definition.baselineReason
    : problems.length ? problems.join("; ") : `Configured for ${config.yo.mode}; every payment is confirmed by a verified notification or a status check before it is posted`;
  return {
    id: definition.id, name: definition.name, state, reason, requested,
    enabledForEnvironment: state === "available",
    adapterImplemented: true,
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
  if (definition.facilityScoped) return facilityScopedStatus(config, definition);
  if (definition.availableWhenConfigured) return configuredStatus(config, definition);
  const requested = Boolean(config.features[definition.id]);
  const adapterImplemented = IMPLEMENTED_ADAPTERS.has(definition.id);
  let state: IntegrationState = definition.baseline;
  let reason = definition.baselineReason;
  let missingPrerequisites = adapterImplemented ? ["successful verification run"] : [...definition.prerequisites];
  let lastVerificationOutcome: IntegrationStatus["lastVerificationOutcome"] = "never-verified";
  let lastSuccessfulVerificationAt: string | null = null;
  if (requested && !adapterImplemented) {
    state = "misconfigured";
    reason = `${definition.flag} is set, but no ${definition.name} adapter exists in this release; the flag is ignored`;
  } else if (requested && adapterImplemented) {
    const problems = definition.configurationProblems?.(config) ?? [];
    const maxAgeMs = config.dicomweb.verificationMaxAgeDays * 86_400_000;
    if (problems.length) {
      state = "misconfigured";
      reason = problems.join("; ");
      missingPrerequisites = ["complete configuration", "successful verification run"];
    } else if (!verification) {
      state = "verification_failed";
      reason = "The adapter has never been verified against its configured endpoint";
    } else if (verification.outcome === "failed") {
      state = "verification_failed";
      lastVerificationOutcome = "failed";
      reason = `The last verification (${verification.finishedAt}) failed: ${verification.failure ?? "see the verification record"}`;
    } else if (verificationAge(verification) > maxAgeMs) {
      state = "verification_failed";
      lastVerificationOutcome = "expired";
      lastSuccessfulVerificationAt = verification.finishedAt;
      reason = `The last successful verification (${verification.finishedAt}) is older than ${config.dicomweb.verificationMaxAgeDays} days`;
    } else {
      state = "available";
      lastVerificationOutcome = "passed";
      lastSuccessfulVerificationAt = verification.finishedAt;
      reason = `Verified against the configured endpoint at ${verification.finishedAt}`;
      missingPrerequisites = [];
    }
  }
  return {
    id: definition.id,
    name: definition.name,
    state,
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

export function isIntegrationAvailable(config: AppConfig, id: IntegrationId, verification?: VerificationRecord | null): boolean {
  return integrationStatus(config, id, verification).state === "available";
}

/** Typed refusal returned whenever an operation needs an integration that is not available. */
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

export function assertIntegrationAvailable(config: AppConfig, id: IntegrationId, operation: string, outcome: string, verification?: VerificationRecord | null): void {
  const status = integrationStatus(config, id, verification);
  if (status.state !== "available") throw new IntegrationUnavailableError(status, operation, outcome);
}
