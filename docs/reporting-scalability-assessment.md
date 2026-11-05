# Medveris reporting and database performance assessment

Read-only findings from the current codebase. This document reviews how reports run today, which queries are likely to become expensive as tenant data grows, where indexes already exist, and where asynchronous generation, replica reads, caching or rate limiting could help. It explicitly separates verified behavior from plausible future bottlenecks, and it does not propose anything that would weaken authorization, consent, financial consistency or tenant isolation.

## 1. Existing reporting architecture

- Reports are served from `apps/api/src/routes/reports.ts` at `GET /api/v1/reports` and `GET /api/v1/reports/:id`.
- The report catalogue lives in `apps/api/src/reports/definitions.ts` as a fixed in-code list (`REPORTS`).
- Each report definition has a fixed SQL/unsafe-SQL body, a role list, a sensitivity flag, an explicit column list, and a `run` function.
- The route:
  - requires staff + MFA-verified facility context
  - checks the caller's roles
  - enforces time-range limits (`MAX_RANGE_DAYS = 366 days`)
  - enforces rate limits before work starts: `reports.run` for JSON and `jobs.submit` for CSV
  - runs the report through `withStaleTolerantRead` with `REPORT_MAX_STALENESS_MS = 30000`
  - writes an audit event for sensitive reports and CSV exports, including `dataSource` and `rows`
  - caps rows in-report to `MAX_ROWS = 1000`
  - returns JSON or CSV with `no-store, private` caching
- CSV exports are intentionally rate-limited more tightly than JSON (`jobs.submit`: 20/600s distributed), likely because CSV is larger and more likely to be used for bulk downloads.
- The stale-tolerant read helper is in `apps/api/src/auth/middleware.ts` and the routing logic is in `packages/db/src/routing.ts`.
- Database timeouts are global and short: `STATEMENT_TIMEOUT_MS = 20000` and `IDLE_IN_TRANSACTION_TIMEOUT_MS = 30000` in `packages/db/src/index.ts`.
- The report route is not public-cached: `apps/api/src/lib/cache-policy.ts` only allows shared caching for explicit public endpoints, and authenticated API responses are `no-store, private`.

This is a synchronous, per-request report pipeline. The request owns the database transaction, the query, the audit write and the response serialization.

## 2. Expensive or potentially expensive queries

### Verified current patterns

- Many reports are genuinely lightweight today: counts and grouped aggregates over a single table with a tenant predicate and a time predicate. Examples:
  - `daily-activity`: counts from `tenant_patient_links` and `encounters`
  - `appointments`: single-table aggregates on `appointments`
  - `bed-occupancy`, `maternity-outcomes`, `diagnoses`, `audit-security`: single-table aggregates with `tenant_id` and time bounds
- Some reports are more complex by design:
  - `staff-workload` calls `app.report_staff_workload(...)`, which runs one count subquery per staff member against `clinical_entry_versions`, `lab_results`, `radiology_report_versions` and `dispenses` for the same tenant/time window.
  - `department-operations` builds a layered CTE pipeline over departments, units, inventory locations, inventory movements, balances, lots, purchase orders, encounters and invoices.
  - `financial-reconciliation` uses correlated subqueries for billed/paid/refunded/reversed/provider-confirmed amounts per invoice.
  - `lab-turnaround` and `radiology-turnaround` join orders, order items, results/studies/reports and include percentile math and correlated specimen subqueries.
  - `pharmacy-stock` mixes current lot/balance values with a correlated dispense subquery for the period.
  - `waiting-times` uses `percentile_cont` and non-called-entry counts on queue entries.
  - `integration-health` is stateless from a reporting perspective; it is cheap but not derived from tenant clinical/financial rows.

### Plausible future bottlenecks

These are not proven performance problems in the current repo, but they are the shapes most likely to matter as data grows:

