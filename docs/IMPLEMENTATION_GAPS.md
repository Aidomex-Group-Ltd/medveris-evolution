# Implementation gaps and production blockers

This file separates harmless local-development gaps from items that block production use.

## Must resolve before any real patient data

1. **Deployment target.** The API runs under Node/Hono locally. `wrangler.jsonc` defines a `medveris-staging` Worker and the private R2 bucket `medveris-staging-uploads` exists, but no staging PostgreSQL database or Hyperdrive config exists yet, so the Worker has never run against Hyperdrive or R2 in Cloudflare. Do not claim Workers readiness.
2. **Secrets and keys.** `.env` contains local secrets. Production needs a managed secret store, key rotation, separation of audit/MFA/session keys and documented recovery.
3. **Backups and restore.** No automated backup, point-in-time recovery drill or restore verification has been performed.
4. **CI/CD.** A GitHub Actions verification workflow is committed, but it has not yet been executed in a hosted runner and there is no deployment approval gate or environment promotion process.
5. **Monitoring.** Structured logs exist for API and jobs. There are no metrics, alerts, dashboards, tracing or on-call runbooks.
6. **Clinical safety and privacy review.** Hazard register, consent wording, retention, breach response, DPIA and jurisdiction-specific legal bases require named owners.
7. **Terminology licensing.** Synthetic fixtures are labelled and must never be presented as SNOMED CT/LOINC. Production mode requires a licensed provider, release pinning and validation.
8. **FHIR conformance.** The facade is a documented read-only subset. It has not been tested with an external validator, reference client or exchange partner.
9. **Rate limiting.** The in-memory limiter is per-process only and is not suitable for multi-instance deployment.
10. **Email and uploads.** Local `.eml` sink and local filesystem storage are development adapters. Resend/R2 paths are not exercised.
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
