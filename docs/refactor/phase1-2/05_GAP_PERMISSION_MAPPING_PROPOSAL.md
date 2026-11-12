# Gap Permission-Mapping Proposal — Phase 1.2

**Date:** 2026-11-12  
**Status:** APPROVED for adoption (owner sign-off 2026-11-12). The 346 permission mappings (24 reuse + 322 new) below are authoritative; the 10 exemption candidates remain unverified and must not be exempted until their controls are confirmed. Adoption proceeds in slices; approval of a mapping does not itself grant a permission or change runtime enforcement.

**Adoption log:**
- 2026-11-12 — reuse slice: 24 routes bound in the matrix (inventory, radiology, organizations, onboarding).
- 2026-11-12 — inventory NEW slice: 15 routes bound; 13 new permissions added to the catalog and granted to the approved candidate roles. Inventory is 30/30 covered.
- Remaining: 307 NEW routes across the other domains; 10 exemption candidates.

## How to read this

- Covers the 356 API routes that currently have neither a matrix action nor a declared exemption.
- **reuse existing**: a permission already in `PERMISSIONS` shares the resource and read/write family; approved for adoption.
- **NEW (owner approval required)**: no existing permission shares the resource; identifier follows `<domain>.<resource>.<verb>`. Approved for catalog/adoption slice by slice.
- **EXEMPT candidate**: likely public/webhook/authenticated-self flow. Verify and add to `NON_PERMISSION_ENDPOINTS` with controls — never exempt to avoid authorization. **Not yet approved.**
- Candidate roles are indicative only; contextual policy, scope and RLS still apply.
- 322 route mappings use 274 unique new permission identifiers (some routes share a permission).

## Summary

| Category | Routes |
|---|---|
| Reuse existing permission | 24 |
| New permission proposed | 322 |
| Exemption candidate | 10 |
| **Total** | **356** |

## Proposals by Router

