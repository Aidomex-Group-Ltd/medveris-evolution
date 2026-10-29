# Integration availability

The registry is `apps/api/src/integrations/registry.ts`. It is the only source of truth for integration state; the admin console (`Administration → Integrations`), `GET /api/v1/admin/integrations` and the `features` map in `GET /api/v1/public/config` all derive from it.

## Rules

- A state is `available` only when an adapter is implemented **and** has a successful verification run against its configured endpoint. The DICOMweb adapter is implemented; it becomes `available` only after a passing, unexpired conformance run recorded in `integration_verifications` for the configured endpoint fingerprint.
- Mobile money (Yo! Payments) is available once requested and fully configured; there is no separate conformance run because every transaction is confirmed by Yo! itself (an RSA-SHA1-signed notification verified against `YO_PUBLIC_KEY`, or an `actransactioncheckstatus` answer) before any payment is posted.
- eHMIS/DHIS2 is facility-scoped: `available` means only that the deployment is authorized and configured. Each facility still needs platform-verified eligibility, an approved mapping and a passing connection test before it can submit (see `docs/21_WORKSPACES_ORGANIZATIONS_AND_EHMIS.md`).
- An environment flag (`FEATURE_*=true`) only *requests* an integration. Without an adapter the state becomes `misconfigured` and the flag is ignored.
- Operations that need an integration call `assertIntegrationAvailable`, which returns HTTP 503 with code `integration_unavailable` and details `{ integration, operation, state, reason, retryable: false, remediation }`. Nothing is persisted and no upstream reference is fabricated.
- `lastSuccessfulVerificationAt` and `lastVerificationOutcome` come from the latest recorded run; integrations without an adapter stay `never-verified`.

## Current states (verified by `tests/unit/integration-registry.test.ts`)

| Integration | State | Enforced effect |
|---|---|---|
| DICOMweb / PACS | unavailable (`misconfigured` or `verification_failed` when requested without a complete configuration or a passing run) | Studies hold metadata only; no PACS study is searched, linked, retrieved or displayed |
| Laboratory (LIS/analyzer) | unavailable | Internal orders, specimens and manual results only; no external exchange code exists |
| Pharmacy (external) | unavailable | Internal pharmacy and stock only; no external prescription transmission code exists |
| Telemedicine media | unavailable | Session records and consent work; `POST /telehealth/sessions/:id/join` is refused |
| Device gateway | unavailable (`misconfigured` if `FEATURE_DEVICES=true`) | Registry and mappings work; `POST /devices/:id/ingest` is refused and stores nothing |
| AI assistance | unavailable | `POST /ai/jobs` is refused; no inference is produced |
| Mobile money (Yo! Payments) | unavailable (`misconfigured` if `FEATURE_PAYMENTS=true` without `YO_MODE`, the API credentials, `YO_PUBLIC_KEY` or a public HTTPS notification origin; `available` once all are set) | Bills and cash work; `POST /invoices/:id/mobile-money` is refused and no prompt is sent. When available, a payment is posted only from a signature-verified Yo! notification or a Yo! status check |
| Public health | unavailable | Aggregate reports are prepared and released as local records only; nothing is transmitted |
| eHMIS / DHIS2 | not_requested (`misconfigured` if `FEATURE_EHMIS=true` without the authorization reference, credential key or allowed hosts) | HMIS periods are prepared, validated, approved and exported for manual entry; nothing is sent to eHMIS/DHIS2 |
| National Health Facility Registry | unavailable | NHFR IDs are entered by hand and shown as recorded, not verified |
| Ledger anchoring | not_requested | Checkpoints are HMAC-signed locally and unanchored |

## Enabling an integration

Each registry entry lists `requiredConfiguration`, `missingPrerequisites` and `remediation`. To enable one:

1. Implement an adapter behind a typed interface returning success, unavailable, rejected, timeout or failure, with bounded timeouts and idempotency for retried commands.
2. Add conformance tests against an approved non-production endpoint.
3. Persist verification runs and only then add the adapter to `IMPLEMENTED_ADAPTERS`; the registry must derive `available` from a recorded successful run.
4. Obtain the clinical or operational approval named in the prerequisites before enabling safety-critical capabilities.
