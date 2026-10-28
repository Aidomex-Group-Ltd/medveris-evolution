import { Hono, type Context } from "hono";
import { patientMergeDecisionSchema, patientMergeRequestSchema, patientMergeReverseSchema, uuidSchema } from "@medveris/contracts";
import type { Tx } from "@medveris/db";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { ConflictError, ForbiddenError, ValidationError } from "../lib/errors.js";
import { parseJson } from "../lib/http.js";
import { uniqueViolation } from "../lib/idempotency.js";
import type { AppEnv } from "../types.js";

export const patientMergeRoutes = new Hono<AppEnv>();

const MERGE_ROLES = ["facility_admin", "records"];
const BLOCKER_MESSAGES: Record<string, string> = {
  "linked-to-another-facility": "the duplicate is linked to another facility; a cross-facility merge needs platform review",
  "has-patient-account": "the duplicate has a patient portal account; the patient must be involved through platform review",
  "has-active-exchange-grant": "the duplicate has an active exchange grant; revoke or let it expire first",
  "has-active-proxy": "the duplicate has an active caregiver proxy; revoke it first",
};

function mergeActor(c: Context<AppEnv>) {
  requireStaff(c);
  if (!requestActor(c).roles.some((role) => MERGE_ROLES.includes(role))) {
    throw new ForbiddenError("Patient merge requires a facility administrator or records officer");
  }
  const auth = c.get("auth")!;
  return { auth, tenantId: auth.activeTenant!.id, config: c.get("deps").config };
}

/** Both identities must be active and linked to this facility, and the duplicate must have no outside dependencies. */
async function assertMergeable(tx: Tx, tenantId: string, sourceId: string, survivorId: string): Promise<void> {
  const rows = await tx`
    select p.id, p.merged_into, exists (select 1 from tenant_patient_links l where l.patient_id = p.id and l.tenant_id = ${tenantId}) as linked
      from patients p where p.id in (${sourceId}, ${survivorId}) for update of p
  `;
  for (const id of [sourceId, survivorId]) {
    const row = rows.find((candidate) => String(candidate.id) === id);
    if (!row || !row.linked) throw new ValidationError("Both patients must be linked to this facility");
    if (row.mergedInto) throw new ConflictError("A patient in this request has already been merged");
  }
  const [blockers] = await tx`select app.patient_merge_blockers(${sourceId}, ${tenantId}) as codes`;
  const codes = (blockers?.codes as string[] | null) ?? [];
  if (codes.length) {
    throw new ConflictError(`This merge cannot be completed by the facility: ${codes.map((code) => BLOCKER_MESSAGES[code] ?? code).join("; ")}`, { blockers: codes });
  }
}

patientMergeRoutes.post("/patient-merges", async (c) => {
  const { auth, tenantId, config } = mergeActor(c);
  const body = await parseJson(c, patientMergeRequestSchema);
  if (body.sourcePatientId === body.survivorPatientId) throw new ValidationError("Choose two different patients");
  const id = crypto.randomUUID();
  try {
    await withStaffActor(c, async (tx) => {
      await assertMergeable(tx, tenantId, body.sourcePatientId, body.survivorPatientId);
      if (body.duplicateCandidateId) {
        await requireRows(await tx`
          select id from patient_duplicate_candidates
           where id = ${body.duplicateCandidateId} and tenant_id = ${tenantId} and status = 'pending'
             and ${body.sourcePatientId} in (primary_patient_id, candidate_patient_id)
             and ${body.survivorPatientId} in (primary_patient_id, candidate_patient_id)
        `, "Pending duplicate candidate for these patients not found");
      }
      await tx`
        insert into patient_merges (id, tenant_id, source_patient_id, survivor_patient_id, duplicate_candidate_id, reason, evidence, requested_by)
        values (${id}, ${tenantId}, ${body.sourcePatientId}, ${body.survivorPatientId}, ${body.duplicateCandidateId ?? null},
          ${body.reason}, ${body.evidence}, ${auth.user.id})
      `;
      await writeAudit(tx, config, requestAudit(c, "patient.merge.request", {
        subjectPatientId: body.sourcePatientId, resourceType: "PatientMerge", resourceId: id,
        metadata: { survivorPatientId: body.survivorPatientId, duplicateCandidateId: body.duplicateCandidateId ?? null },
      }));
    });
  } catch (error) {
    if (uniqueViolation(error) === "patient_merges_one_open_per_source") throw new ConflictError("This patient already has an open or completed merge");
    throw error;
  }
  return c.json({ ok: true, merge: { id, status: "requested" } }, 201);
});

