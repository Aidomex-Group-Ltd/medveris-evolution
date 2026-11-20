# Phase 0 baseline — gate results

- **Repository:** `/home/aidomex/medveris`
- **Branch:** `pr-readiness-20261116`
- **Date run:** 2026-11-19 (audit date per `PRODUCTION_READINESS_REPORT.md`)
- **Mode:** local run, no deploy/production touches

## Commands run

| Step | Command | Result | Duration (wall) |
|---|---|---|---|
| 1 | `npm run lint` | **pass** (exit 0, max-warnings=0) | 52.7s |
| 2 | `npm run typecheck` | **pass** (exit 0, `tsc -p tsconfig.json --noEmit`) | 2m 0.5s |
| 3 | `npm test` | **pass** (exit 0) | 258.4s |
| 4 | `npm run audit:runtime` | **pass** (exit 0) | 3.8s |
| 5 | `npm run build` | **pass** (exit 0) | 17.4s |

## `npm run lint`

- ESLint `eslint . --max-warnings=0`
- Exit code: **0**
- Failures: 0
- Notes: clean.

## `npm run typecheck`

- `tsc -p tsconfig.json --noEmit`
- Exit code: **0**
- Failures: 0

## `npm test`

- Vitest `vitest run --config vitest.config.ts`
- Exit code: **0**
- Test files: **107 passed** / 107
- Tests: **964 passed** / 964
- Failures: 0
- Duration (vitest reported): 258.40s (transform 10.80s, setup 21.41s, import 66.05s, tests 139.09s, environment 26ms)

Notes:

- The first `npm test` invocation in this baseline run exceeded a 300s wall-time cap and was retried with a longer cap; it completed successfully on retry with exit 0. This baseline records the successful run.
- The stderr output contains many `request_error` events. Those are expected structured log lines from integration tests exercising error paths (401/403/404/409/410/422/503). They are not test failures.
- Examples of exercised error paths: shared-supply refusal, invitation expiry/revocation, subscription restriction, PACS/AI/telemedicine/device integration unavailable (503), forged destination rejection, in-transit transfer blocking, payment overpayment refusal, duplicate invitation handling, MFA-enrollment gating.

## `npm run audit:runtime`

- `node scripts/audit-check.mjs`
- Exit code: **0**
- Findings reported: **0**
- Blocking: **0**

Notes:

- Runtime dependency audit uses `scripts/audit-check.mjs`, not raw `npm audit --audit-level`.
- One documented non-blocking exception exists: the `picomatch` ReDoS chain (`GHSA-fc5q-39xc-vjpf`) via `vitest` → `tinyglobby` → `fdir` → `picomatch`. It is printed as non-blocking and does not fail the gate.
- Vite is pinned to `6.4.6` to resolve the middleware/public-directory advisory.

## `npm run build`

- Root build runs web build + `build:api`.
- Exit code: **0**
- Web: Vite build completed (`✓ built in 14.57s` reported in output).
- API: esbuild emits `apps/api/dist/server.mjs` (2.3MB) and `apps/api/dist/worker.mjs` (3.3MB).
- Failures: 0

## `git status` snapshot (at baseline creation)

On `pr-readiness-20261116`:

**Changes not staged for commit:**
- `.github/workflows/ci.yml`
- `.github/workflows/deploy-production.yml`
- `.github/workflows/deploy-staging.yml`
- `apps/web/package.json`
- `package-lock.json`
- `package.json`
- `scripts/production-deploy.mjs`

**Untracked files:**
- `PRODUCTION_READINESS_REPORT.md`
- `docs/operations/DEPENDENCY_AUDIT_EXCEPTIONS.md`
- `scripts/audit-check.mjs`

## Suggested commit grouping (unverified with owner; not committed yet)

These are proposals only. Do not commit until approved.

### Commit A — runtime dependency audit tooling + documented exception

Proposed scope:
- `scripts/audit-check.mjs` (new)
- `docs/operations/DEPENDENCY_AUDIT_EXCEPTIONS.md` (new)
- `package.json` (adds `audit:runtime` script)
- `apps/web/package.json` (test/audit-relevant dev deps)
- `package-lock.json` (lockfile update)

Proposed message:
> Add runtime dependency audit script and documented picomatch exception

Why:
- This is the audit-friendly replacement for raw `npm audit --omit=dev --audit-level=high` used in CI and the production gate.
- It includes the documented Vitest/picomatch chain exception and the Vite pin resolution note.

### Commit B — CI/deploy workflow hardening (no deploy behavior change)

Proposed scope:
- `.github/workflows/ci.yml`
- `.github/workflows/deploy-production.yml`
- `.github/workflows/deploy-staging.yml`
- `scripts/production-deploy.mjs`

Proposed message:
> Replace raw npm audit with audit:runtime in CI and production gate, and document deploy model

Why:
- Aligns CI and production gate on the same audited runtime check.
- Removes stale comments about cross-Worker artifact promotion and the `pr-readiness-20261116` staging branch auto-deploy.
- Staging now targets the dedicated `staging` branch instead of a PR branch.

### Commit C — production readiness report

Proposed scope:
- `PRODUCTION_READINESS_REPORT.md` (new)

Proposed message:
> Add 2026-11-19 production readiness audit report

Why:
- Read-only audit artifact referenced by Phase 0.

## Assumptions

- Wall-clock durations are from `time` output on this machine and are not a performance baseline for the repo.
- Test counts and durations are from the successful `npm test` run recorded above.
- `npm run audit:runtime` findings are read from its stdout line: `runtime audit: 0 finding(s) reported, 0 blocking`.
- No secrets were read, printed, or committed during this baseline.

## What is not covered by this baseline

- No deploy/production command was run.
- No e2e/Playwright run was executed here.
- No review of whether the GitHub `production` environment required-reviewers are configured.
