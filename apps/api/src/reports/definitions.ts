import type { Role } from "@medveris/authz";
import type { Tx } from "@medveris/db";
import type { AppConfig } from "../config.js";
import { integrationStatus, listIntegrations } from "../integrations/registry.js";
import { loadVerifications } from "../integrations/verification.js";

export interface ReportWindow {
  tenantId: string;
  from: string;
  to: string;
  timeZone: string;
  /** Inclusive local start of `from` and exclusive local end of `to`, resolved in `timeZone`. */
  startAt: Date;
  endAt: Date;
  params: Record<string, string>;
  /** Limits department-attributable reports to one department; forced for department-scoped roles. */
  departmentId: string | null;
  roles: readonly string[];
}

export interface ReportResult {
  /** `unavailable` means the figures cannot be produced; it is never used for a genuine zero. */
  state: "ok" | "unavailable";
  rows: Record<string, unknown>[];
  summary: Array<{ label: string; value: number | string | null; definition: string }>;
  notes: string[];
}

export interface ReportDefinition {
  id: string;
  title: string;
  description: string;
  category: "reception" | "clinical" | "laboratory" | "radiology" | "pharmacy" | "inpatient" | "maternity" | "workforce" | "finance" | "governance" | "operations";
  /** Roles that may run the report. These mirror the RLS policies of its source tables, so no role sees false zeros. */
  roles: readonly Role[];
  sensitive: boolean;
  columns: ReadonlyArray<{ key: string; label: string }>;
  definitions: readonly string[];
  run(tx: Tx, window: ReportWindow, config: AppConfig): Promise<ReportResult>;
}

const MAX_ROWS = 1000;

const minutes = (expression: string) =>
  `round((percentile_cont(0.5) within group (order by extract(epoch from (${expression})) / 60))::numeric, 1)`;

function ok(rows: Record<string, unknown>[], summary: ReportResult["summary"] = [], notes: string[] = []): ReportResult {
  return { state: "ok", rows: rows.slice(0, MAX_ROWS), summary, notes: rows.length > MAX_ROWS ? [...notes, `Truncated to ${MAX_ROWS} rows`] : notes };
}

const FRONT_DESK: Role[] = ["receptionist", "records", "nurse", "clinician", "facility_admin"];

