# Phase 1A Remediation 1 — Backend Authorization Matrix (evidence-based)

Baseline inspected: `fix/phase1a-authz-remediation-1` (preserved from `phase1a/rbac-backend-authz`, HEAD `79d91a8`).  
Method: route/handler/helper inspection (`apps/api/src/routes/*.ts`, `apps/api/src/lib/{actor,authorization,errors,scope}.ts`, `apps/api/src/auth/middleware.ts`, `apps/api/src/services/access.ts`, `packages/authz/*`, `packages/db/migrations/032_workspaces_organizations.sql`, existing tests). Not every SQL statement traced; RLS treated as independent control where DB context wrappers/migrations indicate enforcement. Gaps marked `unresolved`/`partial`.

## Legend
- **AuthN**: session (`requireAuth/requireStaff/requirePatient`), platform operator/reviewer, public/webhook/signature, anonymous/system.
- **Permission**: canonical permission or explicit policy; `role/predicate` = legacy/ad-hoc; `none(public)` = intentional.
- **Contextual**: tenant/org/membership/resource ownership/state checks observed.
- **RLS**: expected via `withActor/withStaffActor/withPlatformActor` + `set_config`/policies or DB function guards; `n/a` for non-DB/public.
- **Audit**: `writeAudit`/event recording observed in some paths; not exhaustively traced.
- **Status**: `pass` (defensible for inspected scope), `partial`, `missing`, `intentional-public`, `unresolved`.

## Group A — Finance and billing
| Route/job | AuthN | Permission | Contextual policy | Domain invariant | RLS | Audit | Tests | Finding |
|---|---|---|---|---|---|---|---|---|
| `finance.ts` catalog/settings/payments/refunds/voids/waivers/etc. | `requireStaff` + `withStaffActor` | `assertPriceListManager`/`assertCashier`/`assertFinance` role predicates; `finance.payment.record` role bundle relevant | tenant from `activeTenant`, facility settings/rules, SoD checks in places, idempotency/rate limits | price/currency precision, payment state, confirmation reasons | yes (staff actor tx) | present for many mutations | integration `billing`/finance-related suites exist (not fully audited this increment) | **partial**: legacy price-list guard unresolved for canonical permission mapping (no dedicated catalog permission); high-risk finance mutations need per-endpoint permission+SoD/policy review |
| `billing.ts` | staff/platform split (`requireStaff`/`withStaffActor`/`withPlatformActor`) | billing scope/manage checks, role/predicate mix | tenant/platform separation, provider/config checks | billing state/subscription rules | yes | partial | billing/subscription tests exist | **partial** |
| `pharmacy-pos.ts` | `requireStaff` | cashier/clinical/role guards | tenant, encounter/patient linkage | POS/payment invariants | yes | partial | integration coverage exists | **partial** |
| `subscription-checkout.ts` | `requireStaff` | billing-manage scope checks | tenant, idempotency, provider checks | checkout state | yes | partial | tests exist | **partial** |
| `payment-callbacks.ts` | public webhook (no session) | none (intentional) | signature/provider verification, tenant resolved server-side from reference/hash, rate limited, `withAnonymous/withContext(system)` | idempotency/replay/state transitions | system-context DB; RLS bypass by design for callback processing must be constrained by verified reference | callback/audit paths in service layer (not fully traced) | integration coverage expected; not reverified | **intentional-public/partial evidence**: compensating controls present; requires dedicated webhook forgery/replay/tenant-binding review |

