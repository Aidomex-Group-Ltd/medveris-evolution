# Phase 6 — Dedicated Observability Support Center (2026-11-12)

Final phase of the program *Authentication simplification, interoperability, security hardening & observability*.
This document is the consolidated delivery record for Phases 1–6; per-phase evidence lives in
`REFACTOR.md` and `docs/refactor/phase{3,4,5}/`.

## 6.1 Access model & routing

- **URL-only hidden route** `/support-center`, registered in `apps/web/src/App.tsx` behind `<ProtectedRoute platform>` and **absent from every navigation surface** (public landing, patient portal, provider nav, PLATFORM_NAV). `tests/unit/support-center.test.ts` enforces the hidden-route contract against `nav.ts`/`navigation.ts` and asserts the page binds only operator-gated APIs.
- **Authorization:** platform_operator grant (four-eyes provisioned, 24h-expiry break-glass path exists via CLI), plus a **verified MFA session for every mutating action** (`requireOperator({ mfa: true })`). Server-side only — no client-side role checks gate access.
- **Reads:** `GET /support-center/*` requires the operator grant (any MFA state); mutations require MFA-verified session; all returns are operational aggregates/records with no tenant or patient attribution.
- Note: the platform area's existing `/platform-observability` page (operator nav) is unchanged and is **not** the Support Center; the Support Center is the dedicated incident-facing surface.

## 6.2 Backend modules/APIs (`apps/api/src/routes/support-center.ts`, mount `/api/v1`)

| Module | Endpoints | Implementation |
|---|---|---|
| **Telemetry** | `GET /platform/observability/security-events?span=1h\|6h\|24h\|7d` (built in Phase 5) + existing observability proxy endpoints | `app.security_event_summary(span)` — SECURITY DEFINER, counts-only, platform-GUC-gated; surfaced via `platform-observability` operator routes |
| **Alerting** | `GET /support-center/alerts` | Derived feed — open sev1/sev2 tickets + dead-lettered outbox count (`outbox_events.status='dead-letter'`); stable `externalRef` for idempotent ticketing; **no separate alert store** |
| **Ticketing** | `GET /support-center/tickets[?status&severity]`, `GET /support-center/tickets/:id`, `POST /support-center/tickets`, `POST .../:id/acknowledge`, `.../assign`, `.../notes`, `.../severity`, `.../resolve`, `.../close` | Incident lifecycle with `open → in_progress → resolved → closed`; mandatory resolution text; assignee must be an active platform operator; externalRef dedupe (409 while open ticket exists); full event timeline |
| **Reporting** | `GET /support-center/reporting/summary?span=24h\|7d\|30d` | Aggregates only: incidents by status/severity/category, avg minutes to acknowledge/close, top-10 operator activity by event count — no identifiers of patients/tenants |
| **Operators** | `GET /support-center/operators` | Active platform operator inventory (userId, grant/expiry) for the assign flow |
| **Audit** | every mutation | Hash-chained `audit_events` rows (`support_ticket.*`) + append-only `support_ticket_events` timeline (FK CASCADE on ticket, no DELETE on tickets — close, never delete) |
| **Schema** | `packages/db/migrations/131_support_center_tickets.sql` | `support_tickets` + `support_ticket_events`; FORCE RLS with `app.platform_role = 'platform_operator'`-gated policies on both; additive only; dry-run validated; applied to `medveris_test` via migrator (CI applies to fresh DBs) |

## 6.3 Frontend center (`apps/web/src/pages/SupportCenterPage.tsx`)

Dedicated shell with four modules (Telemetry / Alerting / Ticketing / Reporting) bound to the APIs above;
hidden route only; no ordinary navigation entries anywhere; `useQuery`/`useAction` with existing
`@medveris/ui` primitives; timeline rendering per ticket; operator-assignment dropdown bound to the
operator inventory endpoint. Responsive table primitives follow `packages/ui` conventions.

## 6.4 Operational integrity

