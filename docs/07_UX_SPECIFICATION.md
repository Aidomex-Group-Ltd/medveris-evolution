# User experience specification

## Product structure

Use a public information area, patient portal, facility workspace and restricted platform operations console. Public visitors can read service information and begin free signup. Public pages expose only provider-approved directory details and verification facts, never patient search results. Choose one canonical Medveris brand before launch; do not reuse another product's logo.

## Screen inventory

| Workspace | Screens |
|---|---|
| Public | Home, patient signup, provider signup, directory, credential explanation, privacy and support |
| Patient | Home, patient ID card, records, appointments, medications, consent, access history, proxies, telehealth, account recovery |
| Reception | Registration, identity confirmation, daily schedule, queues, encounters and permitted billing summary |
| Clinical | Assigned worklist, chart, encounter editor, observations, orders, results, prescriptions, referrals and handoffs |
| Wards | Bed board, admissions, transfer dialog, nursing tasks, medication administration and discharge |
| Diagnostics | Order worklist, specimen accession, imaging viewer, preliminary/final report and critical result tracking |
| Theatre | Case board, preoperative assessment, checklist, anesthesia record and recovery handoff |
| Finance | Invoices, claims, payments, reversals, reconciliation and reports |
| Administration | Facilities, departments, memberships, credentials, policies, supplies and integrations |
| Governance | Verification queue, emergency access reviews, audit search, safety events and approved exports |

## Patient chart

Keep patient identity, active encounter, source facility and allergy state visible. Provide summary, timeline, conditions, medicines, observations, investigations, procedures, care plans and documents tabs. Show author/source, clinical time, entered time and signed/amended state. Distinguish preliminary from final reports, patient-reported from clinician-observed information, and AI suggestions from signed clinical facts. Restricted information must not leak through tab counts or hidden DOM content.

An amendment dialog requires reason and expected version, displays the previous value and proposed change, and confirms authorship. A conflict prompts reload and comparison; never silently overwrite. An exchange-access dialog describes what is requested, by whom, for which purpose and duration. A denied record offers permitted next actions without revealing protected details.

## Trust and AI presentation

Credential cards say Submitted, Verification pending, Verified, Expired, Rejected or Revoked and include dates and scope. Use text with icons, not color alone. A verified facility license must not imply every practitioner or listed service is verified. Capability claims show evidence and limitations.

AI panels show task, evidence links, missing information, uncertainty explanation, generation time, model/version and review controls. Label confidence only when a calibrated task-specific value is available. Do not display invented percentages. Absent or failed AI leaves manual clinical workflows usable. An image-analysis overlay remains traceable to its exact study/series/model and cannot masquerade as a final radiologist report.

## Interaction requirements

Target readable 16px body text, strong contrast, keyboard navigation, labeled inputs, semantic tables, appropriate touch targets and visible focus. Test mobile registration, patient portal and lightweight observations separately from workstation imaging. Support high zoom, narrow screens and low bandwidth. Do not assume reliable video or large-image access.

Every action has loading, empty, validation, denied, stale-data, conflict and dependency-failure states. Distinguish saved draft, saving, signed and unsaved work. Require confirmation for identity merges and irreversible privileged actions. Disable repeat submissions while preserving retry safety. Clear chart state on logout, tenant switch and patient switch. Warn before losing an unsaved clinical draft.

Persist no chart data in browser localStorage or generic service-worker caches. Idle lock and session expiry require safe draft handling within the approved storage policy. Use generic notifications without diagnosis details. Timestamp observations with freshness and connection state; stale data never looks live. Provide a documented downtime route when a required dependency is unavailable.

## Terminology and interoperability interfaces

Provide contextual clinical term search with preferred terms, synonyms, system, edition and active status. Persist the selected code behind the readable label. Do not expose a generic global code picker for every clinical field. For lab order catalogues show specimen/method details needed to select the correct LOINC mapping. A terminology outage or inactive concept has a clear local-draft/reconciliation state.

Provide restricted integration status, unresolved identity/mapping queues and import validation reports. The imaging viewer shows reconciled patient/study/accession identity, source archive and diagnostic-versus-preview limitations. FHIR export previews show included scope and source provenance without implying unrestricted access. Avoid dumping standard payload syntax into ordinary clinical tasks.