- Per-author correlated counts in `staff-workload` are the most obvious scaling risk. If a facility has many staff and the underlying tables are large, the report runs several independent scans over the same time-bounded data. The function is `STABLE` and security-definer, which is good for permissioning, but it does not change the underlying access pattern.
- Correlated subqueries in `financial-reconciliation` mean each invoice row touches several sub-selects over `invoice_items`, `payments` and `payment_refunds`. That is acceptable at current volumes, but it is the kind of query that benefits from indexing and, for larger windows, from materialization.
- `department-operations` is the richest report and likely the most expensive when a facility has many inventory locations, movements, lots and purchase orders. It mixes current-state subqueries with period aggregates, so it may not benefit fully from time-only indexes.
- Any report that uses `percentile_cont(...)` over a large set of timed rows is more expensive than simple counts, because it needs ordering/aggregation over the value distribution, not just a grouped count.
- Timezone conversion in the `daily-activity` report uses `( ... at time zone ... )::date` on the filter columns; this is a classic pattern that can prevent a plain index from being used as efficiently as a pure range filter.

## 3. Existing indexes and missing index candidates

### What the migrations already establish

From `packages/db/migrations/001_foundation.sql` and subsequent migrations, there is a substantial index footprint for the tables reports depend on, including:

- `audit_events`: `audit_tenant_time_idx` and `audit_action_time_idx` — directly useful for `audit-security`
- `appointments`: `appointments_tenant_time_idx`
- `encounters`: `encounters_tenant_time_idx`
- `clinical_entry_versions`: indexes including one on `tenant_id, author_id, signed_at` and one on `tenant_id, signed_at`
- `lab_results`: indexes including ones on `tenant_id, created_at` and `tenant_id, order_item_id`
- `imaging_studies`: `imaging_studies_order_item_idx` and related study indexes
- `radiology_reports`: `radiology_reports_study_status_updated_idx` and `radiology_reports_worklist_idx`
- `radiology_report_versions`: indexes including `tenant_id, signed_by, signed_at`
- `dispenses`: `dispenses_tenant_created_idx` and a dispense-by-lot index
- `invoice_items`: indexes including `invoice_id` and the once-only unique indexes on `recommendation_id`/`supply_usage_id`
- `invoices`: `invoices_encounter_idx` and tenant/status indexes
- `service_orders` / `service_order_items`: tenant + type + status/time indexes
- `conditions`: `conditions_patient_idx`
- `queue_entries`: `queue_entries_active_idx`
- `outbox_events`: pending and inflight indexes plus a per-tenant claim cap in `claimOutboxBatch`

The migrations also include RLS policies and, for several reporting functions, explicit `SECURITY DEFINER` grants to `medveris_exchange`/`medveris_runtime` so the function can read tables the caller's role cannot.

### Index candidates worth reviewing before scaling reporting

These are recommendations from reading queries and indexes, not verified misses from an `EXPLAIN` run:

- Any report that filters `created_at`/`signed_at`/`occurred_at`/`opened_at`/`closed_at`/`verified_at` by a time range and groups by a label would likely benefit from a **tenant + time + group-by key** index where one does not already exist. This is the standard report-scaling pattern.
- `staff-workload` would likely benefit from indexes that support **tenant + author/time** scans on each source table. At least some of those already exist; the candidate work is confirming they cover every subquery path and every relevant timestamp column.
- `financial-reconciliation` would likely benefit from indexes supporting invoice-period scans and the payment/refund-per-invoice aggregations, especially if the invoice window is often large.
- `lab-turnaround` and `radiology-turnaround` would likely benefit from indexes that support **tenant + order_type + created_at** on orders, and efficient joins from order items to results/studies/reports by `order_item_id`.
- `department-operations` may benefit from indexes on inventory movements by location and time, inventory balances by location/item, and purchase orders by department/unit and time.
- If timezone-filtered daily reports become hot, consider whether a generated local-day column or a timezone-aware index strategy is worthwhile; the current `at time zone ...::date` pattern is correct but can be index-hostile depending on the plan.

I did not run `EXPLAIN` and did not inspect plans, so these are structural candidates, not confirmed deficiencies.

## 4. Opportunities for asynchronous report generation

### What exists today for async work

The repo already has a real async substrate:

