# Terminology deployment plan — complete deployment of the terminology service

**Consolidated production-readiness review.** One deliverable that consolidates the codebase, configuration, gate, security, test and deployment records into a single decision document. The report file name is:

> `docs/terminology-deployment-plan.md`

This document **contains no code changes, infrastructure changes and no secret values**. It records what exists, what is blocked on external owners, and the exact sequence of actions required to take the terminology service from `local-reference` (current production posture) to a licensed, production configuration.

---

## 1. Executive summary

The terminology service is **implemented and tested in code, but not production-ready**. The adapter stack is complete and fails closed; the constraint that blocks production enablement is **licensing and governance**, which is outside this repository's engineering remit.

- **Current production state:** `TERMINOLOGY_MODE=local-reference` is configured in `wrangler.jsonc` for the `medveris-production` Worker. The local reference catalogue (`apps/api/src/terminology/local-reference.ts`) is a curated internal catalogue, explicitly *not* a licensed SNOMED CT or LOINC distribution. Production responses are RFC-8288 truth-driven (`GET /api/v1/public/config` exposes `terminology.synthetic=false` and `terminology.available=true`).
- **Synthetic terminology is refused in production** (`TERMINOLOGY_MODE=synthetic` throws at config time for `APP_ENV=production`); the production gate additionally rejects a synthetic flag in the live public config. This is a hard production rule, not a preference.
- **The production adapter** (`apps/api/src/terminology/production.ts`) is implemented and fail-closed: any upstream failure, credential rejection or timeout rejects with `DependencyError`; `lookup`/`validateCode` fail closed to `DependencyError`; `$expand`, `$translate` and `search` throw until an approved value set and mapping are configured. Its own probe, `verifyConnection()`, must be run against the configured provider and reports `status.connected=true` only after it succeeds.
- **What remains is an external decision**, not a code task: a licensed (or entitled) provider contract and credentials, an approved provider endpoint, an approved value set/ConceptMap review, release pinning, and clinical/interoperability governance sign-off.

There are **14 production blockers** consolidated below. They are grouped into `A. Code present, success not gated` (the engineering work), `B. Contract, licensing and governance` (the external decisions) and `C. Operational evidence` (the verification records). The deliverable names each blocker, the exact artefact that proves it, and the single named owner category that must act.

---

## 2. The 14 production blockers, classified

