# MedVeris — Deployment Provenance Report

- **Date:** 2026-11-25
- **Repo:** `/home/aidomex/medveris`

## Findings
- Deployed Worker: `medveris-production`, version `13001954-5d14-48c3-9378-ca65c04c370c`, tag `18f842a`, created `2026-11-13T13:20:37.83605Z` — **stale** vs reviewed HEAD `7117f36` (2026-11-23).
- Reviewed tree was dirty during recovery (release gate requires clean tree).
- Deploy workflow: manual `production` GitHub Environment approval-gated, concurrency `production-deploy`, `CLOUDFLARE_DEPLOY_TOKEN`; gate fail-closed.
- INF-006 remediated locally (object-storage size limit).

## Provenance chain
`reviewed commit -> CI verification -> immutable artifact -> approved deployment -> verified production version`
Currently incomplete at the deploy/verify steps.

## Disposition
Blocked pending: clean release tree, reviewed commit deploy, tag verification, Cloudflared unit correction, alert delivery. Real-data release withheld.