- Transactional outbox in `outbox_events`, with `pending`/`processing`/`queued`/`processed`/`dead-letter` states
- Outbox relay to Cloudflare Queues (`relayOutbox`), with per-tenant claim caps and reclaim of stuck rows
- Queue consumer (`consumeJobBatch`) and dead-letter consumer
- Operator replay tool (`replayDeadLetters`)
- Background job cycle in `apps/jobs/src/cycle.ts` used by the Worker `scheduled` handler
- Outbox backlog/readiness helpers (`app.outbox_backlog()`, `outboxMetrics()`)
- Replay, outbox and backlog tables/indexes in migrations `001` and `030`

So the platform is not starting from zero. What is missing for reports is a reporting-specific job contract and result store.

### Which reports are good async candidates

Good candidates are reports that are:

- large-window
- group-by-heavy
- percentile-heavy
- multi-table aggregate
- not needed interactively fast

From the catalogue, the strongest candidates are:

- `staff-workload`
- `financial-reconciliation`
- `department-operations`
- `lab-turnaround`
- `radiology-turnaround`
- `pharmacy-stock` (at least the expiry/dispense portions)
- possibly `maternity-outcomes` and `bed-occupancy` when combined with longer windows or deeper breakdowns

Lighter reports are less compelling async candidates:

- `daily-activity`, `appointments`, `waiting-times`, `consultations`, `diagnoses`, `audit-security`, `integration-health`

These are current-value or small-aggregate reports that are likely fine synchronously for reasonable windows. That said, "lighter" does not mean "always cheap"; it depends on data volume per tenant.

### How async could be added without changing current behavior

A conservative design would be:

- keep the synchronous API for interactive use
- introduce a separate async report submission path that:
  - validates the request the same way the synchronous route does
  - writes a report job/request record
  - submits a background job through the existing outbox/queue path
  - stores the completed report result in a report-result table or object
  - lets the client poll or be notified of completion
- reuse the existing authorization, tenant context, rate limiting and audit patterns
- keep CSV and sensitive reports on stricter submission rate limits
- make async results tenant-scoped and RLS-protected like everything else

This is a new capability, not a modification of the existing synchronous reports.

## 5. Safe opportunities for replica reads

### Current replica routing is already conservative

`packages/db/src/routing.ts` and `apps/api/src/auth/middleware.ts` already implement a bounded-staleness read path:

- only callers that explicitly ask for `consistency: "bounded-staleness"` can use the replica
- replica use requires a healthy standby within `maxLagMs`, measured by `pg_is_in_recovery()`, WAL receiver state and replay lag
- after a write, the session reads from primary until `readYourWritesUntil` expires
- unknown health, lag too high, or a replica that is not a standby routes to primary
- replica failure falls back to primary once

Report routes already use this: `withStaleTolerantRead(..., { maxStalenessMs: 30000 })`.

Also important: the read-only context helper uses `sql.begin("read only", ...)`, so even if a replica-eligible call somehow reached the primary, it still cannot write. That is a strong safety property.

### What is safe to consider for replica reads

From a data-consistency standpoint, the reports most naturally suited to replica reads are those that:

- are aggregate analytics, not individual-record clinical decisions
- tolerate some staleness (and the route already enforces 30s)
- do not perform writes as part of the read

In the current catalogue, the most natural candidates are the aggregate dashboards and operational summaries, for example:

- `daily-activity`
- `appointments`
- `waiting-times`
- `lab-turnaround`
- `radiology-turnaround`
- `bed-occupancy`
- `maternity-outcomes`
- `audit-security`
- `department-operations` (with the same caveats about current-state subqueries)
- `integration-health` (already mostly external-state driven)

### What is not obviously a good replica fit, even if it is aggregate

- `financial-reconciliation` is aggregate, but it is also the report tied to money. If the deployment ever allows replica reads for it, the staleness tolerance and reconciliation semantics need explicit review, because "latest" matters more for payment reconciliation than for a daily activity chart.
- `staff-workload` is personnel activity, not patient care, and is counts-only, but it crosses several sensitive tables. It is a candidate, but only after confirming the underlying function still returns only what the policy intends under replica staleness.

