# Architecture review — M0/M1

## What was built

- **Monorepo:** `apps/api` (Hono on Node), `apps/web` (React 19 + Vite), `apps/jobs` (outbox/integrity worker), `packages/db`, `packages/domain`, `packages/auth`, `packages/authz`, `packages/contracts`, `packages/ui`.
- **System of record:** PostgreSQL with separate `medveris_migrator`, `medveris_runtime`, `medveris_jobs` and `medveris_exchange` roles. Runtime and jobs are `NOBYPASSRLS`; forced row-level security applies to tenant tables.
- **Request transaction:** each protected operation runs in one transaction. Tenant, user, patient, actor kind, roles and platform role are set with transaction-local `set_config`; pooled connections cannot retain another request's context.
- **Clinical integrity:** signed versions are immutable by trigger; a documented narrow transition permits draft→signed. Amendments create a new version linked to the previous one. Content digests and HMAC signatures bind entry, version, author, time and status.
- **Audit:** append-only hash-chained events with HMAC signatures. Audit, clinical write and outbox insert commit atomically. Failed authentication is audited in an anonymous-scoped transaction.
- **Asynchronous work:** transactional outbox; jobs use `FOR UPDATE SKIP LOCKED`, deduplicate through `processed_outbox_events`, back off and dead-letter after six attempts.
- **Integrity checkpoints:** per-tenant Merkle roots over audit hashes, HMAC-signed, with an advisory lock and monotonic batch numbers. External anchoring is deliberately absent.
- **FHIR/terminology:** read-only FHIR R4 facade and a labelled synthetic terminology adapter. Writes and bulk export are rejected rather than simulated.
- **Web:** role-aware navigation and pages for reception, clinical work, patient portal, consent, exchange, credentials, administration, reviewer and sessions. Every protected call uses the session cookie and CSRF header.

## Strengths

- Tenant isolation is enforced in the database, not only in route handlers.
- Clinical history is append-only and verifiable; amendment and error states preserve prior signatures.
- Permission denials and access reads produce durable evidence.
- External capabilities are explicitly unavailable, not faked.
- Browser, HTTP, database and worker paths are all exercised by executable tests.

## Risks and deviations

1. **Deployment claim.** The worker bundle is not a validated Cloudflare target. No Hyperdrive/R2/Wrangler conformance test exists. Treat the Node API as the only verified runtime.
2. **Global patient directory.** Staff SELECT on `patients` is broad because the product contains a minimal global identity directory. Application paths restrict FHIR and chart reads by tenant link; the native `/patients/resolve` requires exact public ID, family name and date of birth. A stricter database policy would require SECURITY DEFINER helpers for duplicate checks and exchange lookups.
3. **In-memory rate limiting.** Suitable for a single local process only.
4. **Terminology content.** Synthetic codes and labels must not be used clinically.
5. **FHIR conformance.** No external validator or partner test; no SMART/OAuth, writes, history, includes or bulk export.
6. **Operational maturity.** No CI, backups, monitoring, alerting, key rotation, load testing or disaster recovery exercises.
7. **Worker model.** Local jobs run as a separate Node process against PostgreSQL. The Worker entrypoint exists but production queue/cron wiring is not configured.
8. **Date handling.** PostgreSQL returns dates as timestamps through the driver; display code tolerates this, but API contracts should be normalized if partners require date-only values.

## Recommended next steps

1. Add GitHub Actions: PostgreSQL service, role setup, migrations, lint, typecheck, tests, Playwright and build artifacts. Require the database-backed tests to gate merges.
2. Decide and test the production runtime (Node container first, Cloudflare only after Hyperdrive/edge proof).
3. Commission independent security review and privacy/clinical hazard review.
4. Implement backup/restore drills, metrics/alerts and key rotation.
5. Tighten the global directory policy with narrowly scoped SECURITY DEFINER functions.
6. Validate FHIR resources and terminology against licensed reference content before any exchange pilot.
