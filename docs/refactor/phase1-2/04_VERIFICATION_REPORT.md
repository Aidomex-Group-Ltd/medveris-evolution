# Verification Report — Phase 1.2 Authorization Matrix Modularization

**Date:** 2026-11-12  
**Branch:** `phase1a/shared-supply-security-closure`  
**Matrix version:** `2026-11-12.phase0-1.foundation` (unchanged)

---

## 1. Scope of This Increment

This increment performed **structural modularization and reconciliation only**. It did not change authorization behavior, did not rewire routes, and did not introduce new permissions.

Stages completed:

| Stage | Deliverable | Status |
|---|---|---|
| 0 | `00_BASELINE.md` — baseline snapshot | ✅ |
| 1 | `matrix.ts` split into `matrix/` domain modules + compat facade | ✅ |
| 2 | `01_API_ROUTE_INVENTORY.md` — 51 routers, 711 routes | ✅ |
| 3 | `02_MATRIX_RECONCILIATION.md` — bindings reconciled | ✅ |
| 4 | `03_ROUTE_COVERAGE_REPORT.md` — coverage metrics | ✅ |
| 5 | Route adoption / enforcement rewiring | ⏸️ Not started (see §7) |
| 6 | This report | ✅ |
| 7+ | Commit / push / deploy | ⏸️ Pending approval (see §8) |

---

## 2. What Changed

### 2.1 Module structure

`packages/authz/src/matrix.ts` (previously ~2,500 lines) is now a **thin compatibility facade** that re-exports from the new package-internal module tree:

```
packages/authz/src/matrix/
  index.ts                 (barrel)
  types/index.ts           (shared types; imports ResourceDomain/ActionVerb from contract)
  version/index.ts         (AUTHORIZATION_MATRIX_VERSION)
  exemptions/index.ts      (NON_PERMISSION_ENDPOINTS)
  lookup/index.ts          (MATRIX_BY_KEY, isKnownMatrixPermission, lookup helpers)
  decision/index.ts        (decideAction, assertMatrixAuthorized, MatrixDeniedError)
  actions/
    index.ts               (aggregates all domain modules → AUTHORIZATION_MATRIX)
    patient.ts             (10)   clinical.ts (29)   pharmacy.ts (3)
    diagnostics.ts (4)     radiology.ts (6)         finance.ts (7)
    billing.ts (4)         inventory.ts (12)        organization.ts (8)
    workforce.ts (10)      content.ts (9)           directory.ts (4)
    integration.ts (9)     platform.ts (3)          audit.ts (2)
    operations.ts (3)      tenant.ts (2)
```

- 125 matrix entries split across 17 domain modules; `actions/index.ts` assembles the ordered `AUTHORIZATION_MATRIX`.
- The facade (`matrix.ts`) exports exactly the previous public API — no additions, no removals.
- No module under `matrix/` imports the compatibility facade (verified).

### 2.2 Reconciliation correction

Ten `admin.ts` bindings omitted the `/admin` mount prefix. They were corrected in the source modules (`organization.ts`, `platform.ts`). After correction, all 325 matrix route patterns match real routes.

---

## 3. Behavioral Parity

The original matrix source was recovered exactly (original `write` + all 10 subsequent edits replayed deterministically from session history), then split. A parity check compared every entry:

| Field | Result |
|---|---|
| Entry count | 125 / 125 |
| `key` set | identical |
| `domain` | identical |
| `status` | identical (98 canonical, 26 legacy, 1 unresolved) |
| `permission` | identical |
| `routeFile` | identical |
| Parity result | **OK (0 drift)** |

Unresolved action remains exactly `patient.merge.request` (`permission: null`). Dual-authorization candidates still include `clinical.note.sign`, `finance.payment.reverse`, `patient.merge.approve`.

---

## 4. API Surface Preservation

- `packages/authz/src/index.ts` imports unchanged (2 imports from `./matrix.js`).
- Facade exports: `AUTHORIZATION_MATRIX`, `AUTHORIZATION_MATRIX_VERSION`, `NON_PERMISSION_ENDPOINTS`, `MATRIX_BY_KEY`, `MatrixDeniedError`, `assertMatrixAuthorized`, `decideAction`, `getMatrixEntry`, `isKnownMatrixAction`, `isKnownMatrixPermission`, `matrixDualAuthorizationCandidates`, `matrixEntriesForDomain`, `matrixEntriesForPermission`, `matrixEntriesForRouteFile`, `matrixUnresolvedActions`.
- Type exports: `AuthorizationScope`, `MatrixDecision`, `MatrixEnforcement`, `MatrixEntry`, `MatrixRequirement`, `MatrixStatus`, `NonPermissionEndpoint`.
- No duplicate export conflicts at the package root (`ActionVerb`/`ResourceDomain` still exported only from `contract.js`).

---

## 5. Checks Run

| Check | Command | Result |
|---|---|---|
| Matrix/authz unit tests | `npx vitest run tests/unit/authz-matrix.test.ts tests/unit/authz.test.ts tests/unit/authz-phase1a.test.ts` | 45/45 passed |
| Typecheck | `npx tsc -p tsconfig.json --noEmit` | exit 0 |
| Lint | `npx eslint . --max-warnings=0` | exit 0 |
| Parity | replayed original vs modular `AUTHORIZATION_MATRIX` | 0 drift |
| Facade isolation | `grep matrix.js` inside `matrix/` | none |

---

## 6. Route Inventory & Coverage (summary)

- Routers: **51**; unique `METHOD path` registrations: **711**.
- Matrix-covered unique routes: **320** (45.0%).
- Exempt (non-permission) unique routes: **36** (5.1%); overlap with matrix: 1.
- Total described coverage: **355** (49.9%).
- Uncovered (gaps): **356** (50.1%) — recorded, not auto-bound.
- All 36 exemption patterns and all 325 matrix patterns resolve to real routes (0 stale).

Full detail in `01_API_ROUTE_INVENTORY.md`, `02_MATRIX_RECONCILIATION.md`, `03_ROUTE_COVERAGE_REPORT.md`.

**Post-verification adoption (2026-11-12):** after owner approval of the gap mappings, the 24
reuse routes were bound, then the inventory NEW slice, the small-domain batch, the
operations/content batch and the maternity/inpatient/diagnostics batch were adopted (231 actions /
473 patterns; 468 matrix-covered, 503 total covered, 208 gaps; still 0 stale; inventory 51/51 covered). The figures above remain the Stage 6 verification baseline. Runtime
route rewiring is still per-slice and not performed by the registry binding.

---

## 7. Known Limitations / Decisions Needed

1. **356 uncovered routes are not bound.** Assigning permissions to them is an owner-approved security decision; guessing would risk over/under-granting. These are catalogued for Stage 5.
2. **Route rewiring not performed.** The foundation explicitly keeps routes on their existing inline enforcement until each is adopted with tests. Mass rewiring (320 covered routes) is high-risk and must be done per slice.
3. **`clinical.ts` is 484 lines** (29 declarative entries; no logic). This exceeds the ~300 LOC guideline but is data-only and cohesive; splitting further would fragment one domain without reducing complexity. Justified exception.
4. **5 multi-claim routes** (`GET /me/records`, `POST /pharmacy/sales`, `POST /lab-results/:id/finalize`, `POST /lab-results/:id/release`, `POST /procurement/purchase-orders/:id/action`) intentionally layer multiple actions; adoption must preserve all checks.

---

## 8. Deployment

**Not performed.** No commit, push, or deployment was executed. Production deployment requires explicit approval, valid credentials/context, and a completed route-adoption verification. See `§7` decisions.

---

*End of verification report.*
