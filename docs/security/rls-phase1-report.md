# MedVeris — PHASE 1 REPORT — RAW INSPECTION RESULTS (local staging copy `medveris_test`)

Inspected with:
- `medveris_runtime` (application role; has full DML grants on most tables via `arwd`)
- `medveris_migrator` (owner of all public tables, `arwdDxt` on memberships etc.)
- `medveris_migrator` connection for `pg_get_functiondef` (as `deploy` user via ssh tunnel — port 55432, SSH key `~/.ssh/medveris_kamatera`)

All queries are read-only: `pg_class/pg_proc/pg_policies/information_schema` lookups, `pg_get_functiondef()`, SSH one-liner. No DDL executed.

## 1. Helper functions in `app` (67 functions) — verified via pg_get_functiondef

Key definitions (verbatim):

```sql
app.has_any_role(required text[]):
  SELECT app.roles() && required

app.roles():
  SELECT COALESCE(string_to_array(NULLIF(current_setting('app.roles', true), ''), ','), ARRAY[]::text[])

app.actor_kind():
  SELECT COALESCE(NULLIF(current_setting('app.actor_kind', true), ''), 'anonymous')

app."current_user"():  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
app.current_patient(): SELECT NULLIF(current_setting('app.patient_id', true), '')::uuid
app.current_tenant():  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
app.current_membership_id(): SELECT NULLIF(current_setting('app.membership_id', true), '')::uuid
app.is_content_editor(): SELECT COALESCE(NULLIF(current_setting('app.platform_role', true), ''), '') IN ('content_editor','content_reviewer')
app.is_platform_reviewer(): (SECURITY DEFINER) SELECT EXISTS (SELECT 1 FROM platform_roles pr JOIN users u ON u.id = pr.user_id WHERE pr.role='credential_reviewer' AND pr.user_id = app."current_user"() AND pr.revoked_at IS NULL AND (pr.expires_at IS NULL OR pr.expires_at > now()))
app.organization_role(p_org): (SECURITY DEFINER) SELECT m.role FROM organization_memberships m WHERE m.organization_id = p_org AND m.user_id = app."current_user"() AND m.status='active' LIMIT 1
```

**FLAG A (GUC trust — item 1, confirmed):** `has_any_role`, and all the invoker identity readers (`actor_kind`, `current_user`, `current_tenant`, `current_patient`, `current_membership_id`, `roles`, `is_content_editor`, `is_hmis_staff`, `is_inventory_staff`, `legacy_elevate_available`, `platform_roles_bootstrap`) are **invoker** and read the mutable `app.*` GUCs. Any policy or DEFINER function that calls them inherits whatever the session set.

**FLAG B:** `outbox_backlog`, `security_event_summary` are DEFINER reading `outbox_events`/`audit_events` without tenant scope (jobs/ops aggregation — review).

## 2. Where the app sets GUCs

`packages/db/src/index.ts` — `setLocalContext()` (transaction-local via `set_config(..., true)`):
```
set_config('app.tenant_id', ..., true)  set_config('app.user_id', ..., true)
set_config('app.patient_id', ..., true)  set_config('app.actor_kind', ..., true)
set_config('app.roles', ..., true)       set_config('app.platform_role', ..., true)
set_config('app.membership_id', ..., true) set_config('app.unit_id', ..., true)
set_config('app.department_id', ..., true)
```
Callers: `routes/auth.ts:237/274`, `services/invitations.ts:144/172/200`, `services/workspaces.ts:127`, `services/subscriptions.ts`. Additional `set_config('app.invitation_token_hash', ..., true)` in `routes/finance.ts`, `routes/auth.ts:255/286/379`, `routes/workspace.ts:213`, `routes/organizations.ts:383`.

**Pooling:** no PgBouncer/pgpool in repo; no session-level `SET` anywhere; raw SQL is parameterized (`routes/me.ts:97/107` reads `sessions where user_id = auth.user.id`). All set_config calls are transaction-local.

