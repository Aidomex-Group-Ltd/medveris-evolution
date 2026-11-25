# Production Security Findings

| Item | Value |
|---|---|
| Audit timestamp | `2026-11-23T09:49:39Z` (UTC) |
| Scope | Read-only production security review |
| Data handling | Aggregate counts and catalog metadata only; no PHI or secret values printed |
| Verdict | **B. DEPLOYED BUT NOT APPROVED FOR REAL PATIENT DATA** |

## Severity rubric

- **Critical**: can directly expose PHI, allow cross-tenant access, destroy data, or prevent recovery.
- **High**: materially weakens authentication, authorization, auditability, availability, or deployment integrity.
- **Medium**: meaningful operational, compliance, or product-readiness gap; not by itself a direct PHI disclosure.
- **Low**: hygiene or documentation issue with limited immediate risk.

## Findings

### `SEC-01` Critical — Production RLS hardening is not applied

Evidence:

- Production `schema_migrations` has `89` rows; latest numeric migration is `138_clinical_entry_attachments_rls.sql`.
- Migrations `139`–`146` are pending.
- Fresh catalog query: `integration_tokens_all` is `ALL` with `USING true` and `WITH CHECK true`.
- `patients_staff_read` uses only `actor_kind='staff'` and `current_user() IS NOT NULL`; no tenant link.
- `patient_accounts_staff` uses only `actor_kind='staff'`.

Impact: any staff-context session can read across tenants; token table access is overbroad. Risk exists even though current count-only query showed `patients=0` and `memberships=0`.

Remediation: apply reviewed migrations `139`–`146` through the controlled release process; verify catalog diff; rerun tenant-isolation integration tests.

Retest: query `pg_policies` after migration and verify no `ALL` policy has unconditional `true`; run `tests/integration/rls.test.ts` and cross-tenant smoke tests with synthetic data.

### `SEC-02` Critical — Recovery is unverified and pgBackRest is crash-looping

Evidence:

- `pgbackrest.service`: `activating (start-post) (Result: exit-code)`, `NRestarts=16221`, `Restart=always`, `RestartUSec=1s`.
- `/usr/bin/pgbackrest server` exits `status=37`.
- `ssh medveris-hapi 'pgbackrest info --stanza=medveris --output=json'` → `rc=41`: `unable to open file '/etc/pgbackrest/pgbackrest.conf' for read: [13] Permission denied`.
- `sudo -n pgbackrest ...` → `sudo: interactive authentication is required`.
- `backup-verification.json` has `result="pass"` but `backupLabel=""`.
- `PRODUCTION_BACKUP_INVENTORY` is absent from GitHub production secrets.

Impact: no independently verified PITR or restore drill exists after the WAL archiving incident; data-loss recovery is unproven.

Remediation: repair pgBackRest daemon, grant read access to an audited inventory path or run via controlled privileged process, capture real JSON inventory, perform post-fix full restore and PITR drill, record backup label and target time, update gate secrets/docs.

Retest: `checkBackupAttestation` must pass with real inventory and non-empty label; archive restore signatures and timestamps.

### `SEC-03` High — Deployed source does not match reviewed commit

Evidence: local HEAD `7117f36813126010d03e20d975ce97437ecd3388`; deployed Worker tag `18f842a`, created `2026-11-13T13:20:37.83605Z`.

Impact: security fixes in local HEAD and uncommitted follow-up fixes cannot be assumed present.

Remediation: deploy reviewed commit from clean tree; record version ID and tag; verify health checks.

Retest: confirm Worker tag/commit mapping and rerun production smoke suite.

### `SEC-04` High — Expired exchange grants remain readable by staff in intended final policy

Evidence: `packages/db/migrations/142_patient_scope_rls_hardening.sql` removed active-window filters from recipient-tenant `exchange_grants` read; `tests/integration/rls.test.ts` now expects expired-grant audit visibility. `app.patient_exchange_lookup()` still checks active window.

Impact: revoked/expired patient-sharing consent may still expose patient data to staff under the recipient tenant.

Remediation: reintroduce active-window enforcement in staff read policy or document explicit audit-only exception with a separate non-PHI view; update tests accordingly.

Retest: expired grant test must show no PHI read through normal patient endpoints.

### `SEC-05` High — Cross-tenant PHI helper lacks tenant linkage

