# PACS / DICOMweb enablement runbook

This runbook fixes the banner **“PACS / DICOMweb unavailable — No PACS is enabled for this environment (FEATURE_DICOMWEB is not set)”** and takes an environment from configuration to verified image review.

The banner is not a transient error. DICOMweb is fail-closed by design:

1. `FEATURE_DICOMWEB` requests the integration.
2. A complete connection (`DICOMWEB_BASE_URL`, authentication, network access) makes the adapter configurable.
3. A platform operator runs a QIDO-RS/WADO-RS conformance check from the same runtime that serves users.
4. Only a stored, passing, unexpired verification makes the integration `available`.
5. A radiographer or radiologist links each Medveris study to its PACS study before images are served.

Medveris stores no pixel data and is not a diagnostic viewer. It relays rendered review images from the PACS; final reporting must still use a validated diagnostic workstation.

## Prerequisites

- A PACS with DICOMweb QIDO-RS study/series/instance search and WADO-RS rendered-frame retrieval.
- A DICOMweb root URL reachable from the API Worker or local API process.
- A dedicated PACS account that requires credentials and has least-privilege read access.
- At least one real or synthetic study in the PACS, or a known Study Instance UID for verification.
- Clinical and security approval for the endpoint, account, retention and image-review workflow.
- A platform operator account to record verification (`reviewer@medveris.local` locally).
- A radiographer or radiologist to register, link and unlink studies.

## Configuration reference

| Setting | Kind | Required | Notes |
|---|---|---|---|
| `FEATURE_DICOMWEB` | var | yes | Set `true` to request the integration. |
| `DICOMWEB_BASE_URL` | var | yes | DICOMweb root, e.g. `https://pacs.example.org/dicom-web`. No trailing slash, credentials, query or fragment. HTTPS outside development/tests. |
| `DICOMWEB_AUTH` | var | yes | `basic` or `bearer` outside development/tests; `none` is local-only. |
| `DICOMWEB_USERNAME` | secret | basic | PACS account username. |
| `DICOMWEB_PASSWORD` | secret | basic | PACS account password. |
| `DICOMWEB_BEARER_TOKEN` | secret | bearer | Bearer token when `DICOMWEB_AUTH=bearer`. |
| `DICOMWEB_TIMEOUT_MS` | var | no | Per-request timeout, default `15000`. |
| `DICOMWEB_MAX_IMAGE_BYTES` | var | no | Largest rendered frame relayed, default `20971520` (20 MiB). |
| `DICOMWEB_VERIFICATION_MAX_AGE_DAYS` | var | no | A passing verification expires after this many days, default `30`. |

Never put credentials in `DICOMWEB_BASE_URL`; they must be Worker secrets in staging and production.

## Workflow A — local end-to-end with the synthetic PACS

Use this to prove the whole path without a real PACS or real patient data.

### A1. Start the synthetic PACS

```bash
npm run pacs:mock
```

It prints the values to use, for example:

```text
DICOMWEB_BASE_URL=http://localhost:8042/dicom-web
DICOMWEB_AUTH=basic
DICOMWEB_USERNAME=medveris
sample Study Instance UID: 2.25...
```

The mock requires basic credentials by default. `PACS_OPEN=true` makes it answer unauthenticated requests, which the conformance check should reject; that is useful for testing the failure path. Override `PACS_PORT`, `PACS_USERNAME`, `PACS_PASSWORD`, `PACS_ACCESSION`, `PACS_FAMILY`, `PACS_GIVEN`, `PACS_BIRTHDATE` and `PACS_SEX` as needed.

### A2. Configure the API

In `.env`:

```dotenv
FEATURE_DICOMWEB=true
DICOMWEB_BASE_URL=http://localhost:8042/dicom-web
DICOMWEB_AUTH=basic
DICOMWEB_USERNAME=medveris
DICOMWEB_PASSWORD=synthetic-pacs-password
```

Restart `npm run dev` so the API reloads the environment.

### A3. Run the conformance check

Sign in as the platform operator and open **Platform → Integrations**, or call the API:

