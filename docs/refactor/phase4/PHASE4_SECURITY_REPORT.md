# Phase 4 — Security hardening & CIA enforcement (2026-11-12)

Scope: threat-surface review, injection/XSS/CSRF defenses, data protection, abuse resistance,
least-privilege tightening, and the residual-risk assessment. Items marked *fixed* landed in this
slice; items marked *documented* are design/config findings with owners and remediation notes.

## 4.1 Threat-surface review — findings and dispositions

| # | Finding | Disposition |
|---|---|---|
| F1 | **Facility-logo pipeline was dead end-to-end**: `POST /logo` 500'd (`sharp` is not a dependency and the dynamic import always rejected), `GET /logo` always reported `hasLogo:false` (no `uploads` row was ever inserted), the proxy URL it returned had no matching route, and `DELETE /logo` 404'd. | **Fixed.** `services/facility-logo.ts` rewritten dependency-free: strict magic-byte verification (PNG/JPEG/WebP only), structural sanitizer that strips privacy metadata (PNG `eXIf`/`tEXt`/`zTXt`/`iTXt`/`tIME`; JPEG `APP1`/`APP2`/`APP13`/`APP15` segments with entropy-data awareness; WebP `EXIF`/`XMP ` chunks with `VP8X` flag-bit clearing and RIFF length recompute). Route now inserts a real `uploads` row (`scan_status: clean` via signature+decode+metadata-strip, `scan_detail` notes it is *not* a malware scan), `tenants.logo_upload_id`, storage-first ordering with tracker-aware failure (503), tenant-scoped `GET /logo/content` (`private, no-store`), real delete (DB null + `uploads` rejected + best-effort storage delete + audit), no fake proxy URLs. |
| F2 | **Any staff member could upload/replace/delete the facility logo** (`requireStaff` only), contradicting the matrix's `workspace.profile.manage` (adminCore: facility_admin/owner) boundary. | **Fixed.** POST/DELETE now enforce `canManageTenant(requestActor(c))`; matrix entry `facility.logo.manage` moved from `legacy` to `canonical` with updated notes; `GET /logo/content` bound to `organization.resource.read`. |
| F3 | **Upload malware scanning is non-functional**: `UPLOAD_SCAN_MODE=live/sandbox` parsed but no scanner exists; uploads flip to `available` after a signature check only. | **Fixed (fail-closed).** Any non-`off` `UPLOAD_SCAN_MODE` now refuses to boot until a scanner is wired (an advertised-but-absent scanner must never masquerade as protection). Signature/metadata checks remain, clearly labelled in responses and `scan_detail`. Wiring ClamAV (or equivalent) into `POST /uploads` and `POST /logo` remains a tracked dependency before any PHI-upload pilot. |
| F4 | **Body-limit vs upload-schema mismatch**: effective decoded ceiling was ~3.8 MB despite `MAX_UPLOAD_BYTES=5MB`; `dataBase64` unbounded at the schema layer. | **Fixed.** `bodyLimit` is now `ceil(max(maxUploadBytes, 2MB) × 4/3) + 64KB`; `uploadSchema.dataBase64` capped at 7 MB; logo schema capped at 3 MB. |
| F5 | **`unhandled_error` logged raw driver messages in production** (postgres.js can echo constraint names/values). | **Fixed.** Production logs carry `event`, `correlationId`, `routeShape` path only (stack/message stay dev-only). FHIR `OperationOutcome` text unchanged; client bodies were and remain generic. |
| F6 | **No CSP on API responses** (HSTS lacked `includeSubDomains`/`preload` as well). | **Fixed (CSP).** API/FHIR/terminology responses now carry `content-security-policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'`. HSTS unchanged: `includeSubDomains`/`preload` deferred (cannot verify every subdomain serves HTTPS today). |
| F7 | **CSRF comparison was not constant-time.** | **Fixed.** Both tokens are SHA-256 hashed and compared with a constant-time XOR loop (`csrfTokenMatches`); no behavior change for valid clients. |
| F8 | **Tenant switch (`POST /me/context`) did not rotate session/CSRF tokens** — a privilege-context change without token re-issue. | **Fixed.** Server rotates: new session (same `mfa_verified_at`, active tenant = target) + new CSRF; old session revoked with `revoked_reason = 'context-switch'`; cookie re-set; response returns `csrfToken`; web `switchTenant()` stores it. Integration harness (`tests/integration/support.ts`) and `onboarding.test.ts` local helper absorb the rotation; support.ts `chooseFacility` updated likewise. DB-backed integration suites were not executed in this environment (no prepared test DB) but now remain self-consistent with rotation. |
| F9 | **Unauthenticated `POST /public/terminology/status` triggered a live outbound probe** of the configured terminology provider with no rate limit (abuse amplification). | **Fixed.** Added `terminology.probe` rate policy (5/5 min, distributed, `local-strict` fallback); `public.ts` must remain read-only except this probe (asserted by test). |
| F10 | **Route authz enforcement is by convention** (inline helpers + RLS), with no CI guard that every route file carries a guard. | **Fixed (detection).** New `tests/unit/route-authz-coverage.test.ts`: statically asserts all 50 `apps/api/src/routes/*.ts` files reference an authorization guard or are documented public surfaces (`public.ts` read-only + rate-limited probe; `payment-callbacks.ts` signature-verified + rate-limited) with their compensating controls. Fails CI on regressions. |
| F11 | **No secret-scan in CI** (production deploy gate runs `npm audit`; CI did not). | **Fixed.** `tests/unit/no-secrets.test.ts` scans all tracked files for PEM private keys, Resend/LivePay/Stripe live-key prefixes and CF token assignments. `npm audit --omit=dev --audit-level=high` added to CI as advisory (`continue-on-error`); the production release gate already enforces it blocking. |
| F12 | **Yo! callbacks use RSA-SHA1** (provider-mandated) | Documented as accepted external risk; LivePay webhook uses HMAC-SHA256 with constant-time compare — keep. |
| F13 | **Uploads marked `available` without malware scan; storage-failure path marks `rejected` with `storage-failure: <error.message>` in `scan_detail`** — internal message persisted (not client-visible). | Reduced: `scan_detail` now also says "not a malware scan" for logos; credentials path unchanged (message is DB-internal only, not returned to clients). Full fix requires a wired scanner (see F3). |