Evidence: `app.patient_enrollment_lookup(text, text, date)` in `packages/db/migrations/142_patient_scope_rls_hardening.sql` filters on staff actor, non-null user/tenant, and exact `(public_id, family_name, date_of_birth)` but does not enforce that the caller's tenant links to the patient.

Impact: staff with matching identifiers from another tenant may receive cross-tenant PHI.

Remediation: add tenant linkage via `created_tenant_id` or `tenant_patient_links`, require valid exchange grant where appropriate, and add cross-tenant regression test.

Retest: positive same-tenant lookup succeeds; cross-tenant lookup returns no rows.

### `SEC-06` High — Overbroad grants and ALL policies remain

Evidence: production has `229` `ALL` policies; prior review identified `101` public `ALL` policies with mismatched or NULL `WITH CHECK`; runtime has DELETE on `163` tables; `integrity_checkpoints`, `integrity_checkpoint_events`, `ledger_anchors` have no RLS.

Impact: excessive write/delete capability and weak integrity-table protection.

Remediation: apply migrations `141`, `143`, and `146`; audit grants; remove unnecessary DELETE privileges.

Retest: compare grant catalog before/after; verify integrity tables have RLS and FORCE RLS.

### `SEC-07` High — Root-run Cloudflare unit is writable by non-root user

Evidence: `/etc/systemd/system/cloudflared-medveris.service` mode `-rw-r--r--`, owner `deploy:deploy`, but `User=root`.

Impact: a compromised `deploy` account can alter service behavior executed as root.

Remediation: `chown root:root` and `chmod 0644`; validate with `systemd-analyze verify`; restart only in approved maintenance window.

Retest: file owner root; non-root write attempt denied; service health unchanged.

### `SEC-08` High — Forgeable platform-role GUC gates are still in production

Evidence: migration `145_platform_role_guc_hardening.sql` is pending; local final tree removes direct `current_setting('app.*')` gates and uses DB-backed checks.

Impact: platform identity may be asserted by callers rather than derived from database-backed role membership.

Remediation: apply migration `145`; update callers to DB-backed helpers; add negative tests with forged GUCs.

Retest: forged `app.platform_role` must not grant operator access.

### `SEC-09` High — Privacy self-service routes promised but missing

Evidence: `docs/privacy-policy-draft.md:99,109` promise “Settings > Privacy”; `apps/api/src/routes/me.ts:14-244` exposes no correction, deletion, export, or preference endpoints.

Impact: privacy notice is inaccurate; data-subject rights workflow is unimplemented.

Remediation: implement routes and UI, or amend notice before go-live; add audit events and retention-safe export/deletion flows.

Retest: authenticated data-subject request produces export/correction/deletion artifacts with audit trail.

### `SEC-10` Medium — Payment adapter mismatch

Evidence: `apps/api/src/routes/finance.ts:1170-1177,1241-1245` is Yo-only while checkout/webhook handle LivePay; `scripts/production-gate.mjs:155-159` requires Yo production mode and secrets; `wrangler.jsonc:407-416` omits `LIVEPAY_ACCOUNT_NUMBER`.

Impact: advertised payment methods may fail or be inconsistent with production configuration.

Remediation: select one production payment mode, align adapter/gate/config, and test signed webhooks.

Retest: one real low-value sandbox or controlled production transaction with reconciled ledger and receipt.

### `SEC-11` Medium — Observability and integration claims not fully verified

Evidence: gate checks support-center URL reachability but not alert destination or Cloudflare token; support center is pull-only; integration registry labels availability without live provider callbacks.

Impact: operators may believe monitoring and integrations are validated when only static configuration exists.

Remediation: add live alert delivery test, token verification, scheduled synthetic checks, and accurate capability labels.

Retest: trigger test alert and verify destination; invoke provider health checks with credentials.

## Positive controls observed

- Local final tree has no direct `current_setting('app.*')` RLS gates after migration `145`.
- All 38 `app` schema SECURITY DEFINER functions in the reviewed tree use `search_path=public, pg_temp`.
- `setLocalContext` uses transaction-local `set_config(..., true)`.
- No secret values or PHI were exposed during the audit.

## Security conclusion

Security approval is withheld. Critical RLS and recovery gaps alone block go-live for real patient data.
