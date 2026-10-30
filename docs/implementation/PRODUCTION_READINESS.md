# Production readiness record — 2026-10-30

Status: **DEPLOYED (synthetic data only).** `npm run deploy:production` completed a blue-green release. Worker `medveris-production` version `714d0dbc-061b-43ce-b82a-3f24234b957c` (tag `d88bb21`) serves 100% of traffic on `https://medveris.online` and `https://medveris-production.aidomexgroupltd.workers.dev`; health, readiness, shell, version, assets and production smoke checks passed. Blue version `ce3d711d-c314-4889-b050-a2c7d2b58f3f` (tag `034baf0`) remains available for rollback with `npm run deploy:production:rollback`.

Staging `medveris-staging` version `713ce689-34a6-4f0b-9023-b0c74e5ae5c4` (tag `d88bb21`) serves 100% of traffic; blue `af600732-926e-49ff-9d52-7e2a071509e0` remains for rollback.

This record covers infrastructure and release evidence only. It is not a clinical, legal or privacy sign-off, and production holds synthetic/demo data (2 tenants, 6 users, no patients, encounters or audit events at the time of release).

## Domain

`medveris.online` is attached to the production Worker as a custom domain, so Cloudflare manages the apex address record and certificate. Registration remains with Namecheap until 2027-08-22 and delegates to the Cloudflare nameservers. MX, SPF, DKIM (`resend._domainkey`) and DMARC records are unchanged. `www.medveris.online` is not a declared route; add a proxied placeholder and a Redirect Rule if `www` must resolve.

## Production PostgreSQL (`medverispro`)

`~/.config/medveris/production/db.env` (0600) targets `medverispro-lokangtom2017-78dc.l.aivencloud.com:23226`, a different server from staging, with `sslmode=verify-full` against `~/.config/medveris/production/ca.pem`; all four URLs share that host, and the three role passwords are distinct and at least 20 characters. PostgreSQL 18.6 hosts `medveris_migrator`, `medveris_runtime`, `medveris_jobs` (LOGIN, no superuser, no BYPASSRLS), `medveris_exchange` (NOLOGIN, BYPASSRLS) and `medveris_production` owned by `medveris_migrator`; all login roles connect with verified TLS. `db-migrate.ts --confirm-database=medveris_production` applied `034`–`038` on 2026-10-30 after the earlier `001`–`033`, each in its own transaction, and the schema integrity check passed.

## Resources (verified 2026-10-30)

| Resource | State |
|---|---|
| Cloudflare account `6337ed24a5f8ff4ec3f74517a55a7e6b` | Wrangler session has access |
| Zone `medveris.online` | Active; apex served by the Worker custom domain; MX, SPF, DKIM and DMARC untouched |
| Worker `medveris-production` | Deployed; version `714d0dbc-061b-43ce-b82a-3f24234b957c` at 100%, blue `ce3d711d-c314-4889-b050-a2c7d2b58f3f` retained |
| R2 `medveris-production-uploads` | Location WEUR, r2.dev disabled, no public custom domain, no CORS |
| Hyperdrive (production) | `medveris-production-runtime` (`c6e463fe4d6649a3a41c7c38fee16d3d`, `medveris_runtime`) and `medveris-production-jobs` (`770ba2f6008d4b7d97e9045f38d987fa`, `medveris_jobs`) on `medveris_production`, caching disabled, `verify-full` with the Aiven project CA `1227360c-…` |
| PostgreSQL | Production `medveris_production` on `medverispro`; staging `medveris_staging` on a separate server |
| Local secrets | `~/.config/medveris/production/secrets.env` (0600, directory 0700) and `resend.env`; the gate reports all required Worker secrets configured and uploads none |
| Backup attestation | `~/.config/medveris/production/backup-verification.json`: point-in-time recovery and encrypted backups confirmed; restore drill recorded 2026-10-28T17:35:12Z by Omuut |

## Quality gates (from `npm run deploy:production` on 2026-10-30)

| Gate | Result |
|---|---|
| `npm run lint` | Pass |
| `npm run typecheck` | Pass |
| `npm test` (unit and PostgreSQL integration on local PostgreSQL 14) | Pass: 55 files, 495 tests |
| `npm run build` | Pass |
| `wrangler deploy --env production --dry-run` | Pass (2640 KiB / 487 KiB gzip) |
| Migration state | Pass after applying `034`–`038` |
| Health, readiness, shell, version, assets, smoke | Pass on green and after promotion to 100% |

## Migrations

38 migrations (`001`–`038`) are applied on staging and production. `038_notifications.sql` adds the operational notification inbox, its recipient-only RLS policies and the `app.enqueue_inventory_notifications()` function owned by `medveris_exchange`. It is additive and backward compatible with the previous blue version.

## Provider-side actions completed

1. **Backup and restore drill.** Point-in-time recovery and encrypted backups confirmed on the `medverispro` Aiven plan; restore drill recorded.
2. **Resend.** Production secrets are configured; the gate reports all required Worker secrets present.
3. **Domain.** `medveris.online` is attached as a Worker custom domain and verified through the release checks.

## Decisions needing qualified review

- Data residency and cross-border transfer under the Uganda Data Protection and Privacy Act, 2019, including registration with the Personal Data Protection Office: the R2 location hint is Western Europe (R2 has no African region), and the database region is not yet chosen.
- Licensed terminology (SNOMED CT affiliate licence, LOINC terms) before enabling `TERMINOLOGY_MODE=production`. Until then coded entries and UCUM unit validation return 503 in production.
- Content governance before enabling `CONTENT_FEEDS_ENABLED`: imports publish without clinical review.
- Map tiles default to the public OpenStreetMap tile service, whose usage policy limits heavy use; confirm or contract a provider.
- Open findings in `SECURITY_AND_PRIVACY_REVIEW.md` (no Content-Security-Policy, per-isolate rate limiting, emailed sign-in codes, global patient identity RLS) must be accepted or fixed before real patient data.
