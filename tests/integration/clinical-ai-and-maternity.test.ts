import { afterAll, describe, expect, it } from "vitest";
import { KAMPALA_TENANT, createHarness } from "./support.js";

const h = createHarness("clinical-ai-and-maternity");

afterAll(async () => {
  await h.sql.end({ timeout: 5 });
});

describe("clinical AI suggestion and maternity alerts", () => {
  it("returns decision-support disclaimers and reports AI unavailable when nothing is configured", async () => {
    const reception = await h.login("reception@medveris.local");
    const patientId = await h.registerPatient(reception);
    const clinician = await h.login("clinician@medveris.local");

    const encounter = await h.expectOk(
      await h.post(clinician, "/api/v1/encounters", {
        patientId,
        type: "walk-in",
        reason: "Routine review",
      }),
    );

    const suggested = await h.expectOk(
      await h.call(clinician, `/api/v1/ai/encounters/${encounter.encounter.id}/suggest`, {
        method: "POST",
        body: JSON.stringify({
          patientId,
          encounterId: encounter.encounter.id,
          encounterState: "in-progress",
          existingContent: "Patient presented for routine review",
        }),
      }),
      200,
    );

    expect(suggested.ok).toBe(true);
    expect(suggested.aiAssist.available).toBe(false);
    expect(suggested.disclaimer).toContain("decision support only");
    expect(suggested.patientId).toBe(patientId);
    expect(suggested.encounterId).toBe(encounter.encounter.id);
  });

  it("surfaces partograph-generated alerts from labour observations for a maternity episode", async () => {
    const reception = await h.login("reception@medveris.local");
    const patientId = await h.registerPatient(reception);
    const midwife = await h.login("midwife@medveris.local");

    const episode = await h.expectOk(
      await h.post(midwife, "/api/v1/maternity/episodes", {
        patientId,
        gravidity: 2,
        parity: 1,
        riskLevel: "low",
      }),
    );

    await h.expectOk(
      await h.post(
        midwife,
        `/api/v1/maternity/episodes/${episode.episode.id}/observations`,
        {
          templateType: "partograph",
          clinicalOccurredAt: new Date().toISOString(),
          maternal: {
            dilation: 4,
            station: -3,
            contractionsPer10Min: 1,
            previousDilation: 3,
          },
          fetal: {
            fetalHeartRate: 100,
          },
        },
      ),
      201,
    );

    const alerts = await h.expectOk(
      await h.call(midwife, `/api/v1/maternity/episodes/${episode.episode.id}/alerts`),
      200,
    );

    expect(alerts.episodeId).toBe(episode.episode.id);
    expect(alerts.alerts.length).toBeGreaterThan(0);
    expect(alerts.alerts.some((a: { source: string }) => a.source === "partograph")).toBe(true);
    expect(alerts.alerts.some((a: { alert: string }) => a.alert === "Labour progress status: delayed")).toBe(true);
  });
});
