# Autonomous workspaces, organizations and eHMIS reporting

Medveris serves private providers, for-profit and not-for-profit. Every facility, department or service unit runs as its own **workspace** with its own owner, users, transactions, inventory, purchasing and reports. A workspace may later join a parent **organization** (a hospital, health system or facility group) through an explicit, approved link. Facilities confirmed eligible and authorized can report aggregate HMIS data to eHMIS/DHIS2.

This extends the existing tenancy model; nothing was rewritten. A workspace is a `tenants` row, so every existing module, RLS policy, audit trail and report already scopes to it.

## Structure

```
Organization (optional)        organizations, organization_memberships, organization_links
  └─ Facility / site           tenants (workspace_kind = facility)
       ├─ Department           departments (service_category for services inside the facility)
       │    └─ Unit            units
       └─ Department or unit workspace hosted by the facility
                               tenants (workspace_kind = department | service-unit, host_tenant_id)
```

- An independent workspace needs no parent. Its creator becomes `owner` (implies `facility_admin`) and can run it alone.
- An organization never owns a workspace's records. `organization_links` records the relationship; linking or leaving moves and copies nothing, so transaction, inventory, report, user and audit history stays with the workspace's `tenant_id`.
- A department or service unit hosted inside a registered facility keeps its own service category and inherits the host's level for roll-ups only (`rollUpLevel`). It is never reclassified as a separate facility.

## Category and level of care

Four fields are kept apart (`packages/domain/src/facility-classification.ts`, `tenants` columns from migration 032):

| Concept | Column | Rule |
|---|---|---|
| Service category | `service_category`, `service_subtype` | Hospital, clinic (general outpatient / specialty), medical centre, health centre, domiciliary, drug shop, pharmacy, dental, laboratory, imaging/radiology, ophthalmology/eye care, other specialist service. Editable list in code. |
| Official level | `official_level`, `official_level_source`, `official_level_reference` | HC I–HC IV, General/District (5), Regional Referral (6), National Referral (7). Needs a source (NHFR, MoH registration or licence) and a reference. Never overwritten by an inferred value. |
| Medveris equivalent | `equivalent_level`, `equivalent_justification` | Operational comparison for clinic-like categories. General outpatient clinic suggests HC II; a different equivalent needs a scope justification. Labelled “Medveris equivalent — confirm service scope”, never as a Ministry level. |
| Level status | `level_status` | `official`, `medveris-equivalent`, `not-applicable`, `not-yet-assigned`. |

- Hospitals choose the registered Level 5, 6 or 7; an equivalent is refused, and nothing is inferred from name or specialty.
- Drug shops, pharmacies, dental, laboratory, imaging, ophthalmology and other standalone services show “No standalone care level assigned” unless an official level is confirmed.
- “Not yet assigned” is allowed while registration is pending.
- Regulator and registry identifiers (NHFR ID, UMDPC/UNMC/AHPC premises licences, NDA drug-shop or pharmacy licence, PSU, Atomic Energy Council) are separate rows in `facility_registrations`. One live workspace per NHFR ID prevents accidental duplicate onboarding. They are recorded, not verified: no NHFR interface exists.
- Every level change is appended to `tenant_level_history` with who recorded it and why; replacing an official level needs a reason.
- Category and level drive module, report and HMIS-form *recommendations* (`recommendModules`). `enabled_modules` stays editable, and the UI states that a level does not prove a service is offered.

## Onboarding paths

`POST /api/v1/auth/register/workspace` (`apps/web/src/components/WorkspaceSignup.tsx`). The user picks one of three options from a dropdown — **Independent workspace**, **New organization or hospital**, **Join an organization** — and a short stepper asks only for that option's fields, with a review step:

1. `independent` — the unit type (laboratory, imaging/radiology centre, pharmacy, drug shop, clinic, dental, eye care, medical centre, other) and name, then the owner account. No organization is created. The owner of a laboratory, imaging centre, pharmacy or drug shop also receives the unit's bench role (`laboratory`; `radiology` + `radiographer`; `pharmacist`) plus `receptionist` and `finance`, so the unit works from the first sign-in; prescribing, signing and reporting roles (`clinician`, `radiologist`, `lab_validator`) are never self-granted.
2. `organization` — organization name, type and ownership, the main site type, then its first administrator (`organization_owner` and site `owner`).
3. `join` — find the organization by name (`GET /auth/organizations/search`, names only, rate-limited) or confirm a join code (`POST /auth/join-codes/lookup`, which does not consume it), then the unit and account; the link stays pending until an organization administrator approves. A person invited as staff pastes the invitation link instead and is taken to the existing acceptance page.