- Incident lifecycle enforced server-side by transition guards (`open→ack→assign/note/severity/resolve→close` only) — 409 on illegal transitions (e.g., close before resolve, re-resolve).
- Every lifecycle step writes both an append-only timeline event and a hash-chained audit row (action names `support_ticket.opened/acknowledged/assigned/note/severity-changed/resolved/closed`).
- External references dedupe alert-driven duplicates at creation time (unique open ticket per alert `externalRef`).
- `GET /support-center/reporting/summary` gives operators the MTTA/MTTR and workload visibility required for incident summaries and operator activity/audit reporting.
- Telemetry remains failure-isolated (Phase 5): the center going down (or Cloudflare observability being unconfigured) never blocks clinical operations, authentication or the jobs cycle.

## 6.5 Verification

- `tests/integration/support-center.test.ts` — **9/9 pass**: 401 anonymous, 403 non-operator, incident create + alert dedupe (409), timeline ordering, acknowledge/assign/note/severity/resolve/close transitions, 422 assign to non-operator, 409 close-before-resolve, jobs-role read-back of hash-chained audit rows for all five lifecycle actions, reporting aggregates and alerts feed shape.
- `tests/unit/support-center.test.ts` — **3/3 pass**: hidden route contract (registered behind `ProtectedRoute platform`; absent from all nav sources); page binds only operator-gated APIs; no patient/clinical API references.
- `tests/unit/route-authz-coverage.test.ts` — 50/50 route files carry guards or documented public surfaces.
- Authz matrix — support-center routes bound (`support.center.read`, `support.ticket.manage`, permission `platform.operations.manage`, enforcement `platform-operator`, MFA required for manage).
- ESLint on all changed/new files — clean. Migration 131 dry-run in BEGIN…ROLLBACK on `medveris_dev` — pass (nothing persisted); applied via migrator to `medveris_test`.
- Web bundle: page + route are type-consistent against `lib/api`, `lib/useQuery`, `lib/useAction`, `lib/format` and `@medveris/ui` exports as used elsewhere; full `tsc` not re-run clean in this window because the concurrent opencode session's `apps/web/src/pages/AuthPage.tsx` currently fails typecheck (see Phase 6 record in REFACTOR.md).

## 6.6 Final program deliverables — deployment, rollback, recovery

### Architecture summary (Phases 1–6)

Single streamlined auth container (Phase 1 UI) with exclusive Patient/Provider toggle; preserved backend auth workflows with tightened RBAC guards (Phase 2); interoperability inventory with truthful standards posture + break-glass revocation (Phase 3); security hardening across uploads/CSRF/session rotation/secrets/headers (Phase 4); operator observability + terminal elevation hardening (Phase 5); dedicated Support Center with ticketing/reporting (Phase 6). Cloudflare Workers remain the edge runtime (Queues for async, cron for jobs, DOs for rate limiting/realtime, Hyperdrive for Postgres, R2 for private object storage); audit remains hash-chained and append-only; RLS remains the hard tenant boundary.

### Migrations to apply on release (in order, through the migrator only)

