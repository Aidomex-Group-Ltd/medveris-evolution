# Implementation gaps and production blockers

This file separates harmless local-development gaps from items that block production use.

## Must resolve before any real patient data

1. **Deployment target.** Staging runs on Cloudflare Workers (`medveris-staging`) against an isolated PostgreSQL database through Hyperdrive and a private R2 bucket, released blue-green (`docs/16_OPERATIONS_AND_DEPLOYMENT.md`). No production environment exists.
2. **Secrets and keys.** `.env` contains local secrets. Production needs a managed secret store, key rotation, separation of audit/MFA/session keys and documented recovery.
3. **Backups and restore.** No automated backup, point-in-time recovery drill or restore verification has been performed.
4. **CI/CD.** A GitHub Actions verification workflow is committed, but it has not yet been executed in a hosted runner and there is no deployment approval gate or environment promotion process.
5. **Monitoring.** Structured logs exist for API and jobs. There are no metrics, alerts, dashboards, tracing or on-call runbooks.
6. **Clinical safety and privacy review.** Hazard register, consent wording, retention, breach response, DPIA and jurisdiction-specific legal bases require named owners.
7. **Terminology licensing.** Synthetic fixtures are labelled and must never be presented as SNOMED CT/LOINC. Production mode requires a licensed provider, release pinning and validation.
8. **FHIR conformance.** The facade is a documented read-only subset. It has not been tested with an external validator, reference client or exchange partner.
9. **Rate limiting.** The in-memory limiter is per-process only and is not suitable for multi-instance deployment.
10. **Email and uploads.** Staging sends email through Resend from `medveris.online` (delivery recorded per token) and stores uploads in R2. `medveris.online` has no DMARC record yet. Local development keeps the `.eml` sink and filesystem storage.
11. **Audit anchoring.** Checkpoints are HMAC-signed and stored locally. No external ledger/WORM anchoring or independent verification job exists.
12. **Patient identity proofing.** Registration verifies email only. Duplicate candidates are tenant-scoped and never auto-merged, but production identity confidence, merge/reconciliation and temporary emergency identities still need an approved operational policy.
13. **Access reviews.** Emergency overrides create review tasks, but there is no automated escalation or periodic access recertification.
14. **External referral exchange.** Follow-up and referral tracking is local and versioned. There is no referral message transport, receiving-facility acknowledgement or directory integration; the UI must not describe local acceptance as external confirmation.

## Accepted local-development limitations

- Synthetic Kampala and Entebbe facilities and fixed seeded accounts.
- In-process jobs loop; local development uses `jobs:once` or `jobs:watch`.
- Desktop-focused responsive CSS; no formal accessibility audit.
- Synthetic test data is reset only through an explicit guarded command.
- The FHIR Patient read is restricted to patients linked to the active facility (or the patient themself). Cross-facility chart access must use the native grant-validated exchange path.

## Security follow-ups

- Tighten `patients` SELECT RLS further if the global directory must not expose minimal identity to every staff member. The current policy permits staff read of the minimal global directory; application paths require a tenant link for chart and FHIR access.
- Add per-tenant rate limits and abuse detection.
- Add automated checks that every protected read writes audit evidence before returning content.
- Add dependency and container scanning.
