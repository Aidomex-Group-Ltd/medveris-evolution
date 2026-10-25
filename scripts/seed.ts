import { createHash } from "node:crypto";
import { createSql, setLocalContext } from "@medveris/db";
import type { Tx } from "@medveris/db";
import { encryptSecret, generateTotpSecret, hashPassword } from "@medveris/auth";
import { canonicalJson, contentDigest } from "@medveris/domain";
import { hmacHex } from "@medveris/auth";
import { loadConfig } from "../apps/api/src/config.js";
import { assertSyntheticEnvironment, loadLocalEnv, requireEnv } from "./lib.js";

loadLocalEnv();
assertSyntheticEnvironment();

const config = loadConfig();
const sql = createSql(requireEnv("DATABASE_URL"), { max: 5 });
const PASSWORD = "Medveris!2026";

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";
const users = {
  admin: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  clinician: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  reception: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  nurse: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  clinicianB: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  reviewer: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  patient: "99999999-9999-4999-8999-999999999999",
} as const;
const patients = {
  amina: "a0000000-0000-4000-8000-000000000001",
  joseph: "a0000000-0000-4000-8000-000000000002",
  grace: "a0000000-0000-4000-8000-000000000003",
  brian: "b0000000-0000-4000-8000-000000000001",
} as const;
const encounterA = "e0000000-0000-4000-8000-000000000001";
const encounterA2 = "e0000000-0000-4000-8000-000000000002";
const encounterB = "e0000000-0000-4000-8000-000000000003";
const entryA = "ce000000-0000-4000-8000-000000000001";
const queueA = "c0000000-0000-4000-8000-000000000001";
const queueB = "c0000000-0000-4000-8000-000000000002";
const grantA = "90000000-0000-4000-8000-000000000001";

