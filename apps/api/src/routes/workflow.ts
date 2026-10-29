import { Hono, type Context } from "hono";
import { hmacHex } from "@medveris/auth";
import {
  recommendationCreateSchema,
  recommendationTransitionSchema,
  recommendationUpdateSchema,
  supplyUsageSchema,
  supplyVoidSchema,
  uuidSchema,
  workQueueQuerySchema,
} from "@medveris/contracts";
import {
  canReadClinical,
  canReadRequestInstructions,
  canRecommend,
  canTakePayments,
  canWorkQueue,
  hasRole,
  queueDepartmentsFor,
  type ActorContext,
  type QueueDepartment,
} from "@medveris/authz";
import type { Tx } from "@medveris/db";
import {
  assertRecommendationTransition,
  canonicalJson,
  contentDigest,
  departmentForCategory,
  merkleRootOf,
  OPEN_RECOMMENDATION_STATUSES,
  primaryDepartmentForCategory,
  WORKFLOW_DEPARTMENTS,
  type RecommendationStatus,
  type WorkflowDepartment,
} from "@medveris/domain";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { ensureMatch, parseJson, parseQuery } from "../lib/http.js";
import { idempotencyKey, uniqueViolation } from "../lib/idempotency.js";
import type { AppEnv } from "../types.js";

export const workflowRoutes = new Hono<AppEnv>();

/** Roles that take part in a visit: front desk, clinicians, departments and the till. */
const VISIT_ROLES = [
  "receptionist", "nurse", "clinician", "specialist_clinician", "facility_admin", "finance",
  "laboratory", "radiology", "pharmacist", "theatre",
] as const;
const OPEN_ENCOUNTER_STATES = ["planned", "arrived", "triaged", "in-progress"];

/** Roles that follow whole visits; anyone else sees only the work sent to their own department. */
const WHOLE_VISIT_ROLES = ["receptionist", "nurse", "clinician", "specialist_clinician", "facility_admin", "finance"] as const;

function departmentOnly(actor: ActorContext): QueueDepartment[] | null {
  return hasRole(actor, ...WHOLE_VISIT_ROLES) ? null : queueDepartmentsFor(actor);
}

function requireVisitAccess(c: Context<AppEnv>): ActorContext {
  requireStaff(c);
  const actor = requestActor(c);
  if (!hasRole(actor, ...VISIT_ROLES)) throw new ForbiddenError("Your role does not take part in patient visits");
  return actor;
}

function tenantOf(c: Context<AppEnv>): string {
  return c.get("auth")!.activeTenant!.id;
}

/** The department a standalone laboratory, imaging centre or pharmacy runs, whose front desk may log walk-in requests. */
function workspaceDepartment(c: Context<AppEnv>): WorkflowDepartment | null {
  return primaryDepartmentForCategory(c.get("auth")!.activeTenant!.workspace?.serviceCategory ?? null);
}

function parseDepartment(value: string | undefined): WorkflowDepartment {
  if (!value || !(WORKFLOW_DEPARTMENTS as readonly string[]).includes(value)) throw new NotFoundError("Unknown department");
  return value as WorkflowDepartment;
}

interface RecommendationRow {
  id: string;
  encounterId: string;
  patientId: string;
  targetDepartment: WorkflowDepartment;
  departmentId: string | null;
  catalogItemId: string | null;
  description: string;
  quantity: string | number;
  priority: string;
  instructions: string | null;
  source: string;
  externalReferrer: string | null;
  status: RecommendationStatus;
  statusNote: string | null;
  billingStatus: string;
  version: number;
  createdAt: Date;
  createdBy: string;
  createdByName: string | null;
  updatedAt: Date;
  updatedByName?: string | null;
  completedAt: Date | null;
  completedByName?: string | null;
  unitPrice?: string | number | null;
  currency?: string | null;
  itemCode?: string | null;
}

/** Shapes a request for the caller: instructions only for clinicians and the receiving department, prices only for the till. */
function present(row: RecommendationRow, actor: ActorContext) {
  const department = row.targetDepartment as QueueDepartment;
  const showInstructions = canReadRequestInstructions(actor, department);
  return {
    id: row.id,
    encounterId: row.encounterId,
    patientId: row.patientId,
    department: row.targetDepartment,
    departmentId: row.departmentId,
    catalogItemId: row.catalogItemId,
    itemCode: row.itemCode ?? null,
    description: row.description,
    quantity: Number(row.quantity),
    priority: row.priority,
    instructions: showInstructions ? row.instructions : null,
    instructionsRestricted: !showInstructions && Boolean(row.instructions),
    source: row.source,
    externalReferrer: row.externalReferrer,
    status: row.status,
    statusNote: row.statusNote,
    billingStatus: row.billingStatus,
    version: Number(row.version),
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    createdByName: row.createdByName,
    updatedAt: row.updatedAt,
    updatedByName: row.updatedByName ?? null,
    completedAt: row.completedAt,
    completedByName: row.completedByName ?? null,
    unitPrice: canTakePayments(actor) && row.unitPrice != null ? Number(row.unitPrice) : null,
    currency: canTakePayments(actor) ? row.currency ?? null : null,
    canProgress: canWorkQueue(actor, department),
    canCancel: (canRecommend(actor) || row.createdBy === actor.userId) && ["requested", "accepted"].includes(row.status),
    canEdit: (canRecommend(actor) || row.createdBy === actor.userId) && row.status === "requested",
  };
}