## 3. Roles (pg_roles)

```
medveris_assistant      | rolsuper=f rolbypassrls=f
medveris_exchange       | rolsuper=f rolbypassrls=f(t)?? -> actually t? verify below
medveris_jobs           | rolsuper=f rolbypassrls=t  <-- BYPASSRLS (expected: jobs role)
medveris_migrator       | rolsuper=f rolbypassrls=t
medveris_operator_guard | rolsuper=f rolbypassrls=f
medveris_runtime        | rolsuper=f rolbypassrls=f
medveris_transfer_guard | rolsuper=f rolbypassrls=t (read-only? verify)
postgres                | rolsuper=t rolbypassrls=t
```
Query of medveris_runtime role-to-role memberships: none (all medveris_* are standalone LOGIN roles).

## 4. RLS state (public schema) — 280 tables

- 270 have `relrowsecurity=t`; 10 disabled: `auth_challenges, email_tokens, integrity_checkpoint_events, integrity_checkpoints, ledger_anchors, schema_migrations, sessions, tenants, usage_resources, users`.
- All RLS-enabled are `relforcerowsecurity=t` (FORCE RLS on every table).
- Zero-policy RLS-on tables: **none** (all 270 have ≥1 policy).

## 5. ACL grants (medveris_runtime on sensitive tables; format `role=acwd` where a=insert r=select w=update d=delete)

```
memberships           | medveris_runtime=arwd/medveris_migrator, medveris_exchange=r, medveris_jobs=r
integration_tokens    | medveris_runtime=arwd/medveris_migrator
integration_configs   | medveris_runtime=arwd/medveris_migrator
integration_messages  | medveris_runtime=arwd/medveris_migrator
outbox_events         | medveris_runtime=arwd/medveris_migrator, medveris_jobs=arw/medveris_migrator, medveris_exchange=r
audit_events          | medveris_runtime=ar/medveris_migrator, medveris_jobs=r, medveris_exchange=r
exchange_grants       | medveris_runtime=arwd/medveris_migrator, medveris_exchange=arw
patients              | medveris_runtime=arwd/medveris_migrator, medveris_exchange=r
tenants               | medveris_runtime=arwd/medveris_migrator, medveris_jobs=r, medveris_exchange=r
users                 | medveris_runtime=arwd/medveris_migrator
sponsored_daily_metrics | medveris_runtime=arwd/medveris_migrator
sponsored_payment_events| medveris_runtime=ar/medveris_migrator
```

## 6. Policy inventory (pg_policies): 483 policies in `public` schema, 0 in `app`

**DELETE-over-grant scan (user item 3):** programmatic scan of all ALL-cmd policies with `qual IS NULL` or `qual='true'` — **0 found** (none). All ALL-cmd policies (229 of them) have non-NULL USING. (Two confirmed app-level DELETEs exist: `memberships_delete` (USING tenant_id=current_tenant) and `exchange_grants` — no DELETE policies on exchange_grants; none on the other flagged tables.)

**OR TRUE / OR current_user IS NOT NULL occurrences (user item 5/13):** exactly 1 — `reference_specialties.reference_specialties_read` USING `(active OR true)`.

**Write-cmd policies with NULL WITH_CHECK (allowed system/admin/DELETE paths only):**
- `memberships.memberships_delete` (DELETE USING tenant_id=current_tenant) — item 1
- `integration_clients.integration_clients_platform_update`
- `plan_resource_rules.plan_resource_rules_operator_delete`
- `platform_roles.platform_roles_operator_delete` (operator, excludes self)
- `sponsored_payments.sponsored_payments_platform_update`

## 7. User-table specific (items 1–6)

### Item 1 — memberships (all 30 INSERT policies + 2 UPDATE + 1 DELETE)