export const REPORTS: readonly ReportDefinition[] = [
  {
    id: "daily-activity",
    title: "Daily activity and patient throughput",
    description: "Registrations and encounters per day.",
    category: "reception",
    roles: FRONT_DESK,
    sensitive: false,
    columns: [
      { key: "day", label: "Day" }, { key: "registrations", label: "New facility registrations" },
      { key: "encountersOpened", label: "Encounters opened" }, { key: "walkIns", label: "Walk-in encounters" },
      { key: "encountersCompleted", label: "Encounters completed" },
    ],
    definitions: [
      "Registrations count patients newly linked to this facility on that local day.",
      "Encounters are counted on the local day they were opened; completed counts use the close time.",
    ],
    async run(tx, w) {
      const rows = await tx`
        with days as (select generate_series(${w.from}::date, ${w.to}::date, interval '1 day')::date as day)
        select to_char(d.day, 'YYYY-MM-DD') as day,
          (select count(*)::int from tenant_patient_links l where l.tenant_id = ${w.tenantId} and (l.created_at at time zone ${w.timeZone})::date = d.day) as registrations,
          (select count(*)::int from encounters e where e.tenant_id = ${w.tenantId} and (e.opened_at at time zone ${w.timeZone})::date = d.day) as encounters_opened,
          (select count(*)::int from encounters e where e.tenant_id = ${w.tenantId} and e.type = 'walk-in' and (e.opened_at at time zone ${w.timeZone})::date = d.day) as walk_ins,
          (select count(*)::int from encounters e where e.tenant_id = ${w.tenantId} and e.state = 'completed' and e.closed_at is not null
              and (e.closed_at at time zone ${w.timeZone})::date = d.day) as encounters_completed
          from days d order by d.day
      `;
      return ok(rows);
    },
  },
  {
    id: "appointments",
    title: "Appointments and no-shows",
    description: "Appointment outcomes for appointments scheduled in the period.",
    category: "reception",
    roles: FRONT_DESK,
    sensitive: false,
    columns: [
      { key: "total", label: "Appointments" }, { key: "scheduled", label: "Still scheduled" }, { key: "arrived", label: "Arrived" },
      { key: "completed", label: "Completed" }, { key: "cancelled", label: "Cancelled" }, { key: "noShow", label: "No-show" },
      { key: "noShowRatePercent", label: "No-show rate %" },
    ],
    definitions: ["No-show rate = no-shows ÷ (arrived + completed + no-shows); cancelled and still-scheduled appointments are excluded. Blank when the denominator is zero."],
    async run(tx, w) {
      const rows = await tx`
        select count(*)::int as total,
               count(*) filter (where status = 'scheduled')::int as scheduled,
               count(*) filter (where status = 'arrived')::int as arrived,
               count(*) filter (where status = 'completed')::int as completed,
               count(*) filter (where status = 'cancelled')::int as cancelled,
               count(*) filter (where status = 'no-show')::int as no_show,
               round(100.0 * count(*) filter (where status = 'no-show')
                 / nullif(count(*) filter (where status in ('arrived', 'completed', 'no-show')), 0), 1) as no_show_rate_percent
          from appointments where tenant_id = ${w.tenantId} and start_at >= ${w.startAt} and start_at < ${w.endAt}
      `;
      return ok(rows);
    },
  },
  {
    id: "waiting-times",
    title: "Queue waiting times",
    description: "Time from joining a queue to being called, per queue.",
    category: "reception",
    roles: FRONT_DESK,
    sensitive: false,
    columns: [
      { key: "queue", label: "Queue" }, { key: "entries", label: "Entries" }, { key: "called", label: "Called" },
      { key: "medianWaitMinutes", label: "Median wait (min)" }, { key: "p90WaitMinutes", label: "90th percentile wait (min)" },
      { key: "stillWaiting", label: "Still waiting" },
    ],
    definitions: ["Wait = called time − queue entry time, for entries created in the period. Entries never called are excluded from the wait statistics and counted as still waiting."],
    async run(tx, w) {
      const rows = await tx.unsafe(`
        select q.name as queue, count(qe.id)::int as entries, count(qe.called_at)::int as called,
               ${minutes("qe.called_at - qe.created_at")} as median_wait_minutes,
               round((percentile_cont(0.9) within group (order by extract(epoch from (qe.called_at - qe.created_at)) / 60))::numeric, 1) as p90_wait_minutes,
               count(qe.id) filter (where qe.called_at is null and qe.status = 'waiting')::int as still_waiting
          from queues q
          left join queue_entries qe on qe.queue_id = q.id and qe.created_at >= $2 and qe.created_at < $3
         where q.tenant_id = $1
         group by q.name order by q.name
      `, [w.tenantId, w.startAt, w.endAt]);
      return ok(rows);
    },
  },
  {
    id: "consultations",
    title: "Consultations by clinician",
    description: "Signed clinical notes and documented encounters per author.",
    category: "clinical",
    roles: ["clinician", "nurse"],
    sensitive: false,
    columns: [{ key: "author", label: "Author" }, { key: "encountersDocumented", label: "Encounters documented" }, { key: "signedNotes", label: "Signed note versions" }],
    definitions: ["Counts signed or amended note versions whose signature time falls in the period."],
    async run(tx, w) {
      const rows = await tx`
        select u.display_name as author, count(distinct v.encounter_id)::int as encounters_documented, count(*)::int as signed_notes
          from clinical_entry_versions v join users u on u.id = v.author_id
         where v.tenant_id = ${w.tenantId} and v.signed_at >= ${w.startAt} and v.signed_at < ${w.endAt}
         group by u.display_name order by signed_notes desc
      `;
      return ok(rows);
    },
  },
  {
    id: "diagnoses",
    title: "Recorded diagnoses",
    description: "Conditions recorded in the period.",
    category: "clinical",
    roles: ["clinician", "nurse"],
    sensitive: true,
    columns: [{ key: "diagnosis", label: "Diagnosis" }, { key: "code", label: "Code" }, { key: "recorded", label: "Times recorded" }, { key: "patients", label: "Patients" }],
    definitions: ["Grouped by the recorded display text and code. Codes in synthetic terminology mode are not licensed SNOMED CT."],
    async run(tx, w) {
      const rows = await tx`
        select coalesce(display, original_text) as diagnosis, snomed_code as code, count(*)::int as recorded, count(distinct patient_id)::int as patients
          from conditions where tenant_id = ${w.tenantId} and recorded_at >= ${w.startAt} and recorded_at < ${w.endAt}
         group by 1, 2 order by recorded desc limit 200
      `;
      return ok(rows);
    },
  },
  {
    id: "lab-turnaround",
    title: "Laboratory workload and turnaround",
    description: "Laboratory orders placed in the period, by test.",
    category: "laboratory",
    roles: ["clinician", "nurse", "laboratory"],
    sensitive: false,
    columns: [
      { key: "test", label: "Test" }, { key: "ordered", label: "Ordered" }, { key: "resulted", label: "Resulted" },
      { key: "verified", label: "Verified" }, { key: "released", label: "Released" }, { key: "pending", label: "Pending" },
      { key: "rejectedSpecimens", label: "Rejected specimens" }, { key: "critical", label: "Critical results" },
      { key: "medianOrderToVerifiedMinutes", label: "Median order → verified (min)" },
    ],
    definitions: ["Turnaround = verification time − order time, for verified results only.", "Pending = ordered items without a result and not cancelled."],
    async run(tx, w) {
      const rows = await tx.unsafe(`
        select i.name as test, count(*)::int as ordered, count(r.id)::int as resulted, count(r.verified_at)::int as verified,
               count(r.reported_at)::int as released,
               count(*) filter (where r.id is null and i.status <> 'cancelled')::int as pending,
               coalesce(sum((select count(*) from specimens s where s.order_item_id = i.id and s.status = 'rejected')), 0)::int as rejected_specimens,
               count(*) filter (where r.critical)::int as critical,
               ${minutes("r.verified_at - o.created_at")} as median_order_to_verified_minutes
          from service_order_items i join service_orders o on o.id = i.order_id
          left join lab_results r on r.order_item_id = i.id
         where o.tenant_id = $1 and o.order_type = 'laboratory' and o.created_at >= $2 and o.created_at < $3
         group by i.name order by ordered desc
      `, [w.tenantId, w.startAt, w.endAt]);
      return ok(rows);
    },
  },
  {
    id: "radiology-turnaround",
    title: "Radiology reporting turnaround",
    description: "Imaging orders placed in the period, by modality.",
    category: "radiology",
    roles: ["clinician", "nurse", "radiology"],
    sensitive: false,
    columns: [
      { key: "modality", label: "Modality" }, { key: "ordered", label: "Ordered" }, { key: "acquired", label: "Acquired" },
      { key: "signed", label: "Signed final" }, { key: "released", label: "Released" }, { key: "unsigned", label: "Not yet signed" },
      { key: "critical", label: "Critical" }, { key: "medianOrderToSignMinutes", label: "Median order → sign (min)" },
      { key: "medianAcquiredToSignMinutes", label: "Median acquired → sign (min)" }, { key: "medianSignToReleaseMinutes", label: "Median sign → release (min)" },
    ],
    definitions: ["All intervals use persisted timestamps (order, acquisition, final signature, release) and include only items where both ends exist."],
    async run(tx, w) {
      const rows = await tx.unsafe(`
        select coalesce(s.modality, '(no study yet)') as modality, count(*)::int as ordered, count(s.acquired_at)::int as acquired,
               count(r.signed_at)::int as signed, count(r.released_at)::int as released,
               count(*) filter (where r.signed_at is null)::int as unsigned,
               count(*) filter (where r.urgency = 'critical')::int as critical,
               ${minutes("r.signed_at - o.created_at")} as median_order_to_sign_minutes,
               ${minutes("r.signed_at - s.acquired_at")} as median_acquired_to_sign_minutes,
               ${minutes("r.released_at - r.signed_at")} as median_sign_to_release_minutes
          from service_order_items i join service_orders o on o.id = i.order_id
          left join imaging_studies s on s.order_item_id = i.id and s.acquisition_status <> 'cancelled'
          left join radiology_reports r on r.study_id = s.id and r.status <> 'cancelled'
         where o.tenant_id = $1 and o.order_type = 'imaging' and i.status <> 'cancelled' and o.created_at >= $2 and o.created_at < $3
         group by 1 order by ordered desc
      `, [w.tenantId, w.startAt, w.endAt]);
      return ok(rows);
    },
  },
  {
    id: "pharmacy-stock",
    title: "Pharmacy stock, expiry and dispensing",
    description: "Current stock by medicine with expiry exposure and quantity dispensed in the period.",
    category: "pharmacy",
    roles: ["pharmacist", "clinician", "nurse"],
    sensitive: false,
    columns: [
      { key: "medicine", label: "Medicine" }, { key: "form", label: "Form" }, { key: "onHand", label: "On hand" },
      { key: "lotsInStock", label: "Lots in stock" }, { key: "expiredQuantity", label: "Expired quantity" },
      { key: "expiringQuantity", label: "Expiring within window" }, { key: "nextExpiry", label: "Next expiry" },
      { key: "dispensedInPeriod", label: "Dispensed in period" },
    ],
    definitions: [
      "On hand and expiry are current values at generation time; dispensed quantity uses the report period.",
      "The expiry window is the expiryWindowDays parameter (default 90 days), not a clinical threshold.",
      "Stock valuation is not shown: pharmacy lots carry no unit cost.",
    ],
    async run(tx, w) {
      const expiryDays = Math.max(1, Math.min(Number.parseInt(w.params.expiryWindowDays ?? "90", 10) || 90, 730));
      const rows = await tx.unsafe(`
        select m.name || ' ' || m.strength as medicine, m.form,
               coalesce(sum(l.quantity), 0)::numeric as on_hand,
               count(l.id) filter (where l.quantity > 0)::int as lots_in_stock,
               coalesce(sum(l.quantity) filter (where l.expires_on < current_date), 0)::numeric as expired_quantity,
               coalesce(sum(l.quantity) filter (where l.expires_on >= current_date and l.expires_on < current_date + $4::int), 0)::numeric as expiring_quantity,
               to_char(min(l.expires_on) filter (where l.quantity > 0 and l.expires_on >= current_date), 'YYYY-MM-DD') as next_expiry,
               (select coalesce(sum(d.quantity), 0)::numeric from dispenses d join stock_lots dl on dl.id = d.lot_id
                 where dl.medicine_id = m.id and d.created_at >= $2 and d.created_at < $3) as dispensed_in_period
          from medicines m left join stock_lots l on l.medicine_id = m.id
         where m.tenant_id = $1
         group by m.id, m.name, m.strength, m.form order by medicine
      `, [w.tenantId, w.startAt, w.endAt, expiryDays]);
      return ok(rows, [], [`Expiry window: ${expiryDays} days`]);
    },
  },
  {
    id: "bed-occupancy",
    title: "Bed occupancy and length of stay",
    description: "Current bed status by ward, with admissions, discharges and average length of stay for the period.",
    category: "inpatient",
    roles: ["clinician", "nurse", "facility_admin"],
    sensitive: false,
    columns: [
      { key: "ward", label: "Ward" }, { key: "beds", label: "Beds" }, { key: "occupied", label: "Occupied" },
      { key: "available", label: "Available" }, { key: "cleaning", label: "Cleaning" }, { key: "unavailable", label: "Unavailable" },
      { key: "occupancyPercentNow", label: "Occupancy % now" },
    ],
    definitions: [
      "Bed figures are current at generation time.",
      "Average length of stay = mean of (discharge − admission) in days for admissions discharged in the period.",
    ],
    async run(tx, w) {
      const rows = await tx`
        select wd.name as ward, count(b.id)::int as beds,
               count(b.id) filter (where b.status = 'occupied')::int as occupied,
               count(b.id) filter (where b.status = 'available')::int as available,
               count(b.id) filter (where b.status = 'cleaning')::int as cleaning,
               count(b.id) filter (where b.status = 'unavailable')::int as unavailable,
               round(100.0 * count(b.id) filter (where b.status = 'occupied') / nullif(count(b.id), 0), 1) as occupancy_percent_now
          from wards wd left join beds b on b.ward_id = wd.id
         where wd.tenant_id = ${w.tenantId} group by wd.name order by wd.name
      `;
      const [stay] = await tx`
        select count(*) filter (where admitted_at >= ${w.startAt} and admitted_at < ${w.endAt})::int as admissions,
               count(*) filter (where discharged_at >= ${w.startAt} and discharged_at < ${w.endAt})::int as discharges,
               round(avg(extract(epoch from (discharged_at - admitted_at)) / 86400) filter (where discharged_at >= ${w.startAt} and discharged_at < ${w.endAt})::numeric, 2) as average_length_of_stay_days
          from admissions where tenant_id = ${w.tenantId}
      `;
      return ok(rows, [
        { label: "Admissions", value: stay?.admissions ?? 0, definition: "Admissions with an admission time in the period" },
        { label: "Discharges", value: stay?.discharges ?? 0, definition: "Admissions with a discharge time in the period" },
        { label: "Average length of stay (days)", value: stay?.averageLengthOfStayDays ?? null, definition: "Blank when no discharges fall in the period" },
      ]);
    },
  },
  {
    id: "maternity-outcomes",
    title: "Maternity and newborn outcomes",
    description: "Deliveries by mode and newborn birth-weight categories for the period.",
    category: "maternity",
    roles: ["clinician", "nurse"],
    sensitive: true,
    columns: [
      { key: "mode", label: "Delivery mode" }, { key: "deliveries", label: "Deliveries" },
      { key: "withComplications", label: "With recorded complications" }, { key: "medianBloodLossMl", label: "Median blood loss (mL)" },
    ],
    definitions: [
      "Birth-weight categories follow WHO definitions: very low < 1500 g, low < 2500 g, ≥ 4000 g reported separately.",
      "Complications count deliveries with any complication text recorded; no clinical threshold is applied.",
    ],
    async run(tx, w) {
      const rows = await tx`
        select mode, count(*)::int as deliveries,
               count(*) filter (where coalesce(btrim(complications), '') <> '')::int as with_complications,
               percentile_cont(0.5) within group (order by blood_loss_ml) as median_blood_loss_ml
          from delivery_records where tenant_id = ${w.tenantId} and delivered_at >= ${w.startAt} and delivered_at < ${w.endAt}
         group by mode order by deliveries desc
      `;
      const [episodes] = await tx`
        select count(*)::int as registered, count(*) filter (where risk_level = 'high')::int as high_risk
          from maternity_episodes where tenant_id = ${w.tenantId} and created_at >= ${w.startAt} and created_at < ${w.endAt}
      `;
      const [born] = await tx`
        select count(*)::int as newborns,
               count(*) filter (where weight_g < 1500)::int as very_low,
               count(*) filter (where weight_g < 2500)::int as low,
               count(*) filter (where weight_g >= 4000)::int as heavy,
               count(*) filter (where weight_g is null)::int as missing_weight
          from newborn_records where tenant_id = ${w.tenantId} and born_at >= ${w.startAt} and born_at < ${w.endAt}
      `;
      return ok(rows, [
        { label: "Maternity episodes registered", value: episodes?.registered ?? 0, definition: "Episodes created in the period" },
        { label: "High-risk episodes", value: episodes?.highRisk ?? 0, definition: "Episodes created in the period with risk level 'high'" },
        { label: "Newborns", value: born?.newborns ?? 0, definition: "Newborn records with a birth time in the period" },
        { label: "Birth weight < 2500 g", value: born?.low ?? 0, definition: "Includes very low birth weight" },
        { label: "Birth weight < 1500 g", value: born?.veryLow ?? 0, definition: "Very low birth weight" },
        { label: "Birth weight ≥ 4000 g", value: born?.heavy ?? 0, definition: "Recorded weight at or above 4000 g" },
        { label: "Weight not recorded", value: born?.missingWeight ?? 0, definition: "Excluded from the weight categories" },
      ]);
    },
  },
  {
    id: "staff-workload",
    title: "Staff workload",
    description: "Per-person counts of signed notes, laboratory results, radiology signatures and dispenses.",
    category: "workforce",
    roles: ["facility_admin", "department_lead"],
    sensitive: true,
    columns: [
      { key: "displayName", label: "Staff member" }, { key: "roles", label: "Roles" }, { key: "signedNotes", label: "Signed notes" },
      { key: "labResultsEntered", label: "Lab results entered" }, { key: "labResultsValidated", label: "Lab results validated" },
      { key: "radiologyReportsSigned", label: "Radiology signatures" }, { key: "dispenses", label: "Dispenses" },
    ],
    definitions: ["Counts only; no patient or record identifiers are returned. Workload counts are not a measure of quality."],
    async run(tx, w) {
      const rows = await tx`select * from app.report_staff_workload(${w.tenantId}, ${w.startAt}, ${w.endAt})`;
      return ok(rows.map((row) => ({ ...row, roles: (row.roles as string[]).join(", ") })));
    },
  },
  {
    id: "financial-reconciliation",
    title: "Billing and payment reconciliation",
    description: "Invoices issued in the period with recorded payments and outstanding balances, per currency.",
    category: "finance",
    roles: ["finance", "facility_admin"],
    sensitive: true,
    columns: [
      { key: "currency", label: "Currency" }, { key: "invoices", label: "Invoices" }, { key: "voided", label: "Voided" },
      { key: "billed", label: "Billed" }, { key: "paid", label: "Recorded payments" }, { key: "reversed", label: "Reversed payments" },
      { key: "outstanding", label: "Outstanding" }, { key: "overpaidInvoices", label: "Invoices paid above total" },
    ],
    definitions: [
      "Billed = sum of line amounts on non-void invoices created in the period.",
      "Recorded payments are manual entries on those invoices, excluding reversed payments. No payment is provider-confirmed.",
      "Invoices paid above total are reconciliation exceptions to review.",
    ],
    async run(tx, w, config) {
      const rows = await tx.unsafe(`
        with inv as (
          select i.id, i.currency, i.status,
                 coalesce((select sum(it.amount) from invoice_items it where it.invoice_id = i.id), 0) as billed,
                 coalesce((select sum(p.amount) from payments p where p.invoice_id = i.id and p.reversed_at is null), 0) as paid,
                 coalesce((select sum(p.amount) from payments p where p.invoice_id = i.id and p.reversed_at is not null), 0) as reversed
            from invoices i where i.tenant_id = $1 and i.created_at >= $2 and i.created_at < $3
        )
        select currency, count(*)::int as invoices, count(*) filter (where status = 'void')::int as voided,
               coalesce(sum(billed) filter (where status <> 'void'), 0)::numeric as billed,
               coalesce(sum(paid) filter (where status <> 'void'), 0)::numeric as paid,
               coalesce(sum(reversed), 0)::numeric as reversed,
               coalesce(sum(greatest(billed - paid, 0)) filter (where status <> 'void'), 0)::numeric as outstanding,
               count(*) filter (where status <> 'void' and paid > billed)::int as overpaid_invoices
          from inv group by currency order by currency
      `, [w.tenantId, w.startAt, w.endAt]);
      const payments = integrationStatus(config, "payments");
      return ok(rows, [
        { label: "Provider-confirmed payments", value: payments.state === "available" ? null : "unavailable", definition: `Payments integration is ${payments.state}: ${payments.reason}` },
      ]);
    },
  },
  {
    id: "audit-security",
    title: "Audit and security events",
    description: "Audit events in the period by action and decision.",
    category: "governance",
    roles: ["facility_admin", "auditor", "privacy_officer"],
    sensitive: true,
    columns: [{ key: "action", label: "Action" }, { key: "decision", label: "Decision" }, { key: "events", label: "Events" }, { key: "actors", label: "Distinct actors" }],
    definitions: ["Counts of this facility's audit events; event content is not included."],
    async run(tx, w) {
      const rows = await tx`
        select action, decision, count(*)::int as events, count(distinct actor_user_id)::int as actors
          from audit_events where tenant_id = ${w.tenantId} and occurred_at >= ${w.startAt} and occurred_at < ${w.endAt}
         group by action, decision order by events desc limit 500
      `;
      const [totals] = await tx`
        select count(*)::int as events, count(*) filter (where decision = 'deny')::int as denied
          from audit_events where tenant_id = ${w.tenantId} and occurred_at >= ${w.startAt} and occurred_at < ${w.endAt}
      `;
      return ok(rows, [
        { label: "Audit events", value: totals?.events ?? 0, definition: "All events in the period" },
        { label: "Denied decisions", value: totals?.denied ?? 0, definition: "Events recorded with decision 'deny'" },
      ]);
    },
  },
  {
    id: "department-operations",
    title: "Department operations",
    description: "Activity, stock and billing for each department and unit, or for one department.",
    category: "operations",
    roles: ["facility_admin", "department_admin", "unit_lead", "report_viewer", "auditor", "finance", "pharmacist"],
    sensitive: false,
    columns: [
      { key: "department", label: "Department" }, { key: "unit", label: "Unit" }, { key: "serviceCategory", label: "Service category" },
      { key: "stockLocations", label: "Stock locations" }, { key: "receipts", label: "Receipts" }, { key: "issues", label: "Issues and consumption" },
      { key: "transfers", label: "Transfers" }, { key: "adjustments", label: "Adjustments" }, { key: "belowMinimum", label: "Lines below minimum (now)" },
      { key: "expiringLots", label: "Lots expiring in 90 days (now)" }, { key: "purchaseOrders", label: "Purchase orders raised" },
      { key: "encounters", label: "Encounters attributed" }, { key: "amountBilled", label: "Amount billed" },
    ],
    definitions: [
      "Stock activity is attributed to the department and unit that own the inventory location; transfers count both directions.",
      "Encounters and invoices count only where a department was recorded on them.",
      "Amount billed is shown to finance and facility administrators; other roles see it as not available, never as zero.",
      "Current values (below minimum, expiring lots) are at generation time; other columns use the report period.",
    ],
    async run(tx, w) {
      const billing = w.roles.includes("finance") || w.roles.includes("facility_admin");
      const rows = await tx`
        with scopes as (
          select d.id as department_id, u.id as unit_id, d.name as department, u.name as unit,
                 coalesce(u.service_category, d.service_category) as service_category, d.sort_order
            from departments d left join units u on u.department_id = d.id and u.enabled
           where d.tenant_id = ${w.tenantId} and d.enabled and (${w.departmentId}::uuid is null or d.id = ${w.departmentId}::uuid)
          union all
          select d.id, null, d.name, null, d.service_category, d.sort_order
            from departments d
           where d.tenant_id = ${w.tenantId} and d.enabled and (${w.departmentId}::uuid is null or d.id = ${w.departmentId}::uuid)
             and exists (select 1 from units u where u.department_id = d.id and u.enabled)
        ),
        locs as (
          select s.department_id, s.unit_id, l.id from scopes s
            join inventory_locations l on l.tenant_id = ${w.tenantId} and l.department_id = s.department_id
             and l.unit_id is not distinct from s.unit_id
        ),
        moves as (
          select lc.department_id, lc.unit_id, m.movement_type, count(*)::int as n
            from locs lc join inventory_movements m on m.tenant_id = ${w.tenantId}
             and (m.source_location_id = lc.id or m.destination_location_id = lc.id)
             and m.occurred_at >= ${w.startAt} and m.occurred_at < ${w.endAt}
           group by lc.department_id, lc.unit_id, m.movement_type
        )
        select s.department, s.unit, s.service_category,
          (select count(*)::int from locs lc where lc.department_id = s.department_id and lc.unit_id is not distinct from s.unit_id) as stock_locations,
          coalesce((select sum(n) from moves mv where mv.department_id = s.department_id and mv.unit_id is not distinct from s.unit_id and mv.movement_type in ('receipt','opening','return')), 0)::int as receipts,
          coalesce((select sum(n) from moves mv where mv.department_id = s.department_id and mv.unit_id is not distinct from s.unit_id and mv.movement_type in ('issue','consumption','write-off')), 0)::int as issues,
          coalesce((select sum(n) from moves mv where mv.department_id = s.department_id and mv.unit_id is not distinct from s.unit_id and mv.movement_type in ('transfer-out','transfer-in')), 0)::int as transfers,
          coalesce((select sum(n) from moves mv where mv.department_id = s.department_id and mv.unit_id is not distinct from s.unit_id and mv.movement_type in ('adjustment','count-adjustment','reversal')), 0)::int as adjustments,
          (select count(*)::int from inventory_location_policies p join locs lc on lc.id = p.location_id
            where lc.department_id = s.department_id and lc.unit_id is not distinct from s.unit_id
              and p.minimum_quantity > coalesce((select sum(b.on_hand - b.reserved - b.quarantined) from inventory_balances b where b.location_id = p.location_id and b.item_id = p.item_id), 0)) as below_minimum,
          (select count(distinct b.lot_id)::int from inventory_balances b join locs lc on lc.id = b.location_id join inventory_lots lot on lot.id = b.lot_id
            where lc.department_id = s.department_id and lc.unit_id is not distinct from s.unit_id and b.on_hand > 0
              and lot.expires_on is not null and lot.expires_on < current_date + 90) as expiring_lots,
          (select count(*)::int from purchase_orders po where po.tenant_id = ${w.tenantId} and po.department_id = s.department_id
              and po.unit_id is not distinct from s.unit_id and po.created_at >= ${w.startAt} and po.created_at < ${w.endAt}) as purchase_orders,
          (select count(*)::int from encounters e where e.tenant_id = ${w.tenantId} and e.department_id = s.department_id
              and e.unit_id is not distinct from s.unit_id and e.opened_at >= ${w.startAt} and e.opened_at < ${w.endAt}) as encounters,
          case when ${billing} then (select coalesce(sum(ii.amount), 0) from invoices i join invoice_items ii on ii.invoice_id = i.id
              where i.tenant_id = ${w.tenantId} and i.department_id = s.department_id and i.unit_id is not distinct from s.unit_id
                and i.status <> 'void' and i.created_at >= ${w.startAt} and i.created_at < ${w.endAt}) end as amount_billed
          from scopes s order by s.sort_order, s.department, s.unit nulls first
      `;
      return ok(rows.map((row) => ({ ...row, unit: row.unit ?? (rows.some((other) => other.department === row.department && other.unit) ? "(department level)" : "—"), amountBilled: billing ? row.amountBilled : "not available for your role" })),
        [], w.departmentId ? ["Limited to one department"] : []);
    },
  },
  {
    id: "integration-health",
    title: "Integration health",
    description: "Server-reported availability of every external integration.",
    category: "governance",
    roles: ["facility_admin", "it_admin", "auditor"],
    sensitive: false,
    columns: [
      { key: "name", label: "Integration" }, { key: "state", label: "State" }, { key: "reason", label: "Reason" },
      { key: "lastVerificationOutcome", label: "Last verification" }, { key: "missingPrerequisites", label: "Missing prerequisites" },
    ],
    definitions: ["States come from the integration registry at generation time. No integration operations are recorded yet, so failed-operation counts are not available."],
    async run(tx, _w, config) {
      return ok(listIntegrations(config, await loadVerifications(tx, config)).map((item) => ({
        name: item.name, state: item.state, reason: item.reason, lastVerificationOutcome: item.lastVerificationOutcome,
        missingPrerequisites: item.missingPrerequisites.join("; "),
      })));
    },
  },
];

export function reportById(id: string): ReportDefinition | undefined {
  return REPORTS.find((report) => report.id === id);
}