const RECOMMENDATION_SELECT = (tx: Tx) => tx`
  r.id, r.encounter_id, r.patient_id, r.target_department, r.department_id, r.catalog_item_id, r.description, r.quantity, r.priority,
  r.instructions, r.source, r.external_referrer, r.status, r.status_note, r.billing_status, r.version, r.created_at, r.created_by,
  r.updated_at, r.completed_at, cu.display_name as created_by_name, uu.display_name as updated_by_name, ku.display_name as completed_by_name,
  s.price as unit_price, s.currency, s.code as item_code
`;

async function loadRecommendation(tx: Tx, tenantId: string, id: string, lock = false): Promise<RecommendationRow> {
  const rows = await tx`
    select ${RECOMMENDATION_SELECT(tx)}
      from care_recommendations r
      join users cu on cu.id = r.created_by
      left join users uu on uu.id = r.updated_by
      left join users ku on ku.id = r.completed_by
      left join service_catalog s on s.id = r.catalog_item_id
     where r.id = ${id} and r.tenant_id = ${tenantId}
     ${lock ? tx`for update of r` : tx``}
  `;
  return requireRows(rows as unknown as RecommendationRow[], "Request not found");
}

async function recordEvent(tx: Tx, c: Context<AppEnv>, input: {
  recommendationId: string; event: string; fromStatus?: string | null; toStatus?: string | null; note?: string | null; changes?: Record<string, unknown>;
}): Promise<void> {
  const auth = c.get("auth")!;
  await tx`
    insert into care_recommendation_events (id, tenant_id, recommendation_id, event, from_status, to_status, note, changes, actor_user_id, actor_roles)
    values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${input.recommendationId}, ${input.event}, ${input.fromStatus ?? null},
      ${input.toStatus ?? null}, ${input.note ?? null}, ${tx.json((input.changes ?? {}) as never)}, ${auth.user.id}, ${auth.activeTenant!.roles})
  `;
}

async function openEncounter(tx: Tx, tenantId: string, encounterId: string) {
  const encounter = await requireRows(await tx`
    select id, patient_id, state, reason from encounters where id = ${encounterId} and tenant_id = ${tenantId} for update
  `, "Visit not found");
  if (!OPEN_ENCOUNTER_STATES.includes(String(encounter.state))) {
    throw new ConflictError(`This visit is ${encounter.state}; requests can only be added to an open visit`);
  }
  return encounter;
}

// ---------------------------------------------------------------- visit workflow