```sql
-- INSERT policies on memberships (verbatim from pg_policies, cmd='INSERT', ~30 total):
memberships_write_any                              WC=app.is_platform_operator()                                  -- no tenant, no user condition
memberships_write_any_via_platform_and_user_id     WC=(app.is_platform_operator() AND user_id=current_user())
memberships_write_any_via_user_id                  WC=(user_id = app."current_user"())                             -- NO tenant, NO role  <-- HOLE A
memberships_write_any_via_user_id_on_any_tenant    WC=(app.is_platform_operator() AND user_id=current_user())     -- no tenant  <-- HOLE A
memberships_write_owner                            WC=(tenant_id=current_tenant() AND user_id=current_user())
memberships_write_owner_via_user                   WC=(user_id=current_user())                                     -- no tenant  <-- HOLE A
memberships_write_via_user_id                      WC=(user_id=current_user())                                     -- no tenant, NO role  <-- HOLE A
memberships_write_via_user_id_on_any_tenant        WC=(user_id=current_user())                                     -- no tenant  <-- HOLE A
memberships_write_registration                     WC=(tenant_id=current_tenant() AND actor_kind IN ('registration','system'))  -- legits
memberships_write_registration_on_any_tenant_via_actor   WC=(actor_kind IN ('registration','system'))             -- <-- HOLE A (any tenant)
-- UPDATE:
memberships_update                                 USING=(tenant_id=current_tenant() OR current_membership_id=id) WC=(tenant_id=current_tenant())
-- DELETE:
memberships_delete                                 USING=(tenant_id=current_tenant())
```

### Item 2 — integration_tokens
```sql
integration_tokens_all (ALL, roles={public}): USING=true  WC=true   -- CRITICAL
```

### Item 3 — (see section 6)

### Item 4 — patients (patients is RLS-on + FORCE; no app.patient_id needed)
```sql
patients_staff_read (SELECT):  USING=(app.actor_kind()='staff' AND app."current_user"() IS NOT NULL)   -- any staff sees ALL tenants' patients <-- HOLE B
patients_integration_read (SELECT): USING=(actor_kind='system' AND current_tenant IS NOT NULL AND (created_tenant_id=current_tenant OR EXISTS (... tenant_patient_links ...)))
patients_self_read (SELECT):   USING=(id = app.current_patient())
patients_staff_update (UPDATE): WC=(actor_kind='staff' AND EXISTS (SELECT 1 FROM tenant_patient_links l WHERE l.patient_id=patients.id AND l.tenant_id=current_tenant))
```

### Item 5 — open write/insert policies
```sql
-- users item 5a: exchange_grants:
grants_patient (ALL): USING=((patient_id=current_patient()) OR (recipient_tenant_id=current_tenant()))
                        WC=((patient_id=current_patient()) AND (grantor_user_id=current_user()))
                      -- recipient-tenant scope leaks into DELETE (USING) for users of other tenants

-- users item 5b: sponsored_daily_metrics.sponsored_metrics_write (ALL): WC=true USING=true  <-- open
-- users item 5c: sponsored_payment_events.sponsored_payment_events_insert (INSERT): WC=true  <-- open

-- users item 5d: integration_tokens open (see item 2).

-- users item 5e: integration_clients (RLS-on, has policies — reviewed):
integration_clients_platform (INSERT): WC=(is_platform_operator() OR (actor_kind='system' AND tenant_id=current_tenant()))
integration_clients_read (SELECT): WC=(is_platform_operator() OR tenant_id=current_tenant() OR (actor_kind='system' AND NOT is_platform_operator()))
```

### Item 6 — integration_verifications / GUC / support tickets
```sql
integration_verifications_record (INSERT): WC=(current_setting('app.platform_role','true')='platform_operator')  -- platform_role GUC trust
integration_verifications_read (SELECT): USING=true (medveris_runtime)
support_tickets / support_ticket_events (ALL, roles={public}): USING=true WC=true  -- wait: actually support_tickets_operator_all exists with platform_role GUC
reference_specialties_read: USING=(active OR true)
```
Wait — support_tickets: `support_tickets_operator_all (ALL, roles={public}): USING=(current_setting('app.platform_role','true')='platform_operator'), WC=(same)`. RLS-on (FORCE). Operator reads OK via GUC. Fix: replace with `is_platform_operator()` (DEFINER reads platform_roles) or add security hardening.

