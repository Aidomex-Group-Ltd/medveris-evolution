import { Hono } from "hono";
import { z } from "zod";
import { aiJobSchema, uuidSchema } from "@medveris/contracts";
import { assertClinicalWrite } from "@medveris/authz";
import { contentDigest, detectRedFlag } from "@medveris/domain";
import { runAi } from "@medveris/ai";
import { requireStaff, withStaffActor, withActor, requireAuth } from "../auth/middleware.js";
import { requestActor, requestAudit } from "../lib/actor.js";
import { parseJson } from "../lib/http.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { DependencyError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { enforceRateLimit } from "../lib/rate-limit.js";
import { aiDependencies } from "../lib/ai.js";
import { assertIntegrationAvailable, isIntegrationOperational } from "../integrations/registry.js";
import type { AppConfig } from "../config.js";
import type { AppEnv } from "../types.js";

export const aiRoutes = new Hono<AppEnv>();

/** Provider string recorded on the job. "ollama" is used for both the sandbox and live Ollama
 * paths, because in both cases the inference is produced by an Ollama server; the job's `source`
 * column distinguishes sandbox from live when that matters for reporting. "workers-ai" remains the
 * fallback for a Cloudflare Workers AI binding when it is configured.
 */
function aiProvider(deps: { config: AppConfig }): string {
  // Live Ollama provider path takes precedence; sandbox path is next; otherwise Workers AI.
  if (deps.config.features.ai && deps.config.ai.baseUrl) return "ollama";
  if (deps.config.modes.ai === "sandbox") return "ollama";
  return "workers-ai";
}

aiRoutes.get("/ai/jobs", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select j.*, p.public_id, p.given_name, p.family_name, u.display_name as created_by_name
      from ai_jobs j join patients p on p.id = j.patient_id join users u on u.id = j.created_by
     where j.tenant_id = ${auth.activeTenant!.id} order by j.created_at desc limit 100
  `);
  return c.json({ jobs: rows, configured: isIntegrationOperational(c.get("deps").config, "ai") });
});

const AI_DISCLAIMER = "AI output is decision support only. It is not a diagnosis and must be reviewed by a qualified clinician.";

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
        ${studyId}, ${aiProvider(deps)}, ${deps.config.aiModel.model}, 'queued', ${digest}, ${AI_DISCLAIMER}, ${auth.user.id})
    `;
    await writeAudit(tx, deps.config, requestAudit(c, "ai.job.create", {
      subjectPatientId: body.patientId, resourceType: "AIJob", resourceId: id,
      metadata: { taskType: body.taskType, requestDigest: digest, evidenceCount: body.evidenceEntryIds.length },
    }));
    // Inference happens off the request path in the jobs runner; the outbox row is the authority.
    await writeOutbox(tx, {
      tenantId: auth.activeTenant!.id,
      eventType: "ai.job.requested",
      aggregateId: id,
      aggregateVersion: 1,
      payload: { jobId: id },
      idempotencyKey: `ai-job:${id}`,
    });
  });
  return c.json({
    ok: true,
    job: { id, status: "queued", provider: aiProvider(deps), responseSummary: null, completedAt: null, disclaimer: AI_DISCLAIMER },
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

// ----------------------------------------------------------------------------
// Role-aware AI assistant (Phase 12)
//
// One conversational surface, two audiences: patients (plain language, escalation
// always available) and clinical staff (concise decision support; the AI assists,
// the clinician decides). Mode is derived from the session, never trusted from the
// client. Red-flag content is intercepted deterministically BEFORE any model call
// and answered with a fixed, safe response; only turn metadata is audited.
// ----------------------------------------------------------------------------

const PROVIDER_MODE_ROLES = new Set(["nurse", "midwife", "clinician", "specialist_clinician", "pharmacist"]);

// Operator mode (added by the concurrent platform-ops session, 2026-11-13): terse system-observability
// assistant for platform operators/SREs. Eligibility is `auth.platformRoles`, never facility roles; patients
// and providers cannot reach it, and it refuses clinical content.

const aiChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(2000),
});
const aiChatSchema = z.object({
  messages: z.array(aiChatMessageSchema).min(1).max(40),
  mode: z.enum(["patient", "provider", "operator"]).optional(),
});