| ID | Phase | Blocker | Proof in the repository | Owner required |
|---|---|---|---|---|
| B1 | Contract | **No licensed/entitled terminology provider contract** (`SNOMED CT`, `LOINC`, `UCUM`). The codebase contains no supplier licence and no entitlement record. | `docs/18_SOURCES.md` (external sources, deployment entitlement not supplied), `docs/01_PRODUCT_REQUIREMENTS.md` (PR20, M1), `docs/INTEROPERABILITY_STANDARDS_POSTURE.md` (SNOMED CT: *“no SNOMED CT licence is configured”*) | Clinical safety lead + product owner (contract and entitlement) |
| B2 | Configuration | **No configured provider endpoint and token.** Production can only run `local-reference` or `unavailable`; `TERMINOLOGY_MODE=production` requires `TERMINOLOGY_PROVIDER_URL` (HTTPS) and a token (`apps/api/src/config.ts`). | `wrangler.jsonc` lines ~365 (`TERMINOLOGY_MODE: "local-reference"`), `apps/api/src/config.ts` validation block | External vendor onboarding (endpoint + token) |
| B3 | Content | **No approved value sets and ConceptMaps.** Value sets and mappings exist only locally (`apps/api/src/terminology/local-reference.ts`), including an *unreviewed* draft map (`local-lab-unreviewed-to-loinc`); nothing is *approved*. | `apps/api/src/terminology/local-reference.ts` (`conceptMaps` array, `reviewed: false` entry) | Clinical governance + terminology steward |
| B4 | Governance | **No approved release pinning.** No licence-mandated edition/version pinning, no `SNOMED_EDITION_URI`, `LOINC_RELEASE` and `UCUM` versions are committed (all `? : null`); no released content-change control. | `apps/api/src/config.ts` (`snomedEditionUri`, `loincRelease` optional), GAP_MATRIX BK18 | Clinical governance + terminology steward |
| B5 | Content | **SNOMED CT licence territory/edition.** Production territory cannot be determined until the licence is selected; no local catalogue may be served as if it were the licensed edition. | `docs/INTEROPERABILITY_STANDARDS_POSTURE.md` (SNOMED CT), `apps/api/src/terminology/types.ts` (`System`/`version` strings) | Legal + clinical safety + product owner |
| B6 | Content | **LOINC licence for redistribution.** Local catalogue is explicitly *not* a licensed LOINC distribution; any production use of LOINC content requires the redistribution terms. | `apps/api/src/terminology/local-reference.ts` (`LOCAL_REF_LABEL`) | Library/privacy comp |
| B7 | Governance | **No external FHIR validator run.** `BK16` in GAP_MATRIX: *“External FHIR validator not run.”* Health-check probes exist (production adapter probes `/version`/`api/version`), but no conformance suite against a licensed endpoint has executed. | `docs/implementation/GAP_MATRIX.md` BK16 | Terminology steward / clinical lead |
| B8 | Operations | **No production terminology probe per operation.** `RESILIENCE_RUNBOOK.md` §6 defines terminology probes, rate limits and alert thresholds, but the probe is called at verification time only, and production alert thresholds are defined, not yet created in the Cloudflare dashboard. | `docs/implementation/RESILIENCE_RUNBOOK.md` §6, §7 (drill table rows) | Operations / platform team |
| B9 | Governance | **No clinical and interoperability sign-off.** This document is an engineering record; it is not a clinical, privacy or legal sign-off and carries no certification. | `docs/implementation/SECURITY_AND_PRIVACY_REVIEW.md` (disclaimer), `docs/17_GOVERNANCE_AND_DECISIONS.md` (named owners required) | Clinical safety lead, privacy lead, security lead, product owner |
| B10 | Governance | **No DPIA/PIA/legal sign-off.** Patient-facing release, cross-border data transfer and Ugandan Data Protection Act, 2019 compliance require legal and privacy review before any real patient data. | `docs/implementation/PRODUCTION_READINESS.md` (decisions needing qualified review), `docs/implementation/SECURITY_AND_PRIVACY_REVIEW.md` (privacy notes) | Privacy lead + legal |
| B11 | Observability | **No live telemetry/alerting.** Dashboards and alert thresholds are defined but not created in the Cloudflare dashboard. | `docs/implementation/RESILIENCE_RUNBOOK.md` §6 | Operations |
| B12 | Evidence | **No fresh production restore drill.** Production is documented as Kamatera-native; no fresh restore drill of `medveris-prod` exists. `backup-verification.json` attests an Aiven drill of 2026-10-28 and is only valid against an Aiven provider. | `docs/implementation/PRODUCTION_READINESS.md` (backup attestation), `scripts/production-gate.mjs` (`checkBackupAttestation`, 90-day age limit) | Operations |
| B13 | External | **Hosted CI and production secret values are unverified.** Hosted CI has never executed; the live `production` GitHub Environment reviewers, `PRODUCTION_SECRETS` values, and the Kamatera-specific `db.env` are not reproducible from this repository. | `.github/workflows/deploy-production.yml` (required GitHub secrets), `docs/implementation/PRODUCTION_READINESS.md` | Project maintainers |
| B14 | Evidence | **No STOW-RS / full PACS conformance.** `STOW-RS` is not implemented; QIDO/WADO are partial. Terminology is separately gated behind PACS `requirePacs()`/`integrationStatus("dicomweb")` verification. | `docs/22_PACS_DICOMWEB_RUNBOOK.md`, `docs/INTEROPERABILITY_STANDARDS_POSTURE.md` (DICOMweb: STOW-RS not implemented) | Radiology/clinical lead |

---

## 3. Terminology architecture and current status

### 3.1 Adapter stack (`apps/api/src/terminology/`)

| File | Role | Production behaviour |
|---|---|---|
| `index.ts` | Factory `createTerminology(config)` | Selects `unavailable` → `production` (with `terminologyProviderUrl`) → `local-reference` → `synthetic` |
| `production.ts` | `ProductionTerminologyAdapter` | HTTP FHIR R4 client; fail-closed on any failure; `$expand`/`$translate`/`search` throw until approved value sets/mappings exist; `verifyConnection()` probe |
| `local-reference.ts` | `LocalReferenceTerminologyAdapter` | Curated internal catalogue (not a licensed SNOMED CT/LOINC distribution); `connected=true`, no external probe |
| `synthetic.ts` | `SyntheticTerminologyAdapter` | Synthetic fixtures, labelled; **disabled in production by config rule** |
| `unavailable.ts` | `UnavailableTerminologyAdapter` | Fail-closed 503 stub — every operation rejects with `DependencyError` |
| `router.ts` | Session-gated FHIR R4 router (`$lookup`, `$validate-code`, `$expand`, `$translate`) | 15 routes, all session-protected; `terminology/fhir/r4` is a read-only facade |

