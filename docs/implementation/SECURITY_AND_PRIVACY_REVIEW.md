# Security and privacy review

Scope: code and configuration review plus executed tests on 2026-10-28. This is an engineering review, not a legal opinion or certification. Compliance with the Uganda Data Protection and Privacy Act, 2019 requires review by qualified legal and clinical staff.

## Controls verified by executed tests

| Control | Evidence |
|---|---|
| Tenant isolation at the database (forced RLS, separate roles) | `tests/integration/rls.test.ts` |
| Department role boundaries and cross-tenant denial | `departments.test.ts` "enforces department role boundaries and tenant isolation" |
| Staff MFA before facility data; patient sessions without staff access | `http.test.ts`, `mfa-setup.spec.ts`, `smoke.spec.ts` |
| CSRF token on state-changing requests | `http.test.ts` |
| Patient lookup is rate-limited, audited and needs identity confirmation; search is limited to the active facility's linked patients | `patients.test.ts` |
| Integrations cannot be enabled by configuration alone | `integration-registry.test.ts`, `departments.test.ts` |
| Email delivery failures are recorded truthfully | `email.test.ts` |
| Staging deploy gate refuses placeholder secrets, shared caches, public buckets and production references | `staging-gate.test.ts` |
| Production gate refuses staging resources, a shared database server, unverified TLS, synthetic terminology, enabled integrations, missing backups or migrations, and early domain attachment | `production-gate.test.ts` |
| Production secrets are generated with OpenSSL only when missing, never overwrite local or remote values, and data-bound keys need fresh-installation evidence | `production-secrets.test.ts` |
| Production never serves synthetic terminology; an unconfigured service reports 503 | `terminology-unavailable.test.ts` |

## Findings

| Severity | Finding | Status |
|---|---|---|
| High | Feature flags enabled device ingestion, AI jobs and telehealth "media configured" without adapters | Fixed (integration registry) |
| High | Client bundle used `react-router` with open-redirect advisories | Fixed (7.18.5; production `npm audit`: 0 vulnerabilities) |
| Medium | PACS state could be asserted manually | Fixed |
| Medium | Dev-tooling advisories (vitest, wrangler/miniflare, concurrently, esbuild dev server) | Open; not shipped to users, upgrade in a tooling-only change |
| Medium | No Content-Security-Policy header; HSTS relies on the `.dev` preload list | Open |
| Medium | In-memory rate limiter is per isolate, not global | Open (`docs/IMPLEMENTATION_GAPS.md`) |
| Medium | `patients` RLS lets any MFA-verified staff member read minimal global identity; application paths add tenant checks | Accepted for synthetic MVP; review before real data |
| Medium | Emailed sign-in codes are a weaker second factor than TOTP: whoever controls the mailbox can reset the password and then pass verification | Accepted so staff without their authenticator can sign in; codes are hashed and bound to the sign-in, expire in 10 minutes, at most 3 sends and 5 wrong codes per sign-in, audited. Review before real data |
| Low | Login page shows the local-development TOTP button and demo-account card in staging | Open |

## Privacy notes

- Patient search audit events record the scope and result count, not the search term.
- Logs and audit metadata avoid clinical narrative; email bodies contain links or a sign-in code only.
- Retention, archival, data-subject requests and breach response workflows are not implemented and are BLOCKED on policy decisions.
- Backups: Aiven-managed backups are assumed but no restore drill has been performed (BLOCKED).