workflowRoutes.get("/encounters/:id/workflow", async (c) => {
  const actor = requireVisitAccess(c);
  const tenantId = tenantOf(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const scoped = departmentOnly(actor);
  const data = await withStaffActor(c, async (tx) => {
    const encounter = await requireRows(await tx`
      select e.id, e.state, e.type, e.opened_at, e.closed_at, e.patient_id, p.public_id, p.given_name, p.family_name, p.date_of_birth, p.sex
        from encounters e join patients p on p.id = e.patient_id
       where e.id = ${id} and e.tenant_id = ${tenantId}
       ${scoped ? tx`and exists (select 1 from care_recommendations r where r.encounter_id = e.id and r.target_department = any(${scoped}::text[]))` : tx``}
    `, "Visit not found");
    const recommendations = await tx`
      select ${RECOMMENDATION_SELECT(tx)}
        from care_recommendations r
        join users cu on cu.id = r.created_by
        left join users uu on uu.id = r.updated_by
        left join users ku on ku.id = r.completed_by
        left join service_catalog s on s.id = r.catalog_item_id
       where r.encounter_id = ${id} and r.tenant_id = ${tenantId}
         ${scoped ? tx`and r.target_department = any(${scoped}::text[])` : tx``}
       order by r.created_at
    `;
    const supplies = await tx`
      select su.id, su.recommendation_id, su.catalog_item_id, s.name, s.code, s.item_type, s.price, s.currency, su.quantity, su.note,
             su.billing_status, su.recorded_at, u.display_name as recorded_by_name, su.voided_at, su.void_reason
        from care_supply_usages su join service_catalog s on s.id = su.catalog_item_id join users u on u.id = su.recorded_by
       where su.encounter_id = ${id} and su.tenant_id = ${tenantId}
       order by su.recorded_at
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "visit.workflow.read", {
      subjectPatientId: String(encounter.patientId), resourceType: "Encounter", resourceId: id,
    }));
    return { encounter, recommendations, supplies };
  });
  const cashier = canTakePayments(actor);
  return c.json({
    encounter: {
      id: data.encounter.id, state: data.encounter.state, type: data.encounter.type, openedAt: data.encounter.openedAt, closedAt: data.encounter.closedAt,
      patient: {
        id: data.encounter.patientId, publicId: data.encounter.publicId, givenName: data.encounter.givenName, familyName: data.encounter.familyName,
        dateOfBirth: data.encounter.dateOfBirth, sex: data.encounter.sex,
      },
    },
    recommendations: (data.recommendations as unknown as RecommendationRow[]).map((row) => present(row, actor)),
    supplies: data.supplies.map((row) => ({
      id: row.id, recommendationId: row.recommendationId, catalogItemId: row.catalogItemId, name: row.name, code: row.code, itemType: row.itemType,
      quantity: Number(row.quantity), note: row.note, billingStatus: row.billingStatus, recordedAt: row.recordedAt, recordedByName: row.recordedByName,
      voidedAt: row.voidedAt, voidReason: row.voidReason,
      unitPrice: cashier ? Number(row.price) : null, currency: cashier ? row.currency : null,
    })),
    permissions: {
      recommend: canRecommend(actor) && OPEN_ENCOUNTER_STATES.includes(String(data.encounter.state)),
      directRequestDepartments: OPEN_ENCOUNTER_STATES.includes(String(data.encounter.state)) ? directDepartments(c, actor) : [],
      recordSupplies: queueDepartmentsFor(actor).length > 0,
      bill: cashier,
    },
  });
});

/** Departments the caller may log a request for without a consultation: their own queue, or the unit's front desk. */
function directDepartments(c: Context<AppEnv>, actor: ActorContext): WorkflowDepartment[] {
  if (canRecommend(actor)) return [...WORKFLOW_DEPARTMENTS];
  const own = new Set<WorkflowDepartment>(queueDepartmentsFor(actor).filter((department) => department !== "procedure" && department !== "other"));
  const unit = workspaceDepartment(c);
  if (unit && hasRole(actor, "receptionist", "facility_admin")) own.add(unit);
  return [...own];
}

workflowRoutes.post("/encounters/:id/recommendations", async (c) => {
  const actor = requireVisitAccess(c);
  const auth = c.get("auth")!;
  const tenantId = tenantOf(c);
  const encounterId = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, recommendationCreateSchema);
  const key = idempotencyKey(c);
  const consultation = canRecommend(actor);
  if (!consultation && !directDepartments(c, actor).includes(body.department)) {
    throw new ForbiddenError("Only a clinician can recommend work for another department");
  }
  const id = crypto.randomUUID();
  const replay = async () => {
    if (!key) return null;
    const [existing] = await withStaffActor(c, async (tx) => tx`
      select id, encounter_id from care_recommendations where tenant_id = ${tenantId} and idempotency_key = ${key}
    `);
    if (!existing) return null;
    if (existing.encounterId !== encounterId) throw new ConflictError("This Idempotency-Key was already used for another visit");
    return String(existing.id);
  };
  const replayed = await replay();
  if (replayed) {
    const row = await withStaffActor(c, (tx) => loadRecommendation(tx, tenantId, replayed));
    return c.json({ ok: true, recommendation: present(row, actor), replayed: true }, 200);
  }
  try {
    await withStaffActor(c, async (tx) => {
      const encounter = await openEncounter(tx, tenantId, encounterId);
      let description = body.description?.trim() ?? "";
      if (body.catalogItemId) {
        const item = await requireRows(await tx`
          select id, name, category, active from service_catalog where id = ${body.catalogItemId} and tenant_id = ${tenantId}
        `, "Price-list item not found");
        if (!item.active) throw new ValidationError("This price-list item is inactive; choose another or ask finance to reactivate it");
        const itemDepartment = departmentForCategory(String(item.category));
        if (itemDepartment !== body.department && itemDepartment !== "other") {
          throw new ValidationError(`${item.name} is a ${itemDepartment} item; send it to that department`);
        }
        description ||= String(item.name);
      }
      if (description.length < 2) throw new ValidationError("Describe the requested service or procedure, or choose it from the price list");
      if (body.departmentId) {
        await requireRows(await tx`select id from departments where id = ${body.departmentId} and tenant_id = ${tenantId}`, "Department not found");
      }
      await tx`
        insert into care_recommendations (id, tenant_id, patient_id, encounter_id, target_department, department_id, catalog_item_id, description,
          quantity, priority, instructions, source, external_referrer, idempotency_key, created_by, updated_by)
        values (${id}, ${tenantId}, ${encounter.patientId}, ${encounterId}, ${body.department}, ${body.departmentId ?? null},
          ${body.catalogItemId ?? null}, ${description}, ${body.quantity}, ${body.priority}, ${body.instructions || null},
          ${consultation ? "consultation" : "direct-request"}, ${body.externalReferrer || null}, ${key}, ${auth.user.id}, ${auth.user.id})
      `;
      await recordEvent(tx, c, { recommendationId: id, event: "created", toStatus: "requested", note: body.instructions || null });
      await writeAudit(tx, c.get("deps").config, requestAudit(c, "care.recommendation.create", {
        subjectPatientId: String(encounter.patientId), resourceType: "CareRecommendation", resourceId: id,
        metadata: { encounterId, department: body.department, catalogItemId: body.catalogItemId ?? null, priority: body.priority, source: consultation ? "consultation" : "direct-request" },
      }));
      await writeOutbox(tx, { tenantId, eventType: "care.recommendation.created", aggregateId: id, aggregateVersion: 1, payload: { encounterId, department: body.department } });
    });
  } catch (error) {
    const constraint = uniqueViolation(error);
    if (constraint === "care_recommendations_idempotency") {
      const raced = await replay();
      if (raced) {
        const row = await withStaffActor(c, (tx) => loadRecommendation(tx, tenantId, raced));
        return c.json({ ok: true, recommendation: present(row, actor), replayed: true }, 200);
      }
    }
    if (constraint === "care_recommendations_open_item" || constraint === "care_recommendations_open_text") {
      throw new ConflictError("This has already been requested for this visit and is still open. Update the existing request instead.");
    }
    throw error;
  }
  const row = await withStaffActor(c, (tx) => loadRecommendation(tx, tenantId, id));
  return c.json({ ok: true, recommendation: present(row, actor) }, 201);
});

workflowRoutes.get("/recommendations/:id", async (c) => {
  const actor = requireVisitAccess(c);
  const tenantId = tenantOf(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const data = await withStaffActor(c, async (tx) => {
    const row = await loadRecommendation(tx, tenantId, id);
    const events = await tx`
      select e.id, e.event, e.from_status, e.to_status, e.note, e.changes, e.occurred_at, e.actor_roles, u.display_name as actor_name
        from care_recommendation_events e left join users u on u.id = e.actor_user_id
       where e.recommendation_id = ${id} and e.tenant_id = ${tenantId}
       order by e.occurred_at, e.id
    `;
    return { row, events };
  });
  const showNotes = canReadRequestInstructions(actor, data.row.targetDepartment as QueueDepartment);
  return c.json({
    recommendation: present(data.row, actor),
    events: data.events.map((event) => ({
      id: event.id, event: event.event, fromStatus: event.fromStatus, toStatus: event.toStatus,
      note: showNotes || ["declined", "cancelled"].includes(String(event.toStatus)) ? event.note : null,
      changes: event.changes, occurredAt: event.occurredAt, actorName: event.actorName, actorRoles: event.actorRoles,
    })),
  });
});

workflowRoutes.patch("/recommendations/:id", async (c) => {
  const actor = requireVisitAccess(c);
  const auth = c.get("auth")!;
  const tenantId = tenantOf(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, recommendationUpdateSchema);
  await withStaffActor(c, async (tx) => {
    const row = await loadRecommendation(tx, tenantId, id, true);
    if (!canRecommend(actor) && row.createdBy !== actor.userId) throw new ForbiddenError("Only the requesting clinician can change this request");
    ensureMatch(body.expectedVersion, Number(row.version));
    if (row.status !== "requested") throw new ConflictError(`The department has already ${row.status === "accepted" ? "accepted" : "started"} this request; cancel and re-request instead`);
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (body.priority && body.priority !== row.priority) changes.priority = { from: row.priority, to: body.priority };
    if (body.quantity != null && body.quantity !== Number(row.quantity)) {
      if (row.billingStatus !== "unbilled") throw new ConflictError("This request is already on a bill; ask the cashier to remove it before changing the quantity");
      changes.quantity = { from: Number(row.quantity), to: body.quantity };
    }
    if (body.instructions !== undefined && (body.instructions || null) !== row.instructions) changes.instructions = { from: row.instructions ? "previous text" : null, to: body.instructions ? "updated text" : null };
    if (!Object.keys(changes).length) return;
    await tx`
      update care_recommendations set
        priority = ${body.priority ?? row.priority},
        quantity = ${body.quantity ?? Number(row.quantity)},
        instructions = ${body.instructions !== undefined ? body.instructions || null : row.instructions},
        version = version + 1, updated_by = ${auth.user.id}, updated_at = now()
       where id = ${id}
    `;
    await recordEvent(tx, c, { recommendationId: id, event: "updated", fromStatus: row.status, toStatus: row.status, changes });
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "care.recommendation.update", {
      subjectPatientId: row.patientId, resourceType: "CareRecommendation", resourceId: id, metadata: { fields: Object.keys(changes) },
    }));
  });
  const row = await withStaffActor(c, (tx) => loadRecommendation(tx, tenantId, id));
  return c.json({ ok: true, recommendation: present(row, actor) });
});

workflowRoutes.post("/recommendations/:id/transitions", async (c) => {
  const actor = requireVisitAccess(c);
  const auth = c.get("auth")!;
  const tenantId = tenantOf(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, recommendationTransitionSchema);
  const note = body.note?.trim() || null;
  await withStaffActor(c, async (tx) => {
    const row = await loadRecommendation(tx, tenantId, id, true);
    ensureMatch(body.expectedVersion, Number(row.version));
    const department = row.targetDepartment as QueueDepartment;
    const requesterSide = body.status === "cancelled";
    if (requesterSide && !canRecommend(actor) && row.createdBy !== actor.userId) throw new ForbiddenError("Only the requesting clinician can cancel this request");
    if (!requesterSide && !canWorkQueue(actor, department)) throw new ForbiddenError(`Only ${department} staff can update this request`);
    assertRecommendationTransition(row.status, body.status, requesterSide ? "requester" : "department");
    if ((body.status === "cancelled" || body.status === "declined") && (!note || note.length < 3)) {
      throw new ValidationError("Give a reason so the requester and reception know why");
    }
    if ((body.status === "cancelled" || body.status === "declined") && row.billingStatus !== "unbilled") {
      throw new ConflictError(row.billingStatus === "billed"
        ? "This request is on an unpaid bill. Ask the cashier to remove it from the bill first."
        : "This request has been paid. Ask the cashier to reverse or refund the payment first.");
    }
    await tx`
      update care_recommendations set
        status = ${body.status}, status_note = ${note ?? row.statusNote}, version = version + 1, updated_by = ${auth.user.id}, updated_at = now(),
        accepted_by = case when ${body.status}::text = 'accepted' then ${auth.user.id}::uuid else accepted_by end,
        accepted_at = case when ${body.status}::text = 'accepted' then now() else accepted_at end,
        started_at = case when ${body.status}::text = 'in-progress' then now() else started_at end,
        completed_by = case when ${body.status}::text = 'completed' then ${auth.user.id}::uuid else completed_by end,
        completed_at = case when ${body.status}::text = 'completed' then now() else completed_at end
       where id = ${id}
    `;
    await recordEvent(tx, c, { recommendationId: id, event: "status-changed", fromStatus: row.status, toStatus: body.status, note });
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "care.recommendation.transition", {
      subjectPatientId: row.patientId, resourceType: "CareRecommendation", resourceId: id,
      metadata: { from: row.status, to: body.status, department },
    }));
    await writeOutbox(tx, {
      tenantId, eventType: "care.recommendation.status-changed", aggregateId: id, aggregateVersion: Number(row.version) + 1,
      payload: { from: row.status, to: body.status, department },
    });
  });
  const row = await withStaffActor(c, (tx) => loadRecommendation(tx, tenantId, id));
  return c.json({ ok: true, recommendation: present(row, actor) });
});

// ---------------------------------------------------------------- department work queues

workflowRoutes.get("/work-queues", async (c) => {
  const actor = requireVisitAccess(c);
  const tenantId = tenantOf(c);
  const own = queueDepartmentsFor(actor);
  const overview = hasRole(actor, "facility_admin", "clinician", "specialist_clinician");
  const rows = await withStaffActor(c, async (tx) => tx`
    select target_department, status, count(*)::int as count,
           count(*) filter (where priority = 'emergency')::int as emergency,
           count(*) filter (where priority = 'urgent')::int as urgent
      from care_recommendations
     where tenant_id = ${tenantId} and (status = any(${[...OPEN_RECOMMENDATION_STATUSES]}::text[]) or (status = 'completed' and completed_at >= date_trunc('day', now())))
     group by target_department, status
  `);
  const departments = WORKFLOW_DEPARTMENTS.filter((department) => own.includes(department) || overview).map((department) => {
    const counts = rows.filter((row) => row.targetDepartment === department);
    const count = (status: string) => counts.filter((row) => row.status === status).reduce((sum, row) => sum + Number(row.count), 0);
    return {
      department,
      canWork: own.includes(department),
      requested: count("requested"),
      accepted: count("accepted"),
      inProgress: count("in-progress"),
      completedToday: count("completed"),
      emergency: counts.filter((row) => row.status !== "completed").reduce((sum, row) => sum + Number(row.emergency), 0),
      urgent: counts.filter((row) => row.status !== "completed").reduce((sum, row) => sum + Number(row.urgent), 0),
    };
  });
  return c.json({ departments, unitDepartment: workspaceDepartment(c) });
});

workflowRoutes.get("/work-queues/:department", async (c) => {
  const actor = requireVisitAccess(c);
  const tenantId = tenantOf(c);
  const department = parseDepartment(c.req.param("department"));
  if (!canWorkQueue(actor, department) && !hasRole(actor, "clinician", "specialist_clinician")) {
    throw new ForbiddenError(`The ${department} work queue is for ${department} staff`);
  }
  const query = parseQuery(c, workQueueQuerySchema);
  const statuses = query.status === "open" ? [...OPEN_RECOMMENDATION_STATUSES]
    : query.status === "completed" ? ["completed"]
      : query.status === "closed" ? ["completed", "declined", "cancelled"]
        : ["requested", "accepted", "in-progress", "completed", "declined", "cancelled"];
  const rows = await withStaffActor(c, async (tx) => {
    const found = await tx`
      select ${RECOMMENDATION_SELECT(tx)},
             p.public_id, p.given_name, p.family_name, p.date_of_birth, p.sex,
             e.state as encounter_state, e.reason as encounter_reason, e.opened_at as encounter_opened_at
        from care_recommendations r
        join users cu on cu.id = r.created_by
        left join users uu on uu.id = r.updated_by
        left join users ku on ku.id = r.completed_by
        left join service_catalog s on s.id = r.catalog_item_id
        join patients p on p.id = r.patient_id
        join encounters e on e.id = r.encounter_id
       where r.tenant_id = ${tenantId} and r.target_department = ${department} and r.status = any(${statuses}::text[])
       order by case r.status when 'in-progress' then 0 when 'accepted' then 1 when 'requested' then 2 else 3 end,
                case r.priority when 'emergency' then 0 when 'urgent' then 1 else 2 end,
                case when r.status in ('completed','declined','cancelled') then extract(epoch from r.updated_at) * -1 else extract(epoch from r.created_at) end
       limit ${query.limit}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "work-queue.read", { resourceType: "WorkQueue", metadata: { department, status: query.status, count: found.length } }));
    return found;
  });
  const showReason = canReadClinical(actor) || canWorkQueue(actor, department);
  return c.json({
    department,
    canWork: canWorkQueue(actor, department),
    items: rows.map((row) => ({
      ...present(row as unknown as RecommendationRow, actor),
      patient: { id: row.patientId, publicId: row.publicId, givenName: row.givenName, familyName: row.familyName, dateOfBirth: row.dateOfBirth, sex: row.sex },
      visit: { id: row.encounterId, state: row.encounterState, reason: showReason ? row.encounterReason : null, openedAt: row.encounterOpenedAt },
    })),
  });
});

