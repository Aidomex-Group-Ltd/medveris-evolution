import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withContext } from "@medveris/db";
import { KAMPALA_TENANT, createHarness, type Session } from "./support.js";

const h = createHarness("merge");
const ENTEBBE_TENANT = "22222222-2222-4222-8222-222222222222";
const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let reception: Session;
let admin: Session;
let records: Session;

beforeAll(async () => {
  reception = await h.login("reception@medveris.local");
  admin = await h.login("admin@medveris.local");
  records = await h.login("records@medveris.local");
});

afterAll(async () => {
  await h.sql.end({ timeout: 5 });
});

async function registerPair(familyName: string) {
  const register = () => h.post(reception, "/api/v1/reception/patients", {
    givenName: "Synthetic", familyName, dateOfBirth: "1985-02-03", sex: "male", identityConfidence: "confirmed-verbal",
  });
  const survivor = (await register()).patient;
  const duplicate = (await register()).patient;
  const candidates = await h.expectOk(await h.call(admin, "/api/v1/admin/duplicate-candidates"));
  const candidate = candidates.candidates.find((item: { candidatePublicId: string }) => item.candidatePublicId === duplicate.publicId);
  return { survivor, duplicate, candidateId: candidate.id as string };
}

async function auditCount(action: string, resourceId: string): Promise<number> {
  const rows = await withContext(h.sql, { tenantId: KAMPALA_TENANT, userId: ADMIN_ID, actorKind: "staff", roles: ["facility_admin"] },
    async (tx) => tx`select count(*)::int as count from audit_events where action = ${action} and resource_id = ${resourceId}`);
  return rows[0]!.count as number;
}

describe("authorised patient merge", () => {
  it("requires a second authorised person, then redirects the duplicate to the survivor", async () => {
    const familyName = `Merge${Date.now()}`;
    const { survivor, duplicate, candidateId } = await registerPair(familyName);
    const duplicateEncounter = await h.post(reception, "/api/v1/encounters", { patientId: duplicate.patientId, type: "walk-in", reason: "Synthetic visit under the duplicate" });

    const byReception = await h.call(reception, "/api/v1/patient-merges", {
      method: "POST", body: JSON.stringify({ sourcePatientId: duplicate.patientId, survivorPatientId: survivor.patientId, reason: "x".repeat(12), evidence: "y".repeat(12) }),
    });
    expect(byReception.status).toBe(403);

    const requested = await h.post(admin, "/api/v1/patient-merges", {
      sourcePatientId: duplicate.patientId, survivorPatientId: survivor.patientId, duplicateCandidateId: candidateId,
      reason: "Same person registered twice on the same day (synthetic)", evidence: "Identity document checked at the desk (synthetic)",
    });
    const mergeId = requested.merge.id as string;

    const selfApproval = await h.call(admin, `/api/v1/patient-merges/${mergeId}/approve`, { method: "POST", body: JSON.stringify({ note: "Approving my own request" }) });
    expect(selfApproval.status).toBe(403);
    await h.post(records, `/api/v1/patient-merges/${mergeId}/approve`, { note: "Second-person review agrees (synthetic)" }, 200);

    const resolved = await h.post(reception, "/api/v1/patients/resolve", { publicId: duplicate.publicId, familyName, dateOfBirth: "1985-02-03" }, 200);
    expect(resolved.matched).toBe(true);
    expect(resolved.patient.id).toBe(survivor.patientId);
    expect(resolved.patient.mergedFrom).toBe(duplicate.publicId);

    const blocked = await h.call(reception, "/api/v1/encounters", {
      method: "POST", body: JSON.stringify({ patientId: duplicate.patientId, type: "walk-in", reason: "Should be refused" }),
    });
    expect(blocked.status).toBe(409);

    const identity = await h.expectOk(await h.call(reception, `/api/v1/patients/${survivor.patientId}/identity`));
    expect(identity.merged.map((row: { publicId: string }) => row.publicId)).toEqual([duplicate.publicId]);
    expect(identity.encounters.some((row: { id: string }) => row.id === duplicateEncounter.encounterId)).toBe(true);

    const candidates = await h.expectOk(await h.call(admin, "/api/v1/admin/duplicate-candidates"));
    expect(candidates.candidates.some((item: { id: string }) => item.id === candidateId)).toBe(false);
    expect(await auditCount("patient.merge.complete", mergeId)).toBe(2);

    const list = await h.expectOk(await h.call(records, "/api/v1/patient-merges?status=completed"));
    expect(list.merges.find((row: { id: string }) => row.id === mergeId).decidedByName).toBe("Rose Records");
  });

  it("reverses a completed merge with a reason", async () => {
    const familyName = `Unmerge${Date.now()}`;
    const { survivor, duplicate } = await registerPair(familyName);
    const requested = await h.post(admin, "/api/v1/patient-merges", {
      sourcePatientId: duplicate.patientId, survivorPatientId: survivor.patientId,
      reason: "Believed to be the same person (synthetic)", evidence: "Same name and date of birth (synthetic)",
    });
    await h.post(records, `/api/v1/patient-merges/${requested.merge.id}/approve`, { note: "Approved (synthetic)" }, 200);
    await h.post(admin, `/api/v1/patient-merges/${requested.merge.id}/reverse`, { reason: "Twins confirmed on re-check; identities are distinct" }, 200);
    const resolved = await h.post(reception, "/api/v1/patients/resolve", { publicId: duplicate.publicId, familyName, dateOfBirth: "1985-02-03" }, 200);
    expect(resolved.patient.id).toBe(duplicate.patientId);
    expect(resolved.patient.mergedFrom).toBeNull();
    expect(await auditCount("patient.merge.reverse", requested.merge.id)).toBe(2);
  });

  it("refuses to merge an identity another facility relies on", async () => {
    const { survivor, duplicate } = await registerPair(`Shared${Date.now()}`);
    await withContext(h.sql, { tenantId: ENTEBBE_TENANT, userId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", actorKind: "staff", roles: ["clinician"] }, async (tx) => tx`
      insert into tenant_patient_links (id, tenant_id, patient_id, local_mrn) values (${crypto.randomUUID()}, ${ENTEBBE_TENANT}, ${duplicate.patientId}, ${`SYNTH-ENT-${Date.now()}`})
    `);
    const response = await h.call(admin, "/api/v1/patient-merges", {
      method: "POST", body: JSON.stringify({
        sourcePatientId: duplicate.patientId, survivorPatientId: survivor.patientId,
        reason: "Synthetic attempt across facilities", evidence: "Synthetic evidence text",
      }),
    });
    expect(response.status).toBe(409);
    const body = await h.json(response);
    expect(body.error.details.blockers).toEqual(["linked-to-another-facility"]);
    expect(body.error.message).not.toContain(ENTEBBE_TENANT);
  });
});