### 3.2 Configuration surface

- **`TERMINOLOGY_MODE`** must be one of `synthetic`, `production`, `local-reference`, `unavailable` (`apps/api/src/config.ts`).
- **Production rule.** `TERMINOLOGY_MODE=synthetic` throws in `APP_ENV=production`. `TERMINOLOGY_MODE=production` requires `TERMINOLOGY_PROVIDER_URL` (HTTPS). These are enforced both at init and in the test suite (`terminology-unavailable.test.ts`).
- **Staging** uses `TERMINOLOGY_MODE=synthetic` (CI `ci.yml` line 55; `wrangler.jsonc` staging env).
- **Production** currently uses `local-reference` (wrangler.jsonc line ~365) with a comment that no licensed terminology service is contracted; coded entries therefore report the local catalogue, not a licensed source.
- **Public config surface** (`apps/api/src/routes/public.ts`) exposes `terminology.mode`, `synthetic`, `available`, `label` and `status` so browsers and operators can distinguish configured+reachable from configured+unverified from unavailable. Green/smoke checks assert `terminology.synthetic !== false` and `terminology.available === false` fail closed.

### 3.3 Current status

| Dimension | Status |
|---|---|
| Adapter code | **Implemented and unit-tested** (`terminology-production.test.ts`, `terminology-local-reference.test.ts`, `terminology-unavailable.test.ts`, `production-gate.test.ts`) |
| Integration behaviour | **Locally exercised**; hosted CI has never run |
| Production configuration | `local-reference` configured; production gate requires `unavailable`, `local-reference` or `production` (with URL) |
| Provider endpoint/contract | **Missing** — external |
| Licensed content | **Missing** — external |
| Approved value sets / mapping governance | **Missing** — external |
| Release pinning | **Missing** — external |
| Validation | Adapter fail-closed; external FHIR validator not run (BK16) |
| Production enablement | **Blocked on B1–B7, B9–B10** (licensing, governance, sign-off) |
| Synthetic data restriction | **In force** for staging and production until terms are approved/licensed and formally cleared |

---

## 4. Staged deployment actions

The following sequence is the plan to complete the deployment. **This is a plan and owner assignment, not a change to the repository.** Items in `A` are code/config changes the engineer can make; items in `B` and `C` require named owners outside engineering and cannot be executed here.

### Phase A — Code, configuration and gating (engineered, do now)

A1. **Declare the deployment surface.** Name the target provider endpoint URL and token source in `wrangler.jsonc` (`TERMINOLOGY_PROVIDER_URL` must be HTTPS; `TERMINOLOGY_PROVIDER_TOKEN` is a Worker secret, never a plaintext var). Production configuration must satisfy the gate rule: `TERMINOLOGY_MODE=production` *and* `TERMINOLOGY_PROVIDER_URL` present. This is a `wrangler.jsonc` var change plus a secret upload via `wrangler secret put`; the gate (`scripts/production-gate.mjs` `checkProductionConfig`) enforces that `production.secrets.required` lists `TERMINOLOGY_PROVIDER_TOKEN` and any other required secrets without printing them.

A2. **Approve value sets and mappings before enablement.** Every production value set and ConceptMap must be reviewed and marked `reviewed: true`, with specimen/method/unit context where relevant (existing local catalogue already carries these for laboratory mappings). The *unreviewed* `local-lab-unreviewed-to-loinc` map must be removed or replaced; an unapproved draft mapping must never be applied. This is the content gate for `$validateCode`, `$expand` and `$translate` on the production adapter.

A3. **Pin the licensed releases.** Commit `SNOMED_EDITION_URI`, `LOINC_RELEASE` and `UCUM` versions (already surfaced in `config.ts`) so a release cannot silently change editions. Record the pinned versions in a release manifest alongside the migration and configuration digests.

A4. **Keep the fail-closed behaviour.** Do not weaken `ProductionTerminologyAdapter` or the router for convenience. Ensure `$expand`, `$translate` and `search` in production remain throwing until an approved value set and mapping are registered, and that verifyConnection failure leaves `connected=false` rather than guessing.