// ---------------------------------------------------------------- supplied items

workflowRoutes.post("/encounters/:id/supplies", async (c) => {
  const actor = requireVisitAccess(c);
  const auth = c.get("auth")!;
  const tenantId = tenantOf(c);
  const encounterId = uuidSchema.parse(c.req.param("id"));
  if (!queueDepartmentsFor(actor).length) throw new ForbiddenError("Department, nursing or clinical staff record supplied items");
  const body = await parseJson(c, supplyUsageSchema);
  const key = idempotencyKey(c);
  if (key) {
    const [existing] = await withStaffActor(c, async (tx) => tx`select id from care_supply_usages where tenant_id = ${tenantId} and idempotency_key = ${key}`);
    if (existing) return c.json({ ok: true, supply: { id: String(existing.id) }, replayed: true }, 200);
  }
  const id = crypto.randomUUID();
  try {
    await withStaffActor(c, async (tx) => {
      const encounter = await requireRows(await tx`select id, patient_id, state from encounters where id = ${encounterId} and tenant_id = ${tenantId} for update`, "Visit not found");
      if (["cancelled", "entered-in-error"].includes(String(encounter.state))) throw new ConflictError(`This visit is ${encounter.state}`);
      const scoped = departmentOnly(actor);
      if (scoped) {
        const [related] = await tx`select 1 from care_recommendations where encounter_id = ${encounterId} and target_department = any(${scoped}::text[]) limit 1`;
        if (!related) throw new NotFoundError("Visit not found");
      }
      const item = await requireRows(await tx`select id, name, active from service_catalog where id = ${body.catalogItemId} and tenant_id = ${tenantId}`, "Price-list item not found");
      if (!item.active) throw new ValidationError("This item is inactive on the price list");
      if (body.recommendationId) {
        const recommendation = await requireRows(await tx`select id, target_department from care_recommendations where id = ${body.recommendationId} and encounter_id = ${encounterId} and tenant_id = ${tenantId}`, "Request not found on this visit");
        if (!canWorkQueue(actor, recommendation.targetDepartment as QueueDepartment) && !canReadClinical(actor)) {
          throw new ForbiddenError("Record supplies against your own department's requests");
        }
      }
      await tx`
        insert into care_supply_usages (id, tenant_id, patient_id, encounter_id, recommendation_id, catalog_item_id, quantity, note, idempotency_key, recorded_by)
        values (${id}, ${tenantId}, ${encounter.patientId}, ${encounterId}, ${body.recommendationId ?? null}, ${body.catalogItemId}, ${body.quantity},
          ${body.note || null}, ${key}, ${auth.user.id})
      `;
      await writeAudit(tx, c.get("deps").config, requestAudit(c, "care.supply.record", {
        subjectPatientId: String(encounter.patientId), resourceType: "SupplyUsage", resourceId: id,
        metadata: { encounterId, catalogItemId: body.catalogItemId, quantity: body.quantity, recommendationId: body.recommendationId ?? null },
      }));
    });
  } catch (error) {
    if (uniqueViolation(error) === "care_supply_usages_idempotency") {
      const [existing] = await withStaffActor(c, async (tx) => tx`select id from care_supply_usages where tenant_id = ${tenantId} and idempotency_key = ${key}`);
      if (existing) return c.json({ ok: true, supply: { id: String(existing.id) }, replayed: true }, 200);
    }
    throw error;
  }
  return c.json({ ok: true, supply: { id } }, 201);
});

