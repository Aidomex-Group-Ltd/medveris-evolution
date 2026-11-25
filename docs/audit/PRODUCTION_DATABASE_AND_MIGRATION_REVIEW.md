# Production Database and Migration Review

| Item | Value |
|---|---|
| Audit timestamp | `2026-11-23T09:49:39Z` (UTC) |
| Scope | Read-only production database catalog, migration ledger, roles, grants, and migration source review |
| Database | `medveris-prod` on PostgreSQL `18.6` |
| Ledger rows | `89` |
| Pending migrations | `139`–`146` inclusive |
| Verdict | **B. DEPLOYED BUT NOT APPROVED FOR REAL PATIENT DATA** |

## Evidence

### Connection identity

A temporary SSH tunnel was opened to the production host and `MIGRATION_DATABASE_URL` was used without printing secret values.

Query:

```sql
select current_database(), current_user, version(), inet_server_addr(), inet_server_port(), pg_is_in_recovery();
```

Result:

| database | user | version | host | port | in recovery |
|---|---|---|---|---|---|
| `medveris-prod` | `medveris_migrator` | PostgreSQL `18.6 (Ubuntu 18.6-0ubuntu0.26.04.1)` | `127.0.0.1` | `5432` | `f` |

### Aggregate data counts

Count-only queries returned:

| table | rows |
|---|---:|
| `tenants` | 3 |
| `users` | 6 |
| `memberships` | 0 |
| `patients` | 0 |
| `patient_accounts` | 0 |
| `audit_events` | 0 |
| `exchange_grants` | 0 |
| `outbox_events` | 0 |

No row contents or PHI were inspected.

### Schema and RLS catalog

- `public_tables=280`
- `rls_tables=270`
- `force_rls_tables=270`
- `all_policies=229`
- Tables without RLS: `integrity_checkpoints`, `integrity_checkpoint_events`, `ledger_anchors`

Representative production policies:

| table | policy | command | qual | with_check |
|---|---|---|---|---|
| `integration_tokens` | `integration_tokens_all` | `ALL` | `true` | `true` |
| `patients` | `patients_staff_read` | `SELECT` | `(app.actor_kind()='staff' AND app.current_user() IS NOT NULL)` | n/a |
| `patient_accounts` | `patient_accounts_staff` | `SELECT` | `(app.actor_kind()='staff')` | n/a |
| `patients` | `patients_staff_update` | `UPDATE` | tenant link via `tenant_patient_links` | tenant link via `tenant_patient_links` |
| `patients` | `patients_integration_read` | `SELECT` | tenant/link checks | n/a |

### Migration ledger

Query:

```sql
select count(*) as migration_rows, max(version) as last_ledger_migration from public.schema_migrations;
```

Result: `89` rows, lexicographic max `99_backfill_unit_type.sql`.

Latest numeric entries returned:

- `99_backfill_unit_type.sql`
- `98_add_unit_type.sql`
- `138_clinical_entry_attachments_rls.sql`
- `137_receipts_runtime_grants.sql`
- `136_subscription_fx_rates.sql`
- `135_subscription_receipts_api.sql`
- `134_subscription_receipts_and_events.sql`
- `133_break_glass_narrow_role.sql`
- `132_assistant_read_only.sql`
- `131_support_center_tickets.sql`

Repository migrations pending in production:

| migration | purpose |
|---|---|
| `139_memberships_rls_hardening.sql` | membership write hardening and invitation reactivation |
| `140_integration_tokens_tenant_scope.sql` | integration token tenant scoping and exchange-client grant support |
| `141_all_policy_delete_overgrant_split.sql` | split broad `ALL` policies |
| `142_patient_scope_rls_hardening.sql` | patient/patient-account tenant scope and enrollment lookup helper |
| `143_remaining_rls_overgrant_hardening.sql` | remaining write/audit/outbox/exchange/report policy hardening |
| `144_global_catalogue_read_hardening.sql` | catalogue read hardening |
| `145_platform_role_guc_hardening.sql` | database-backed platform role checks |
| `146_integrity_rls_and_guards.sql` | integrity/ledger RLS and invariant guards |

### Roles

Observed login roles: `medveris_app`, `medveris_jobs`, `medveris_runtime`, `medveris_migrator`.

- All have `rolsuper=f`, `rolbypassrls=f`, `rolcanlogin=t`.
- Only role membership observed: `medveris_app` is a member of `medveris_runtime` with `admin_option=f`.
- No `medveris_jobs` membership row was observed.
- Prior evidence: runtime has DELETE on `163` tables.

## Findings

### `DB-CRIT-01` — Eight production migrations are pending

Severity: Critical.

The database is at numeric migration `138` while the repository contains hardening migrations through `146`. All tenant-isolation and integrity fixes in those migrations are absent from production.

Remediation: use the reviewed deployment path to apply `139`–`146`; record applied versions and timings; verify catalog diff.

Retest: `schema_migrations` contains all eight versions; RLS catalog matches reviewed local tree; tenant-isolation tests pass.

### `DB-HIGH-01` — Migration ledger has no checksums or code identity

Severity: High.

`schema_migrations` stores only `version` and `applied_at`; it cannot prove that applied migration contents match source control. This is especially relevant because migrations `139`, `140`, `142`, and `143` were edited under already-committed filenames.

Remediation: add checksum/source identity to the migration ledger or an external signed release manifest; reconcile historical rows.

Retest: gate compares checksums and refuses mismatched filenames/content.

### `DB-HIGH-02` — Broad policies and grants remain in production

Severity: High.

`integration_tokens_all` is unconditional; `229` `ALL` policies exist; prior review found `101` policies with mismatched/NULL `WITH CHECK`; runtime has DELETE on `163` tables.

Remediation: apply migrations `140`, `141`, `143`; audit grants and remove unnecessary write/delete rights.

Retest: policy and grant diff shows no broad unconditional `ALL` policy and no unexpected DELETE grants.

### `DB-HIGH-03` — Integrity/ledger tables lack RLS

Severity: High.

`integrity_checkpoints`, `integrity_checkpoint_events`, and `ledger_anchors` are not RLS-protected.

Remediation: apply migration `146`.

Retest: catalog query shows RLS and FORCE RLS enabled for all three tables.

### `DB-MED-01` — Migration version ordering is lexical and ambiguous

Severity: Medium.

`max(version)` returns `99_backfill_unit_type.sql`, while the latest numeric migration is `138_clinical_entry_attachments_rls.sql`. Any operator relying on lexicographic max will misread ledger state.

Remediation: use numeric-prefix parsing in migration tooling and gate checks.

Retest: gate reports numeric latest migration `138` before and `146` after remediation.

### `DB-MED-02` — Local test database drift

Severity: Medium.

Edited migrations `140`, `142`, and `143` were only partially synchronized into `medveris_test`; `143` was not applied there. Targeted tests remain red after the edits.

Remediation: rebuild or migrate `medveris_test` from the reviewed tree; rerun full suite.

Retest: `npm test`, `npm run lint`, and `npm run typecheck` all pass.

### `DB-MED-03` — Hyphenated DB-name setup fix is uncommitted

Severity: Medium.

`scripts/db-setup.ts` contains an uncommitted quoted-identifier fix for hyphenated database names. Without it, fresh environment setup may fail.

Remediation: review and commit or deliberately drop with documented rationale.

Retest: fresh database setup succeeds from clean checkout.

## Database conclusion

Database approval is withheld. Production is materially behind the reviewed migration set and still contains broad access policies and unprotected integrity tables.
