import { afterAll, describe, expect, it } from "vitest";
import { KAMPALA_TENANT, createHarness } from "./support.js";

const h = createHarness("clinical-bmi");

afterAll(async () => {
  await h.sql.end({ timeout: 5 });
});

describe("clinical BMI screening", () => {
  it("computes BMI from note text, persists it, and returns it on draft entry creation", async () => {
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

    const created = await h.expectOk(
      await h.post(
        clinician,
        `/api/v1/encounters/${encounter.encounter.id}/entries`,
        {
          title: "Assessment",
          subjective: "Patient reports weight 70kg and height 1.7m",
          objective: "Examination unremarkable",
          assessment: "",
          plan: "",
          clinicalOccurredAt: new Date().toISOString(),
          changeNote: "Initial note",
        },
      ),
      201,
    );

    expect(created.ok).toBe(true);
    expect(created.entryId).toBeDefined();
    expect(created.bmi).toEqual({ bmi: 24.2, riskLevel: "low" });

    const rows = await h.sql`
      select bmi, risk_level
        from clinical_bmi_screenings
       where tenant_id = ${KAMPALA_TENANT} and encounter_id = ${encounter.encounter.id}
       order by recorded_at desc
      limit 1
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.bmi).toBe(24.2);
    expect(rows[0]!.risk_level).toBe("low");
  });

  it("does not persist BMI when weight and height are not observable in the note", async () => {
    const reception = await h.login("reception@medveris.local");
    const patientId = await h.registerPatient(reception);
    const clinician = await h.login("midwife@medveris.local");

    const encounter = await h.expectOk(
      await h.post(clinician, "/api/v1/encounters", {
        patientId,
        type: "walk-in",
        reason: "Routine review",
      }),
    );

    const created = await h.expectOk(
      await h.post(
        clinician,
        `/api/v1/encounters/${encounter.encounter.id}/entries`,
        {
          title: "Assessment",
          subjective: "No measurements taken today",
          objective: "",
          assessment: "",
          plan: "",
          clinicalOccurredAt: new Date().toISOString(),
          changeNote: "Initial note",
        },
      ),
      201,
    );

    expect(created.bmi).toBeNull();
  });
});