Registration signs the new owner in (session bound to the new workspace) and sends them to two-step verification, then to the unit's dashboard. Errors return to the step that can fix them with the entered values kept: an existing email offers sign-in or password reset; an invalid code or organization returns to the find step; a rate limit says nothing was created.

`users.last_active_tenant_id` remembers the workspace a user last opened (registration, `POST /me/context`); sign-in reopens it while the membership is active, otherwise it opens the only membership or asks the user to choose. Navigation follows the active workspace's `enabled_modules` (empty for older workspaces means every module) and hides organization screens for workspaces with no active organization link. A standalone laboratory, imaging centre or pharmacy lands on a dashboard built around its own work queue, visits and till.

An existing workspace links later from **Workspace profile → Organization** with a join code. The older `POST /auth/register/facility` still works and creates an independent workspace with an unassigned level.

## Linking, approval and history

- Organization administrators issue single- or multi-use join codes (hashed, expiring, revocable).
- A join request records possible duplicates (same normalised name or shared registry identifier). Approval is refused until the administrator records how the duplicate was resolved; rejecting keeps the existing site authoritative.
- Approval sets `visible_from` to the approval time. Organization roll-ups exclude earlier activity unless the workspace administrator explicitly shares full history (at request time or later, with a reason).
- Organization staff see aggregate counts and amounts only, through security-definer roll-ups (`app.organization_sites`, `app.organization_site_metrics`). Organization membership grants no access inside a site; staff need a site membership for that. Patient-level records are never exposed through a link.
- Either side can end an active link; in-transit transfers must be settled first. Every step is in `organization_link_events` (append-only) and `audit_events`.

## Roles and scope

| Role | Scope | Notes |
|---|---|---|
| `owner` | workspace | Implies `facility_admin`; only an owner grants ownership; the last owner cannot be removed or demoted. |
| `facility_admin` | workspace | Existing role. |
| `department_admin` | one department | Manages that department's memberships (operational roles only), stock, purchasing and reports. |
| `unit_lead` | one unit | Operates the unit's stock and purchasing. |
| `staff`, `report_viewer` | workspace or scope | Basic read and reporting access. |
| `organization_owner`, `organization_admin` | organization | Sites, join codes, link decisions, inventory-mode proposals, members, consolidated reports. |
| `organization_reporting` | organization | Consolidated aggregate reports only. |

Scope is stored on `memberships.scope_department_id/scope_unit_id` (copied from the invitation). The API enforces it (`apps/api/src/lib/scope.ts`) for stock locations, purchase orders, department reports and transaction attribution; RLS keeps every row inside its workspace.

## Autonomous operations

- **Attribution.** Encounters and invoices carry `department_id`/`unit_id`. Scoped staff default to their own department or unit; an invoice inherits its encounter's department.
- **Inventory.** Existing balances, lots, expiry, counts, adjustments, internal transfers and audit are per workspace. Stock stays independent by default.
- **Shared supply.** An organization can propose shared supply per site; it applies only after that site's administrator accepts. Transfers between shared-supply sites post `transfer-out` at the source and `transfer-in` at the destination (`organization_stock_transfers`), each in its own ledger, with discrepancy notes and cancellation.
- **Purchasing.** Suppliers and purchase orders (draft → submitted → approved → partially received / received, or cancelled) per workspace, with optimistic versioning. Receipts post to the stock ledger with lot and expiry and cannot exceed the outstanding quantity.
- **Reports.** Department filter on the report catalogue (forced for scoped roles) and a `department-operations` report. Organizations get a consolidated summary by site and department, with facility roll-ups and CSV export.

## eHMIS / DHIS2 reporting

Sources checked on 2026-10-29: MoH *Guidelines for Implementation of the Electronic Medical Records System* (January 2024, still the current version on the MoH library), MoH *Health Information Exchange and Interoperability Guidelines* (2023), SQIS+ non-state facility types, MoH care-level FAQ, DHIS2 2.41 Web API (`dataValueSets`, `dryRun`, `importStrategy`).

What the guideline says and how it is used:

- Certified private-sector EMRS deployments produce national HMIS reports and integrate with eHMIS/DHIS2. Medveris **does not claim** certification; the deployment must record the authorization reference it operates under (`EHMIS_DEPLOYMENT_AUTHORIZATION_REF`) before live submission can be enabled.
- Monthly reports are pushed by the 7th, validated from the 8th to the 15th and locked after the 15th. This is stored as a configurable `hmis_reporting_rules` row (platform default, per-facility override with its source), not hard-coded.
- Client-level data is for exceptional, authorized cases such as public-health emergencies. Only aggregate reporting is implemented; the authorization scope column accepts only `aggregate`.

Facility workflow (`/ehmis`, `apps/api/src/routes/ehmis.ts`):

1. Record the NHFR ID and the DHIS2 organisation unit UID.
2. Record the Ministry authorization; a platform operator who did not record it verifies it (`eligibility_status = verified`, enforced by a database trigger and check constraints). Category and level never imply eligibility.
3. Add dataset mappings (Medveris source metric with sex/age disaggregation → data element and category option combo) and approve them with a reference.
4. Prepare a period: values come from the facility's own records (`app.hmis_source_metrics`), validated (period ended, org unit mapped, mapping approved, no duplicate elements, whole non-negative numbers, all-zero and locked-period warnings), then approved. Approval recomputes and refuses if source data changed.
5. Export CSV/JSON (`dataValueSet`) for manual entry and record the manual reference — always available, even with no connection.
6. Live submission (only when ready): DHIS2 dry run, then import. Each period revision has an idempotency key; a submitted revision is never sent again, concurrent claims are refused, and a claim abandoned for more than 10 minutes may be retried (DHIS2 imports overwrite rather than duplicate). Corrections reopen the period as a new revision.

Credentials are encrypted server-side with `EHMIS_CREDENTIALS_KEY`, bound to the facility, sent only in the `Authorization` header to the configured host, and never returned, logged or included in errors. Base URLs must be HTTPS, non-private and in `EHMIS_ALLOWED_HOSTS` outside development and tests. Connection tests, dry runs, imports, refusals, exports and manual entries are written to the append-only `hmis_submission_ledger`.

NHFR and other national registries are a separate, `unavailable` registry entry: no approved interface specification, endpoint or credentials exist, so nothing is called and no connection is simulated.

## Migrations

| File | Content | Compatibility |
|---|---|---|
| `031_dicomweb_pacs.sql` | PACS study link and verification records | Additive |
| `032_workspaces_organizations.sql` | Classification columns, level history, registrations, organization memberships/invitations/links/join codes/events, membership and invitation scope, encounter/invoice attribution, suppliers, purchase orders, inter-site transfers, new roles in RLS, roll-up functions | Additive: new columns are nullable or defaulted; replaced policies accept every row and role the previous ones did. Backfills `service_category` from `facility_type`, marks standalone categories `not-applicable`, and records existing `tenants.organization_id` assignments as active links with full history. No organization memberships are created, so no one gains organization access by migration. |
| `033_ehmis_reporting.sql` | Facility eHMIS integration, mappings, periods, ledger, reporting rules, source metrics | Additive; the platform monthly rule is seeded from the January 2024 guideline. |

Old application versions keep working against the new schema, as blue-green releases require.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `FEATURE_EHMIS` | Requests live DHIS2 submission for the deployment | off (`not_requested`; preparation and export still work) |
| `EHMIS_DEPLOYMENT_AUTHORIZATION_REF` | MoH certification or written authorization this deployment operates under | unset → live submission refused |
| `EHMIS_CREDENTIALS_KEY` (secret, ≥32 chars) | Encrypts facility DHIS2 credentials | unset → credentials cannot be stored |
| `EHMIS_ALLOWED_HOSTS` | DHIS2 hosts facilities may use | empty → refused outside development/test |
| `EHMIS_TIMEOUT_MS` | DHIS2 request timeout | 20000 |
| `FEATURE_NHFR` | Requests NHFR integration | off; no adapter exists, so `misconfigured` if set |

## Still needed from outside the codebase

- Ministry of Health EMRS certification or written authorization for the Medveris deployment, then `EHMIS_DEPLOYMENT_AUTHORIZATION_REF`, `EHMIS_CREDENTIALS_KEY` and `EHMIS_ALLOWED_HOSTS`.
- For each facility: its Ministry authorization, NHFR ID, DHIS2 organisation unit, approved dataset/data element/category option combo UIDs from the district biostatistician, and DHIS2 credentials.
- Confirmation that each mapped Medveris source metric matches the current HMIS form definitions (for example HMIS 105 new versus re-attendance).
- An approved NHFR interface specification, endpoint and credentials before any registry lookup is built.