### Item 6 — audit_events (app.lib.audit writeAudit() — insert with `tenant_id` input; hash-chain UPDATE policies)
```sql
-- audit_events UPDATE (grep-based):
audit_events_hash_chain_update? — need to grep for existing UPDATE policies on audit_events
```

## 8. Legitimate flows (from code, read-only) that MUST keep working

**Registrations**: `auth.ts:237` (`setLocalContext(tx, {actorKind:"registration", userId})` + `insert into users`), `auth.ts:274` (tenant creation), `services/invitations.ts:144/172/200` (registration context), `workspace.ts`/`organizations.ts:383` (join codes).
**Membership writes needed:**
- `auth.ts:274` — insert owner membership for new tenant (actorKind='registration', userId set, tenantId=created tenant)
- `services/invitations.ts:200` — invitation acceptance (actorKind='registration', tenantId set)
- `services/admin.ts`? (admin.ts:253 update memberships set roles for admin add, admin.ts:295 update status='removed' for removal)
- platform operator adds members (same UPDATE policies)
**integration_clients:** `integrations.ts:85` insert by platform (insert WC), `integrations.ts:145` update by platform (update WC), `auth/integration.ts:39` update integration_tokens last_used_at.
**integration_tokens:** `integrations.ts:233` insert (actorKind='system', platformRole='platform_operator' → WC=system? No — WC must allow system actor and operator), `integrations.ts:149/176/189` revoke (operator).
**exchange_grants:** `consent.ts:57` insert (patient share), `consent.ts:98` update revoked_at (patient), `fhir/router.ts:378/382/393` reads.
**outbox_events:** `lib/audit.ts writeOutbox` — runtime inserts (actor not set: actorKind not set → NULL), `jobs` writes (medveris_jobs).
**audit_events:** `lib/audit.ts writeAudit` — `select pg_advisory_xact_lock`, read previous_hash, insert. (tenant_id = input.tenantId ?? null).
**users:** `auth.ts:87` insert into users during registration (runtime, actorKind='registration'), reads by id=auth.user.id.

## 9. App code — where DEFINER helper functions read tables they shouldn't

- `is_facility_admin()` — DEFINER — joins `directory_facilities` (RLS-on) WHERE claimed_tenant_id = current_tenant. OK.
- `organization_role()` — DEFINER — `organization_memberships` (RLS-on). OK.

## 10. Soft spots (documented, not changed by this phase)

- `users` RLS OFF — holds login emails, `users` is written by runtime during registration (registration flows). users table is RLS-off. (Confirmed: `users` table = `{arwd/medveris_migrator, r/mediveris_migrator(...)? see section 5}` — runtime=arwd, exchange=r.)
- `sessions`, `auth_challenges`, `email_tokens` — auth infra, RLS-off by design.
- `has_any_role` GUC trust — `roles` GUC never set by untrusted code.
- `integration_clients_read` has weird branch `(actor_kind='system' AND is_platform_operator()=false)` — allows system non-operator to read — intentional for public OAuth endpoints.
- `users` has no RLS (`relrowsecurity=f`) — org profile reads of `users` (organizations.ts) rely on this.

## 11. False positives / not changes needed

- `integration_clients_read` "system AND NOT operator" — intentional, documented.
- `integration_verifications_record` — relies on GUC; DEFINER setter fix from item 6.
- `memberships_write_owner`/`memberships_write_registration`/etc. — actually fine as written.

## 12. Phases

1. Audit app code for flows that depend on `has_any_role()` returning GUC-trust.
2. Write migrations for user items 1–6.
3. Validate on staging copy (medveris_test) — including the tests/security/ suite from Phase 3.