`129_emergency_override_revocation.sql`, `130_security_event_summary.sql`, `131_support_center_tickets.sql` — additive; no data changes; backward-compatible; rollback = drop the new objects (documented in each file's header). CI applies these to fresh databases automatically.

### Configuration / Cloudflare inventory

- **Hyperdrive**: `HYPERDRIVE` (runtime) / `HYPERDRIVE_JOBS` (jobs), `--caching-disabled` required.
- **Queues**: `*-jobs` + `*-jobs-dlq` (max retries 8/3, DLQ alerting by operator email when `OPERATOR_ALERT_EMAIL` is set).
- **Durable Objects**: `RATE_LIMITER`, `REALTIME` (SQLite-backed).
- **R2**: private uploads bucket per environment (`medveris-{staging,production}-uploads`) — never public.
- **Cron**: `*/5 * * * *` (jobs cycle incl. outbox relay, grant expiry, export purge, integrity checkpoints, security-anomaly flag).
- **Secrets** (names only): `SESSION_SECRET`, `AUDIT_SIGNING_KEY`, `MFA_ENCRYPTION_KEY`, `RESEND_API_KEY`, `AI_TOKEN` (prod), `LIVEPAY_API_KEY`, `LIVEPAY_WEBHOOK_SECRET`, `YO_*` (staging). Optional for Support Center: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (returns truthful `unavailable` envelopes until set), `OPERATOR_ALERT_EMAIL` (DLQ alerts).
- **Vars** (non-secret): `APP_ENV`, `APP_ORIGIN`, `EXPECTED_DATABASE_NAME`, `AUDIT_SIGNING_KEY_ID`, feature flags (`FEATURE_*`, all false in production by default), `REQUEST_LOG_SAMPLE_RATE` (staging 1.0, production 0.1), `redact_query_string: true`.

### Access & admin instructions

1. **Grant an operator** (rarely; four-eyes): request via `POST /admin/platform-operator/requests` (operator, MFA) → a second, distinct operator approves → `platform_roles` row granted with expiry. Bootstrap (first operator / lost access): `MIGRATION_DATABASE_URL=... npm run platform:operator -- grant --user <uuid> --reason "..." [--allow-production]`; grants expire automatically (default hours, capped) and are swept by the jobs cycle.
2. **Support Center access**: navigate directly to `/support-center` (it is deliberately not in any menu). Sign in with an operator account holding MFA; mutations will fail closed without a verified MFA session.
3. **Operator onboarding**: create user → enroll TOTP (invitation flow) → grant `credential_reviewer` + `platform_operator` via four-eyes or bootstrap CLI.
4. **Incident drill**: open `/support-center` → Alerting → open ticket from signal → assign → resolve with resolution text → close; verify timeline + audit (`support_ticket.*`) — see 6.5 tests.

### Deployment / rollback / recovery

- **Release**: production gate (`npm run deploy:production`) — lint/typecheck/tests (expects the full suite green; see note about the concurrent session), build, package, staged verification, backup-verification freshness (<90d). Deploy is blue-green; white/blue kept for instant rollback (`npm run deploy:production:rollback`).
- **Schema rollback**: 129–131 are additive; rollback is `DROP FUNCTION app.security_event_summary(integer);`, `DROP TABLE support_ticket_events; DROP TABLE support_tickets;`, `ALTER TABLE emergency_overrides DROP COLUMN revoked_by, DROP COLUMN revoked_reason;` — only if the release they rode with is rolled back and no writes to new objects are needed. Prefer forward-fix per `docs/refactor/DATA_SAFETY_PROTOCOL.md`.
- **Recovery drills**: mandatory restore drill before pilot per `docs/16_OPERATIONS_AND_DEPLOYMENT.md`; record in `backup-verification.json`; RPO ≤15m / RTO ≤4h targets remain **proposed**, not approved.
- **Incident response**: SEV1 (confidentiality/clinical-integrity class) → engage operators via Alerting tab → open ticket → freeze changes → rollback via blue-green → post-incident review using Reporting MTTA/MTTR.

### Known limitations (explicit, not waived)

1. Cloudflare observability dataset unconfigured in this account; endpoints return structured `unavailable` (Telemetry tab shows truthful empty/stale states).
2. Alerting is derived (dead-letter + high-sev open tickets) — no WAF/Bot feeds, no paging, no PagerDuty; thresholds static.
3. Support Center pagination is capped at 100 rows per query; timeline 200 events — no bulk export endpoint yet.
4. Audit-hash-chain independent verifier still absent (write-time tamper-evidence only).
5. Reporting covers incidents only; clinical-sync and availability SLAs are visibility-only on the Telemetry tab.
6. The concurrent opencode session in the same working tree is reworking `apps/web/src/pages/AuthPage.tsx` congruently with Phase 1's auth overlay — see Phase 6 delivery note; coordinate before release.