```bash
# Sign in, complete MFA, then use the session cookie and CSRF token from the response.
curl -X POST http://localhost:8787/api/v1/admin/integrations/dicomweb/verify \
  -H 'content-type: application/json' \
  -H "cookie: mv_session=..." \
  -H "x-medveris-csrf: ..." \
  -d '{}'
```

The run must report these checks as passed:

- `configuration`
- `credentials-required` — an unauthenticated search must be refused
- `qido-rs-studies`
- `qido-rs-series`
- `qido-rs-instances`
- `wado-rs-rendered`

If the PACS has no studies, pass a known UID:

```json
{ "sampleStudyInstanceUid": "1.2.840..." }
```

A passing run is stored in `integration_verifications` and expires after `DICOMWEB_VERIFICATION_MAX_AGE_DAYS`.

### A4. Link a study and view images

1. Sign in as a radiographer or radiologist and register an imaging study from the radiology worklist (or use an existing study).
2. Open the study/report and find **Images (PACS)**.
3. **Search PACS** by accession. The mock creates a synthetic study for the requested accession, so any Medveris accession returns a candidate.
4. Check the identity comparison. If the synthetic patient demographics do not match, either restart the mock with matching `PACS_FAMILY`/`PACS_GIVEN`/`PACS_BIRTHDATE`/`PACS_SEX`, or record a reason of at least 10 characters to link anyway.
5. **Link** the study.
6. Open a series and view the rendered frames. Every image access is audited as `radiology.images.view`; PACS searches and links are audited as `radiology.pacs.search` / `radiology.pacs.link`.

### A5. Test failure paths deliberately

- Stop the mock and re-run verification: it fails at `credentials-required` or a later step, and the integration stays unavailable.
- Start with `PACS_OPEN=true`: verification fails at `credentials-required` because the PACS accepts unauthenticated searches.
- Use a wrong password: verification fails with an `unauthorized` detail.
- Let the verification age past the configured maximum: the integration becomes unavailable again until reverified.

## Workflow B — staging or production

### B1. Prepare the connection

1. Obtain the DICOMweb root and a least-privilege read account from the PACS administrator.
2. Confirm the Worker can reach the endpoint over HTTPS. Do not use a redirecting URL; configure the final DICOMweb root.
3. Confirm the PACS refuses unauthenticated searches. The conformance check fails an open PACS.
4. Record the endpoint, account owner, approval reference and review date in the integration register.

### B2. Declare variables and secrets

For staging, add to `env.staging.vars` in `wrangler.jsonc`:

```jsonc
"FEATURE_DICOMWEB": "true",
"DICOMWEB_BASE_URL": "https://pacs.example.org/dicom-web",
"DICOMWEB_AUTH": "basic",
```

For production, add the same keys to `env.production.vars`.

Declare the matching credentials in the environment’s `secrets.required` list:

```jsonc
// basic
"DICOMWEB_USERNAME", "DICOMWEB_PASSWORD"
// or bearer
"DICOMWEB_BEARER_TOKEN"
```

Store the values outside the repository:

- Staging: `~/.config/medveris/staging/secrets.env` (mode `0600`), or `npx wrangler secret put DICOMWEB_PASSWORD --env staging`.
- Production: `~/.config/medveris/production/secrets.env` (mode `0600`), or `npx wrangler secret put DICOMWEB_PASSWORD --env production`.

The deploy gates now accept `FEATURE_DICOMWEB=true` only when the endpoint is HTTPS, the auth mode is `basic` or `bearer`, and the matching secrets are declared. They still refuse `FEATURE_DICOMWEB=true` with `DICOMWEB_AUTH=none`.

### B3. Deploy through the gate

```bash
npm run deploy:staging:check
npm run deploy:staging

npm run deploy:production:check
npm run deploy:production
```

The gates upload missing declared secrets from the protected secrets files. A deployment does not make the PACS available; verification does.

### B4. Verify from the deployed runtime

Sign in to the deployed environment as a platform operator and run **Platform → Integrations → Run verification**, optionally with a sample Study Instance UID. A facility administrator who also holds the platform operator role can use **Admin → Integrations** instead. Verification proves network reachability from the Worker, credential enforcement, QIDO-RS parsing and WADO-RS rendered retrieval. It stores only check names, outcomes, timings and non-identifying details.

