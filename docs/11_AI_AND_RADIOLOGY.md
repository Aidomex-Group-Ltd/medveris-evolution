# Clinical AI prediction and radiology support

This specification defines controlled support workflows. It does not validate a model, provide a clinical diagnostic protocol or authorize autonomous medical decisions. Each production task needs an approved intended use, representative evaluation, accountable clinical owner and appropriate local regulatory assessment.

## Task registry

| Task | Inputs | Reviewable output | Release condition |
|---|---|---|---|
| Record summary | Authorized records with exact version references | Structured summary and source links | Factuality, omission and privacy evaluation |
| Differential support | Complaint, history, examination, authorized results | Candidate considerations, supporting/conflicting evidence and missing information | Intended-population clinical evaluation |
| Care prediction | Defined longitudinal features with timestamps | Specific defined risk/time horizon and limitations | Calibration, subgroup testing and prospective workflow evaluation |
| Follow-up assistance | Approved care plan and current observations | Overdue follow-up or review suggestions | Governed rules and clinical acceptance |
| Report assistance | Prior/current reports and clinical question | Draft comparison or structured report | Radiologist review and source fidelity |
| Image analysis | Validated modality/body region/protocol | Task-specific findings or overlays | Modality-specific performance and intended-use approval |

Do not promise prediction of all chronic diseases. A model needs a precise outcome, eligible population, prediction horizon, validation dataset and actionable workflow. Do not infer calibrated probabilities from an LLM's prose or self-reported confidence.

## AI job lifecycle

Requested → eligibility checked → evidence snapshot prepared → queued → running → output validated → clinician review → accepted/edited/rejected. Include failed, cancelled, expired and withdrawn states. Re-evaluate data permissions before gathering inputs and before returning output. If input versions change, mark the output stale and require re-evaluation. Never silently update an existing signed diagnosis or prescription from a model result.

Store job ID, patient/tenant scope, authorized input references and digest, model/provider/version, prompt template version, retrieval index version, inference configuration, time, task eligibility, output, validation flags and clinician decision. Source-linked evidence should identify actual chart entries or approved clinical references; reject fabricated citations. Keep sensitive prompts/results out of generic logging.

## Retrieval and safeguards

Only retrieve permitted patient records and licensed, versioned clinical knowledge. Separate approved knowledge sources from arbitrary uploaded text. Treat patient documents as untrusted input that cannot change access policy or issue tool instructions. Do not let the model call general database queries, grant access, send messages or execute treatment commands. Enforce output schemas, scope controls and a manual workflow on failure. No patient data is used for vendor training by default.

Guard against hallucinations, omissions, anchoring, automation bias, wrong-patient context, missing units, historical/current confusion and demographic bias. Distinguish unavailable evidence from normal findings. Escalation content follows approved pathways; an unavailable AI service must not delay emergency treatment or suppress standard alerts.

## Radiology architecture

Use a PACS with supported DICOMweb operations and an appropriately selected diagnostic viewer. Support worklists, study/series/instance identity, accession matching, prior comparison, image access audit, report versions and critical-result acknowledgement. Uploaded screenshots and generic thumbnails are not substitutes for diagnostic-quality studies. Diagnostic viewing requires review of modality, display, image fidelity, tools, workflow and local requirements.

A radiology model registry specifies modality, anatomy, patient population, acquisition protocol, image quality constraints, contraindications, output format, model version and approval status. Dispatch only eligible studies. Out-of-scope, corrupted or incomplete studies receive explicit unsupported/needs-review outcomes. A general multimodal model can be explored for bounded report assistance but is not assumed clinically suitable for every X-ray, CT, MRI, ultrasound or other study.

AI findings remain separate from preliminary and final radiologist reports. The authorized radiologist reviews, edits and signs the final report. Preserve original images and trace overlays to exact instances and model versions. Reprocessing does not overwrite the previous output. Wrong-patient/study matches must be quarantined for reconciliation.

## Validation and monitoring

Write a model card and evaluation protocol per task. Record dataset provenance and permission, inclusion/exclusion criteria, patient-level split, external validation, population representation, failure analysis and clinically appropriate endpoints. For prediction use discrimination, calibration, missingness and decision impact; for image analysis use task-specific metrics and false-negative/false-positive review; for summaries test factuality and clinically significant omissions. Acceptance thresholds are set in advance by qualified owners, not invented by the coding agent.

Run a silent prospective evaluation before visible clinical recommendations when appropriate. Monitor drift, subgroup performance, user overrides, adverse events and alert fatigue. Provide per-task kill switches, rollback to a known model version and continued manual operation. Claims are limited to the evaluated model, task, population and setting.

## Standardized AI evidence

AI inputs reference FHIR/native resource versions, SNOMED CT edition and LOINC/UCUM observation semantics. Resolve units, specimen, measurement time and code meaning before feature construction. AI-proposed codes are suggestions validated against the selected value set and reviewed before chart commit; never trust generated identifiers. Radiology jobs identify exact DICOM study/series/instances, acquisition context and eligible SOP classes through the authorized PACS adapter. Keep overlays/results linked to originals; use DICOM structured reporting or segmentation only where the chosen model and receiving PACS explicitly support tested object semantics. Terminology release changes require feature/model compatibility review.