workflowRoutes.post("/supplies/:id/void", async (c) => {
  const actor = requireVisitAccess(c);
  const auth = c.get("auth")!;
  const tenantId = tenantOf(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, supplyVoidSchema);
  await withStaffActor(c, async (tx) => {
    const supply = await requireRows(await tx`select id, patient_id, recorded_by, billing_status, voided_at from care_supply_usages where id = ${id} and tenant_id = ${tenantId} for update`, "Supplied item not found");
    if (supply.voidedAt) throw new ConflictError("This supplied item is already voided");
    if (supply.recordedBy !== auth.user.id && !hasRole(actor, "facility_admin")) throw new ForbiddenError("Only the person who recorded it, or a facility administrator, can void it");
    if (supply.billingStatus !== "unbilled") throw new ConflictError("This item is on a bill. Ask the cashier to remove it from the bill first.");
    await tx`update care_supply_usages set voided_at = now(), voided_by = ${auth.user.id}, void_reason = ${body.reason} where id = ${id}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "care.supply.void", {
      subjectPatientId: String(supply.patientId), resourceType: "SupplyUsage", resourceId: id, metadata: { reason: body.reason },
    }));
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- reception visit board

workflowRoutes.get("/visits/board", async (c) => {
  const actor = requireVisitAccess(c);
  const tenantId = tenantOf(c);
  const cashier = canTakePayments(actor);
  const scoped = departmentOnly(actor);
  const rows = await withStaffActor(c, async (tx) => tx`
    select e.id, e.state, e.type, e.opened_at, e.closed_at, e.patient_id, p.public_id, p.given_name, p.family_name, p.date_of_birth, p.sex,
           coalesce(r.requested, 0) as requested, coalesce(r.active, 0) as active, coalesce(r.completed, 0) as completed,
           coalesce(r.closed, 0) as closed, coalesce(r.unbilled, 0) as unbilled_requests, coalesce(r.unpaid, 0) as unpaid_requests,
           coalesce(r.paid, 0) as paid_requests, coalesce(su.unbilled, 0) as unbilled_supplies,
           r.departments
      from encounters e
      join patients p on p.id = e.patient_id
      left join lateral (
        select count(*) filter (where status = 'requested')::int as requested,
               count(*) filter (where status in ('accepted','in-progress'))::int as active,
               count(*) filter (where status = 'completed')::int as completed,
               count(*) filter (where status in ('declined','cancelled'))::int as closed,
               count(*) filter (where billing_status = 'unbilled' and status not in ('declined','cancelled'))::int as unbilled,
               count(*) filter (where billing_status in ('billed','part-paid'))::int as unpaid,
               count(*) filter (where billing_status = 'paid')::int as paid,
               array_agg(distinct target_department) filter (where status in ('requested','accepted','in-progress')) as departments
          from care_recommendations where encounter_id = e.id and tenant_id = e.tenant_id
      ) r on true
      left join lateral (
        select count(*) filter (where billing_status = 'unbilled' and voided_at is null)::int as unbilled
          from care_supply_usages where encounter_id = e.id and tenant_id = e.tenant_id
      ) su on true
     where e.tenant_id = ${tenantId}
       and (e.state in ('planned','arrived','triaged','in-progress') or e.closed_at >= date_trunc('day', now()) or e.opened_at >= date_trunc('day', now()))
       ${scoped ? tx`and exists (select 1 from care_recommendations q where q.encounter_id = e.id and q.target_department = any(${scoped}::text[]))` : tx``}
     order by case when e.state in ('planned','arrived','triaged','in-progress') then 0 else 1 end, e.opened_at desc
     limit 100
  `);
  const balances = cashier && rows.length
    ? await withStaffActor(c, async (tx) => tx`
        select i.encounter_id,
               sum(coalesce((select sum(ii.amount) from invoice_items ii where ii.invoice_id = i.id), 0)) as total,
               sum(coalesce((select sum(pm.amount) from payments pm where pm.invoice_id = i.id and pm.reversed_at is null), 0)) as paid
          from invoices i
         where i.tenant_id = ${tenantId} and i.status <> 'void' and i.encounter_id = any(${rows.map((row) => String(row.id))}::uuid[])
         group by i.encounter_id
      `)
    : [];
  return c.json({
    visits: rows.map((row) => {
      const balance = balances.find((entry) => entry.encounterId === row.id);
      return {
        id: row.id, state: row.state, type: row.type, openedAt: row.openedAt, closedAt: row.closedAt,
        patient: { id: row.patientId, publicId: row.publicId, givenName: row.givenName, familyName: row.familyName, dateOfBirth: row.dateOfBirth, sex: row.sex },
        requests: {
          requested: Number(row.requested), active: Number(row.active), completed: Number(row.completed), closed: Number(row.closed),
          departments: (row.departments as string[] | null) ?? [],
        },
        billing: {
          unbilledRequests: Number(row.unbilledRequests), unpaidRequests: Number(row.unpaidRequests), paidRequests: Number(row.paidRequests),
          unbilledSupplies: Number(row.unbilledSupplies),
          total: balance ? Number(balance.total) : null,
          paid: balance ? Number(balance.paid) : null,
          balance: balance ? Number(balance.total) - Number(balance.paid) : null,
        },
      };
    }),
    canBill: cashier,
  });
});

// ---------------------------------------------------------------- consultation note integrity

/**
 * Tamper evidence for a consultation note: each version's content digest is recomputed, and each audit event
 * about the note is located in its signed Merkle checkpoint, whose root and signature are recomputed. External
 * ledger anchoring is reported as recorded; nothing is claimed beyond it.
 */
workflowRoutes.get("/entries/:id/integrity", async (c) => {
  requireStaff(c);
  const actor = requestActor(c);
  if (!canReadClinical(actor)) throw new ForbiddenError("A clinical role is required to read note integrity");
  const tenantId = tenantOf(c);
  const config = c.get("deps").config;
  const entryId = uuidSchema.parse(c.req.param("id"));
  const data = await withStaffActor(c, async (tx) => {
    const versions = await tx`
      select version, status, content, content_digest, signed_at, recorded_at, signature_key_id, (signature is not null) as signed
        from clinical_entry_versions where entry_id = ${entryId} and tenant_id = ${tenantId} order by version
    `;
    if (!versions.length) throw new NotFoundError("Clinical note not found");
    const events = await tx`select * from app.clinical_entry_integrity(${entryId})`;
    const checkpointIds = [...new Set(events.map((event) => event.checkpointId).filter(Boolean).map(String))];
    const checkpoints = checkpointIds.length
      ? await tx`select * from integrity_checkpoints where tenant_id = ${tenantId} and id = any(${checkpointIds}::uuid[]) order by batch_number`
      : [];
    const leaves = new Map<string, Array<{ id: string; eventHash: string }>>();
    for (const checkpoint of checkpoints) {
      const rows = await tx`select id, event_hash from app.integrity_checkpoint_leaves(${checkpoint.id})`;
      leaves.set(String(checkpoint.id), rows.map((row) => ({ id: String(row.id), eventHash: String(row.eventHash) })));
    }
    const anchors = checkpointIds.length
      ? await tx`select checkpoint_id, adapter, state, network, transaction_ref, confirmed_at from ledger_anchors where checkpoint_id = any(${checkpointIds}::uuid[])`
      : [];
    await writeAudit(tx, config, requestAudit(c, "clinical.entry.integrity.read", { resourceType: "ClinicalEntry", resourceId: entryId }));
    return { versions, events, checkpoints, leaves, anchors };
  });
  const versionResults = [];
  for (const version of data.versions) {
    const recomputed = await contentDigest(version.content);
    versionResults.push({
      version: Number(version.version), status: version.status, signedAt: version.signedAt, recordedAt: version.recordedAt,
      storedDigest: version.contentDigest, recomputedDigest: recomputed, contentMatches: recomputed === version.contentDigest, signed: Boolean(version.signed),
    });
  }
  const checkpointResults = [];
  for (const checkpoint of data.checkpoints) {
    const leaves = data.leaves.get(String(checkpoint.id)) ?? [];
    const recomputedRoot = await merkleRootOf(leaves);
    const payload = {
      tenantId, batchNumber: Number(checkpoint.batchNumber), eventCount: Number(checkpoint.eventCount),
      rangeStart: new Date(checkpoint.rangeStart).toISOString(), rangeEnd: new Date(checkpoint.rangeEnd).toISOString(),
      merkleRoot: checkpoint.merkleRoot, previousCheckpointHash: checkpoint.previousCheckpointHash ?? null,
      keyId: checkpoint.signatureKeyId, algorithm: checkpoint.algorithm,
    };
    const verifiableKey = checkpoint.signatureKeyId === config.auditSigningKeyId;
    const signatureValid = verifiableKey ? (await hmacHex(config.auditSigningKey, canonicalJson(payload))) === checkpoint.signature : null;
    const anchor = data.anchors.find((row) => row.checkpointId === checkpoint.id);
    // A different leaf count means an event committed inside the range after the checkpoint was taken; the root cannot be compared.
    const comparable = leaves.length === Number(checkpoint.eventCount);
    checkpointResults.push({
      batchNumber: Number(checkpoint.batchNumber), eventCount: Number(checkpoint.eventCount), createdAt: checkpoint.createdAt,
      merkleRoot: checkpoint.merkleRoot, rootMatches: comparable ? recomputedRoot === checkpoint.merkleRoot : null,
      signatureKeyId: checkpoint.signatureKeyId, signatureValid,
      ledgerState: checkpoint.ledgerState,
      anchor: anchor ? { adapter: anchor.adapter, state: anchor.state, network: anchor.network, transactionRef: anchor.transactionRef, confirmedAt: anchor.confirmedAt } : null,
    });
  }
  const events = data.events.map((event) => ({
    eventId: event.eventId, action: event.action, occurredAt: event.occurredAt, eventHash: event.eventHash, previousHash: event.previousHash,
    checkpointBatch: event.batchNumber == null ? null : Number(event.batchNumber),
  }));
  return c.json({
    entryId,
    versions: versionResults,
    events,
    checkpoints: checkpointResults,
    summary: {
      contentIntact: versionResults.every((version) => version.contentMatches),
      eventsCheckpointed: events.filter((event) => event.checkpointBatch != null).length,
      eventsAwaitingCheckpoint: events.filter((event) => event.checkpointBatch == null).length,
      checkpointsVerified: checkpointResults.every((checkpoint) => checkpoint.rootMatches !== false && checkpoint.signatureValid !== false),
      externallyAnchored: checkpointResults.some((checkpoint) => checkpoint.anchor?.state === "confirmed"),
    },
  });
});