### B5. Enable clinical use

Radiographers/radiologists link studies as in Workflow A4. Until a study is linked, reports can still be written from images reviewed outside Medveris; the study keeps metadata only.

### B6. Monitor and reverify

- Check **Platform → Integrations** (or **Admin → Integrations** for a facility administrator) for `verification_failed` or an expired verification.
- Re-run verification before the configured maximum age.
- A failed verification immediately makes the integration unavailable; linked studies remain linked, but image retrieval is refused until a later run passes.
- Monitor PACS latency, timeout and error responses. `pacs_unavailable` is returned as a retryable dependency failure; authorization and identity failures are not retryable.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Banner says `FEATURE_DICOMWEB is not set` | Flag false or absent | Set `FEATURE_DICOMWEB=true` and redeploy/restart. |
| `misconfigured: DICOMWEB_BASE_URL is not set` | No endpoint | Set the HTTPS DICOMweb root. |
| `misconfigured: DICOMWEB_AUTH=basic requires ...` | Credentials missing | Add the username and password as secrets. |
| `misconfigured: DICOMWEB_BASE_URL must use HTTPS` | HTTP endpoint outside local | Use HTTPS or the local mock. |
| `misconfigured: ... must not embed credentials` | Userinfo in URL | Remove it and use secrets. |
| `verification_failed: never verified` | No stored run | Run verification as a platform operator. |
| `verification_failed: ... failed` | Endpoint, credentials, network or open PACS | Read the failed check detail, fix it, rerun. |
| `verification_failed: ... older than N days` | Expired verification | Re-run verification. |
| `pacs_unavailable` with `failure: unreachable` | Worker cannot reach the PACS | Fix network/DNS/firewall; confirm the final URL. |
| `pacs_unavailable` with `failure: timeout` | PACS too slow | Raise `DICOMWEB_TIMEOUT_MS` within limits or fix PACS latency. |
| `pacs_unavailable` with `failure: unauthorized` | Wrong or expired credentials | Rotate the PACS account credentials and secrets. |
| `pacs_rejected` on a frame | Frame number beyond the image | Use a frame returned by the instance listing. |
| Search returns no candidates | Accession/patient/date do not match | Search by the exact accession, PACS patient ID or study date range. |
| Link refused with an identity mismatch | Family name or date of birth differs | Check the study; if correct, record an override reason of at least 10 characters. |
| Link refused as already linked | PACS study linked to another Medveris study | Unlink the other study with a reason first. |
| Images refused after unlink | Study is no longer reconciled | Relink the correct PACS study. |

## Disable or roll back

- Set `FEATURE_DICOMWEB=false` and redeploy. The integration becomes unavailable immediately; linked study metadata remains but no PACS request is made.
- To stop using a specific PACS without disabling the feature, remove its credentials or change the endpoint. The stored verification is bound to the endpoint fingerprint, so a new endpoint requires a new passing run.
- To unlink one study, use **Unlink PACS study** with a reason. The study returns to `pending` and images are no longer served.

## Security and governance notes

- Use HTTPS and a dedicated least-privilege PACS read account. Never use a shared administrator account.
- Do not store credentials in `wrangler.jsonc`, `.env.example` or the repository. Staging and production values are Worker secrets.
- Verification is recorded without patient identifiers or demographics.
- Every PACS search, link, unlink and image access is audited.
- The rendered-frame viewer is for review only. Confirm findings on a validated diagnostic workstation before signing a report.
- STOW-RS is not implemented: Medveris does not upload or modify studies in the PACS.
- Re-run verification after credential rotation, endpoint changes, PACS upgrades or the configured maximum age.

## Acceptance evidence

```bash
npm run lint
npm run typecheck
npm test -- tests/integration/pacs.test.ts tests/unit/production-gate.test.ts tests/unit/staging-gate.test.ts
```

The PACS integration test covers the never-verified state, failed and open-PACS verification, passing QIDO/WADO verification, identity-checked linking, duplicate-link refusal, rendered-frame relay, unreachable-PACS handling and unlink.
