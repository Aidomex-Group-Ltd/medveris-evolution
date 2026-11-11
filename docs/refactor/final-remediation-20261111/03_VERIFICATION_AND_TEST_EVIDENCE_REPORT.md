# 03 — Verification and Test Evidence Report

## Commands executed and outcomes

| Check | Command | Result | Notes |
|---|---|---:|---|
| Lint | `npm run -s lint` | PASS (exit 0) | Clean. |
| Typecheck | `npm run -s typecheck` | PASS (exit 0) | Completed successfully in this session (addresses prior gate-report hang). |
| Targeted unit (authz) | `npx vitest run tests/unit/authz-phase1a.test.ts tests/unit/authz.test.ts` | PASS | 2 files, 28 tests passed. |
| Targeted integration (workspaces) | `npx vitest run tests/integration/workspaces.test.ts` | PASS | 1 file, 22 tests passed (~22.7s tests, ~40.9s total). Exercised organizations, shared-supply, security closure, RLS/helper/audit cases, and autonomous department/procurement flows in local test context. |

## Behavioral evidence from integration run
- Expected rejection/audit/error paths observed in stderr with correct status classes (e.g. 403/404/409/422 for forged/unauthorized/invalid-state/invariant violations; no-success-audit-on-denied-mutation case passed).
- Deterministic RLS isolation transfer fixture: in-tenant visibility = 1 row, outsider tenant visibility = 0 rows (asserted in test).

## Not executed / incomplete in this pass
- Full repository test suite (`npm test` / all integration/e2e) — **not run** (time/scope; targeted suites prioritized for touched remediation surface).
- `npm run build` — **not run**.
- `npm audit` — **not run** (no dependency changes made).
- `npm run deploy:staging:check` (dry-run) — **not run**; remains environment/credential-dependent and not certified here.
- Hosted/staging migration-state, role/privilege, and backup/restore verification — **not verified** (no hosted access used).

## Evidence summary
- **Verified locally:** lint, typecheck, targeted authz unit tests, targeted workspace/shared-supply integration and security-closure cases including deterministic RLS fixture and audit-denial behavior.
- **Not fully verified:** full-suite parity, build/package/runtime deploy gates, outbox consumer delivery/poison/dedup behavior, and exhaustive cross-module authz/permission matrices beyond exercised cases.
