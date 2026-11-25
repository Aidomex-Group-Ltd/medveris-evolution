# Production Infrastructure Evidence

Date: 2026-11-23
Repo: `/home/aidomex/medveris`
Safety: read-only evidence; no Cloudflare, systemd, Worker, DNS, tunnel, or secret change was made.

## 1. Evidence

| Evidence | Path |
|---|---|
| Independent review | `docs/audit/PRODUCTION_INDEPENDENT_REVIEW.md` |
| Infrastructure review | `docs/audit/PRODUCTION_INFRASTRUCTURE_REVIEW.md` |
| Go-live acceptance | `docs/audit/PRODUCTION_GO_LIVE_ACCEPTANCE.md` |
| Deploy workflow diff | `.github/workflows/deploy-production.yml` |
| Deploy script diff | `scripts/production-deploy.mjs` |
| Gate script diff | `scripts/production-gate.mjs` |
| Gate unit test | `/tmp/ready/phaseA/production-gate-test.out` |
| Lint / typecheck | `/tmp/ready/phaseA/lint.out`, `/tmp/ready/phaseA/typecheck.out` |

## 2. Current source changes

| Area | Evidence | Disposition |
|---|---|---|
| Backup inventory in workflow | `.github/workflows/deploy-production.yml:77`, `:80`, `:89` | `SOURCE REVIEWED`; production secret still absent |
| Gate backup stanza | `scripts/production-gate.mjs:22` | `SOURCE REVIEWED`; `SOURCE TESTED` by gate unit `26/26` |
| Backup attestation validation | `scripts/production-gate.mjs:339-372` | `SOURCE REVIEWED`; `SOURCE TESTED` |
| Deploy evidence plumbing | `scripts/production-deploy.mjs:147-150` | `SOURCE REVIEWED`; not production-verified |
| Production AI secrets | `wrangler.jsonc:406-414` no longer requires `AI_TOKEN`/`OLLAMA_*` while `FEATURE_AI=false` | `SOURCE REVIEWED`; `SOURCE TESTED` |
| Payment secrets | `wrangler.jsonc:390-391` keeps `FEATURE_PAYMENTS=false`, `PAYMENT_PROVIDER=livepay`; `:412-413` still declares LivePay secrets while gate requires Yo when payments are enabled | `APPLICATION BLOCKED`; mismatch remains |
| DB setup hyphen fix | `scripts/db-setup.ts` quoted database identifier | `SOURCE REVIEWED`; not production-verified |

## 3. Production facts

| Check | Current result | Disposition |
|---|---|---|
| Deployed Worker | `medveris-production`, version `13001954-5d14-48c3-9378-ca65c04c370c`, tag `18f842a`, created `2026-11-13T13:20:37.83605Z` | Stale |
| Reviewed local HEAD | `7117f36813126010d03e20d975ce97437ecd3388` | Not deployed |
| Working tree | `21` modified tracked entries, `17` untracked entries | Blocks non-dry-run deploy |
| Cloudflared unit | `/etc/systemd/system/cloudflared-medveris.service` owned `deploy:deploy`, mode `0644`, `User=root` | Critical |
| Root diagnostics | `sudo: interactive authentication is required` | Operator blocked |
| Alert webhook | `/etc/medveris/backup-alert-webhook` empty | Critical should-fix |
| Health monitor | no `medveris-health-monitor` unit found | Should-fix |
| Worker/DB locality | no placement benchmark or residency sign-off | Unverified |
| Object delivery | `apps/api/src/lib/storage.ts` buffers whole objects | Should-fix |

## 4. Deploy gate status

Local checks this session:

- `npm run lint` → `0`
- `npm run typecheck` → `0`
- `npx vitest run --config vitest.config.ts tests/unit/production-gate.test.ts` → `26/26`

Production gate still cannot pass because:

- `PRODUCTION_BACKUP_INVENTORY` is absent;
- `backup-verification.json` has empty `backupLabel`;
- `pgbackrest.service` is unstable;
- working tree is dirty;
- deployed Worker tag does not match reviewed HEAD.

## 5. Pass/fail commands

```bash
test -z "$(git status --porcelain)"
npx --no-install wrangler deployments list --env production
npm run deploy:production:check
ssh medveris-hapi 'stat -c "%U %a" /etc/systemd/system/cloudflared-medveris.service'
ssh medveris-hapi 'sudo -n -l'
npm run audit:runtime
```

Expected results: clean tree; reviewed tag; gate `0`; Cloudflared `root 644`; scoped sudo list; audit `0`. Current production results do not pass.

## 6. Decision

- `SOURCE TESTED` for gate logic.
- Observed in production: stale deployment, Cloudflared unit, and alert gaps.
- Infrastructure approval is withheld until a reviewed commit is deployed, provenance is verified, the unit is corrected, and alerts are delivered end-to-end.
