import { afterAll, describe, expect, it } from "vitest";
import type { AiRunInput } from "@medveris/ai";
import { KAMPALA_TENANT, KAMPALA_FACILITY_SLUG, createHarness } from "./support.js";

let behaviour: "ok" | "fail" = "ok";
const prompts: string[] = [];

const h = createHarness("ai-jobs", {
  env: { FEATURE_AI: "true", AI_MODEL: "@cf/test/model" },
  deps: () => ({
    ai: {
      run: async (input: AiRunInput) => {
        prompts.push(input.prompt);
        if (behaviour === "fail") throw new Error("upstream model unavailable");
        return { text: "Synthetic summary for clinician review", usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 } };
      },
    },
  }),
});

afterAll(async () => {
  await h.sql.end({ timeout: 5 });
});

describe("Workers AI clinical jobs", () => {
  it("runs through the centralized service, persists the result and audits without PHI in the prompt", async () => {
    const reception = await h.login("reception@medveris.local", KAMPALA_TENANT, { facilitySlug: KAMPALA_FACILITY_SLUG });
    const patientId = await h.registerPatient(reception);
    const clinician = await h.login("clinician@medveris.local");

    const created = await h.expectOk(await h.call(clinician, "/api/v1/ai/jobs", {
      method: "POST", body: JSON.stringify({ taskType: "record-summary", patientId, evidenceEntryIds: [] }),
    }), 202);
    expect(created.job.status).toBe("completed");

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
      expect(created.job.status).toBe("failed");
      const job = await h.expectOk(await h.call(clinician, `/api/v1/ai/jobs/${created.job.id}`));
      expect(job.job).toMatchObject({ status: "failed", provider: "workers-ai", responseSummary: null });
    } finally {
      behaviour = "ok";
    }
  });
});