## Group B — Admin, membership, and platform
| Route/job | AuthN | Permission | Contextual policy | Domain invariant | RLS | Audit | Tests | Finding |
|---|---|---|---|---|---|---|---|---|
| `admin.ts` | staff/platform guards | mixed predicates/permissions, role delegation, step-up/SoD in areas | membership/tenant scope, platform workflows separated | grant/review invariants | yes | extensive in sensitive flows | integration/admin tests exist | **partial**: heterogeneous enforcement styles |
| `organization.ts` | staff/membership checks | permission/predicate checks | tenant/org membership/resource scope | org structure rules | yes | partial | integration `workspaces`/org tests | **partial** |
| `organizations.ts` | `requireOrganizationActor` | `requireRole` org membership roles | org membership role checks | link/site/report invariants | yes | present for mutations | `workspaces.test.ts` | **partial** (org-role model, not canonical permission engine) |
| `workspace.ts` (non-shared-supply) | `requireStaff` | `workspace.profile.manage`, `organization.link.manage`, `inventory.stock.read/receive/transfer.manage` (session bundle checks) | tenant from active session, live link locking/state checks, location/item scope assertions in supply flows | level/registration/link/inventory-mode rules | yes (`withStaffActor`) | many mutations audited | `workspaces.test.ts` | **partial**: permission-only session checks + route invariants; needs per-mutation matrix hardening |
| `credentials.ts` | reviewer/staff/platform separation | review permissions/predicates | reviewer/platform context | credential lifecycle | yes | partial | integration coverage | **partial** |
| `platform-observability.ts` | `requireOperator`/platform actor | platform eligibility gate | platform-only, aggregate-only intent | observability scope | platform actor tx for DB | partial | limited | **partial** |
| `ops.ts` `/health/ready` | none | none | dependency probe only, no sensitive data | n/a | n/a | no | operational | **intentional-public** |
| `ops.ts` `/ops/status` | `withPlatformActor` | platform operator gate | platform-only aggregate state | n/a | platform actor tx | no explicit audit observed | limited | **partial** (gate-only helper semantics remediated in contract/docs; route uses platform actor wrapper) |

## Group C — Clinical records and workflows
| Route/job | AuthN | Permission | Contextual policy | Domain invariant | RLS | Audit | Tests | Finding |
|---|---|---|---|---|---|---|---|---|
| `clinical.ts` | staff/patient contexts | mix of predicates and policy engine (`assertAuthorized`/`loadAccessActor`) for sensitive note actions | care-team/tenant/patient context in policy and route checks | clinical note state/sign/amend rules | yes | present for sensitive actions | clinical integration/unit tests exist | **partial**: strongest in sensitive note actions; broader clinical surface not fully inventoried per handler |
| `consent.ts` | patient/staff/proxy contexts | policy/role checks vary | consent/resource/patient relationships | consent/legal basis rules | yes | partial | consent tests | **partial** |
| `patient-merge.ts` | staff privileged | admin/clinical predicates | tenant/resource identity checks | irreversible merge invariants | yes | expected | integration coverage | **partial/high-risk** |
| `emergency.ts`, `care.ts`, `workflow.ts`, `diagnostics.ts`, `radiology.ts`, `pharmacy.ts`, `inpatient.ts`, `maternity.ts`, `theatre.ts` | mostly `requireStaff` | role/predicate/permission bundles, modality-specific checks | tenant/department/encounter/resource checks vary | strong domain workflows | yes | varies | domain integration tests exist | **partial**: large heterogeneous surface; diagnostics/radiology use `assertDiagnostics` + specific permissions in parts |

