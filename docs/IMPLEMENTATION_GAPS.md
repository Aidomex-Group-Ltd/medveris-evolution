# Implementation gaps and production blockers

This file separates harmless local-development gaps from items that block production use.

## Must resolve before any real patient data

1. **Deployment target.** Staging (`medveris-staging`) and production (`medveris-production`, `https://medveris.online`) run on Cloudflare Workers against separate isolated PostgreSQL servers through Hyperdrive with private R2 buckets, released blue-green (see `PRODUCTION_READINESS.md` and `docs/16_OPERATIONS_AND_DEPLOYMENT.md`). Both hold synthetic data only; no real patient data has been processed.
2. **Secrets and keys.** Production secrets live in `~/.config/medveris/production/` (0600) and are checked by the deployment gate. Key rotation has not been drilled, and documented recovery for the audit/MFA/session key separation is still outstanding.
3. **Backups and restore.** Aiven point-in-time recovery and encrypted backups are confirmed, and a restore drill was recorded on 2026-10-28 (`~/.config/medveris/production/backup-verification.json`). A recurring drill schedule and an RPO/RTO target are still needed.
4. **CI/CD.** A GitHub Actions verification workflow is committed and the deploy scripts run the full gate, but the workflow has not executed in a hosted runner and there is no deployment approval or environment promotion process.
5. **Monitoring.** Structured logs exist for API and jobs. There are no metrics, alerts, dashboards, tracing or on-call runbooks.
6. **Clinical safety and privacy review.** Hazard register, consent wording, retention, breach response, DPIA and jurisdiction-specific legal bases require named owners.
7. **Terminology licensing.** Synthetic fixtures are labelled and must never be presented as SNOMED CT/LOINC. Production mode requires a licensed provider, release pinning and validation.
8. **FHIR conformance.** The facade is a documented read-only subset. It has not been tested with an external validator, reference client or exchange partner.
9. **Rate limiting.** Sensitive policies are counted in a Durable Object per identity with a local fallback; staging and production refuse to start without the binding. The fallback remains per-isolate, so a misconfigured binding would degrade to approximate limits.
10. **Email and uploads.** Staging and production send email through Resend from `medveris.online` (delivery recorded per token) and store uploads in private R2 buckets. MX, SPF, DKIM and DMARC are configured for the apex; `www.medveris.online` is not routed. Local development keeps the `.eml` sink and filesystem storage.
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