const PATIENT_SYSTEM_PROMPT = [
  "You are Medveris Intelligence, a careful health assistant for a patient using the Medveris patient portal.",
  "Rules you must always follow:",
  "- Never give a diagnosis, a prescription, or a medication change. You give general, plain-language health information only.",
  "- Use plain, warm language (about a 6th-8th grade reading level). Never be alarming, and never dismissive.",
  "- Ask one clarifying question at a time before giving general guidance.",
  "- Always remind the patient that this is not medical advice and they should talk to a clinician.",
  "- If something sounds urgent or worsening, tell the patient to contact a clinician or emergency services now.",
  "- If asked for a diagnosis, a test interpretation, or a medication decision, decline briefly and explain that a clinician must decide.",
  "- Keep answers under 180 words. Short paragraphs or bullet points only.",
].join("\n");

const PROVIDER_SYSTEM_PROMPT = [
  "You are Medveris Intelligence, decision support for a licensed healthcare provider. You assist; you never decide.",
  "Rules you must always follow:",
  "- Lead with the answer. Be concise and use standard clinical terminology.",
  "- State uncertainty explicitly. Never invent sources, citations, studies or capabilities. If unsure, say so.",
  "- Do not produce an autonomous diagnosis or medication change; frame all output as support for the provider's own judgment.",
  "- End with a one-line reminder to confirm in the patient record and follow facility protocols.",
  "- Keep answers under 220 words.",
].join("\n");

const PATIENT_DISCLAIMER = "This is not medical advice. Only a qualified clinician can diagnose, prescribe, or change treatment.";
const PROVIDER_DISCLAIMER = "Decision support only — verify against the patient record and clinical guidelines before acting.";

const CRISIS_REPLY = [
  "Thank you for telling me. This could be serious, so please treat it as urgent:",
  "call emergency services now (112 or 999) or go to the nearest health facility immediately. Do not wait for a reply here.",
  "If you are thinking about harming yourself, please contact emergency services or a crisis line right now.",
].join("\n");