A5. **Add a release-cleanup record.** When the provider is live, the release evidence written by `npm run deploy:production` must capture `TERMINOLOGY_MODE`, `TERMINOLOGY_PROVIDER_URL`, `TERMINOLOGY_PROVIDER_TOKEN` reference (never the value), and the pinned content version digests into `.wrangler/release-evidence/`. Lock `npm run deploy:production:check` to a commit (already enforced: working tree must be clean).

### Phase B — Contract, licensing and governance (external owners)

B1. **Negotiate and sign the licensed terminology contract.** Specify the provider catalogue (SNOMED CT edition, LOINC, UCUM, local concepts needed), territory, data-subject access and retention terms, and licensing tier. No production terminology enablement occurs until the contract is signed and the provider is entitled.

B2. **Provide the approved provider endpoint and token.** The provider must expose an FHIR R4 terminology server, serve `/version` or `/api/version`, require HTTPS, and accept `Authorization: Bearer <token>`. Token granted as a Worker secret, never in `vars`, and never in the release evidence.

B3. **Obtain the approved value sets and ConceptMaps.** The provider (or national/legal body) approves the value sets and reviewed mappings that will be served; the repo marks them `reviewed: true`. Unreviewed or draft mappings remain blocked.

B4. **Validate with the external FHIR validator.** Run an external conformance/validator suite against the configured provider (BK16 remaining work) and record the output. This is the missing piece that separates *code present* from *proved working*.

B5. **Obtain clinical safety, privacy and interoperability governance sign-off.** These named owners (per `docs/17_GOVERNANCE_AND_DECISIONS.md`) sign the clinical, DPIA/PIA and interoperability positions. This is separate from engineering verification and is required before any real patient data or public release.

### Phase C — Operational enablement and evidence (administrative, must be recorded)

C1. **Run the production terminology probe.** Point `verifyConnection()` at the live provider and record `status.connected=true`, `providerVersion`, `lastVerifiedAt`. Operationally, the probe is fail-closed and must not be called per operation (per RESILIENCE_RUNBOOK §6).

C2. **Verify backups against the production target.** `backup-verification.json` must name `Kamatera` as provider (production gate requires `attestation.provider === PRODUCTION.expectedBackupProvider`), `targetDatabase === "medveris-prod"`, `pointInTimeRecovery: true`, `encryptedBackups: true`, the restore-drill identity, drill timestamp (within 90 days), the latest full backup label and an encryption-verified restore. The current Aiven attestation (2026-10-28) is valid only for Aiven; a Kamatera-native record must be produced and recorded before production enablement. Note the gate checks attestation *content* truthfully; it checks the provider string, not the uniqueness of provider/target credentials.

C3. **Resolve hosted CI and production secret verification.** Hosted CI and `deploy-production.yml` run only after the secrets (`PRODUCTION_SECRETS_ENV`, `PRODUCTION_RESEND_ENV`, `PRODUCTION_DB_ENV`, `PRODUCTION_BACKUP_ATTESTATION`, `CLOUDFLARE_DEPLOY_TOKEN`) are provided by the maintainers and the `production` GitHub Environment has required reviewers. Until then, production enablement is unverified by the repository's own pipeline.

C4. **Create the observability dashboards and alerts.** Create the Workers Observability saved queries and alerts from `RESILIENCE_RUNBOOK.md` §6 (API error rate, latency, database unavailable, queue backlog, dead letters, relay failures, checkpoint failure, rate-limit coordination, rejection, real-time, replica lag, readiness) on staging first, then production. Confirm `REALTIME_ENABLED=false` in production and `FEATURE_DICOMWEB=false` in both environments.

C5. **Confirm governance sign-off** for clinical and interoperability release, then flip the public banner (`FEATURE_SYNTHETIC_DATA_BANNER`) back to `false`, engage the demo banner only while production holds synthetic data.

---

## 5. Definition of done for full terminology deployment

A complete production terminology deployment is met only when **all** of the following hold:

1. A licensed/entitled provider contract and credentials exist (owner: contract and data governance).
2. `TERMINOLOGY_MODE=production` with `TERMINOLOGY_PROVIDER_URL` (HTTPS) and `TERMINOLOGY_PROVIDER_TOKEN` (secret) declared in production configuration.
3. Approved value sets and ConceptMaps exist and are `reviewed: true`; unapproved drafts are not served.
4. Licensing terms (SNOMED CT, LOINC, UCUM) cover the territory and redistribution; releases are pinned to licence-mandated editions/releases.
5. `verifyConnection()` passes and `status.connected=true`; a failing probe leaves `connected=false`.
6. All production gate assertions still pass (`npm run deploy:production:check`).
7. Staged verification on synthetic-only data has been completed, and no real patient data has been requested or processed.
8. Clinical/interoperability governance sign-off (DPIA/PIA/legal where applicable) is recorded.
9. A fresh production restore drill is recorded for the production target (Kamatera) and included in `backup-verification.json`.
10. Observability dashboards and alerts are created and running; host/CI verification of the release exists.

