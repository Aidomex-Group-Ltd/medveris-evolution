import type { AppConfig } from "../config.js";
import { AppError } from "../lib/errors.js";

export type IntegrationState =
  | "available"
  | "degraded"
  | "unavailable"
  | "disabled"
  | "not_requested"
  | "misconfigured"
  | "verification_failed";

export type IntegrationId = "dicomweb" | "lab" | "pharmacy" | "telemedicine" | "devices" | "ai" | "payments" | "publicHealth" | "ledgerAnchoring";

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
}

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
  lastVerificationOutcome: "never-verified";
  capabilities: Array<{ capability: string; status: IntegrationState }>;
  effectWhileUnavailable: string;
  remediation: string;
}

/**
 * No external adapter is implemented in this release, so no integration can be `available`. An adapter
 * must be added together with a persisted verification record before this list may change.
 */
const IMPLEMENTED_ADAPTERS: ReadonlySet<IntegrationId> = new Set();

export const INTEGRATIONS: readonly IntegrationDefinition[] = Object.freeze([
  {
    id: "dicomweb",
    name: "DICOMweb / PACS",
    flag: "FEATURE_DICOMWEB",
    baseline: "unavailable",
    baselineReason: "No PACS endpoint, credentials or DICOMweb conformance testing is configured",
    requiredConfiguration: ["DICOMweb base URL", "approved credentials", "network access to the PACS"],
    prerequisites: ["DICOMweb adapter implementation", "QIDO-RS/WADO-RS/STOW-RS conformance tests against an approved test PACS", "authorization review"],
    capabilities: ["study search", "image retrieval", "study transfer"],
    effectWhileUnavailable: "Imaging studies can only be recorded with PACS state 'not-configured'; no images are retrieved, displayed or transferred.",
    remediation: "Provide an approved test PACS, implement and verify the DICOMweb adapter, then record a successful conformance run.",
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
    name: "Payments",
    flag: "FEATURE_PAYMENTS",
    baseline: "unavailable",
    baselineReason: "No payment provider, verified callback signature or reconciliation is configured",
    requiredConfiguration: ["payment provider credentials", "callback signing secret"],
    prerequisites: ["provider adapter implementation", "signed callback verification", "idempotency and reconciliation tests"],
    capabilities: ["online payment initiation", "provider-confirmed payment status", "provider receipts"],
    effectWhileUnavailable: "Invoices and manually recorded payments work; no online payment is initiated or treated as provider-confirmed.",
    remediation: "Contract a payment provider, implement the adapter with signed callbacks and pass reconciliation tests.",
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

function statusFor(config: AppConfig, definition: IntegrationDefinition): IntegrationStatus {
  const requested = Boolean(config.features[definition.id]);
  const adapterImplemented = IMPLEMENTED_ADAPTERS.has(definition.id);
  let state: IntegrationState = definition.baseline;
  let reason = definition.baselineReason;
  const missingPrerequisites = adapterImplemented ? ["successful verification run"] : [...definition.prerequisites];
  if (requested && !adapterImplemented) {
    state = "misconfigured";
    reason = `${definition.flag} is set, but no ${definition.name} adapter exists in this release; the flag is ignored`;
  } else if (requested && adapterImplemented) {
    state = "verification_failed";
    reason = "The adapter has never been verified against its configured endpoint";
  }
  return {
    id: definition.id,
    name: definition.name,
    state,
    reason,
    requested,
    enabledForEnvironment: false,
    adapterImplemented,
    requiredConfiguration: definition.requiredConfiguration,
    missingPrerequisites,
    lastSuccessfulVerificationAt: null,
    lastVerificationOutcome: "never-verified",
    capabilities: definition.capabilities.map((capability) => ({ capability, status: state })),
    effectWhileUnavailable: definition.effectWhileUnavailable,
    remediation: definition.remediation,
  };
}

export function listIntegrations(config: AppConfig): IntegrationStatus[] {
  return INTEGRATIONS.map((definition) => statusFor(config, definition));
}

export function integrationStatus(config: AppConfig, id: IntegrationId): IntegrationStatus {
  const definition = INTEGRATIONS.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`Unknown integration ${id}`);
  return statusFor(config, definition);
}

export function isIntegrationAvailable(config: AppConfig, id: IntegrationId): boolean {
  return integrationStatus(config, id).state === "available";
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

export function assertIntegrationAvailable(config: AppConfig, id: IntegrationId, operation: string, outcome: string): void {
  const status = integrationStatus(config, id);
  if (status.state !== "available") throw new IntegrationUnavailableError(status, operation, outcome);
}