## Group D — Data exchange and content
| Route/job | AuthN | Permission | Contextual policy | Domain invariant | RLS | Audit | Tests | Finding |
|---|---|---|---|---|---|---|---|---|
| `data-exchange.ts` | staff | permission checks | tenant/scope restrictions | exchange consent/state rules | yes | partial | tests exist | **partial** |
| `integrations.ts` | platform/admin | platform/admin permission checks | platform/config scope | integration config safety | yes/platform context | partial | integration tests | **partial** |
| `directory.ts` | mixed public/staff/platform | moderation/manage permissions for protected ops | tenant/moderation state | publication/claim rules | mixed | partial | directory tests | **partial** (public reads intentional) |
| `promotions.ts` | staff/platform | permission/platform checks | tenant/moderation/billing linkage | promotion lifecycle | yes | partial | tests | **partial** |
| `content.ts` | mixed auth/staff/public aspects | permission checks + policy SoD/audience rules | tenant/audience/visibility | content lifecycle | yes/mixed | partial | content tests | **partial** |
| `documents.ts` | auth/staff | permission/RLS patterns | tenant/resource ownership | document state | yes | partial | tests | **partial** |
| `reports.ts` | `requireStaff` | report role allowlist per definition (`allowed(report, roles)`) | tenant, scope/department restrictions, sensitive export audit, rate limits | report range/timezone bounds, CSV export handling | stale-tolerant read with actor/RLS context + staff audit tx | sensitive/view/export audited | report tests exist | **partial**: role-based, not canonical permission/action registry; sensitive reads audited |
| `ehmis.ts` | staff | permission checks | tenant/report scope | submission rules | yes | partial | tests | **partial** |

## Group E — Identity, onboarding, and realtime
| Route/job | AuthN | Permission | Contextual policy | Domain invariant | RLS | Audit | Tests | Finding |
|---|---|---|---|---|---|---|---|---|
| `auth.ts` public subpaths | public/auth flows | n/a | token/session/rate-limit/CSRF rules | credential/session lifecycle | mixed | auth events | auth tests | **intentional-public/mixed** (protected subpaths require per-path review) |
| `auth.ts` protected subpaths | `requireAuth` and specific guards | varies | session/user/tenant context | MFA/session rules | yes | yes | auth tests | **partial** (not fully remapped this increment) |
| `onboarding.ts` | auth/staff/invitation flows | permission/role checks vary | invitation/tenant/org binding | onboarding state | yes/mixed | partial | onboarding/workspace tests | **partial** |
| `reception.ts` | staff | role checks/rate limits | tenant/patient/visit scope | registration/queue rules | yes | partial | reception tests | **partial** |
| `me.ts` | `requireAuth/requirePatient` | self-scope | actor-scoped reads/writes, tenant selection constraints | profile/context rules | yes | limited | me tests | **partial** |
| `realtime.ts` | authenticated ticket issuance | MFA/staff checks, rate limit | tenant/session binding | connection authorization | n/a for ticket issuance DB reads scoped | limited | realtime tests | **partial** |
| `notifications.ts` | `requireAuth` + `withActor` | implicit self-scope | relies on actor context/RLS recipient scoping | notification delivery state | yes (recipient/user context) | limited | tests may exist | **partial** (self-scope reliance should be evidenced) |

## Group F — Operational mutations
| Route/job | AuthN | Permission | Contextual policy | Domain invariant | RLS | Audit | Tests | Finding |
|---|---|---|---|---|---|---|---|---|
| `inventory.ts` | `requireStaff` | extensive `inventory.*` permission checks + scope assertions | tenant/location/item/lot scope | stock ledger invariants, lot/expiry/recall rules | yes | many operations | `inventory` integration tests | **partial but comparatively strong**; cross-tenant/resource checks largely delegated to scoped queries + RLS + assertions (needs exhaustive handler audit) |
| `procurement.ts` | `requireStaff` | permission checks + scope assertions | tenant/department/location/item scope | PO/receipt state rules | yes | present | workspaces/procurement flows | **partial** |
| `workspace.ts` shared-supply (selected slice) | `requireStaff` + `withStaffActor` | `inventory.stock.read`, `inventory.transfer.manage`, `inventory.stock.receive` session-bundle checks | **hardened this increment**: tenant from active session only; shared-supply listing requires active link + accepted shared-supply mode; transfers filtered to current tenant involvement; dispatch validates server-side shared-supply arrangement; receive/cancel locked by tenant role and revalidated against shared arrangement + transfer organization; location/item scope assertions retained | transfer status, quantity/discrepancy/lot rules, open-transfer constraints, ledger posting functions | yes + DB functions `app.shared_supply_*`/policies (migration 032) | dispatch/receive/cancel audited | existing `workspaces.test.ts` flow exercises happy path; no dedicated cross-tenant negative API tests added yet in this increment | **partial (improved)** |
| `operations.ts`, `devices.ts`, `programmes.ts`, `telehealth.ts`, `facility-logo.ts`, `workforce-reference.ts` | staff/auth | role/predicate/permission checks vary | tenant/resource scope varies | domain rules vary | mostly yes | varies | mixed | **partial**; `facility-logo.ts` performs tenant-scoped staff writes but route-level permission/role check beyond `requireStaff` not evident in inspected excerpt (needs confirmation) |
| `facility-logo.ts` | `requireStaff` | none explicit beyond staff role session | tenant from active tenant, rate limited, upload validation/storage quarantine flow | file/type/signature/size processing | yes for DB updates | update/remove audited | no dedicated authz-negative test found | **unresolved/partial** |