## 4.2 Input validation & injection defenses (verified, no changes needed)

- ~350+ `parseJson/parseQuery` zod call sites across routes; path params parsed as uuid/regex; validation errors expose only `path`+`message`.
- postgres.js tagged templates are parameterized throughout; all `sql.unsafe`/`tx.unsafe` interpolations verified to be constant allowlists/validated identifiers with bound parameters; text search escapes `%_\`; `ilike` uses escaped patterns respectively.
- XSS: React SPA escapes by default; zero `dangerouslySetInnerHTML` found in app source (spot-checked during review); API returns `nosniff`; web serves a restrictive CSP from `apps/web/public/_headers`; cookies are `httpOnly`+`SameSite=Strict`.
- CSRF: synchronizer token (session-bound, in-memory on client, `x-medveris-csrf` header), Strict cookie (defense-in-depth), constant-time compare (F7). Rotation on tenant switch (F8).
- Command injection: no `exec`/`spawn` of user input found in app code paths (scripts are operator-invoked offline tooling).
- HTTP 409 optimistic concurrency + immutable signed clinical versions remain the conflict model.

## 4.3 Data protection

- Transit: HTTPS/HSTS everywhere (API + web + HSTS on both); same-origin deployment (no CORS headers anywhere by design; Capacitor mobile origin posture is **undocumented/unverified** — flagged for the mobile track: either Capacitor native-HTTP bridge or an explicit CORS allowlist decision).
- At rest: Postgres with RLS FORCE (164 enable/force sites), runtime role non-superuser; `app.*` GUC context; object storage private buckets (no public access in wrangler.jsonc); `uploads` content served tenant-scoped only; logs contain no bodies/tokens (`routeShape`, `safeFields` key denylist, Workers `redact_query_string: true`).
- File integrity: SHA-256 digests recorded at upload; logo bytes carry `sha256` to staff; export files digest-pinned (existing `data-exchange` design).
- Legal/PII minimization: request telemetry logs no IDs/query strings; auth logs no passwords/codes; audit metadata avoids PHI by convention (spot-check clean).
- `.env*` and key material ignored by git; working tree secret scan is now enforced in CI (F11).

## 4.4 Abuse resistance & resilience

- Rate limiting: 30+ policies; auth/MFA/reset/recovery progressive lockouts (300s→3600s cap); account-keyed `auth.login.account` bucket; per-isolate volume guards (`api.authenticated` 600/min, `api.public` 300/min, backed by edge WAF outside this repo); upload 20/h; payment callback limits; coordination failure never degrades to unlimited (local-strict/closed).
- Audit completeness: hash-chained, HMAC-signed, append-only `audit_events` (DB triggers reject UPDATE/DELETE) for clinical read/write, consent/exchange, break-glass, auth, platform ops — with allow/deny + `reasonCode` on sensitive exchange paths. Hash-chain **full verification tooling does not exist** (no independent chain verifier) — flagged, not implemented (scope).
- Backup/recovery: `docs/16` RPO ≤15m / RTO ≤4h **proposed, not approved**; production gate enforces restore-drill evidence <90 days via `backup-verification.json`; PITR/restore is provider-managed; no in-repo backup tooling (documented gap); `docs/refactor/DATA_SAFETY_PROTOCOL.md` governs migrations.
- Health: `/api/health`, `/api/v1/health/live` probes; platform observability work (Phases 5–6) covers alerting.

## 4.5 Least-privilege tightening (this slice)

- Facility-logo admin boundary (F2); matrix `facility.logo.manage` canonicalized.
- Route-authz coverage guard prevents silently unguarded new route files (F10).
- Emergency-override revocation shipped with requester-or-governance least privilege (Phase 3).
- `emergency.access.revoke` permission scoped to eligibility-matched roles (Phase 3).
- NOT rewired: the authorization matrix remains registry-level; runtime enforcement remains inline (+RLS backstop). A centralized permission middleware with a route-coverage gate is the correct next hardening step but is a broad behavior-risk change requiring its own approved slice; the F10 test is the safety net in the interim.

## 4.6 Residual risks (explicit, not waived)

1. **No malware scanning on uploads** (F3) — blocking for PHI document evidence; needs ClamAV/sandbox in the upload path + AV signature hygiene, then flip the fail-closed guard.
2. **Capacitor mobile origin vs same-origin deployment** — needs an explicit decision + docs; otherwise mobile API calls may rely on undocumented Capacitor native-HTTP behavior.
3. **Centralized authz enforcement** — matrix documents intent; no route currently calls it; inline checks + RLS remain the controls. Coverage of a *new* route missing both a helper and the matrix is now caught by CI (F10), but parameterized denial audits exist only on some deny paths.
4. **Backup restore drills unscheduled; RPO/RTO unapproved; no object-storage versioning in wrangler.jsonc.**
5. **Yo! RSA-SHA1** (provider-mandated), documented.
6. **`local-strict` rate limiter degrades to per-isolate** under coordination failure (by design, documented; edge WAF is the global control and lives outside the repo).
7. **Audit chain verifier absent** — tamper-evidence is write-time only; independent verification tooling pending.
8. **Clinician/nurse MFA step-up age** is session-scoped (enrollment+verified per session), not re-verified per sensitive action beyond platform roles' 300s step-up; acceptable but noted.
9. **Production `unhandled_error` now log-hygienic, but `nativeErrorBody` returns `err.message` for `AppError`s verbatim** — all in-tree AppError messages are static strings (verified); keep it that way (F5 residual).
10. **CSP `frame-ancestors` is on API responses; web relies on `_headers`** — verify the Workers static-assets pipeline honors `_headers` in the staging smoke test.

## Verification

- `npm run typecheck` — pass (after fixing two incorrect relative import paths in parallel-authored `apps/web/src/components/observability/TelemetryDashboard.tsx`; see note below).
- Full unit suite — see REFACTOR.md Phase 4 record for the exact count (re-run after this doc landed).
- Migration 129 dry-run — pass; dev DB untouched.
- CI: dependency-audit advisory added; `route-authz-coverage` and `no-secrets` run in `npm test`.

## Note on the parallel worktree session (ops risk)

While this phase executed, a second concurrent coding session (`opencode`, pts/0) was mutating
the same working tree: observability dashboard components and pages, auth page edits, emergency-access
UI, API auth/legal rewrites, e2e updates, and support-harness changes. Those files are **not** part of
this phase's commit. TypeScript reported errors exclusively in those files until two import paths were
corrected; further mutation may reintroduce breakage before that session finishes. All verification in
this document reflects the tree at the time it ran. Recommend: freeze concurrent edits during phase
verification, or land the other session's work in its own reviewed commit before the release gate.
