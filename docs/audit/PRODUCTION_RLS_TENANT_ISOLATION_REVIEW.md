# Production RLS and Tenant Isolation Review

| Item | Value |
|---|---|
| Audit timestamp | `2026-11-23T09:49:39Z` (UTC) |
| Scope | Read-only review of production policy catalog, reviewed migration tree, and tenant-isolation tests |
| Production RLS coverage | `270` of `280` public tables have RLS and FORCE RLS |
| Final verdict | **B. DEPLOYED BUT NOT APPROVED FOR REAL PATIENT DATA** |

## Method

Reviewed production catalog via `pg_policies` and `pg_class` over a temporary SSH tunnel, compared migrations `139`–`146` in the local tree, reviewed SECURITY DEFINER helpers, and inspected tenant-isolation integration tests and recent failure logs. No PHI rows were read.

## Evidence

### Production catalog

Fresh read-only queries returned:

- `public_tables=280`, `rls_tables=270`, `force_rls_tables=270`.
- `all_policies=229`.
- `integration_tokens`, policy `integration_tokens_all`, `cmd=ALL`, roles `{public}`, `qual=true`, `with_check=true`.
- `patients`, policy `patients_staff_read`, `cmd=SELECT`, roles `{public}`, `qual=(app.actor_kind()='staff' AND app.current_user() IS NOT NULL)`.
- `patient_accounts`, policy `patient_accounts_staff`, `cmd=SELECT`, roles `{public}`, `qual=(app.actor_kind()='staff')`.
- `patients_staff_update` is tenant-linked via `tenant_patient_links`.
- `patients_integration_read` includes tenant/link checks.
- Tables without RLS: `integrity_checkpoints`, `integrity_checkpoint_events`, `ledger_anchors`.

### Reviewed local migration set

Positive controls in the reviewed tree:

- `139_memberships_rls_hardening.sql`: membership modifications require actor self/membership or valid invitation path.
- `140_integration_tokens_tenant_scope.sql`: token policies scoped to tenant/client identity; follow-up grants `SELECT ON public.integration_clients TO medveris_exchange` because the SECURITY DEFINER token trigger owner needs it.
- `141_all_policy_delete_overgrant_split.sql`: splits broad `ALL` policies.
- `142_patient_scope_rls_hardening.sql`: scopes patient and patient-account staff reads; adds `app.patient_enrollment_lookup(text, text, date)`.
- `143_remaining_rls_overgrant_hardening.sql`: narrows remaining write/audit/outbox/exchange/report policies; follow-up adds `sponsored_metrics_anonymous_read`.
- `144_global_catalogue_read_hardening.sql`: removes dead authenticated branches from global catalogue reads.
- `145_platform_role_guc_hardening.sql`: replaces forgeable GUC gates with DB-backed role checks.
- `146_integrity_rls_and_guards.sql`: adds RLS and guards to integrity/ledger tables.

## Findings

### `RLS-CRIT-01` — Unconditional integration token policy in production

Severity: Critical.

`integration_tokens_all` grants `ALL` with unconditional `true` for `USING` and `WITH_CHECK`. This is an overbroad read/write/delete path for sensitive integration credentials.

Remediation: apply migration `140` and verify no unconditional `ALL` policy remains on `integration_tokens`.

Retest: query `pg_policies` and run `tests/integration/directory.test.ts` token-scope cases.

### `RLS-CRIT-02` — Staff patient reads are not tenant-linked in production

Severity: Critical.

`patients_staff_read` and `patient_accounts_staff` allow any staff-context actor to read patient records without tenant linkage. The reviewed migration `142` changes this, but production has not applied it.

Remediation: apply migration `142`; require tenant membership/link and active exchange grants where applicable.

Retest: cross-tenant staff read must return no rows; same-tenant read must succeed.

### `RLS-CRIT-03` — `app.patient_enrollment_lookup` lacks tenant linkage

Severity: Critical.

The reviewed function filters on actor kind, non-null user/tenant, and exact demographic identifiers, but does not verify that the caller's tenant links to the returned patient. Owner `medveris_exchange` is BYPASSRLS, so the function determines the effective boundary.

Remediation: add `created_tenant_id = app.current_tenant()` or `EXISTS` against `tenant_patient_links`; restrict to valid enrollment workflow; add test.

Retest: same-tenant enrollment succeeds; cross-tenant duplicate check returns no PHI.

### `RLS-HIGH-01` — Expired exchange grants intended to remain readable

Severity: High.

Migration `142` removed active-window filters from recipient-tenant `exchange_grants` read and `tests/integration/rls.test.ts` now asserts expired-grant audit visibility. Normal patient lookup helpers still enforce active windows, creating inconsistent consent semantics.

Remediation: enforce active windows in normal read policy; provide separate audited administrative view if expired-grant visibility is required.

Retest: expired grant cannot be used via patient endpoints; audit view records actor/reason.

### `RLS-HIGH-02` — Integrity and ledger tables have no RLS

Severity: High.

`integrity_checkpoints`, `integrity_checkpoint_events`, and `ledger_anchors` are not RLS-protected in production. Migration `146` is pending.

Remediation: apply migration `146` and verify RLS/FORCE RLS.

Retest: catalog query shows all three tables with `relrowsecurity` and `relforcerowsecurity` true.

### `RLS-HIGH-03` — Platform-role GUC gates remain possible in production

Severity: High.

Migration `145` is pending. Without it, callers may forge platform-role context.

Remediation: apply migration `145`; add negative tests with forged GUCs.

Retest: forged platform role does not grant operator access.

### `RLS-MED-01` — Test evidence currently incomplete

Severity: Medium.

Recent targeted logs show remaining failures involving `sponsored_daily_metrics`, `integration_clients`, and radiology worklist pagination. Follow-up fixes were made but not rerun.

Remediation: apply edited migrations to `medveris_test`, rerun targeted suite and full suite, archive logs.

Retest: zero failures in `npm test`.

## Positive controls

- Local final tree uses `search_path=public, pg_temp` on all 38 `app` SECURITY DEFINER functions.
- `setLocalContext` uses transaction-local settings.
- Reviewed organization and promotion audit writes now set local tenant context.
- No direct `current_setting('app.*')` RLS gates remain in the reviewed local tree after migration `145`.

## Conclusion

RLS approval is withheld. Production policy catalog does not match the hardened local migration set, and the reviewed local tree still contains at least one cross-tenant PHI helper defect.
