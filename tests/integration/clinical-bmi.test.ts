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

    const encounter = await h.post(clinician, "/api/v1/encounters", {
      patientId,
      type: "walk-in",
      reason: "Routine review",
    });
    await h.post(clinician, `/api/v1/encounters/${encounter.encounterId}/triage`, {
      complaint: "Routine review", urgency: "routine", notes: "", allergyState: "none",
    }, 200);

    const created = await h.post(
      clinician,
      `/api/v1/encounters/${encounter.encounterId}/entries`,
      {
        title: "Assessment",
        subjective: "Patient reports weight 70kg and height 1.7m",
        objective: "Examination unremarkable",
        assessment: "",
        plan: "",
        clinicalOccurredAt: new Date().toISOString(),
        changeNote: "Initial note",
      },
    );

    expect(created.ok).toBe(true);
    expect(created.entryId).toBeDefined();
    expect(created.bmi).toEqual({ bmi: 24.2, riskLevel: "low" });

    // The screening table is row-level secured: read it with the same tenant and clinical role
    // claims the request used, scoped to this transaction so no other test inherits them.
    const rows = await h.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${KAMPALA_TENANT}, true), set_config('app.roles', 'clinician,nurse,clinical_staff', true)`;
      return tx`
        select bmi, risk_level
          from clinical_bmi_screenings
         where tenant_id = ${KAMPALA_TENANT} and encounter_id = ${encounter.encounterId}
         order by recorded_at desc
        limit 1
      `;
    });
    expect(rows.length).toBe(1);
    // `numeric` comes back from Postgres as a string.
    expect(Number(rows[0]!.bmi)).toBe(24.2);
    expect(rows[0]!.riskLevel).toBe("low");
  });

  it("does not persist BMI when weight and height are not observable in the note", async () => {
    const reception = await h.login("reception@medveris.local");
    const patientId = await h.registerPatient(reception);
    const clinician = await h.login("midwife@medveris.local");

    const encounter = await h.post(clinician, "/api/v1/encounters", {
      patientId,
      type: "walk-in",
      reason: "Routine review",
    });
    await h.post(clinician, `/api/v1/encounters/${encounter.encounterId}/triage`, {
      complaint: "Routine review", urgency: "routine", notes: "", allergyState: "none",
    }, 200);

    const created = await h.post(
      clinician,
      `/api/v1/encounters/${encounter.encounterId}/entries`,
      {
        title: "Assessment",
        subjective: "No measurements taken today",
        objective: "",
        assessment: "",
        plan: "",
        clinicalOccurredAt: new Date().toISOString(),
        changeNote: "Initial note",
      },
    );

    expect(created.bmi).toBeNull();
  });
});
