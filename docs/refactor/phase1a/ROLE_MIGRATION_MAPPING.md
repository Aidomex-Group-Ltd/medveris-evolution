# Phase 1A — Role and Permission Migration Mapping

Purpose: preserve existing access semantics while moving toward canonical, backend-enforced authorization. **No existing roles or permissions are removed in Phase 1A.**

## 1. Existing roles (preserved)
Source: `packages/authz/src/{index,permissions}.ts`

| Role | Compatibility status | Security/permission mapping notes |
|---|---|---|
| patient | keep | Self/proxy-limited patient actions; no staff tenant privileges |
| proxy | keep | Delegated patient scopes only; explicit expiry/scope checks |
| receptionist | keep | Registration/lookup/front-desk operational permissions; no clinical signing/finance privilege implied |
| nurse | keep | Clinical documentation/observations/care-plan/med administration per bundle; cannot sign clinical notes |
| midwife | keep, implies `nurse` | Adds note signing capability in current model; clinical signing remains subject to policy/credential/privilege context |
| clinician | keep | Clinical read/write/sign/amend/error/void/archive/emergency activation as mapped; signing requires policy checks |
| specialist_clinician | keep | Specialist clinical bundle; not a generic admin/finance role |
| diagnostic_practitioner | keep | Diagnostic creation/worklist/record access per bundle |
| department_lead | keep | Clinical leadership + role-grant request/care-team as mapped; not universal admin |
| facility_admin | keep | Tenant administrative bundle; not clinical signing authority by role alone |
| finance | keep | Finance dashboard/payment/catalog/reporting as mapped; high-risk money ops require SoD/future dual-auth policy |
| auditor | keep | Audit/inventory/report read as mapped; not clinical write/sign |
| credential_reviewer | keep | Platform/credential review permission; distinct from operator |
| pharmacist | keep | Dispense/inventory/procurement as mapped |
| laboratory, radiology, radiographer, radiologist, lab_validator | keep, implied mappings preserved | Department capabilities and sign/validate distinctions preserved (`radiologist` signs radiology reports; validator validates results) |
| ward_manager | keep, implies `nurse` | Ward/bed management + nursing bundle |
| privacy_officer | keep | Audit/privacy review; no clinical record mutation implied |
| public_health, hr, records, theatre, housekeeping, porter, mortuary, cssd, biomedical, quality, it_admin, research | keep | Operational/support/reporting bundles as currently defined |
| content_editor, content_reviewer, opportunity_moderator | keep | Content workflow permissions with separation-of-duties rules |
| owner | keep, implies `facility_admin` | Ownership protections (grant/remove constraints) must remain explicit |
| department_admin, unit_lead | keep (scoped) | Membership-scoped admin/lead permissions; cannot exceed scope |
| staff, report_viewer | keep | Limited baseline/read/report access as mapped |

## 2. Existing permission identifiers (preserved)
Source: `packages/authz/src/permissions.ts` (`PERMISSIONS`, `ROLE_PERMISSIONS`).

- **Status:** all existing permission identifiers retained in Phase 1A.
- **Migration action:** map route/service checks to these canonical permissions or policy actions; add new permissions only additively with evidence and compatibility review (none added in this phase except documentation/contract helpers).

## 3. Legacy check to canonical mapping (initial)

| Legacy check/pattern | Current usage examples | Canonical permission(s)/control | Replacement strategy |
|---|---|---|---|
| `requireAuth` | self/account/session routes | authenticated session | Keep; add action-level checks where resource access beyond self/tenant membership is possible |
| `requireStaff` | facility routes | active facility membership + MFA/staff session context | Keep as entry guard; pair with permission/policy checks per mutation/read sensitivity |
| `requirePatient` | patient portal routes | verified patient account context | Keep; enforce self/proxy/released-record constraints |
| `isPlatformOperator` / `withPlatformActor` | admin/platform ops/observability | `platform.operations.manage` + platform role | Keep; ensure every platform-only endpoint uses operator guard before privileged context |
| `permissionsForRoles(...).has(...)` | content, directory, inventory, procurement, workspace, ehmis, etc. | corresponding `PERMISSIONS` | Prefer centralized helper `requireSessionPermission`/`hasSessionPermission`; adopt `assertAuthorized` for contextual actions |
| `assertClinicalRead/Write/Sign`, `canSignClinical` | clinical routes/helpers | `clinical.record.read_authorized`, `clinical.note.create`, `clinical.note.sign` etc. | Preserve; route remaining sensitive note/record actions through policy engine consistently |
| `assertCashier`, `canTakePayments`, finance role checks | billing/finance/POS | `finance.payment.record`, finance/admin bundles | Preserve; add explicit permission checks and dual-auth design hooks for high-risk mutations |
| `assertPriceListManager` | finance/catalog | finance/admin management (current) | Preserve behavior; refine to explicit catalog/pricing permission in future additive change if needed |
| organization `requireRole` | organizations routes | organization membership roles | Preserve; document as organization-scope authorization boundary |

## 4. Database/role-model compatibility
- **RLS GUCs and helper functions:** unchanged; all actor contexts must continue setting `app.tenant_id/user_id/patient_id/actor_kind/roles/platform_role/membership_id/unit_id/department_id` as applicable.
- **Membership/role-grant tables and policies:** no destructive changes in Phase 1A. Existing assignments, implied roles, scoped memberships, and platform roles remain valid.
- **Future additive migrations (if approved):** custom permission grants/assignments, dual-authorization request/decision/execution tables, and endpoint-level audit enrichment must include backfill, compatibility mapping, rollback plan, and isolated verification before any production use.

## 5. Review checklist before replacing any check
1. Identify current allow/deny behavior and affected roles/tenants.
2. Map to existing permission(s) and policy/resource context.
3. Confirm RLS and service invariants still enforce scope.
4. Add/adjust tests for authorized, unauthorized, cross-tenant, escalation, and bypass cases.
5. Deploy additively; remove legacy path only after verification evidence.