## 13. Remediation migrations (ordered)

All migrations are transactional, idempotent, and paired with rollbacks in `packages/db/rollbacks/`. No migration was persisted locally; every test used `BEGIN…ROLLBACK`.

| # | Migration | Rollback | Purpose |
|---|---|---|---|
| 139 | `139_memberships_rls_hardening.sql` | `139_memberships_rls_hardening_rollback.sql` | Replaces 31 broad membership policies with 5 INSERT / 2 SELECT / 2 UPDATE / 1 DELETE; adds guard triggers and last-admin protection. |
| 140 | `140_integration_tokens_tenant_scope.sql` | `140_integration_tokens_tenant_scope_rollback.sql` | Backfills `tenant_id`, adds sync trigger, splits `integration_tokens_all`, removes DELETE. |
| 141 | `141_all_policy_delete_overgrant_split.sql` | `141_all_policy_delete_overgrant_split_rollback.sql` | Backs up 101 ALL policies, splits them into SELECT/INSERT/UPDATE, creates no DELETE policies, revokes DELETE. |
| 142 | `142_patient_scope_rls_hardening.sql` | `142_patient_scope_rls_hardening_rollback.sql` | Scopes patient/patient-account staff reads via tenant links, created tenant, or active exchange grants; adds `app.patient_exchange_lookup`. |
| 143 | `143_remaining_rls_overgrant_hardening.sql` | `143_remaining_rls_overgrant_hardening_rollback.sql` | Hardens sponsored metrics/payments, integration configs, outbox, audit, exchange grants, logo update, directory reports; revokes sensitive DELETEs. |
| 144 | `144_global_catalogue_read_hardening.sql` | `144_global_catalogue_read_hardening_rollback.sql` | Removes dead `OR true` / `OR current_user()` catalogue read branches; operators still see inactive rows via `app.is_platform_operator()`. |
| 145 | `145_platform_role_guc_hardening.sql` | `145_platform_role_guc_hardening_rollback.sql` | Replaces forgeable `app.platform_role` / migrator-GUC gates with DB-backed `platform_roles` checks; migrator-only bootstrap/legacy flags. |
| 146 | `146_integrity_rls_and_guards.sql` | `146_integrity_rls_and_guards_rollback.sql` | Enables FORCE RLS on integrity checkpoint/event/ledger tables, scopes runtime reads to tenant, removes jobs' ledger INSERT, asserts RLS role invariants and no-RLS allowlist. |

`scripts/migrations.ts` no-RLS allowlist is now: `auth_challenges`, `email_tokens`, `sessions`, `users`, `tenants`, `schema_migrations`, `usage_resources`.

## 14. Test evidence (local staging copy, `BEGIN…ROLLBACK`)

