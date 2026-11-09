import { afterAll, describe, expect, it } from "vitest";
import type { AiRunInput } from "@medveris/ai";
import { createSql } from "@medveris/db";
import { handleEvent } from "../../apps/jobs/src/queue.js";
import { aiAwareDispatch, type AiJobRuntime } from "../../apps/jobs/src/ai.js";
import { KAMPALA_TENANT, KAMPALA_FACILITY_SLUG, createHarness } from "./support.js";

let behaviour: "ok" | "fail" = "ok";
const prompts: string[] = [];

const h = createHarness("ai-jobs", {
  env: { FEATURE_AI: "true", AI_MODE: "sandbox", OLLAMA_URL: "http://localhost:11434", AI_MODEL: "@cf/test/model" },
});
const jobsDatabaseUrl = process.env.JOBS_DATABASE_URL ?? process.env.DATABASE_URL;
if (!jobsDatabaseUrl) throw new Error("JOBS_DATABASE_URL or DATABASE_URL is required");
const jobsSql = createSql(jobsDatabaseUrl, { max: 2 });

const runtime: AiJobRuntime = {
  ai: {
    run: async (input: AiRunInput) => {
      prompts.push(input.prompt);
      if (behaviour === "fail") throw new Error("upstream model unavailable");
      return { text: "Synthetic summary for clinician review", usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 } };
    },
  },
  providerName: "workers-ai",
  modelConfig: { provider: "workers-ai", model: "@cf/test/model", inputTokensMax: 4096, timeoutMs: 1000 },
  logAiRun: () => undefined,
  source: "workers-ai",
};

const pump = async (jobId: string): Promise<number> => {
  // Claim exactly this job's outbox event; the shared test database may hold other tenants' events.
  const rows = await jobsSql`
    update outbox_events set status = 'processing', attempt_count = attempt_count + 1, claimed_at = now()
     where id = (select id from outbox_events where status = 'pending' and aggregate_id = ${jobId}::uuid order by occurred_at limit 1)
     returning id, tenant_id, event_type, aggregate_id, aggregate_version, payload, attempt_count`;
  const row = rows[0];
  if (!row) return 0;
  await handleEvent(
    { sql: jobsSql, dlq: null, realtime: null, realtimeEventTypes: [], dispatch: aiAwareDispatch(jobsSql, runtime) },
    {
      id: String(row.id),
      tenantId: row.tenantId == null ? null : String(row.tenantId),
      eventType: String(row.eventType),
      aggregateId: row.aggregateId == null ? null : String(row.aggregateId),
      aggregateVersion: row.aggregateVersion == null ? null : Number(row.aggregateVersion),
      payload: (row.payload ?? {}) as Record<string, unknown>,
      attemptCount: Number(row.attemptCount),
    },
  );
  return 1;
};

afterAll(async () => {
  await h.sql.end({ timeout: 5 });
  await jobsSql.end({ timeout: 5 });
});

describe("Workers AI clinical jobs", () => {
  it("runs through the centralized service, persists the result and audits without PHI in the prompt", async () => {
    const reception = await h.login("reception@medveris.local", KAMPALA_TENANT, { facilitySlug: KAMPALA_FACILITY_SLUG });
    const patientId = await h.registerPatient(reception);
    const clinician = await h.login("clinician@medveris.local");

    const created = await h.expectOk(await h.call(clinician, "/api/v1/ai/jobs", {
      method: "POST", body: JSON.stringify({ taskType: "record-summary", patientId, evidenceEntryIds: [] }),
    }), 202);
    expect(created.job.status).toBe("queued");
    expect(await pump(created.job.id)).toBe(1);

    const job = await h.expectOk(await h.call(clinician, `/api/v1/ai/jobs/${created.job.id}`));
    expect(job.job).toMatchObject({
      status: "completed",
      provider: "workers-ai",
      responseSummary: "Synthetic summary for clinician review",
    });
    expect(job.job.completedAt).not.toBeNull();
    expect(job.disclaimer).toContain("decision support only");

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain(patientId);
    expect(prompts[0]).toContain("TASK_TYPE: record-summary");
  });

  it("refuses a patient that is not linked to the active workspace before inference", async () => {
    const reception = await h.login("reception@medveris.local", KAMPALA_TENANT, { facilitySlug: KAMPALA_FACILITY_SLUG });
    const patientId = await h.registerPatient(reception);
    const otherClinician = await h.login("clinician.b@medveris.local");
    const before = prompts.length;
    const response = await h.call(otherClinician, "/api/v1/ai/jobs", {
      method: "POST", body: JSON.stringify({ taskType: "record-summary", patientId, evidenceEntryIds: [] }),
    });
    expect(response.status).toBe(404);
    expect(prompts).toHaveLength(before);
  });

  it("records a failed job instead of leaking the inference error", async () => {
    const reception = await h.login("reception@medveris.local", KAMPALA_TENANT, { facilitySlug: KAMPALA_FACILITY_SLUG });
    const patientId = await h.registerPatient(reception);
    const clinician = await h.login("clinician@medveris.local");
    behaviour = "fail";
    try {
      const created = await h.expectOk(await h.call(clinician, "/api/v1/ai/jobs", {
        method: "POST", body: JSON.stringify({ taskType: "record-summary", patientId, evidenceEntryIds: [] }),
      }), 202);
      expect(created.job.status).toBe("queued");
      expect(await pump(created.job.id)).toBe(1);
      const job = await h.expectOk(await h.call(clinician, `/api/v1/ai/jobs/${created.job.id}`));
      expect(job.job).toMatchObject({ status: "failed", provider: "workers-ai", responseSummary: null });
    } finally {
      behaviour = "ok";
    }
  });
});