aiRoutes.post("/ai/chat", async (c) => {
  const auth = requireAuth(c);
  const deps = c.get("deps");
  const body = await parseJson(c, aiChatSchema);

  const staffClinical = Boolean(auth.activeTenant)
    && (auth.activeTenant!.roles ?? []).some((role) => PROVIDER_MODE_ROLES.has(role));
  const isOperator = auth.platformRoles.includes("platform_operator");
  const requested = body.mode;
  let mode: "patient" | "provider" | "operator";
  if (requested === "provider" || (requested === undefined && staffClinical)) {
    if (!staffClinical) {
      throw new ForbiddenError("Provider mode requires an active clinical role (nurse, midwife, clinician, specialist clinician or pharmacist).");
    }
    requireStaff(c); // active facility + MFA, same as other staff-facing AI surfaces
    mode = "provider";
  } else if (requested === "operator" || (requested === undefined && isOperator)) {
    if (!isOperator) {
      throw new ForbiddenError("Operator mode requires a platform_operator role.");
    }
    mode = "operator";
  } else if (requested === "patient") {
    if (!auth.patientId && !staffClinical) {
      throw new ForbiddenError("Patient mode requires a verified patient account.");
    }
    mode = "patient";
  } else if (!auth.patientId) {
    throw new ForbiddenError("Patient mode requires a verified patient account.");
  } else {
    mode = "patient";
  }

  await enforceRateLimit(c, "ai.chat", auth.user.id);

  const reversed = [...body.messages].reverse();
  const lastUser = reversed.find((message) => message.role === "user");
  if (!lastUser) throw new ValidationError("At least one user message is required.");
  const redFlag = detectRedFlag(lastUser.content);

  await withActor(c, async (tx) => {
    await writeAudit(tx, deps.config, {
      actorKind: mode === "patient" ? "patient" : "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant?.roles ?? [],
      tenantId: auth.activeTenant?.id ?? null,
      subjectPatientId: auth.patientId ?? null,
      action: "ai.chat.turn",
      resourceType: "AIConversation",
      resourceId: crypto.randomUUID(),
      metadata: {
        mode,
        redFlag: Boolean(redFlag),
        redFlagCategory: redFlag?.category ?? null,
        messageCount: body.messages.length,
      },
    });
  });

  // Operator mode: terse technical disclaimer, AI refusal of clinical content
  const operatorDisclaimer = "AI output is decision support only for system operations. No clinical content is retrieved or summarized.";
  const operatorSystemPrompt = [
    "You are Medveris Intelligence, system observability assistant for platform operators and SREs.",
    "Rules you must always follow:",
    "- Lead with the answer. Be concise and use technical terminology.",
    "- Never retrieve, summarize, or generate clinical content, patient data, or clinical notes.",
    "- If asked about patient data, decline in one calm sentence and explain this is system-observability mode.",
    "- State uncertainty explicitly. Never invent sources, citations, studies or capabilities. If unsure, say so.",
    "- Keep answers under 150 words.",
  ].join("\n");
  const disclaimer = mode === "provider" ? PROVIDER_DISCLAIMER : PATIENT_DISCLAIMER;
  if (redFlag) {
    return c.json({
      message: CRISIS_REPLY,
      redFlag: true,
      redFlagCategory: redFlag.category,
      disclaimer: PATIENT_DISCLAIMER,
      provider: null,
      model: null,
    });
  }

  assertIntegrationAvailable(deps.config, "ai", "ai.chat",
    "no request was sent and no inference was produced");

  const transcript = body.messages
    .slice(0, -1)
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
    .join("\n")
    .slice(-6000);
  const prompt = transcript
    ? `Conversation so far:\n${transcript}\n\nUser's latest message:\n${lastUser.content}`
    : lastUser.content;

  // Operator mode: use operator system prompt that refuses clinical content
  const systemPrompt = mode === "operator" ? operatorSystemPrompt : (mode === "provider" ? PROVIDER_SYSTEM_PROMPT : PATIENT_SYSTEM_PROMPT);

  const result = await runAi(aiDependencies(deps), deps.config.aiModel, {
    model: deps.config.aiModel.model,
    system: systemPrompt,
    prompt,
    max_tokens: 512,
    temperature: mode === "operator" ? 0.1 : (mode === "provider" ? 0.2 : 0.3),
  }, {
    taskType: "chat.assistant",
    tenantId: auth.activeTenant?.id ?? null,
    patientId: auth.patientId ?? null,
    mode,
  });

  if (!result.ok) {
    throw new DependencyError(result.error?.message ?? "The AI assistant is unavailable right now. Please try again shortly.");
  }

  const responseText = result.output?.text ?? "";
  // Operator mode: strip any clinical content and add refusal microcopy if needed
  let finalText = responseText;
  if (mode === "operator") {
    // Ensure no clinical content slipped through - replace any patient-identifiable content
    finalText = responseText.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted email]");
    finalText = finalText.replace(/\b\d{3,9}([-.\s]\d{3,4})?\b/g, "[redacted phone]");
    finalText = finalText.replace(/\bPatient [A-Za-z]+/gi, "[redacted patient]");
    finalText = finalText.replace(/clinical note|diagnosis|prescription|medication/i, "[system data]");
  }
  return c.json({
    message: finalText,
    redFlag: false,
    redFlagCategory: null,
    disclaimer: mode === "operator" ? operatorDisclaimer : disclaimer,
    provider: result.provider,
    model: deps.config.aiModel.model,
    usage: result.usage ?? null,
    mode,
  });
});