- Full 139–146 forward + rollback dry-run: `rc=0`; applied state `specialties=1`, `bad_price=0`, `tickets=1`, `integrity_rls=3`, `unexpected_no_rls=0`; restored state `old_specialties=1`, `integrity_no_rls=3`.
- 139: forward+rollback restored original 31 membership policies and 0 guard triggers.
- 140: forward+rollback restored original ACLs and `tenant_id` state; fixed UUID/text comparison during testing.
- 141: forward+rollback restored 101 original policies; rollback made idempotent with `DROP POLICY IF EXISTS` before recreating originals.
- 142: forward+rollback rc=0; patient/patient-account policies and `app.patient_exchange_lookup` present only in applied state.
- 143 behavior: `sponsored_valid=PASS`, `sponsored_invalid=DENIED`, `outbox_match=PASS`, `outbox_mismatch=DENIED`, `audit_staff_mismatch=DENIED`, `integration_tenant=PASS`, `integration_global=DENIED`, `payment_staff_valid=PASS`, `payment_staff_invalid=DENIED`, `audit_system_cross_tenant=PASS`.
- 145 forged-GUC behavior: `bootstrap_forged=f`, `legacy_forged=f`, `content_editor_forged=f`, `operator_check_forged=f`, `outbox_backlog_forged_rows=0`, `security_summary_forged_rows=0`, `support_ticket_forged_rows=0`, `support_event_forged_rows=0`.
- 145 DB-backed positive control: temporary active `platform_roles.platform_operator` row gives `operator_check_db_backed=t`, `support_ticket_db_backed_rows=47`, `support_event_db_backed_rows=329`.
- 146 behavior: wrong-tenant runtime sees `checkpoints=0/events=0/anchors=0`; matching tenant sees `checkpoints=49/events=30385`; jobs sees `checkpoints=49`; runtime and jobs ledger INSERTs are `DENIED`.
- `npm run lint` passed. `npm run typecheck` passed with a 400000 ms timeout.
- `npm test` completed with 106/107 test files passing (964/966 tests); the two failures are in `tests/unit/production-gate.test.ts` and are caused by unrelated pre-existing edits to `scripts/production-gate.mjs` (restore-drill label validation), not by the RLS migrations or `scripts/migrations.ts`.

## 15. `pg_policies` diff summary

Before: 483 policies in `public`. After 139–146: 917 policies. Full raw diff generated at `/tmp/rls/pg_policies.diff` (1453 diff lines) using identical `pg_policies` snapshots before/after a single dry-run transaction.

Key changes:
- `memberships`: 31 broad policies → 8 narrow command-specific policies plus triggers.
- `integration_tokens`: `integration_tokens_all` ALL/true/true → tenant-scoped SELECT/INSERT/UPDATE.
- 101 ALL policies: replaced by `_rls_select`, `_rls_insert`, `_rls_update`; no new DELETE policies.
- `patients`, `patient_accounts`: staff reads scoped; patient exchange lookup added.
- `sponsored_daily_metrics`, `sponsored_payment_events`, `integration_configs`, `outbox_events`, `audit_events`, `exchange_grants`, `tenants`, `directory_reports`: split/narrowed with explicit exceptions for preserved flows.
- `reference_specialties`, `master_prices`, `sponsored_packages`: dead permissive read branches removed.
- `platform_roles`, `integration_verifications`, `support_tickets`, `support_ticket_events`: GUC gates replaced by `app.is_platform_operator()` / DB-backed role checks.
- `integrity_checkpoints`, `integrity_checkpoint_events`, `ledger_anchors`: new tenant-scoped SELECT policies and jobs SELECT/INSERT policies.

## 16. Rollout note

1. Preflight on production: snapshot `pg_policies`, `pg_roles`, table grants, and RLS flags. Migration 146 intentionally aborts if `medveris_app` is `SUPERUSER`, `BYPASSRLS`, or owns relations; resolve that before deployment rather than bypassing the check.
2. Apply 139–146 in order with `ON_ERROR_STOP=1`. Each migration is a single transaction; do not skip 146 because it enforces the final invariants.
3. Postflight: rerun the catalog assertions and behavior checks from section 14, then smoke-test registration/invitations, admin membership removal, integration clients/tokens, patient consent and FHIR reads, sponsored metrics/payment writes, audit/outbox writes, support tickets, catalogue reads, and integrity jobs.
4. Rollback only in reverse order. Rollbacks 141 and 146 explicitly restore prior over-granted access and should be treated as emergency PHI-exposure changes with incident follow-up.

## 17. Remaining out-of-scope / parked

- `users`, `tenants`, `sessions`, `auth_challenges`, `email_tokens`, `usage_resources`, `schema_migrations` remain RLS-off by reviewed design; no `tenant_scopes` table exists locally.
- `has_any_role()` remains GUC-based for legacy role lists; no raw user-controlled `SET` path was found. The confirmed forgeable platform-role gates were fixed in 145.
- `integration_clients_read` system/non-operator branch remains intentional for public OAuth endpoints.
