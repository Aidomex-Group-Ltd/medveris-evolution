import { Hono } from "hono";
import { aiJobSchema, uuidSchema } from "@medveris/contracts";
import { assertClinicalWrite } from "@medveris/authz";
import { contentDigest } from "@medveris/domain";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { runClinicalAi } from "../lib/ai.js";
import { requestActor, requestAudit } from "../lib/actor.js";
import { parseJson } from "../lib/http.js";
import { writeAudit } from "../lib/audit.js";
import { NotFoundError } from "../lib/errors.js";
import { assertIntegrationAvailable, isIntegrationAvailable } from "../integrations/registry.js";
import type { AppEnv } from "../types.js";

export const aiRoutes = new Hono<AppEnv>();

aiRoutes.get("/ai/jobs", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select j.*, p.public_id, p.given_name, p.family_name, u.display_name as created_by_name
      from ai_jobs j join patients p on p.id = j.patient_id join users u on u.id = j.created_by
     where j.tenant_id = ${auth.activeTenant!.id} order by j.created_at desc limit 100
  `);
  return c.json({ jobs: rows, configured: isIntegrationAvailable(c.get("deps").config, "ai") });
});

const AI_DISCLAIMER = "AI output is decision support only. It is not a diagnosis and must be reviewed by a qualified clinician.";

/**
 * The prompt carries the task and the shape of the request only: no patient identifiers, names or
 * clinical text leave the facility database, so a provider never receives PHI from this route.
 */
function clinicalPrompt(request: { taskType: string; evidenceEntryIds: string[]; studyId: string | null }): string {
  return [
    `TASK_TYPE: ${request.taskType}`,
    `EVIDENCE_ENTRY_COUNT: ${request.evidenceEntryIds.length}`,
    `STUDY_REFERENCE: ${request.studyId ? "provided" : "none"}`,
    "Draft a short summary for clinician review from the task type and evidence counts above.",
    "Do not invent patient facts, identifiers, measurements or diagnoses.",
  ].join("\n");
}

aiRoutes.post("/ai/jobs", async (c) => {
  requireStaff(c);
  assertClinicalWrite(requestActor(c));
  const deps = c.get("deps");
  assertIntegrationAvailable(deps.config, "ai", "ai.job.create",
    "no request was sent and no clinical inference was produced");
  const auth = c.get("auth")!;
  const body = await parseJson(c, aiJobSchema);
  const id = crypto.randomUUID();
  const studyId = body.studyId ?? null;
  await withStaffActor(c, async (tx) => {
    const linked = await tx`select 1 from tenant_patient_links where tenant_id = ${auth.activeTenant!.id} and patient_id = ${body.patientId}`;
    if (!linked[0]) throw new NotFoundError("Patient is not linked to this facility");
    const digest = await contentDigest({
      taskType: body.taskType, patientId: body.patientId, evidenceEntryIds: body.evidenceEntryIds, studyId,
    });
    await tx`
      insert into ai_jobs (id, tenant_id, patient_id, task_type, evidence_entry_ids, study_id, provider, model, status,
        request_digest, disclaimer, created_by)
      values (${id}, ${auth.activeTenant!.id}, ${body.patientId}, ${body.taskType}, ${body.evidenceEntryIds},
        ${studyId}, 'workers-ai', ${deps.config.aiModel.model}, 'running', ${digest}, ${AI_DISCLAIMER}, ${auth.user.id})
    `;
    await writeAudit(tx, deps.config, requestAudit(c, "ai.job.create", {
      subjectPatientId: body.patientId, resourceType: "AIJob", resourceId: id,
      metadata: { taskType: body.taskType, requestDigest: digest, evidenceCount: body.evidenceEntryIds.length },
    }));
  });
  const result = await runClinicalAi(deps, auth, {
    taskType: body.taskType,
    patientId: body.patientId,
    evidenceEntryIds: body.evidenceEntryIds,
    studyId,
    prompt: clinicalPrompt({ taskType: body.taskType, evidenceEntryIds: body.evidenceEntryIds, studyId }),
  });
  // Only the model's own text is stored. Provider errors stay in the log so a failure never leaks
  // upstream detail into the chart, and the job is marked failed instead.
  const status = result.ok ? "completed" : "failed";
  const responseSummary = result.ok ? (result.output?.text?.trim() || null) : null;
  const completedAt = new Date();
  await withStaffActor(c, async (tx) => {
    await tx`
      update ai_jobs set status = ${status}, provider = ${result.provider}, model = ${deps.config.aiModel.model},
        response_summary = ${responseSummary}, completed_at = ${completedAt}
       where id = ${id} and tenant_id = ${auth.activeTenant!.id}
    `;
  });
  return c.json({
    ok: true,
    job: { id, status, provider: result.provider, responseSummary, completedAt, disclaimer: AI_DISCLAIMER },
  }, 202);
});

aiRoutes.get("/ai/jobs/:id", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const job = await withStaffActor(c, async (tx) => {
    const rows = await tx`select * from ai_jobs where id = ${id} and tenant_id = ${auth.activeTenant!.id}`;
    return rows[0] ?? null;
  });
  if (!job) throw new NotFoundError("AI job not found");
  return c.json({ job, disclaimer: job.disclaimer });
});
