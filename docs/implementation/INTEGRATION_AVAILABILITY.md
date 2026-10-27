# Integration availability

The registry is `apps/api/src/integrations/registry.ts`. It is the only source of truth for integration state; the admin console (`Administration → Integrations`), `GET /api/v1/admin/integrations` and the `features` map in `GET /api/v1/public/config` all derive from it.

## Rules

- A state is `available` only when an adapter is implemented **and** has a successful verification run against its configured endpoint. No adapter is implemented in this release, so no integration can be `available`.
- An environment flag (`FEATURE_*=true`) only *requests* an integration. Without an adapter the state becomes `misconfigured` and the flag is ignored.
- Operations that need an integration call `assertIntegrationAvailable`, which returns HTTP 503 with code `integration_unavailable` and details `{ integration, operation, state, reason, retryable: false, remediation }`. Nothing is persisted and no upstream reference is fabricated.
- `lastSuccessfulVerificationAt` is `null` and `lastVerificationOutcome` is `never-verified` for every integration, because no verification has ever run.

## Current states (verified by `tests/unit/integration-registry.test.ts`)

| Integration | State | Enforced effect |
|---|---|---|
| DICOMweb / PACS | unavailable | Imaging studies only with PACS state `not-configured`; no image retrieval, display or transfer |
| Laboratory (LIS/analyzer) | unavailable | Internal orders, specimens and manual results only; no external exchange code exists |
| Pharmacy (external) | unavailable | Internal pharmacy and stock only; no external prescription transmission code exists |
| Telemedicine media | unavailable | Session records and consent work; `POST /telehealth/sessions/:id/join` is refused |
| Device gateway | unavailable (`misconfigured` if `FEATURE_DEVICES=true`) | Registry and mappings work; `POST /devices/:id/ingest` is refused and stores nothing |
| AI assistance | unavailable | `POST /ai/jobs` is refused; no inference is produced |
| Payments | unavailable | Invoices and manually recorded payments only; no payment initiation or provider confirmation code exists |
| Public health | unavailable | Aggregate reports are prepared and released as local records only; nothing is transmitted |
| Ledger anchoring | not_requested | Checkpoints are HMAC-signed locally and unanchored |

## Enabling an integration

Each registry entry lists `requiredConfiguration`, `missingPrerequisites` and `remediation`. To enable one:

1. Implement an adapter behind a typed interface returning success, unavailable, rejected, timeout or failure, with bounded timeouts and idempotency for retried commands.
2. Add conformance tests against an approved non-production endpoint.
3. Persist verification runs and only then add the adapter to `IMPLEMENTED_ADAPTERS`; the registry must derive `available` from a recorded successful run.
4. Obtain the clinical or operational approval named in the prerequisites before enabling safety-critical capabilities.