patientMergeRoutes.get("/patient-merges", async (c) => {
  const { tenantId } = mergeActor(c);
  const status = c.req.query("status") ?? "all";
  if (!["all", "requested", "completed", "rejected", "reversed"].includes(status)) throw new ValidationError("Invalid merge status filter");
  const rows = await withStaffActor(c, async (tx) => tx`
    select m.id, m.status, m.reason, m.evidence, m.requested_at, m.decided_at, m.decision_note, m.reversed_at, m.reversal_reason,
           m.requested_by, ru.display_name as requested_by_name, du.display_name as decided_by_name, vu.display_name as reversed_by_name,
           s.id as source_id, s.public_id as source_public_id, s.given_name as source_given_name, s.family_name as source_family_name,
           to_char(s.date_of_birth, 'YYYY-MM-DD') as source_date_of_birth,
           v.id as survivor_id, v.public_id as survivor_public_id, v.given_name as survivor_given_name, v.family_name as survivor_family_name,
           to_char(v.date_of_birth, 'YYYY-MM-DD') as survivor_date_of_birth
      from patient_merges m
      join patients s on s.id = m.source_patient_id
      join patients v on v.id = m.survivor_patient_id
      join users ru on ru.id = m.requested_by
      left join users du on du.id = m.decided_by
      left join users vu on vu.id = m.reversed_by
     where m.tenant_id = ${tenantId} and (${status} = 'all' or m.status = ${status})
     order by m.requested_at desc limit 200
  `);
  return c.json({ merges: rows });
});

patientMergeRoutes.post("/patient-merges/:id/approve", async (c) => {
  const { auth, tenantId, config } = mergeActor(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, patientMergeDecisionSchema);
  await withStaffActor(c, async (tx) => {
    const merge = await requireRows(await tx`
      select * from patient_merges where id = ${id} and tenant_id = ${tenantId} for update
    `, "Merge request not found");
    if (merge.status !== "requested") throw new ConflictError(`This merge is already ${merge.status}`);
    if (String(merge.requestedBy) === auth.user.id) throw new ForbiddenError("A different authorised person must approve a merge they did not request");
    const sourceId = String(merge.sourcePatientId);
    const survivorId = String(merge.survivorPatientId);
    await assertMergeable(tx, tenantId, sourceId, survivorId);
    const [snapshot] = await tx`
      select public_id, given_name, family_name, to_char(date_of_birth, 'YYYY-MM-DD') as date_of_birth, sex, phone, email,
             identity_confidence, created_via, created_at
        from patients where id = ${sourceId}
    `;
    await tx`update patients set merged_into = ${survivorId}, updated_at = now() where id = ${sourceId}`;
    await tx`
      update patient_merges set status = 'completed', decided_by = ${auth.user.id}, decided_at = now(), decision_note = ${body.note},
        source_snapshot = ${tx.json(snapshot as never)}
       where id = ${id}
    `;
    if (merge.duplicateCandidateId) {
      await tx`
        update patient_duplicate_candidates set status = 'linked', reviewed_by = ${auth.user.id}, reviewed_at = now(),
          review_note = ${`Merged: ${body.note}`} where id = ${merge.duplicateCandidateId} and status = 'pending'
      `;
    }
    for (const [subject, role] of [[sourceId, "source"], [survivorId, "survivor"]] as const) {
      await writeAudit(tx, config, requestAudit(c, "patient.merge.complete", {
        subjectPatientId: subject, resourceType: "PatientMerge", resourceId: id,
        metadata: { role, sourcePatientId: sourceId, survivorPatientId: survivorId, requestedBy: String(merge.requestedBy) },
      }));
    }
    await writeOutbox(tx, { tenantId, eventType: "patient.merged", aggregateId: id, payload: { sourcePatientId: sourceId, survivorPatientId: survivorId } });
  });
  return c.json({ ok: true, status: "completed" });
});