### `inventory.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/inventory/adjustments` | `inventory.adjustment.read` | NEW (owner approval required) | pharmacist, ward_manager, facility_admin, cssd, biomedical |
| GET | `/inventory/assets` | `inventory.asset.read` | reuse existing | approved permission exists |
| GET | `/inventory/assets/:id` | `inventory.asset.read` | reuse existing | approved permission exists |
| GET | `/inventory/counts` | `inventory.count.read` | NEW (owner approval required) | pharmacist, ward_manager, facility_admin, cssd, biomedical |
| GET | `/inventory/items` | `inventory.item.read` | NEW (owner approval required) | pharmacist, ward_manager, facility_admin, cssd, biomedical |
| GET | `/inventory/locations` | `inventory.location.read` | NEW (owner approval required) | pharmacist, ward_manager, facility_admin, cssd, biomedical |
| GET | `/inventory/policies` | `inventory.policy.read` | NEW (owner approval required) | pharmacist, ward_manager, facility_admin, cssd, biomedical |
| GET | `/inventory/recalls` | `inventory.recall.read` | NEW (owner approval required) | pharmacist, ward_manager, facility_admin, cssd, biomedical |
| GET | `/inventory/reports/asset-downtime` | `inventory.report.read` | reuse existing | approved permission exists |
| GET | `/inventory/reports/consumption` | `inventory.report.read` | reuse existing | approved permission exists |
| GET | `/inventory/reports/count-variance` | `inventory.report.read` | reuse existing | approved permission exists |
| GET | `/inventory/reports/expiry` | `inventory.report.read` | reuse existing | approved permission exists |
| GET | `/inventory/reports/low-stock` | `inventory.report.read` | reuse existing | approved permission exists |
| GET | `/inventory/reports/maintenance-due` | `inventory.report.read` | reuse existing | approved permission exists |
| GET | `/inventory/reports/recall-status` | `inventory.report.read` | reuse existing | approved permission exists |
| GET | `/inventory/reports/requisition-fulfilment` | `inventory.report.read` | reuse existing | approved permission exists |
| GET | `/inventory/reports/transfer-discrepancies` | `inventory.report.read` | reuse existing | approved permission exists |
| GET | `/inventory/reports/valuation` | `inventory.report.read` | reuse existing | approved permission exists |
| GET | `/inventory/requisitions` | `inventory.requisition.read` | NEW (owner approval required) | pharmacist, ward_manager, facility_admin, cssd, biomedical |
| GET | `/inventory/requisitions/:id` | `inventory.requisition.read` | NEW (owner approval required) | pharmacist, ward_manager, facility_admin, cssd, biomedical |
| GET | `/inventory/transfers` | `inventory.transfer.read` | NEW (owner approval required) | pharmacist, ward_manager, facility_admin, cssd, biomedical |
| GET | `/inventory/transfers/:id` | `inventory.transfer.read` | NEW (owner approval required) | pharmacist, ward_manager, facility_admin, cssd, biomedical |
| POST | `/inventory/assets` | `inventory.asset.manage` | reuse existing | approved permission exists |
| POST | `/inventory/assets/:id/events` | `inventory.asset.manage` | reuse existing | approved permission exists |
| POST | `/inventory/counts` | `inventory.count.manage` | reuse existing | approved permission exists |
| POST | `/inventory/movements/:id/reverse` | `inventory.movement.reverse.manage` | NEW (owner approval required) | pharmacist, ward_manager, facility_admin, cssd, biomedical |
| POST | `/inventory/requisitions` | `inventory.requisition.manage` | NEW (owner approval required) | pharmacist, ward_manager, facility_admin, cssd, biomedical |
| POST | `/inventory/requisitions/:id/submit` | `inventory.requisition.submit` | NEW (owner approval required) | pharmacist, ward_manager, facility_admin, cssd, biomedical |
| POST | `/inventory/reservations` | `inventory.reservation.manage` | NEW (owner approval required) | pharmacist, ward_manager, facility_admin, cssd, biomedical |
| POST | `/inventory/reservations/:id/release` | `inventory.reservation.release.manage` | NEW (owner approval required) | pharmacist, ward_manager, facility_admin, cssd, biomedical |
### `fhir/router.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| ALL | `/fhir/r4/*` | `integration.r4._.manage` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| GET | `/fhir/r4/AuditEvent` | `integration.r4.auditevent.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| GET | `/fhir/r4/AuditEvent/:id` | `integration.r4.auditevent.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| GET | `/fhir/r4/Consent` | `integration.r4.consent.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| GET | `/fhir/r4/Consent/:id` | `integration.r4.consent.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| GET | `/fhir/r4/DocumentReference` | `integration.r4.documentreference.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| GET | `/fhir/r4/DocumentReference/:id` | `integration.r4.documentreference.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| GET | `/fhir/r4/Organization` | `integration.r4.organization.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| GET | `/fhir/r4/Organization/:id` | `integration.r4.organization.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| GET | `/fhir/r4/Patient` | `integration.r4.patient.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| GET | `/fhir/r4/Patient/:id` | `integration.r4.patient.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| GET | `/fhir/r4/Practitioner` | `integration.r4.practitioner.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| GET | `/fhir/r4/Practitioner/:id` | `integration.r4.practitioner.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| GET | `/fhir/r4/PractitionerRole/:id` | `integration.r4.practitionerrole.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| GET | `/fhir/r4/Provenance` | `integration.r4.provenance.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| GET | `/fhir/r4/Provenance/:id` | `integration.r4.provenance.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| GET | `/fhir/r4/metadata` | `integration.r4.metadata.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
### `operations.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/housekeeping/tasks` | `operations.task.read` | NEW (owner approval required) | facility_admin, ward_manager, quality |
| GET | `/mortuary/cases` | `operations.case.read` | NEW (owner approval required) | facility_admin, ward_manager, quality |
| GET | `/mortuary/cases/:id` | `operations.case.read` | NEW (owner approval required) | facility_admin, ward_manager, quality |
| GET | `/operations/beds` | `operations.bed.read` | NEW (owner approval required) | facility_admin, ward_manager, quality |
| GET | `/porter/tasks` | `operations.task.read` | NEW (owner approval required) | facility_admin, ward_manager, quality |
| GET | `/technical/assets` | `operations.asset.read` | NEW (owner approval required) | facility_admin, ward_manager, quality |
| GET | `/technical/cssd-cycles` | `operations.cssd_cycle.read` | NEW (owner approval required) | facility_admin, ward_manager, quality |
| GET | `/technical/work-orders` | `operations.work_order.read` | NEW (owner approval required) | facility_admin, ward_manager, quality |
| POST | `/housekeeping/tasks/:id/transition` | `operations.task.transition.manage` | NEW (owner approval required) | facility_admin, ward_manager, quality |
| POST | `/mortuary/cases/:id/effects` | `operations.case.effect.manage` | NEW (owner approval required) | facility_admin, ward_manager, quality |
| POST | `/mortuary/cases/:id/movements` | `operations.case.movement.manage` | NEW (owner approval required) | facility_admin, ward_manager, quality |
| POST | `/mortuary/cases/:id/release` | `operations.case.release.manage` | NEW (owner approval required) | facility_admin, ward_manager, quality |
| POST | `/porter/tasks/:id/transition` | `operations.task.transition.manage` | NEW (owner approval required) | facility_admin, ward_manager, quality |
| POST | `/technical/assets` | `operations.asset.manage` | NEW (owner approval required) | facility_admin, ward_manager, quality |
| POST | `/technical/cssd-cycles` | `operations.cssd_cycle.manage` | NEW (owner approval required) | facility_admin, ward_manager, quality |
| POST | `/technical/cssd-cycles/:id/release` | `operations.cssd_cycle.release.manage` | NEW (owner approval required) | facility_admin, ward_manager, quality |
| POST | `/technical/work-orders/:id/transition` | `operations.work_order.transition.manage` | NEW (owner approval required) | facility_admin, ward_manager, quality |
### `maternity.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/maternity/children/:patientId/events` | `clinical.children.event.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| GET | `/maternity/children/:patientId/immunization-catch-up` | `clinical.children.immunization_catch_up.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| GET | `/maternity/children/:patientId/immunization-due` | `clinical.children.immunization_due.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| GET | `/maternity/children/:patientId/immunizations` | `clinical.children.immunization.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| GET | `/maternity/episodes` | `clinical.episode.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| GET | `/maternity/episodes/:id` | `clinical.episode.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| GET | `/maternity/episodes/:id/alerts` | `clinical.episode.alert.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| GET | `/maternity/episodes/:id/antenatal-visits` | `clinical.episode.antenatal_visit.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| GET | `/maternity/immunization-schedule` | `clinical.immunization_schedule.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| PATCH | `/maternity/episodes/:id` | `clinical.episode.update` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| PATCH | `/maternity/newborns/:newbornId/status` | `clinical.newborn.status.update` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| POST | `/maternity/children/:patientId/events` | `clinical.children.event.manage` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| POST | `/maternity/children/:patientId/immunizations` | `clinical.children.immunization.manage` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| POST | `/maternity/episodes/:id/alerts` | `clinical.episode.alert.manage` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| POST | `/maternity/episodes/:id/newborns` | `clinical.episode.newborn.manage` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| POST | `/maternity/episodes/:id/observations` | `clinical.episode.observation.manage` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| POST | `/maternity/newborns/:newbornId/patient` | `clinical.newborn.patient.manage` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
### `content.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| DELETE | `/content/:id/bookmark` | `content.bookmark.delete` | NEW (owner approval required) | content_editor, content_reviewer, opportunity_moderator |
| GET | `/access/summary` | `content.summary.read` | NEW (owner approval required) | content_editor, content_reviewer, opportunity_moderator |
| GET | `/admin/care-team` | `organization.care_team.read` | NEW (owner approval required) | facility_admin, owner, hr |
| GET | `/content/bookmarks/mine` | `organization.bookmark.mine.read` | NEW (owner approval required) | facility_admin, owner, hr |
| GET | `/content/editorial/items` | `organization.editorial.item.read` | NEW (owner approval required) | facility_admin, owner, hr |
| GET | `/content/preferences/mine` | `organization.preference.mine.read` | NEW (owner approval required) | facility_admin, owner, hr |
| GET | `/content/sources` | `organization.source.read` | NEW (owner approval required) | facility_admin, owner, hr |
| GET | `/dashboards/patient` | `organization.patient.read` | NEW (owner approval required) | facility_admin, owner, hr |
| GET | `/dashboards/specialist` | `organization.specialist.read` | NEW (owner approval required) | facility_admin, owner, hr |
| GET | `/opportunities` | `organization.resource.read` | NEW (owner approval required) | facility_admin, owner, hr |
| POST | `/content-feeds/opportunities/:id/withdraw` | `organization.opportunity.withdraw.manage` | NEW (owner approval required) | facility_admin, owner, hr |
| POST | `/content/:id/bookmark` | `organization.bookmark.manage` | NEW (owner approval required) | facility_admin, owner, hr |
| POST | `/content/:id/report` | `organization.report.manage` | NEW (owner approval required) | facility_admin, owner, hr |
| POST | `/opportunities/:id/bookmark` | `organization.bookmark.manage` | NEW (owner approval required) | facility_admin, owner, hr |
| POST | `/opportunities/:id/report` | `organization.report.manage` | NEW (owner approval required) | facility_admin, owner, hr |
| PUT | `/content/preferences/mine` | `organization.preference.mine.update` | NEW (owner approval required) | facility_admin, owner, hr |
### `inpatient.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/admissions/:id` | `clinical.resource.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| GET | `/admissions/:id/fluid-balance` | `clinical.fluid_balance.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| GET | `/admissions/:id/transfers` | `clinical.transfer.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| GET | `/directory/clinical-members` | `clinical.clinical_member.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| GET | `/wards/:id/capacity` | `clinical.capacity.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| PATCH | `/admissions/:id/tasks/:taskId/assign` | `clinical.task.assign.update` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| POST | `/admissions` | `clinical.resource.manage` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| POST | `/admissions/:id/administrations` | `clinical.administration.manage` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| POST | `/admissions/:id/administrations/:administrationId/omit` | `clinical.administration.omit.manage` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| POST | `/admissions/:id/handoffs` | `clinical.handoff.manage` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| POST | `/admissions/:id/tasks/:taskId/escalate` | `clinical.task.escalate.manage` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| POST | `/admissions/:id/tasks/:taskId/omit` | `clinical.task.omit.manage` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| POST | `/admissions/:id/transition` | `clinical.transition.manage` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| POST | `/wards` | `clinical.resource.manage` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| POST | `/wards/:id/beds` | `clinical.bed.manage` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
### `organization.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/organization/cadres` | `organization.cadre.read` | NEW (owner approval required) | facility_admin, owner, hr |
| GET | `/organization/departments` | `organization.department.read` | NEW (owner approval required) | facility_admin, owner, hr |
| GET | `/organization/job-titles` | `organization.job_title.read` | NEW (owner approval required) | facility_admin, owner, hr |
| GET | `/organization/locations` | `organization.location.read` | NEW (owner approval required) | facility_admin, owner, hr |
| GET | `/organization/units` | `organization.unit.read` | NEW (owner approval required) | facility_admin, owner, hr |
| GET | `/workforce/onboarding/:id` | `organization.onboarding.read` | NEW (owner approval required) | facility_admin, owner, hr |
| GET | `/workforce/privileges` | `organization.privilege.read` | NEW (owner approval required) | facility_admin, owner, hr |
| GET | `/workforce/staff` | `organization.staff.read` | NEW (owner approval required) | facility_admin, owner, hr |
| GET | `/workforce/summary` | `organization.summary.read` | NEW (owner approval required) | facility_admin, owner, hr |
| PATCH | `/organization/departments/:id` | `organization.department.update` | NEW (owner approval required) | facility_admin, owner, hr |
| PATCH | `/workforce/onboarding/:id` | `organization.onboarding.update` | NEW (owner approval required) | facility_admin, owner, hr |
| POST | `/organization/catalogue` | `organization.catalogue.manage` | NEW (owner approval required) | facility_admin, owner, hr |
| POST | `/organization/departments/:id/units` | `organization.department.unit.manage` | NEW (owner approval required) | facility_admin, owner, hr |
| POST | `/workforce/engagements/:id/training` | `organization.engagement.training.manage` | NEW (owner approval required) | facility_admin, owner, hr |
| POST | `/workforce/onboarding/:id/decision` | `organization.onboarding.decision.manage` | NEW (owner approval required) | facility_admin, owner, hr |
### `radiology.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/radiology/catalogue` | `radiology.catalogue.read` | NEW (owner approval required) | radiology, radiographer, radiologist |
| GET | `/radiology/clinical-recipients` | `radiology.clinical_recipient.read` | NEW (owner approval required) | radiology, radiographer, radiologist |
| GET | `/radiology/critical-communications` | `radiology.critical_communication.read` | NEW (owner approval required) | radiology, radiographer, radiologist |
| GET | `/radiology/images/status` | `radiology.images.view` | reuse existing | approved permission exists |
| GET | `/radiology/orders/:orderItemId/report` | `radiology.order.report.read` | NEW (owner approval required) | radiology, radiographer, radiologist |
| GET | `/radiology/reports/:id` | `radiology.report.read` | NEW (owner approval required) | radiology, radiographer, radiologist |
| GET | `/radiology/studies/:id` | `radiology.study.read` | NEW (owner approval required) | radiology, radiographer, radiologist |
| GET | `/radiology/studies/:id/images/series/:seriesUid` | `radiology.images.view` | reuse existing | approved permission exists |
| GET | `/radiology/studies/:id/images/series/:seriesUid/instances/:instanceUid/frames/:frame` | `radiology.images.view` | reuse existing | approved permission exists |
| GET | `/radiology/worklist` | `radiology.worklist.read` | NEW (owner approval required) | radiology, radiographer, radiologist |
| POST | `/radiology/critical-communications/:id/acknowledge` | `radiology.critical_communication.acknowledge.manage` | NEW (owner approval required) | radiology, radiographer, radiologist |
| POST | `/radiology/critical-communications/:id/escalate` | `radiology.critical_communication.escalate.manage` | NEW (owner approval required) | radiology, radiographer, radiologist |
| POST | `/radiology/reports/:id/critical-communications` | `radiology.report.draft` | reuse existing | approved permission exists |
| POST | `/radiology/studies/:id/pacs-link` | `radiology.study.register` | reuse existing | approved permission exists |
| POST | `/radiology/studies/:id/pacs-unlink` | `radiology.study.register` | reuse existing | approved permission exists |
### `terminology/router.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/terminology/autocomplete` | `integration.autocomplete.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| GET | `/terminology/fhir/r4/*` | `integration.fhir.r4._.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| GET | `/terminology/fhir/r4/CodeSystem/$lookup` | `integration.fhir.r4.codesystem._lookup.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| GET | `/terminology/fhir/r4/CodeSystem/$validate-code` | `integration.fhir.r4.codesystem._validate_code.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| GET | `/terminology/fhir/r4/ConceptMap/$translate` | `integration.fhir.r4.conceptmap._translate.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| GET | `/terminology/fhir/r4/ValueSet/$expand` | `integration.fhir.r4.valueset._expand.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| GET | `/terminology/fhir/r4/ValueSet/$validate-code` | `integration.fhir.r4.valueset._validate_code.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| GET | `/terminology/fhir/r4/metadata` | `integration.fhir.r4.metadata.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| GET | `/terminology/fields` | `integration.field.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| GET | `/terminology/search` | `integration.search.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| POST | `/terminology/fhir/r4/CodeSystem/$lookup` | `integration.fhir.r4.codesystem._lookup.manage` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| POST | `/terminology/fhir/r4/CodeSystem/$validate-code` | `integration.fhir.r4.codesystem._validate_code.manage` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| POST | `/terminology/fhir/r4/ConceptMap/$translate` | `integration.fhir.r4.conceptmap._translate.manage` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| POST | `/terminology/fhir/r4/ValueSet/$expand` | `integration.fhir.r4.valueset._expand.manage` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| POST | `/terminology/fhir/r4/ValueSet/$validate-code` | `integration.fhir.r4.valueset._validate_code.manage` | NEW (owner approval required) | facility_admin, it_admin, public_health |
### `diagnostics.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/critical-communications` | `diagnostic.resource.read` | NEW (owner approval required) | laboratory, lab_validator, diagnostic_practitioner |
| GET | `/diagnostic-orders` | `diagnostic.resource.read` | NEW (owner approval required) | laboratory, lab_validator, diagnostic_practitioner |
| GET | `/diagnostic-orders/:id` | `diagnostic.resource.read` | NEW (owner approval required) | laboratory, lab_validator, diagnostic_practitioner |
| GET | `/diagnostic-reporting/releasable` | `diagnostic.releasable.read` | NEW (owner approval required) | laboratory, lab_validator, diagnostic_practitioner |
| GET | `/diagnostic-reporting/worklist` | `diagnostic.worklist.read` | NEW (owner approval required) | laboratory, lab_validator, diagnostic_practitioner |
| GET | `/lab-tests` | `diagnostic.resource.read` | NEW (owner approval required) | laboratory, lab_validator, diagnostic_practitioner |
| GET | `/patients/:id/diagnostics` | `diagnostic.diagnostic.read` | NEW (owner approval required) | laboratory, lab_validator, diagnostic_practitioner |
| PATCH | `/specimens/:id` | `diagnostic.resource.update` | NEW (owner approval required) | laboratory, lab_validator, diagnostic_practitioner |
| POST | `/critical-communications/:id/acknowledge` | `diagnostic.acknowledge.manage` | NEW (owner approval required) | laboratory, lab_validator, diagnostic_practitioner |
| POST | `/diagnostic-orders/:id/assign` | `diagnostic.assign.manage` | NEW (owner approval required) | laboratory, lab_validator, diagnostic_practitioner |
| POST | `/diagnostic-orders/:id/transitions` | `diagnostic.transition.manage` | NEW (owner approval required) | laboratory, lab_validator, diagnostic_practitioner |
| POST | `/imaging-studies` | `diagnostic.resource.manage` | NEW (owner approval required) | laboratory, lab_validator, diagnostic_practitioner |
| POST | `/lab-results/:id/critical-communications` | `diagnostic.critical_communication.manage` | NEW (owner approval required) | laboratory, lab_validator, diagnostic_practitioner |
| POST | `/lab-tests` | `diagnostic.resource.manage` | NEW (owner approval required) | laboratory, lab_validator, diagnostic_practitioner |
### `workflow.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/encounters/:id/workflow` | `clinical.workflow.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| GET | `/entries/:id/integrity` | `clinical.integrity.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| GET | `/recommendations/:id` | `clinical.resource.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| GET | `/visits/board` | `clinical.board.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| GET | `/work-queues` | `clinical.resource.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| GET | `/work-queues/:department` | `clinical.resource.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| PATCH | `/recommendations/:id` | `clinical.resource.update` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| POST | `/encounters/:id/recommendations` | `clinical.recommendation.manage` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| POST | `/encounters/:id/supplies` | `clinical.supply.manage` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| POST | `/recommendations/:id/transitions` | `clinical.transition.manage` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| POST | `/supplies/:id/void` | `clinical.void.manage` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
### `directory.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/public/directory/facilities` | `directory.directory.facility.read` | NEW (owner approval required) | facility_admin, content_editor |
| GET | `/public/directory/facilities/:publicId` | `directory.directory.facility.read` | NEW (owner approval required) | facility_admin, content_editor |
| GET | `/public/directory/map-config` | `directory.directory.map_config.read` | NEW (owner approval required) | facility_admin, content_editor |
| GET | `/public/directory/meta` | `directory.directory.meta.read` | NEW (owner approval required) | facility_admin, content_editor |
| POST | `/directory/duplicates/:id/review` | `directory.duplicate.review` | NEW (owner approval required) | facility_admin, content_editor |
| POST | `/directory/facilities/:id/capabilities` | `directory.facility.capability.manage` | NEW (owner approval required) | facility_admin, content_editor |
| POST | `/directory/facilities/:id/edit-requests` | `directory.facility.edit_request.manage` | NEW (owner approval required) | facility_admin, content_editor |
| POST | `/directory/facilities/:id/moderation` | `directory.facility.moderation.manage` | NEW (owner approval required) | facility_admin, content_editor |
| POST | `/directory/facilities/:id/services` | `directory.facility.service.manage` | NEW (owner approval required) | facility_admin, content_editor |
| POST | `/public/directory/events` | `directory.directory.event.manage` | NEW (owner approval required) | facility_admin, content_editor |
| POST | `/public/directory/reports` | `directory.directory.report.manage` | NEW (owner approval required) | facility_admin, content_editor |
### `workforce-reference.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/reference/cadres/:code` | `workforce.cadre.read` | NEW (owner approval required) | hr, facility_admin |
| GET | `/reference/capabilities` | `workforce.capability.read` | NEW (owner approval required) | hr, facility_admin |
| GET | `/reference/capabilities/:code` | `workforce.capability.read` | NEW (owner approval required) | hr, facility_admin |
| GET | `/reference/departments/:code` | `workforce.department.read` | NEW (owner approval required) | hr, facility_admin |
| GET | `/reference/job-titles` | `workforce.job_title.read` | NEW (owner approval required) | hr, facility_admin |
| GET | `/reference/job-titles/:code` | `workforce.job_title.read` | NEW (owner approval required) | hr, facility_admin |
| GET | `/reference/onboarding/cadre-specialty` | `workforce.onboarding.cadre_specialty.read` | NEW (owner approval required) | hr, facility_admin |
| GET | `/reference/payroll-grades/:code` | `workforce.payroll_grade.read` | NEW (owner approval required) | hr, facility_admin |
| GET | `/reference/regulators` | `workforce.regulator.read` | NEW (owner approval required) | hr, facility_admin |
| GET | `/reference/regulators/:code` | `workforce.regulator.read` | NEW (owner approval required) | hr, facility_admin |
| GET | `/reference/specialties/:code` | `workforce.specialty.read` | NEW (owner approval required) | hr, facility_admin |
### `admin.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/admin/facility` | `organization.facility.read` | NEW (owner approval required) | facility_admin, owner, hr |
| GET | `/admin/integrations` | `organization.integration.read` | NEW (owner approval required) | facility_admin, owner, hr |
| GET | `/admin/invitations` | `organization.invitation.read` | NEW (owner approval required) | facility_admin, owner, hr |
| POST | `/admin/integrations/ai/verify` | `organization.integration.ai.verify` | NEW (owner approval required) | facility_admin, owner, hr |
| POST | `/admin/integrations/dicomweb/verify` | `organization.integration.dicomweb.verify` | NEW (owner approval required) | facility_admin, owner, hr |
| POST | `/admin/invitations/:id/revoke` | `organization.invitation.revoke.manage` | NEW (owner approval required) | facility_admin, owner, hr |
| POST | `/admin/platform-operator/elevate` | `platform.platform_operator.elevate.manage` | NEW (owner approval required) | it_admin (with platform_operator grant) |
| POST | `/admin/platform-operator/requests/:id/cancel` | `platform.platform_operator.request.cancel.manage` | NEW (owner approval required) | it_admin (with platform_operator grant) |
| POST | `/admin/platform-operator/requests/:id/deny` | `platform.platform_operator.request.deny.manage` | NEW (owner approval required) | it_admin (with platform_operator grant) |
| POST | `/admin/platform-operator/revoke` | `platform.platform_operator.revoke.manage` | NEW (owner approval required) | it_admin (with platform_operator grant) |
### `billing.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/billing/invoices/:id` | `billing.invoice.read` | NEW (owner approval required) | owner, facility_admin |
| GET | `/billing/plans` | `billing.plan.read` | NEW (owner approval required) | owner, facility_admin |
| GET | `/platform/billing/accounts/:id/invoices` | `billing.billing.account.invoice.read` | NEW (owner approval required) | owner, facility_admin |
| GET | `/platform/billing/invoices/:id` | `billing.billing.invoice.read` | NEW (owner approval required) | owner, facility_admin |
| GET | `/platform/billing/plans` | `billing.billing.plan.read` | NEW (owner approval required) | owner, facility_admin |
| POST | `/billing/notifications/:id/read` | `billing.notification.read.manage` | NEW (owner approval required) | owner, facility_admin |
| POST | `/billing/subscription/quote` | `billing.subscription.quote.manage` | NEW (owner approval required) | owner, facility_admin |
| POST | `/platform/billing/plans/:id/approve` | `billing.billing.plan.approve` | NEW (owner approval required) | owner, facility_admin |
| POST | `/platform/billing/subscriptions/:id/status` | `billing.billing.subscription.status.manage` | NEW (owner approval required) | owner, facility_admin |
| POST | `/platform/billing/usage/:id/correct` | `billing.billing.usage.correct.manage` | NEW (owner approval required) | owner, facility_admin |
### `ehmis.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/ehmis` | `hmis.resource.read` | NEW (owner approval required) | public_health, facility_admin |
| GET | `/ehmis/eligibility-requests` | `hmis.eligibility_request.read` | NEW (owner approval required) | public_health, facility_admin |
| GET | `/ehmis/periods/:id/export` | `hmis.period.export.read` | NEW (owner approval required) | public_health, facility_admin |
| POST | `/ehmis/eligibility-request` | `hmis.eligibility_request.manage` | NEW (owner approval required) | public_health, facility_admin |
| POST | `/ehmis/eligibility/:tenantId/decision` | `hmis.eligibility.decision.manage` | NEW (owner approval required) | public_health, facility_admin |
| POST | `/ehmis/mappings/:id/approve` | `hmis.mapping.approve` | NEW (owner approval required) | public_health, facility_admin |
| POST | `/ehmis/mappings/:id/retire` | `hmis.mapping.retire.manage` | NEW (owner approval required) | public_health, facility_admin |
| POST | `/ehmis/periods/:id/manual-submission` | `hmis.period.manual_submission.manage` | NEW (owner approval required) | public_health, facility_admin |
| POST | `/ehmis/periods/:id/reopen` | `hmis.period.reopen.manage` | NEW (owner approval required) | public_health, facility_admin |
### `finance.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/encounters/:id/billable` | `finance.billable.read` | NEW (owner approval required) | finance, facility_admin |
| GET | `/mobile-money/:id` | `finance.resource.read` | NEW (owner approval required) | finance, facility_admin |
| GET | `/payments/:id/receipt` | `finance.receipt.read` | NEW (owner approval required) | finance, facility_admin |
| GET | `/service-catalog/:id/history` | `finance.history.read` | NEW (owner approval required) | finance, facility_admin |
| POST | `/claims` | `finance.resource.manage` | NEW (owner approval required) | finance, facility_admin |
| POST | `/invoices` | `finance.resource.manage` | NEW (owner approval required) | finance, facility_admin |
| POST | `/invoices/:id/items/:itemId/remove` | `finance.item.remove.manage` | NEW (owner approval required) | finance, facility_admin |
| POST | `/mobile-money/:id/check` | `finance.check.manage` | NEW (owner approval required) | finance, facility_admin |
| POST | `/service-catalog/:id/convert` | `finance.convert.manage` | NEW (owner approval required) | finance, facility_admin |
### `theatre.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/theatre-cases` | `clinical.resource.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| GET | `/theatre-cases/:id` | `clinical.resource.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| GET | `/theatres` | `clinical.resource.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| POST | `/theatre-cases/:id/consent` | `clinical.consent.manage` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| POST | `/theatre-cases/:id/counts` | `clinical.count.manage` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| POST | `/theatre-cases/:id/preop` | `clinical.preop.manage` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| POST | `/theatre-cases/:id/recovery` | `clinical.recovery.manage` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| POST | `/theatre-cases/:id/specimens` | `clinical.specimen.manage` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| POST | `/theatres` | `clinical.resource.manage` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
### `reception.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/appointments` | `patient.resource.read` | NEW (owner approval required) | receptionist, records, facility_admin |
| GET | `/queues/:queueId/entries` | `patient.entry.read` | NEW (owner approval required) | receptionist, records, facility_admin |
| POST | `/encounters` | `patient.resource.manage` | NEW (owner approval required) | receptionist, records, facility_admin |
| POST | `/encounters/:id/transitions` | `patient.transition.manage` | NEW (owner approval required) | receptionist, records, facility_admin |
| POST | `/encounters/:id/triage` | `patient.triage.manage` | NEW (owner approval required) | receptionist, records, facility_admin |
| POST | `/encounters/:id/triage/complete` | `patient.triage.complete.manage` | NEW (owner approval required) | receptionist, records, facility_admin |
| POST | `/queues` | `patient.resource.manage` | NEW (owner approval required) | receptionist, records, facility_admin |
| POST | `/queues/:queueId/entries` | `patient.entry.manage` | NEW (owner approval required) | receptionist, records, facility_admin |
### `auth.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/auth/organizations/search` | `—` | EXEMPT candidate (authenticated-self) | verify controls; not a permission |
| GET | `/auth/totp/dev` | `—` | EXEMPT candidate (authenticated-self) | verify controls; not a permission |
| POST | `/auth/invitations/decline` | `—` | EXEMPT candidate (authenticated-self) | verify controls; not a permission |
| POST | `/auth/invitations/status` | `—` | EXEMPT candidate (authenticated-self) | verify controls; not a permission |
| POST | `/auth/join-codes/lookup` | `—` | EXEMPT candidate (authenticated-self) | verify controls; not a permission |
| POST | `/auth/login/mfa/email` | `—` | EXEMPT candidate (authenticated-self) | verify controls; not a permission |
| POST | `/auth/register/facility` | `—` | EXEMPT candidate (authenticated-self) | verify controls; not a permission |
| POST | `/auth/verify-email/resend` | `—` | EXEMPT candidate (authenticated-self) | verify controls; not a permission |
### `pharmacy-pos.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/pharmacy/pos/catalog` | `finance.po.catalog.read` | NEW (owner approval required) | finance, facility_admin |
| GET | `/pharmacy/pos/items/:id/lots` | `finance.po.item.lot.read` | NEW (owner approval required) | finance, facility_admin |
| GET | `/pharmacy/pos/patients` | `finance.po.patient.read` | NEW (owner approval required) | finance, facility_admin |
| GET | `/pharmacy/prescriptions` | `finance.prescription.read` | NEW (owner approval required) | finance, facility_admin |
| GET | `/pharmacy/prescriptions/:id` | `finance.prescription.read` | NEW (owner approval required) | finance, facility_admin |
| GET | `/pharmacy/reports/sales` | `finance.report.sale.read` | NEW (owner approval required) | finance, facility_admin |
| GET | `/pharmacy/sales` | `finance.sale.read` | NEW (owner approval required) | finance, facility_admin |
| GET | `/pharmacy/sales/:id` | `finance.sale.read` | NEW (owner approval required) | finance, facility_admin |
### `credentials.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/credentials/:id/history` | `credential.history.read` | NEW (owner approval required) |  |
| GET | `/credentials/facility` | `credential.facility.read` | NEW (owner approval required) |  |
| GET | `/credentials/facility/queue` | `credential.facility.queue.read` | NEW (owner approval required) |  |
| GET | `/credentials/mine` | `credential.mine.read` | NEW (owner approval required) |  |
| GET | `/uploads/:id/content` | `credential.content.read` | NEW (owner approval required) |  |
| POST | `/credentials` | `credential.resource.manage` | NEW (owner approval required) |  |
| POST | `/uploads` | `credential.resource.manage` | NEW (owner approval required) |  |
### `pharmacy.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/medication-orders` | `pharmacy.resource.read` | NEW (owner approval required) |  |
| GET | `/medicines` | `pharmacy.resource.read` | NEW (owner approval required) |  |
| GET | `/patients/:id/medication` | `pharmacy.medication.read` | NEW (owner approval required) |  |
| GET | `/stock/lots` | `pharmacy.lot.read` | NEW (owner approval required) |  |
| POST | `/medicines` | `pharmacy.resource.manage` | NEW (owner approval required) |  |
| POST | `/stock/lots` | `pharmacy.lot.manage` | NEW (owner approval required) |  |
| POST | `/stock/movements` | `pharmacy.movement.manage` | NEW (owner approval required) |  |
### `integrations.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/integrations/patients/links` | `integration.patient.link.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| GET | `/public/integrations/products` | `integration.integration.product.read` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| POST | `/integrations/clients/:id/decision` | `integration.client.decision.manage` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| POST | `/integrations/clients/:id/revoke-tokens` | `integration.client.revoke_token.manage` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| POST | `/integrations/products` | `integration.product.manage` | NEW (owner approval required) | facility_admin, it_admin, public_health |
| POST | `/public/integrations/oauth/token` | `integration.integration.oauth.token.manage` | NEW (owner approval required) | facility_admin, it_admin, public_health |
### `programmes.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/patients/:id/programmes` | `programme.programme.read` | NEW (owner approval required) | clinician, nurse, facility_admin |
| GET | `/programmes` | `programme.resource.read` | NEW (owner approval required) | clinician, nurse, facility_admin |
| GET | `/programmes/:id/enrolments` | `programme.enrolment.read` | NEW (owner approval required) | clinician, nurse, facility_admin |
| GET | `/public-health/reports` | `programme.report.read` | NEW (owner approval required) | clinician, nurse, facility_admin |
| POST | `/enrolments/:id/events` | `programme.event.manage` | NEW (owner approval required) | clinician, nurse, facility_admin |
| POST | `/patients/:id/advance-care` | `programme.advance_care.manage` | NEW (owner approval required) | clinician, nurse, facility_admin |
### `promotions.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/promotions/campaigns` | `promotion.campaign.read` | NEW (owner approval required) | facility_admin, owner, content_editor |
| GET | `/promotions/campaigns/:id/metrics` | `promotion.campaign.metric.read` | NEW (owner approval required) | facility_admin, owner, content_editor |
| GET | `/promotions/campaigns/:id/payments` | `promotion.campaign.payment.read` | NEW (owner approval required) | facility_admin, owner, content_editor |
| GET | `/promotions/packages` | `promotion.package.read` | NEW (owner approval required) | facility_admin, owner, content_editor |
| POST | `/promotions/campaigns/:id/cancel` | `promotion.campaign.cancel.manage` | NEW (owner approval required) | facility_admin, owner, content_editor |
| POST | `/public/promotions/webhooks/payments` | `promotion.promotion.webhook.payment.manage` | NEW (owner approval required) | facility_admin, owner, content_editor |
### `workspace.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/workspace` | `workspace.resource.read` | NEW (owner approval required) | facility_admin, owner |
| GET | `/workspace/organization` | `workspace.organization.read` | NEW (owner approval required) | facility_admin, owner |
| POST | `/workspace/organization/history` | `workspace.organization.history.manage` | NEW (owner approval required) | facility_admin, owner |
| POST | `/workspace/organization/withdraw` | `workspace.organization.withdraw.manage` | NEW (owner approval required) | facility_admin, owner |
| POST | `/workspace/registrations` | `workspace.registration.manage` | NEW (owner approval required) | facility_admin, owner |
| POST | `/workspace/registrations/:id/status` | `workspace.registration.status.manage` | NEW (owner approval required) | facility_admin, owner |
### `organizations.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| POST | `/organizations/:id/join-codes` | `organization.join_code.manage` | NEW (owner approval required) | facility_admin, owner, hr |
| POST | `/organizations/:id/join-codes/:codeId/revoke` | `organization.join_code.revoke.manage` | NEW (owner approval required) | facility_admin, owner, hr |
| POST | `/organizations/:id/links/:linkId/end` | `organization.link.manage` | reuse existing | approved permission exists |
| POST | `/organizations/:id/links/:linkId/inventory-mode` | `organization.link.manage` | reuse existing | approved permission exists |
| POST | `/organizations/:id/members/:memberId/remove` | `organization.member.remove.manage` | NEW (owner approval required) | facility_admin, owner, hr |
| POST | `/organizations/invitations/accept` | `organization.invitation.accept.manage` | NEW (owner approval required) | facility_admin, owner, hr |
### `onboarding.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/onboarding/catalogue/versions` | `onboarding.catalogue.read` | reuse existing | approved permission exists |
| GET | `/onboarding/facilities` | `onboarding.facility.read` | NEW (owner approval required) | hr, facility_admin |
| GET | `/onboarding/proxies` | `onboarding.proxy.read` | NEW (owner approval required) | hr, facility_admin |
| GET | `/onboarding/proxies/queue` | `onboarding.proxy.queue.read` | NEW (owner approval required) | hr, facility_admin |
| POST | `/onboarding/proxies/requests` | `onboarding.proxy.request.manage` | NEW (owner approval required) | hr, facility_admin |
### `platform-observability.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/platform/observability/api-metrics` | `platform.observability.api_metric.read` | NEW (owner approval required) | it_admin (with platform_operator grant) |
| GET | `/platform/observability/integrations` | `platform.observability.integration.read` | NEW (owner approval required) | it_admin (with platform_operator grant) |
| GET | `/platform/observability/logs` | `platform.observability.log.read` | NEW (owner approval required) | it_admin (with platform_operator grant) |
| GET | `/platform/observability/traces` | `platform.observability.trace.read` | NEW (owner approval required) | it_admin (with platform_operator grant) |
| GET | `/platform/observability/workers` | `platform.observability.worker.read` | NEW (owner approval required) | it_admin (with platform_operator grant) |
### `procurement.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/procurement/purchase-orders` | `inventory.purchase_order.read` | NEW (owner approval required) | pharmacist, ward_manager, facility_admin, cssd, biomedical |
| GET | `/procurement/purchase-orders/:id` | `inventory.purchase_order.read` | NEW (owner approval required) | pharmacist, ward_manager, facility_admin, cssd, biomedical |
| GET | `/procurement/suppliers` | `inventory.supplier.read` | NEW (owner approval required) | pharmacist, ward_manager, facility_admin, cssd, biomedical |
| POST | `/procurement/purchase-orders/:id/receive` | `inventory.purchase_order.receive` | NEW (owner approval required) | pharmacist, ward_manager, facility_admin, cssd, biomedical |
| POST | `/procurement/suppliers/:id/status` | `inventory.supplier.status.manage` | NEW (owner approval required) | pharmacist, ward_manager, facility_admin, cssd, biomedical |
### `documents.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/document-templates` | `document.resource.read` | NEW (owner approval required) | clinician, nurse, facility_admin |
| GET | `/document-templates/:id` | `document.resource.read` | NEW (owner approval required) | clinician, nurse, facility_admin |
| GET | `/documents` | `document.resource.read` | NEW (owner approval required) | clinician, nurse, facility_admin |
| GET | `/documents/:id` | `document.resource.read` | NEW (owner approval required) | clinician, nurse, facility_admin |
### `telehealth.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/telehealth/sessions` | `clinical.session.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| GET | `/telehealth/sessions/:id` | `clinical.session.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| GET | `/telehealth/sessions/:id/participants` | `clinical.session.participant.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| POST | `/telehealth/sessions/:id/consent` | `clinical.session.consent.manage` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
### `subscription-checkout.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/billing/subscription-checkout/quote` | `billing.subscription_checkout.quote.read` | NEW (owner approval required) | owner, facility_admin |
| GET | `/billing/subscription-renewal` | `billing.subscription_renewal.read` | NEW (owner approval required) | owner, facility_admin |
| POST | `/billing/subscription-checkout/:id/cancel` | `billing.subscription_checkout.cancel.manage` | NEW (owner approval required) | owner, facility_admin |
### `emergency.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/emergency/cases` | `clinical.case.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| GET | `/emergency/cases/:id` | `clinical.case.read` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
| POST | `/emergency/cases/:id/observations` | `clinical.case.observation.manage` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |
### `ai.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/ai/jobs` | `ai.job.read` | NEW (owner approval required) | clinician, facility_admin |
| GET | `/ai/jobs/:id` | `ai.job.read` | NEW (owner approval required) | clinician, facility_admin |
### `devices.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/device-alerts` | `devices.resource.read` | NEW (owner approval required) | biomedical, facility_admin |
| GET | `/devices` | `devices.resource.read` | NEW (owner approval required) | biomedical, facility_admin |
### `payment-callbacks.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| POST | `/public/payments/yo/failures` | `—` | EXEMPT candidate (webhook) | verify controls; not a permission |
| POST | `/public/payments/yo/subscriptions/failures` | `—` | EXEMPT candidate (webhook) | verify controls; not a permission |
### `facility-logo.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| GET | `/logo` | `organization.resource.read` | NEW (owner approval required) | facility_admin, owner, hr |
### `clinical.ts`

| Method | Path | Proposed | Basis | Candidate roles |
|---|---|---|---|---|
| PUT | `/entries/:id/draft` | `clinical.draft.update` | NEW (owner approval required) | clinician, nurse, midwife, specialist_clinician |

---

*End of proposal. No permissions added, no routes rewired by this document.*