function hashId(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function context(tx: Tx, tenantId: string | null, userId: string | null, roles: string[], patientId: string | null = null, actorKind: "staff" | "patient" | "registration" = "staff") {
  await setLocalContext(tx, { tenantId, userId, patientId, actorKind, roles });
}

const passwordHash = await hashPassword(PASSWORD);

async function person(
  tx: Tx,
  id: string,
  email: string,
  displayName: string,
  givenName: string,
  familyName: string,
  mfa: boolean,
): Promise<string | null> {
  const secret = mfa ? generateTotpSecret() : null;
  const secretEnc = secret ? await encryptSecret(secret, config.mfaEncryptionKey) : null;
  await tx`
    insert into users (id, email, email_verified_at, password_hash, display_name, given_name, family_name, status, totp_secret_enc, mfa_enrolled_at)
    values (${id}, ${email}, now(), ${passwordHash}, ${displayName}, ${givenName}, ${familyName}, 'active',
      ${secretEnc}, ${secret ? new Date() : null})
    on conflict (id) do update set email = excluded.email, display_name = excluded.display_name,
      given_name = excluded.given_name, family_name = excluded.family_name, password_hash = excluded.password_hash,
      email_verified_at = excluded.email_verified_at, totp_secret_enc = excluded.totp_secret_enc,
      mfa_enrolled_at = excluded.mfa_enrolled_at, status = 'active', updated_at = now()
  `;
  return secret;
}

try {
  await sql.begin(async (tx) => {
    await tx`
      insert into tenants (id, name, slug, facility_type, city, country, email, phone, status, public_listing)
      values (${tenantA}, 'Kampala Community Clinic (synthetic)', 'kampala-community', 'outpatient', 'Kampala', 'Uganda',
        'hello@kampala.example', '+256-000-000-001', 'active', true),
        (${tenantB}, 'Entebbe Family Health Centre (synthetic)', 'entebbe-family', 'outpatient', 'Entebbe', 'Uganda',
        'hello@entebbe.example', '+256-000-000-002', 'active', true)
      on conflict (id) do update set name = excluded.name, city = excluded.city, status = 'active', public_listing = true
    `;

    await person(tx, users.admin, "admin@medveris.local", "Amina Administrator", "Amina", "Administrator", true);
    await person(tx, users.clinician, "clinician@medveris.local", "Dr Daniel Okello", "Daniel", "Okello", true);
    await person(tx, users.reception, "reception@medveris.local", "Rita Reception", "Rita", "Nabirye", true);
    await person(tx, users.nurse, "nurse@medveris.local", "Nurse Sarah Atim", "Sarah", "Atim", true);
    await person(tx, users.clinicianB, "clinician.b@medveris.local", "Dr Peter Ssemakula", "Peter", "Ssemakula", true);
    await person(tx, users.reviewer, "reviewer@medveris.local", "Independent Reviewer", "Irene", "Kagoya", true);
    await person(tx, users.patient, "patient@medveris.local", "Amina Nakato", "Amina", "Nakato", false);

    await context(tx, tenantA, users.admin, ["facility_admin"], null);
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-admin-a")}, ${tenantA}, ${users.admin}, ${["facility_admin"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-clinician-a")}, ${tenantA}, ${users.clinician}, ${["clinician"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-nurse-a")}, ${tenantA}, ${users.nurse}, ${["nurse"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-reception-a")}, ${tenantA}, ${users.reception}, ${["receptionist"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;

    await context(tx, tenantB, users.admin, ["facility_admin"], null);
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-clinician-b")}, ${tenantB}, ${users.clinicianB}, ${["clinician"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;
    await tx`insert into platform_roles (user_id, role) values (${users.reviewer}, 'credential_reviewer') on conflict do nothing`;

    await context(tx, tenantA, users.clinician, ["clinician"], null);
    for (const [key, id, given, family, dob, sex, publicId] of [
      ["amina", patients.amina, "Amina", "Nakato", "1988-04-12", "female", "MV-7K2M-9QX4-4T2A-8Z3N"],
      ["joseph", patients.joseph, "Joseph", "Mukasa", "1974-11-03", "male", "MV-9Q4T-6H2J-8K5M-3P7S"],
      ["grace", patients.grace, "Grace", "Achieng", "1996-07-21", "female", "MV-3N8P-2W7R-5Y6C-1B4D"],
    ] as const) {
      await tx`
        insert into patients (id, public_id, given_name, family_name, date_of_birth, sex, email, phone, identity_confidence, created_via, created_tenant_id)
        values (${id}, ${publicId}, ${given}, ${family}, ${dob}, ${sex}, ${key === "amina" ? "patient@medveris.local" : `${key}@example.test`},
          ${`+256-700-000-${key === "amina" ? "001" : key === "joseph" ? "002" : "003"}`}, 'confirmed-verbal', 'assisted-registration', ${tenantA})
        on conflict (id) do update set given_name = excluded.given_name, family_name = excluded.family_name,
          date_of_birth = excluded.date_of_birth, sex = excluded.sex, email = excluded.email, phone = excluded.phone
      `;
      await tx`insert into tenant_patient_links (id, tenant_id, patient_id, local_mrn) values (${hashId(`link-${key}-a`)}, ${tenantA}, ${id}, ${`KCC-${key.toUpperCase()}`}) on conflict (tenant_id, patient_id) do nothing`;
    }
    await context(tx, tenantB, users.clinicianB, ["clinician"], null);
    await tx`
      insert into patients (id, public_id, given_name, family_name, date_of_birth, sex, email, phone, identity_confidence, created_via, created_tenant_id)
      values (${patients.brian}, 'MV-5V8X-2C4B-7N9M-6Q1W', 'Brian', 'Ochieng', '1982-02-17', 'male', 'brian@example.test',
        '+256-700-000-004', 'confirmed-verbal', 'assisted-registration', ${tenantB})
      on conflict (id) do update set given_name = excluded.given_name, family_name = excluded.family_name
    `;
    await tx`insert into tenant_patient_links (id, tenant_id, patient_id, local_mrn) values (${hashId("link-brian-b")}, ${tenantB}, ${patients.brian}, 'EFH-BRIAN') on conflict (tenant_id, patient_id) do nothing`;

    await context(tx, tenantA, users.patient, ["patient"], patients.amina, "patient");
    await tx`
      insert into patient_accounts (id, user_id, patient_id, verified_at)
      values (${hashId("account-amina")}, ${users.patient}, ${patients.amina}, now())
      on conflict (user_id) do nothing
    `;

    await context(tx, tenantA, users.clinician, ["clinician"], null);
    await tx`insert into queues (id, tenant_id, name) values (${queueA}, ${tenantA}, 'Walk-in queue') on conflict (tenant_id, name) do nothing`;

    await tx`
      insert into appointments (id, tenant_id, patient_id, clinician_user_id, start_at, duration_minutes, reason, status, created_by)
      values (${hashId("appt-amina")}, ${tenantA}, ${patients.amina}, ${users.clinician}, ${new Date(Date.now() + 86_400_000)},
        30, 'Hypertension follow-up (synthetic)', 'scheduled', ${users.reception})
      on conflict (id) do nothing
    `;

    await tx`
      insert into encounters (id, tenant_id, patient_id, clinician_user_id, type, state, version, reason, opened_at, closed_at, created_by)
      values (${encounterA}, ${tenantA}, ${patients.amina}, ${users.clinician}, 'follow-up', 'completed', 3,
        'Hypertension review (synthetic)', ${new Date(Date.now() - 7 * 86_400_000)}, ${new Date(Date.now() - 7 * 86_400_000 + 3_600_000)}, ${users.clinician}),
        (${encounterA2}, ${tenantA}, ${patients.joseph}, ${users.clinician}, 'walk-in', 'arrived', 1,
        'Cough and fever (synthetic)', now(), null, ${users.reception})
      on conflict (id) do nothing
    `;
    await tx`insert into queue_entries (id, tenant_id, queue_id, patient_id, encounter_id, status, priority) values (${hashId("qe-joseph")}, ${tenantA}, ${queueA}, ${patients.joseph}, ${encounterA2}, 'waiting', 'routine') on conflict (id) do nothing`;

    await context(tx, tenantB, users.clinicianB, ["clinician"], null);
    await tx`insert into queues (id, tenant_id, name) values (${queueB}, ${tenantB}, 'Walk-in queue') on conflict (tenant_id, name) do nothing`;
    await tx`
      insert into encounters (id, tenant_id, patient_id, clinician_user_id, type, state, version, reason, opened_at, created_by)
      values (${encounterB}, ${tenantB}, ${patients.brian}, ${users.clinicianB}, 'walk-in', 'triaged', 2, 'Joint pain (synthetic)', now(), ${users.clinicianB})
      on conflict (id) do nothing
    `;

    const noteContent = (plan: string) => ({
      schemaVersion: "urn:medveris:schema:outpatient-note:1",
      title: "Hypertension follow-up",
      subjective: "Reports adherence to medication. Occasional morning headache. No chest pain or breathlessness.",
      objective: "Alert and well. BP recorded in vitals. Heart sounds normal. No pedal oedema.",
      assessment: "Essential hypertension, apparently controlled. Lifestyle advice reinforced.",
      plan,
    });
    await context(tx, tenantA, users.clinician, ["clinician"], null);
    await tx`
      insert into clinical_entries (id, tenant_id, patient_id, encounter_id, current_version, status, created_by)
      values (${entryA}, ${tenantA}, ${patients.amina}, ${encounterA}, 2, 'amended', ${users.clinician})
      on conflict (id) do update set current_version = 2, status = 'amended'
    `;
    const v1Content = noteContent("Continue amlodipine. Review in 3 months. Red flags discussed.");
    const v1Digest = await contentDigest(v1Content);
    const v1Id = hashId("entry-a-v1");
    const v1Occurred = new Date(Date.now() - 7 * 86_400_000);
    const v1Signed = new Date(Date.now() - 7 * 86_400_000 + 3_000_000);
    const v1Signature = await hmacHex(config.auditSigningKey, canonicalJson({
      entryId: entryA, version: 1, contentDigest: v1Digest, authorId: users.clinician,
      occurredAt: v1Occurred.toISOString(), status: "signed",
    }));
    await tx`
      insert into clinical_entry_versions (id, entry_id, tenant_id, patient_id, encounter_id, version, previous_version_id,
        author_id, occurred_at, recorded_at, signed_at, status, change_note, title, content_schema, content, content_digest,
        signature, signature_key_id)
      values (${v1Id}, ${entryA}, ${tenantA}, ${patients.amina}, ${encounterA}, 1, null, ${users.clinician}, ${v1Occurred},
        ${v1Signed}, ${v1Signed}, 'signed', 'Initial consultation and plan recorded.', 'Hypertension follow-up',
        'urn:medveris:schema:outpatient-note:1', ${tx.json(v1Content as never)}, ${v1Digest}, ${v1Signature}, ${config.auditSigningKeyId})
      on conflict (entry_id, version) do nothing
    `;
    const v2Content = noteContent("Continue amlodipine. Home BP diary requested. Review in 3 months. Red flags discussed.");
    const v2Digest = await contentDigest(v2Content);
    const v2Id = hashId("entry-a-v2");
    const v2Occurred = new Date(Date.now() - 7 * 86_400_000 + 3_600_000);
    const v2Signature = await hmacHex(config.auditSigningKey, canonicalJson({
      entryId: entryA, version: 2, contentDigest: v2Digest, authorId: users.clinician,
      occurredAt: v2Occurred.toISOString(), status: "amended",
    }));
    await tx`
      insert into clinical_entry_versions (id, entry_id, tenant_id, patient_id, encounter_id, version, previous_version_id,
        author_id, occurred_at, recorded_at, signed_at, status, change_note, title, content_schema, content, content_digest,
        signature, signature_key_id)
      values (${v2Id}, ${entryA}, ${tenantA}, ${patients.amina}, ${encounterA}, 2, ${v1Id}, ${users.clinician}, ${v2Occurred},
        ${new Date()}, ${v2Occurred}, 'amended', 'Clarified home blood-pressure monitoring plan.', 'Hypertension follow-up',
        'urn:medveris:schema:outpatient-note:1', ${tx.json(v2Content as never)}, ${v2Digest}, ${v2Signature}, ${config.auditSigningKeyId})
      on conflict (entry_id, version) do nothing
    `;

    await tx`
      insert into observations (id, tenant_id, patient_id, encounter_id, loinc_system, loinc_version, loinc_code, display, original_text,
        coding, value_num, unit_code, unit_system, occurred_at, author_id, status)
      values (${hashId("obs-sbp")}, ${tenantA}, ${patients.amina}, ${encounterA}, 'http://loinc.org', '2.80-medveris-synthetic', '8480-6',
        'Systolic blood pressure', 'Systolic blood pressure', ${tx.json({ system: "http://loinc.org", code: "8480-6", display: "Systolic blood pressure" })},
        128, 'mm[Hg]', 'http://unitsofmeasure.org', ${v1Occurred}, ${users.clinician}, 'final'),
        (${hashId("obs-dbp")}, ${tenantA}, ${patients.amina}, ${encounterA}, 'http://loinc.org', '2.80-medveris-synthetic', '8462-4',
        'Diastolic blood pressure', 'Diastolic blood pressure', ${tx.json({ system: "http://loinc.org", code: "8462-4", display: "Diastolic blood pressure" })},
        78, 'mm[Hg]', 'http://unitsofmeasure.org', ${v1Occurred}, ${users.clinician}, 'final'),
        (${hashId("obs-hr")}, ${tenantA}, ${patients.amina}, ${encounterA}, 'http://loinc.org', '2.80-medveris-synthetic', '8867-4',
        'Heart rate', 'Heart rate', ${tx.json({ system: "http://loinc.org", code: "8867-4", display: "Heart rate" })},
        72, '/min', 'http://unitsofmeasure.org', ${v1Occurred}, ${users.clinician}, 'final')
      on conflict (id) do nothing
    `;
    await tx`
      insert into conditions (id, tenant_id, patient_id, encounter_id, snomed_version, snomed_code, display, original_text, coding, clinical_status, onset_date, note, author_id)
      values (${hashId("cond-htn")}, ${tenantA}, ${patients.amina}, ${encounterA}, 'http://snomed.info/sct/version/20240131-medveris-synthetic',
        '38341003', 'Hypertension', 'Hypertension', ${tx.json({ system: "http://snomed.info/sct", code: "38341003", display: "Hypertension" })},
        'active', '2019-06-01', 'Long-standing diagnosis, confirmed from previous records.', ${users.clinician})
      on conflict (id) do nothing
    `;
    await tx`
      insert into allergies (id, tenant_id, patient_id, encounter_id, state, substance_coding, reaction_coding, severity, note, author_id)
      values (${hashId("allergy-penicillin")}, ${tenantA}, ${patients.amina}, ${encounterA}, 'recorded',
        ${tx.json({ system: "http://snomed.info/sct", code: "372687004", display: "Amoxicillin" })},
        ${tx.json({ system: "http://snomed.info/sct", code: "126485001", display: "Urticaria" })}, 'moderate', 'Rash after oral amoxicillin.', ${users.clinician})
      on conflict (id) do nothing
    `;
    await tx`
      insert into follow_ups (id, tenant_id, patient_id, encounter_id, due_date, instructions, status, author_id)
      values (${hashId("follow-htn")}, ${tenantA}, ${patients.amina}, ${encounterA}, ${new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10)},
        'Bring home blood-pressure readings and medication list.', 'pending', ${users.clinician})
      on conflict (id) do nothing
    `;

    await context(tx, tenantA, users.patient, ["patient"], patients.amina, "patient");
    await tx`
      insert into exchange_grants (id, patient_id, grantor_user_id, recipient_tenant_id, source_tenant_ids, categories, purpose,
        legal_basis, authorization_evidence, starts_at, expires_at, sensitivity_exclusions)
      values (${grantA}, ${patients.amina}, ${users.patient}, ${tenantB}, ${[tenantA]}, ${["encounter", "note", "observation", "condition", "allergy", "follow-up"]},
        'Continuity of care while travelling to Entebbe (synthetic consent record)', 'patient-consent',
        'Synthetic seeded consent for demonstration. Not a real patient authorization.', ${new Date(Date.now() - 86_400_000)},
        ${new Date(Date.now() + 30 * 86_400_000)}, ${["mental-health", "reproductive-health", "genetic", "hiv"]})
      on conflict (id) do nothing
    `;

    await context(tx, tenantA, users.clinician, ["clinician"], null);
    await tx`
      insert into credentials (id, subject_type, subject_user_id, submitted_by, credential_type, issuer, jurisdiction,
        credential_number, scope, issued_on, expires_on, status)
      values (${hashId("credential-clinician")}, 'practitioner', ${users.clinician}, ${users.clinician}, 'Medical licence',
        'Uganda Medical and Dental Practitioners Council', 'Uganda', 'SYNTH-UMDPC-0001', 'General outpatient medicine',
        '2022-01-15', '2027-01-14', 'submitted')
      on conflict (id) do nothing
    `;

    await context(tx, tenantA, users.admin, ["facility_admin"], null);
    await tx`
      insert into integration_configs (id, tenant_id, adapter, enabled, config, configured_by)
      values (${hashId("integration-lab")}, ${tenantA}, 'laboratory', false, ${tx.json({ status: "disabled", displayName: "Laboratory results", note: "Integration unavailable in this release" })}, ${users.admin})
      on conflict (id) do nothing
    `;
  });

  console.log(JSON.stringify({
    ok: true,
    synthetic: true,
    password: PASSWORD,
    facilities: { kampala: tenantA, entebbe: tenantB },
    accounts: {
      admin: "admin@medveris.local",
      clinician: "clinician@medveris.local",
      reception: "reception@medveris.local",
      nurse: "nurse@medveris.local",
      clinicianB: "clinician.b@medveris.local",
      reviewer: "reviewer@medveris.local",
      patient: "patient@medveris.local",
    },
    patients: {
      amina: "MV-7K2M-9QX4-4T2A-8Z3N",
      joseph: "MV-9Q4T-6H2J-8K5M-3P7S",
      grace: "MV-3N8P-2W7R-5Y6C-1B4D",
      brian: "MV-5V8X-2C4B-7N9M-6Q1W",
    },
    note: "All staff accounts require TOTP. Local .env should set DEV_SHOW_TOTP_SECRETS=true to retrieve a code at /api/v1/auth/totp/dev?email=...",
  }, null, 2));
} finally {
  await sql.end({ timeout: 5 });
}