patientMergeRoutes.post("/patient-merges/:id/reject", async (c) => {
  const { auth, tenantId, config } = mergeActor(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, patientMergeDecisionSchema);
  await withStaffActor(c, async (tx) => {
    const merge = await requireRows(await tx`select * from patient_merges where id = ${id} and tenant_id = ${tenantId} for update`, "Merge request not found");
    if (merge.status !== "requested") throw new ConflictError(`This merge is already ${merge.status}`);
    if (String(merge.requestedBy) === auth.user.id) throw new ForbiddenError("A different authorised person must decide a merge they did not request");
    await tx`update patient_merges set status = 'rejected', decided_by = ${auth.user.id}, decided_at = now(), decision_note = ${body.note} where id = ${id}`;
    await writeAudit(tx, config, requestAudit(c, "patient.merge.reject", {
      subjectPatientId: String(merge.sourcePatientId), resourceType: "PatientMerge", resourceId: id,
      metadata: { survivorPatientId: String(merge.survivorPatientId) },
    }));
  });
  return c.json({ ok: true, status: "rejected" });
});

patientMergeRoutes.post("/patient-merges/:id/reverse", async (c) => {
  const { auth, tenantId, config } = mergeActor(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, patientMergeReverseSchema);
  await withStaffActor(c, async (tx) => {
    const merge = await requireRows(await tx`select * from patient_merges where id = ${id} and tenant_id = ${tenantId} for update`, "Merge request not found");
    if (merge.status !== "completed") throw new ConflictError("Only a completed merge can be reversed");
    const sourceId = String(merge.sourcePatientId);
    const restored = await tx`
      update patients set merged_into = null, updated_at = now()
       where id = ${sourceId} and merged_into = ${merge.survivorPatientId} returning id
    `;
    if (!restored.length) throw new ConflictError("The duplicate identity no longer points to this survivor; review the merge history");
    await tx`
      update patient_merges set status = 'reversed', reversed_by = ${auth.user.id}, reversed_at = now(), reversal_reason = ${body.reason} where id = ${id}
    `;
    for (const subject of [sourceId, String(merge.survivorPatientId)]) {
      await writeAudit(tx, config, requestAudit(c, "patient.merge.reverse", {
        subjectPatientId: subject, resourceType: "PatientMerge", resourceId: id,
        metadata: { sourcePatientId: sourceId, survivorPatientId: String(merge.survivorPatientId) },
      }));
    }
    await writeOutbox(tx, { tenantId, eventType: "patient.merge.reversed", aggregateId: id, payload: { sourcePatientId: sourceId } });
  });
  return c.json({ ok: true, status: "reversed" });
});

/** The surviving identity with any identities merged into it, and their encounters at this facility. */
patientMergeRoutes.get("/patients/:id/identity", async (c) => {
  requireStaff(c);
  const roles = requestActor(c).roles;
  if (!roles.some((role) => ["receptionist", "records", "nurse", "clinician", "facility_admin"].includes(role))) {
    throw new ForbiddenError("Front-desk, records or clinical access is required");
  }
  const auth = c.get("auth")!;
  const tenantId = auth.activeTenant!.id;
  const id = uuidSchema.parse(c.req.param("id"));
  const data = await withStaffActor(c, async (tx) => {
    const patient = await requireRows(await tx`
      select p.id, p.public_id, p.given_name, p.family_name, to_char(p.date_of_birth, 'YYYY-MM-DD') as date_of_birth, p.sex, p.merged_into
        from patients p join tenant_patient_links l on l.patient_id = p.id and l.tenant_id = ${tenantId}
       where p.id = ${id}
    `, "Patient is not linked to this facility");
    // Derived from the identity link rather than merge records, which hold reasons and evidence restricted to merge reviewers.
    const merged = await tx`
      select s.id, s.public_id, s.given_name, s.family_name
        from patients s join tenant_patient_links l on l.patient_id = s.id and l.tenant_id = ${tenantId}
       where s.merged_into = ${id}
       order by s.public_id
    `;
    const identityIds = [id, ...merged.map((row) => String(row.id))];
    const encounters = await tx`
      select e.id, e.patient_id, e.type, e.state, e.reason, e.opened_at, p.public_id
        from encounters e join patients p on p.id = e.patient_id
       where e.tenant_id = ${tenantId} and e.patient_id = any(${identityIds}::uuid[])
       order by e.opened_at desc limit 100
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "patient.identity.read", {
      subjectPatientId: id, resourceType: "Patient", resourceId: id, metadata: { mergedIdentities: merged.length },
    }));
    return { patient, merged, encounters };
  });
  return c.json(data);
});