## Group G — Background jobs and consumers
| Route/job | AuthN | Permission | Contextual policy | Domain invariant | RLS | Audit | Tests | Finding |
|---|---|---|---|---|---|---|---|---|
| `apps/jobs/src/*`, outbox relay/consumers | system/job context (`actorKind=system`, job DB role) | not session-permission based | claims outbox rows by authoritative DB state; payload identifiers must be matched, not trusted for authority | idempotent processing/retry safety | job-role grants/RLS policies and system context by design | job/outbox audit/events vary | job tests exist in places (not audited this increment) | **partial/unresolved for selected slice**: shared-supply mutations are synchronous route operations posting ledger/outbox events; consumer-side privileged behavior not revalidated in this increment |

## Selected bounded enforcement slice (implemented)

**Slice:** `apps/api/src/routes/workspace.ts` shared-supply endpoints only:
- `GET /workspace/shared-supply`
- `POST /workspace/shared-supply/transfers`
- `POST /workspace/shared-supply/transfers/:id/receive`
- `POST /workspace/shared-supply/transfers/:id/cancel`

**Justification:** smallest coherent high-risk group with clear existing permissions (`inventory.stock.read`, `inventory.transfer.manage`, `inventory.stock.receive`), tenant-scoped session context (`requireStaff`/`withStaffActor`), server-side arrangement primitives (`app.shared_supply_organization/sites`, `organization_stock_transfers`), and existing integration coverage (`tests/integration/workspaces.test.ts`). Semantics were evidence-supported from route + migration behavior; no owner policy decision required. Changes preserve legitimate workflow while tightening contextual checks (active accepted shared-supply link required for listing, tenant-involved transfer filtering, arrangement revalidation on receive/cancel).

**Not included:** workspace profile/modules/registrations/link/inventory-mode response/endpoints and all other route groups remain unchanged except unrelated helper/contract remediation.

## Outstanding gaps (explicit)
1. Canonical permission for price-list/catalog management is unresolved; `assertPriceListManager` remains role-based and must not be mapped to read-only finance permission. Owner decision required.
2. No full route-by-route action registry; many endpoints use heterogeneous role/predicate/permission checks.
3. Finance, admin/platform, patient-merge, webhooks, content/directory moderation, and most clinical/operational mutations require endpoint-level hardening and DB-backed negative tests.
4. Shared-supply selected slice lacks new dedicated cross-tenant/unauthorized API-negative integration tests in this run (existing happy-path coverage only); job/consumer authorization for emitted outbox events not revalidated.
5. `facility-logo.ts` authorization intent (any staff vs workspace/profile admin) unresolved from inspected evidence.
6. `notifications.ts` relies on self-scope/RLS pattern not independently proven by new tests here.
7. Policy engine adoption is limited; session-permission checks remain permission-only by design and must be paired with contextual/domain controls per route.
