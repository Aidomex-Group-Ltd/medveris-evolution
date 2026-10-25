# Primary sources and interpretation

Sources checked 25 October 2026. They inform selected design choices; they do not endorse Medveris or certify the proposed system. Product policies and engineering targets elsewhere in this kit are recommendations based on the supplied requirements, not quotations from these sources. Recheck current documentation during implementation.

| Source | URL | Relevance |
|---|---|---|
| Cloudflare Workers limits | https://developers.cloudflare.com/workers/platform/limits/ | Runtime limits require workload separation and measured sizing |
| Hyperdrive getting started | https://developers.cloudflare.com/hyperdrive/get-started/ | Workers-to-database connectivity setup |
| Hyperdrive query caching | https://developers.cloudflare.com/hyperdrive/concepts/query-caching/ | Review and disable cache for protected clinical queries |
| PostgreSQL row security | https://www.postgresql.org/docs/current/ddl-rowsecurity.html | RLS policies, default denial and privileged-role bypass behavior |
| HL7 FHIR R4 security | https://hl7.org/fhir/R4/security.html | FHIR requires actual security controls around exchange |
| HL7 FHIR R4 Provenance | https://hl7.org/fhir/R4/provenance.html | Clinical source and authorship mapping |
| HL7 FHIR R4 AuditEvent | https://hl7.org/fhir/R4/auditevent.html | Security and access-event mapping |
| DICOM PS3.18 web services | https://dicom.nema.org/medical/dicom/current/output/chtml/part18/ps3.18.html | Standard imaging web-service boundary |
| WHO ethics and governance of AI for health | https://www.who.int/publications/i/item/9789240029200 | Human rights, accountability and governance context |
| WHO large multi-modal model guidance | https://www.who.int/publications/i/item/9789240084759 | Governance considerations for health-related generative AI |

The chosen FHIR R4 profile is a deliberate integration starting point, not a claim that R4 is the newest release. DICOM current-edition links may change; pin the edition used by each implementation. PostgreSQL current-version links likewise require pinning to the deployed supported version. No numeric Cloudflare quota, clinical threshold, model performance or legal deadline is inferred from these references.

## Additional primary standards sources for version 1.1

Checked 25 October 2026. These sources define terminology/API behavior and inform service selection. Deployment entitlement and final contract review remain specific to the selected countries and vendors.

| Source | URL | Purpose |
|---|---|---|
| HL7 FHIR R4 terminology service | https://hl7.org/fhir/R4/terminology-service.html | Lookup, validation, expansion and translation operations |
| HL7 FHIR R4 REST interactions | https://hl7.org/fhir/R4/http.html | Metadata, read/search/version semantics and transactions |
| LOINC FHIR terminology service | https://loinc.org/kb/api/fhir | Official API access and supported terminology operations |
| LOINC license | https://loinc.org/license | Content terms and attribution review |
| SNOMED API implementation guidance | https://docs.snomed.org/implementation-guides/implementation-fact-sheets/technology-adoption/is-there-a-snomed-api | Local/hosted service options and demo/production distinction |
| SNOMED CT licensing | https://www.snomed.org/licensing | Deployment licensing review |
| SNOMED cloud/API licensing FAQ | https://ihtsdo.freshdesk.com/support/solutions/articles/4000218007-what-are-the-licensing-requirements-for-offering-a-cloud-based-solution-using-snomed-ct-via-apis-onl | Cross-country usage considerations |

Do not infer that SNOMED International supplies a production API subscription, that a public example endpoint is approved for clinical entry, or that terminology API availability establishes patient-data processing permission.
