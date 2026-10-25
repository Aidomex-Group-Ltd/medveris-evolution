# Security and threat model

## Protected assets and trust boundaries

Assets include clinical content, identity directory, consent, staff credentials, audit proofs, device telemetry, payment references and encryption keys. Boundaries include public browser to API, API to database, tenant API to exchange, API to objects, hospital devices to gateway, gateway to cloud and cloud to external vendors. Assume malicious tenants, stolen staff sessions, compromised integrations, curious operators and accidental disclosure.

| Threat | Required control | Verification |
|---|---|---|
| Guessed ID or object reference | Non-sequential IDs, exact lookup controls and per-resource authorization | Anonymous and wrong-tenant requests disclose nothing |
| Tenant leakage | Runtime RLS, composite constraints, scoped repositories and narrow exchange role | Test all operations under actual runtime roles |
| Stolen staff session | MFA, secure cookies, expiry, recovery controls and revocation | Removed membership and revoked sessions fail immediately |
| CSRF or XSS | CSRF defense, strict origins, CSP, output escaping and safe rich text | Browser security tests; no unsafe rendered HTML |
| SQL injection | Parameterized queries and bounded filters | Fuzz inputs and inspect query construction |
| Malicious uploaded file | Size/type checks, quarantine, malware scan and private delivery | Mismatched MIME, malware and oversized files rejected |
| Audit tampering | Append-only runtime privileges, signed checkpoints, independent copies | Alteration and missing-event verification tests |
| Consent bypass | Central decision service and execution-time rechecks | Revoke during queued export and before download |
| Cache leakage | No-store, disabled protected query cache and client cache clearing | Two users and tenants never share responses |
| Device spoofing/replay | Device credentials, signatures, sequence tracking and assignment validation | Replay, wrong-patient and revoked-device tests |
| Model prompt injection | Treat records as untrusted evidence; no tool authority from documents | Malicious document cannot request data or invoke actions |
| Vendor data exposure | Approved contracts, retention, region and scoped payloads | Outbound integration inventory and egress tests |
| Insider misuse | Least privilege, no standing operator chart access, audited temporary access | Privileged access review and denied admin chart test |
| Ransomware or deletion | Isolated backups, protected retention and restore drills | Timed recovery from separate credentials |
| Export exfiltration | Minimal scope, reauthentication, size limits, expiry and audit | Revocation and object access tests |

## Identity and application controls

Use a maintained identity solution supporting staff MFA and secure recovery. Enforce TLS, credential rotation, secret stores, service token audiences and strict CORS. Rate-limit authentication, patient lookup and exports. Mask identifiers in logs. Disable session recording and third-party analytics on clinical pages unless explicitly approved and proven to exclude protected content. Do not attach patient names to error traces, URLs or email subjects.

Database access should be private where feasible, TLS-protected and restricted to approved origins/services. Use separate migration, tenant-runtime, exchange, audit-ingest and backup roles. FORCE RLS where appropriate; remember superuser and BYPASSRLS are exceptions. Review privileged functions and search paths. Test pooled context isolation and SQL behavior rather than assuming ORM scoping is enough.

## File and image lifecycle

Uploads move pending → quarantined → scanned → available/rejected. Verify declared versus detected type, file signatures, size and decompression limits. Strip unnecessary metadata for derivatives while retaining required original clinical evidence under policy. Reject active executable content. Protect DICOM metadata as patient data. Object keys are opaque and private. Scan completion and authorization must be checked before serving; possession of a URL is insufficient authority.

## Privacy engineering

Map collection purposes, access roles, processing locations, retention and sub-processors. Separate legal identity evidence from the ordinary chart. Limit public directory data. Distinguish operational processing from research and model training; disable training reuse by default. De-identification requires assessment of residual reidentification risk, including small cohorts, dates and images. Retain only the minimum data needed for each purpose and execute governed disposal across indexes, derivatives and vendors.

## Security acceptance

Before pilot: dependency and secret scans, permissions review, isolation tests, upload tests, external vendor review and recovery drill. Before broader clinical deployment: independent penetration testing and closure of high-impact findings, plus review of tenant exchange, identity merging, overrides, export and operator access. Security sign-off records the tested release and scope; it is not a blanket compliance certificate.

## Standards and integration threats

FHIR searches, `_include`, `_revinclude`, history, counts, pagination links and exports require the same record-level filtering as direct reads. Reject unbounded unsupported search and validate client scopes. Guard DICOMweb query/retrieve metadata, frames and bulk-data references against indirect object access. Disable arbitrary PACS or terminology URL proxying and validate destinations to prevent SSRF. ECL/filter/expansion requests have depth, length, pagination and execution limits. Keep code-system content rights and credentials behind server-side adapters; never place vendor credentials in React bundles. Log no patient-containing search terms to public terminology services.
