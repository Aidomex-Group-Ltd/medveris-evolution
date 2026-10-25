# Clinical and operational workflows

Each workflow requires local clinical owner review, role permissions, audit coverage, exception handling and user acceptance before release. Protocols, drug dosing, escalation thresholds and treatment pathways must come from approved clinical governance, not generated placeholder rules.

## Reception and outpatient care

Register or resolve patient → confirm identity → create appointment/walk-in encounter → queue → triage → clinician consultation → requests/prescription/referral → results review → discharge or admission → follow-up. Use a persistent patient banner with two appropriate identifiers and clearly distinguish temporary identities. Triage captures complaint, observations, allergies state, urgency and author. Make missing results and pending tasks visible before encounter closure.

Encounter states: planned → arrived → triaged → in-progress → completed; cancellation and entered-in-error require reasons. Reopening creates an explicit event. Queue transfers preserve history. Clinical notes: draft → signed → amended or entered-in-error; a correction never erases the original.

## Emergency and recovery

Allow temporary identity registration and immediate encounter creation without making administrative completion a prerequisite for resuscitation documentation. Capture triage, emergency team actions, serial observations, orders, critical results and handoffs. Record late documentation as such with separate clinical and recording times. Escalation follows the facility's actual emergency policy. Emergency access is distinct from ordinary registration and remains audited. Recovery includes post-procedure observations, handoff, discharge criteria and responsible clinician acceptance.

## Inpatient wards

Admission → capability-appropriate bed → nursing assessment → multidisciplinary care and medication administration → transfers → discharge/death/transfer-out documentation. Configure general, pediatric, adult male, adult female, surgical, maternity, NICU and ICU wards without hard-coding demographic restrictions that prevent documented clinical exceptions. Record bed-cleaning and unavailable states. Transfer assignment and release are atomic. Preserve isolation precautions and handoff tasks under appropriate access policies.

## Pediatric neonatal maternity and critical care

Pediatrics and NICU require birth date/time certainty, age-appropriate fields, weight with units and measurement time, guardian relationships and approved medicine validation. Link a newborn to maternal records through an explicit relationship while preserving separate patient identities and access rights. Maternity supports antenatal, labour, delivery, postnatal and referral records. Critical care supports high-frequency observation review, fluid balance, ventilation documentation and handoff. Do not label these modules as validated critical monitoring until device, alarm and workflow acceptance is complete.

## Theatre and anesthesia

Request procedure → preoperative assessment → procedure-specific consent → schedule and team allocation → identity/site/laterality confirmation → checklist stages → anesthesia and intraoperative record → counts/specimens/implants documentation → recovery handoff → postoperative plan. Capture exceptions with authorized sign-off. An ordinary booking cannot bypass consent and safety-check state. Emergency exceptions require the approved local protocol and reason.

## Laboratory and radiology

Order → collection/booking → specimen or study identity check → accession → processing/acquisition → preliminary result → authorized final report → acknowledgement and follow-up. Rejected specimens retain reason and recollection lineage. Corrected reports notify responsible teams and preserve prior versions. Critical-result communication records recipient, time, acknowledgement and escalation. Imaging worklists link patient, encounter, accession and DICOM study identifiers; ambiguous matching goes to reconciliation.

## Medicines and pharmacy

Order → clinical verification → dispensing → administration → reconciliation. Record ingredient/product, dose and units, route, frequency, duration, prescriber and current status. Distinguish unknown allergies from no known allergies. Prevent duplicate retries and document overrides. Safety checks use a governed drug database and validated rules; do not ship fabricated interaction or pediatric dose calculations. Stock changes occur through ledger events with lot, expiry, location and author. Controlled medicine handling follows applicable local policy.

## Primary chronic hospice and palliative care

Support immunizations, screening, community referrals and preventive follow-up. Chronic programmes include diabetes, hypertension and configurable conditions with longitudinal goals, appointments, observations, adherence and referrals. Hospice and palliative care include patient goals, symptom tracking, family contacts, advance-care documentation where applicable and coordinated home visits. Record patient preferences and clinician review; avoid predicting terminal outcomes from an unvalidated model.

## Finance administration and supplies

Price service → invoice → coverage/claim → payment reconciliation → reversal/refund. Maintain decimal precision and audit price changes. Billing access uses minimum necessary service data. Staff scheduling, procurement, stock requests, equipment maintenance and departmental configuration have distinct administrative roles. Do not store raw payment card data. Use hosted payment processing where selected and verify callback signatures.

## Public health

Define reporting programme and authority → validate source cohort → generate approved aggregate dataset → suppress or review small cells → authorize release → transmit → receive acknowledgement → reconcile corrections. Identifiable statutory reporting uses a separate restricted disclosure route with documented basis. Include provenance, case definition/version, date range, denominator, missingness and reporting facility. Government connectivity is not assumed to exist until an adapter is configured and tested.

## Coded workflow requirements

Complaint, findings, diagnoses and procedures use reviewed contextual SNOMED CT selections where licensed and appropriate. Lab/vital/device observation identities use validated LOINC mappings with UCUM quantitative units. Categorical answers use the chosen value-set binding rather than forced numeric conversion. Staff can inspect preferred term, code, system and version; uncertain/unmapped input remains visibly local until reconciled.

Radiology orders progress through reconciled accession and DICOM study identities, PACS acquisition, authorized DICOMweb viewing and DiagnosticReport/ImagingStudy exchange. Laboratory local tests require reviewed LOINC mapping before standardized publication. A corrected code or imported result creates an attributable version and follows notification workflows. Claims, surveillance and operational APIs use explicit reviewed translations, never assumed semantic equivalence.