### What must stay on primary

Do **not** send the following to a replica without a very explicit exception review:

- anything that blends reads with writes, or that depends on the caller's own just-written data
- authorization, consent, credential or access decisions
- any clinical read that must reflect the latest write
- any financial mutation or reconciliation step that is part of a transaction

The current report route already avoids writing during the stale-tolerant read itself; audit is written afterward. That is the right shape.

The existing guardrails already prevent these categories from silently moving to a replica, because the replica path is opt-in and consistency-gated.

## 6. Caching and rate-limiting recommendations

### Current caching posture

- Shared/edge caching is only allowed for explicit public endpoints. Authenticated report responses are `no-store, private`.
- This is the correct default for staff-facing clinical/financial reporting. Do not relax it toward shared caching for authenticated reports.

### Where caching could still help, without breaking privacy

Possible app-level cache targets are not the report responses themselves, but derived reference data that is expensive to compute and safe to share within a tenant or across time:

- report metadata/catalogue is already low-cost, so caching it is not a priority
- look for repeated expensive reference computations inside reports that are stable for a window; these are report-specific, not generic
- if async reports are added, the completion/poll path is a more natural place to avoid recomputation than the synchronous report endpoint

Do not cache report rows per user or per session in a shared cache.

### Rate limiting observations

Current relevant policies from `apps/api/src/lib/rate-limit.ts`:

- `reports.run`: 30 per 60s, distributed, failure mode `local`
- `jobs.submit`: 20 per 600s, distributed, failure mode `local-strict`

Notes:

- The asymmetry between JSON and CSV is reasonable: CSV exports are heavier and more likely to be abused as bulk extraction.
- `reports.run` at 30/60s is a per-identity coarse limit; for a single heavy report this does not directly protect the database from one expensive report run. Rate limits limit request frequency, not query cost.
- Distributed rate limiting uses a Durable Object with a coordination timeout and fallback behavior rather than falling back to unlimited. That is good for abuse resistance.

Possible tightening, if warranted by measurement:

- stricter `jobs.submit` behavior for CSV of sensitive reports
- cost-based or heavier limits for reports with large windows or expensive categories
- separate limits for interactive vs async submission paths once async exists
- application-level "expensive report" gating keyed to window size category or report type, in addition to rate limits

Again, these are policy options, not changes to make yet.

## 7. Tenant isolation risks

### What already protects isolation

- Every reportable table is RLS-enabled and tenant-scoped where appropriate.
- Report definitions carry explicit role lists and are filtered by the route.
- Several reporting functions are `SECURITY DEFINER` and re-check `app.current_tenant()` or `app.is_hmis_staff()` etc., so even when the caller cannot read a source table directly, the function still restricts output to the caller's facility and role.
- `staff-workload` is designed to return counts only, no patient or record identifiers, and only for the caller's active facility.
- `hmis_source_metrics` and similar functions use an `allowed` guard subquery and return counts only.
- The report route audits sensitive/report-export access.
- CSV cells are escaped against spreadsheet formula injection.

### Risks to watch, not current failures

- Any new report or async report path must preserve the same rule: no cross-tenant data, no bypassing RLS, no role expansion by accident.
- If async results are stored, the store must be tenant-scoped and access-controlled exactly like the synchronous response.
- When introducing materialized aggregates for reporting, the refresh/query path must remain tenant-aware. A global aggregate table is a common source of accidental cross-tenant exposure.
- If replica reads are enabled for some reports, ensure that "stale" does not become a loophole that changes authorization outcomes; the existing consistency opt-in is the right model, but it still needs review per report class.
- Care is needed with any helper that runs as a definer function: the function's grants and internal predicates must remain correct if tables or policies change later.

No current code indicates a cross-tenant reporting leak. The main risk is in future additions, especially materialized or async reporting.

## 8. Prioritized implementation proposal

This is a proposal for later implementation, not a change to make now.

### Priority 1: verify before optimizing