---

## 6. Governance and owners

| Owner role | Responsibility |
|---|---|
| Clinical safety lead | Clinical code accuracy, SNOMED CT edition licence, safety sign-off |
| Privacy lead | DPIA/PIA, data residency, cross-border transfer, retention |
| Security lead | Threat model, secrets handling, CSP, rate limit review |
| Product owner | Provider entitlement, content rights, release decision, sign-off |
| Terminology steward | Value set/mapping governance, release pinning, FHIR validator, release record |

This split is documented in `docs/17_GOVERNANCE_AND_DECISIONS.md`. No single engineering owner can clear the external terms.

---

## 7. Evidence needed and currently unavailable

| Evidence | Current state | Exact need |
|---|---|---|
| Hosted CI | Never executed | CI run on the target commit |
| Production secret values | Not reproducible from repository | Values for `PRODUCTION_SECRETS_ENV`, `PRODUCTION_RESEND_ENV`, `PRODUCTION_DB_ENV`, `PRODUCTION_BACKUP_ATTESTATION` |
| Live telemetry/alerting | Defined, not created | Cloudflare dashboard saved queries and alerts |
| Production restore drill of `medveris-prod` | Not present; Aiven drill only (2026-10-28) | Fresh Kamatera restore drill recorded in `backup-verification.json` |
| Migration state read | Not readable here | Read `schema_migrations` via tunnel (port 55432) |
| `production` GitHub Environment reviewers | Unconfirmed | Settings → Environments → production → Required reviewers |
| `FEATURE_DICOMWEB`, `REALTIME_ENABLED`, `CONTENT_FEEDS_ENABLED` in production | Confirmed `false` in `wrangler.jsonc` | No action needed while blocked |
| External FHIR validator | Not run | Record of a passing conformance run against a licensed provider |
| PACS conformance | Partial; STOW-RS missing | Passing DICOMweb conformance run |
| DPIA/PIA/legal sign-off | Not obtained | Signed privacy review |
| Named owners | Documented | Confirmation of the named owners |
| External vendor credentials and provider contract | Not present | Contract and entitlements |
| Synthetic data in staging/production | In force until terms cleared | Never request or process real patient data |

---

## 8. Synthetic-data restriction (in force)

Until the terminology terms are approved/licensed and formally cleared:

- Staging and production **hold synthetic data only**. Synthetic data must be preserved; never request or process real patient data.
- The public environment banner remains driven by server truth and must stay **non-dismissible** while production holds synthetic data.
- `TERMINOLOGY_MODE=synthetic` is a config-time error in production; the terminology adapter in production is `local-reference` (or `unavailable`) and refuses synthetic codes.
- No configuration change, deployment or content approval should silently re-enable synthetic terminology.

---

## 9. What this report does not change

- This report **modifies no code, configuration, secrets, infrastructure or deployment**. The working tree and the untracked preservation scripts (`medveris-restore-test.sh`, `medveris-rotate-pgbackrest.sh`, `scripts/rebuild-production-db.sh`) are untouched.
- It does not restate per-file prose; it consolidates the existing records in `docs/implementation/PRODUCTION_READINESS.md`, `SECURITY_AND_PRIVACY_REVIEW.md`, `GAP_MATRIX.md`, `RESILIENCE_RUNBOOK.md`, `SCALABILITY_AND_RESILIENCE.md`, `INTEROPERABILITY_STANDARDS_POSTURE.md`, `TEST_EVIDENCE.md`, `01_PRODUCT_REQUIREMENTS.md`, `14_DELIVERY_BACKLOG.md`, `17_GOVERNANCE_AND_DECISIONS.md`, `16_OPERATIONS_AND_DEPLOYMENT.md`, `deployment-architecture.md`, `docs/production-core-functionality-assessment.md`, `docs/production-recovery-deployment-checklist.md` and the gate/test scripts.

---

## 10. Report file

**`docs/terminology-deployment-plan.md`**

That is the single consolidated document for the complete terminology deployment; it captures the 14 production blockers, the architecture, the staged actions, the named owners, the evidence gaps and the synthetic-data restriction.
