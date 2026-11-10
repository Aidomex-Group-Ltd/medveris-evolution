# Phase 1A — Protected Endpoint Inventory (evidence-based)

Generated from static route inspection on `phase1a/rbac-backend-authz` (baseline `79d91a8`). Counts are approximate regex-based signals, not proof of correctness.

## Guard legend
- **AuthN:** `requireAuth`, `requireStaff`, `requirePatient`, `requirePlatformReviewer`
- **Actor/DB context:** `withActor`, `withStaffActor`, `withPlatformActor`, `withReviewerActor`, `withStaleTolerantRead`
- **AuthZ checks:** `permissionsForRoles`, `assertAuthorized`/policy, role predicates/assertions, `isPlatformOperator`, `ForbiddenError` conditions, scope checks
- **RLS:** transaction-local `app.*` context + Postgres policies/grants (independent layer)

## Route inventory

| Route | Handlers | Guard signals | AuthN/Context | AuthZ mechanism (observed) | Tenant/org binding | Notes / residual risk |
|---|---:|---:|---|---|---|---|
| admin.ts | 56 | 41 | staff/platform | membership manager/delegation checks, platform-operator workflow guards, MFA step-up/SoD, `withStaffActor/withPlatformActor` | active tenant from session | High-risk admin/privilege flows; generalized dual-auth not active |
| ai.ts | 8 | 8 | staff | clinical write assertions, integration availability, actor-scoped writes | active tenant | Verify task-specific permissions/policy coverage |
| auth.ts | 49 | 14 | mixed public/authenticated | rate limits, token/session/password/MFA flows, server-side tenant selection | server-derived default/selected membership | Public endpoints by design; must never trust client tenant authority |
| billing.ts | 30 | 40 | staff/platform | billing scope/view/manage assertions, platform actor for operator actions | billing scope resolved server-side | Facility subscription vs patient billing distinctions must remain enforced |
| care.ts | 19 | 19 | staff | role/clinical guards | active tenant | Verify per-action permission granularity |
| clinical.ts | 55 | 48 | staff | clinical read/write/sign helpers + `assertAuthorized` for note sign/amend/error/void/archive | active tenant/patient linkage | Stronger policy use than most routes; continue coverage review |
| consent.ts | 21 | 25 | auth/staff/patient contexts | consent/proxy/emergency/break-glass checks | subject/patient/tenant scoped | Emergency override and PHI access need full audit/authorization verification |
| content.ts | 79 | 61 | auth/staff | `permissionsForRoles`, audience/visibility/tenant rules, some SoD | tenant/patient-aware scoping | Mixed public/auth paths; complex visibility logic risk |
| credentials.ts | 18 | 38 | staff/reviewer/platform | reviewer separation, status/verification checks | tenant/platform scoped | Privileged verification actions |
| data-exchange.ts | 17 | 21 | staff | `permissionsForRoles` (implied roles), scope restrictions, sensitive export checks | active tenant + dataset scope | Export/PHI boundary high risk |
| devices.ts | 21 | 19 | staff | role/permission patterns | active tenant | Verify device/patient linkage checks |
| diagnostics.ts | 66 | 74 | staff | diagnostics assertions + permissions | active tenant | Large surface, queue/result actions |
| directory.ts | 56 | 55 | mixed public/staff/platform | permission checks, platform moderation/operator guards | tenant/platform depending action | Public reads + protected mutations/moderation |
| documents.ts | 40 | 36 | auth/staff | permission/RLS/actor checks | active tenant/patient | PHI/file access sensitivity |
| ehmis.ts | 40 | 48 | staff | permission checks | active tenant | Reporting/export sensitivity |
| emergency.ts | 17 | 15 | staff | emergency/clinical role guards | active tenant | High-risk care workflow |
| facility-logo.ts | 6 | 10 | staff | `requireStaff` + `withStaffActor`; upload/branding actions | active tenant | Confirm explicit admin/permission intent and file validation controls |
| finance.ts | 76 | 79 | staff | finance assertions, price/payment rules, targeted SoD self-action guards | active tenant | High-risk money mutations; generalized dual-auth pending design approval |
| inpatient.ts | 77 | 61 | staff | ward/clinical/role guards | active tenant | Large clinical/operational surface |
| integrations.ts | 27 | 32 | staff/platform | permission/platform checks | tenant/platform | Credential/integration risk |
| inventory.ts | 134 | 119 | staff | extensive permission + department/unit scope checks | tenant + location/scope | Largest route; many mutating operations |
| legal.ts | 6 | 3 | public + auth | public document fetch; authenticated acceptance/history via `requireAuth/withActor` | user/session scoped | Append-only acceptance semantics |
| maternity.ts | 54 | 48 | staff | clinical/role guards | active tenant | Sensitive clinical domain |
| me.ts | 18 | 12 | auth/patient | `requireAuth/requirePatient`, actor-scoped DB context | session/user/patient; tenant switch validated against memberships | No client tenant authority accepted |
| notifications.ts | 3 | 3 | auth | `requireAuth` + `withActor`; RLS self-scope by recipient user | user-scoped (recipient) | Adequate for inbox/self-mark-read if RLS intact |
| onboarding.ts | 37 | 46 | mixed | auth/staff/invitation/registration checks | server-resolved context/tokens | Complex flows, verify least privilege |
| operations.ts | 58 | 51 | staff | role/permission checks | active tenant | Operational mutations |
| ops.ts | 4 | 2 | platform for status | `/health/ready` intentionally unauthenticated liveness/readiness probe; `/ops/status` uses `withPlatformActor` (requires platform operator) | none/platform | Readiness endpoint should remain non-sensitive; status is aggregate-only |
| organization.ts | 64 | 56 | staff | membership/admin checks | active tenant/org relations | Tenant/org boundary critical |
| organizations.ts | 30 | 7 | auth/org actor | `requireOrganizationActor` + `requireRole` (org membership) for admin/reporting actions | organization membership, not facility active tenant | Cross-tenant aggregation/reporting must enforce org membership and site visibility rules |
| patient-merge.ts | 10 | 14 | staff | privileged checks | tenant/patient | High-risk identity operation, dual-auth candidate |
| payment-callbacks.ts | 17 | 0 | **public webhook** | signature/provider verification, reference-to-tenant resolution server-side, rate limits, idempotent evidence application, system actor DB context | resolved from trusted reference/provider evidence | Must not accept client tenant/user authority; replay/signature failures handled |
| pharmacy-pos.ts | 29 | 33 | staff | cashier/clinical/role guards | active tenant | Money/dispense operations |
| pharmacy.ts | 30 | 37 | staff | pharmacist/clinical guards | active tenant | Medication operations |
| platform-observability.ts | 16 | 4 | auth/platform | `requireOperator` (`isPlatformOperator` -> `requireAuth` + platform role) on every endpoint; `withPlatformActor` for jobs DB; read-only proxy | platform scope | Ensure all future endpoints keep operator gate |
| procurement.ts | 13 | 21 | staff | `permissionsForRoles` + scope assertions + `withStaffActor` | active tenant + location/department scope | Financial/supply chain mutations |
| programmes.ts | 39 | 34 | staff | role guards | active tenant | Clinical/program workflows |
| promotions.ts | 20 | 47 | staff/platform | permission/platform checks | tenant/platform | Billing/moderation sensitivity |
| public.ts | 13 | 0 | **public** | none (by design), read-only/config/status/terminology reachability controls | none | Must not expose PHI/secrets; rate/abuse controls handled elsewhere as applicable |
| radiology.ts | 33 | 35 | staff | diagnostics permissions + PACS/image access checks | active tenant | Imaging/PHI sensitivity |
| realtime.ts | 4 | 4 | auth/staff | ticket issuance requires auth, MFA/staff when tenant active, rate limit, authorized channels | session/active tenant | Upgrade path separate from route; ticket scope must remain server-derived |
| reception.ts | 57 | 52 | staff | role/rate-limit checks, registration billing integration | active tenant | Patient registration and initial billing side effects |
| reports.ts | 4 | 7 | staff | report allowlist by role + department scope checks | active tenant/department | Export/report authorization and PHI leakage controls need verification |
| subscription-checkout.ts | 11 | 15 | staff | billing manage scope, idempotency, rate limit, integration checks | billing scope server-resolved | Payment initiation sensitive; no browser redirect trusted as payment |
| telehealth.ts | 22 | 17 | staff | role/clinical guards | active tenant | Session/media access sensitivity |
| theatre.ts | 37 | 29 | staff | role/clinical guards | active tenant | Clinical workflow |
| workflow.ts | 28 | 34 | staff | visit/queue role helpers, department-only scoping for non-whole-visit roles | active tenant | Order routing integrity/authorization coupling |
| workforce-reference.ts | 18 | 20 | staff | permission/reference checks | active tenant/global refs as applicable | Admin/reference data changes |
| workspace.ts | 27 | 35 | staff | permission checks for manage/link actions | active tenant/workspace | Org linkage and workspace profile mutations |

## Endpoints intentionally not session-protected
- `public.ts` read-only/config/status endpoints.
- `legal.ts` public legal document pages (authenticated endpoints in same file are protected).
- `auth.ts` login/register/recovery/invitation verification/token flows (protected by flow-specific tokens/rate limits/state checks).
- `payment-callbacks.ts` provider webhooks (protected by cryptographic signature/reference verification and server-side tenant resolution).
- `ops.ts` `/health/ready` liveness/readiness probe (non-sensitive aggregate response).

## Highest-priority verification targets (Phase 1A+)
1. Finance high-risk mutations and config changes (SoD/dual-auth candidates).
2. Admin/membership/role/privilege/platform-operator operations.
3. Clinical record read/write/sign, emergency access, merges, exports.
4. Data exchange, integrations, directory moderation, promotion/payment operations.
5. Any mutation path relying only on coarse `requireStaff` without explicit action-level authorization.