- Get query plans for the currently expensive-looking reports under realistic tenant data volumes, especially:
  - `staff-workload`
  - `department-operations`
  - `financial-reconciliation`
  - `lab-turnaround`
  - `radiology-turnaround`
- Confirm which indexes are actually used, and which time/group-by scans are sequential.
- Capture p50/p95 latency and database time for JSON and CSV report requests, not just successful responses but also slow ones.

### Priority 2: low-risk performance wins

- Add or adjust indexes for confirmed hot paths, focusing on tenant + time + relevant join/group keys.
- Review timezone-filtered reports for index friendliness; if a local-day column helps, consider it as a measured change.
- Ensure `STATEMENT_TIMEOUT_MS` is still appropriate for the largest acceptable report; a 20s timeout is fine for guardrail purposes, but if legitimate reports regularly approach it, that is a signal to offload or optimize rather than raise the timeout reflexively.

### Priority 3: offload the most expensive reports

- Add async generation for the heavier reports first, likely `staff-workload`, `department-operations`, `financial-reconciliation`, `lab-turnaround`, `radiology-turnaround`.
- Reuse the existing outbox/queue infrastructure and the existing authorization/audit patterns.
- Store async results tenant-scoped and protect them with the same access rules as the synchronous endpoint.

### Priority 4: replica reads for appropriate analytics

- Enable replica reads only for reports that are clearly analytics and staleness-tolerant.
- Keep financial reconciliation and anything with stricter freshness needs on primary unless explicitly reviewed.
- Keep authorization/consent/clinical read-your-writes paths on primary.

### Priority 5: policy and observability

- Add reporting-specific observability: per-report latency, database time, row counts, replica-vs-primary route, CSV vs JSON.
- Consider cost-aware rate limits or expensive-report gating once the hot reports are known.
- Keep shared caching restricted to public endpoints; avoid caching authenticated report responses.

## 9. Testing and performance benchmarks required

Before any implementation, the following should be verified with tests and benchmarks, not assumed:

### Functional safety tests

- Each report still returns the same answers under the same inputs after indexing or async changes.
- Role and tenant isolation hold: a user cannot see another facility's data, and cannot see data their role cannot read.
- Sensitive reports and CSV exports remain audited.
- Async report results are tenant-scoped and access-controlled.
- No report path can write data when it is supposed to be read-only.

### Performance benchmarks

- Baseline latency and database time for the expensive reports at current seed/synthetic volume and at a larger synthetic tenant volume.
- Index impact measurements: before/after `EXPLAIN` and runtime for the same queries.
- Async vs synchronous comparisons for the offloading candidates, including submission, completion and poll latency.
- Replica-read staleness and fallback behavior under lag, including that primary fallback occurs and that read-only transactions never write.
- Rate-limit behavior for JSON vs CSV and for any new expensive-report policy.

### Operational tests

- Outbox/queue replay and dead-letter handling for any new reporting jobs.
- Backpressure behavior when many report jobs are queued for one tenant.
- Recovery behavior if an async report job fails or is replayed.
- Verification that the report pipeline still behaves correctly when the replica is unhealthy or lagging.

## Findings summary

### Verified

- Reports are synchronous, role-checked, time-bounded, row-capped, rate-limited and auditable today.
- The app already has a conservative bounded-staleness replica path and read-only reporting transactions.
- The repo already has outbox, queue, DLQ, replay and background-job infrastructure.
- Shared caching is restricted to explicit public endpoints; authenticated reports are private.
- Index coverage for reporting tables is already substantial in the migrations.

### Likely but unverified bottlenecks

- `staff-workload` per-author correlated counts across several large tables.
- `department-operations` multi-table inventory/encounter/invoice aggregation.
- `financial-reconciliation` per-invoice correlated subqueries.
- Percentile and correlated-subquery heavy turnaround reports.
- Timezone-converted daily filters.

### Out of scope for this assessment

- Clinical, consent, authorization, financial-consistency and tenant-isolation risks are treated as safety constraints, not as optimization opportunities.
- No change is proposed to application code, migrations, Wrangler config, production secrets, replica enablement or realtime enablement.
