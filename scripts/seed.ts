import { createHash } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { createSql, setLocalContext } from "@medveris/db";
import type { Tx } from "@medveris/db";
import { encryptSecret, generateTotpSecret, hashPassword } from "@medveris/auth";
import {
  DEFAULT_DEPARTMENTS,
  DEFAULT_PRIVILEGES,
  UGANDA_CADRES,
  UGANDA_ONBOARDING_CATALOGUE,
  canonicalJson,
  catalogueCodeForDefaultDepartment,
  contentDigest,
} from "@medveris/domain";
import { hmacHex } from "@medveris/auth";
import { loadConfig } from "../apps/api/src/config.js";
import { assertSyntheticEnvironment, loadLocalEnv, requireEnv } from "./lib.js";

loadLocalEnv();
const stagingSeed = assertSyntheticEnvironment();

const LOCAL_PASSWORD = "Medveris!2026";
const totpExportFile = stagingSeed ? requireEnv("SEED_TOTP_EXPORT_FILE") : null;
if (totpExportFile) {
  const rel = relative(process.cwd(), resolve(totpExportFile));
  if (!rel.startsWith("..") && !isAbsolute(rel)) throw new Error("SEED_TOTP_EXPORT_FILE must be outside the repository");
}
const PASSWORD = stagingSeed ? requireEnv("SEED_ACCOUNT_PASSWORD") : LOCAL_PASSWORD;
if (stagingSeed && (PASSWORD.length < 16 || PASSWORD === LOCAL_PASSWORD)) {
  throw new Error("SEED_ACCOUNT_PASSWORD must be at least 16 characters and differ from the local default");
}
const seededTotp = new Map<string, string>();

const config = loadConfig();
const sql = createSql(requireEnv("DATABASE_URL"), { max: 5 });

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
  finance: "abababab-abab-4aba-8aba-abababababab",
  pharmacist: "bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc",
  laboratory: "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd",
  radiology: "dededede-dede-4ded-8ded-dededededede",
  publicHealth: "efefefef-efef-4efe-8efe-efefefefefef",
  hr: "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0",
  records: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1",
  housekeeping: "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1",
  porter: "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2",
  mortuary: "b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3",
  cssd: "b4b4b4b4-b4b4-4b4b-8b4b-b4b4b4b4b4b4",
  biomedical: "b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b5b5",
  quality: "b6b6b6b6-b6b6-4b6b-8b6b-b6b6b6b6b6b6",
  radiographer: "b7b7b7b7-b7b7-4b7b-8b7b-b7b7b7b7b7b7",
  labValidator: "b8b8b8b8-b8b8-4b8b-8b8b-b8b8b8b8b8b8",
  wardManager: "b9b9b9b9-b9b9-4b9b-8b9b-b9b9b9b9b9b9",
  privacy: "bababab0-baba-4bab-8bab-bababababab0",
} as const;
const organizationA = "0a000000-0000-4000-8000-000000000001";
const staffClinician = "0b000000-0000-4000-8000-000000000001";
const staffNurse = "0b000000-0000-4000-8000-000000000002";
const staffPending = "0b000000-0000-4000-8000-000000000003";
const engagementClinician = "0c000000-0000-4000-8000-000000000001";
const engagementNurse = "0c000000-0000-4000-8000-000000000002";
const engagementPending = "0c000000-0000-4000-8000-000000000003";
const onboardingPending = "0d000000-0000-4000-8000-000000000001";
const templateA = "0e000000-0000-4000-8000-000000000001";
const templateVersionA = "0e000000-0000-4000-8000-000000000101";
const documentA = "0e000000-0000-4000-8000-000000000201";
const maternityGrace = "0f000000-0000-4000-8000-000000000001";
const mortarCaseA = "0f000000-0000-4000-8000-000000000101";
const assetA = "0f000000-0000-4000-8000-000000000201";
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
const wardA = "a1000000-0000-4000-8000-000000000001";
const bedA1 = "a1000000-0000-4000-8000-000000000101";
const bedA2 = "a1000000-0000-4000-8000-000000000102";
const theatreA = "a2000000-0000-4000-8000-000000000001";
const medicineA = "a3000000-0000-4000-8000-000000000001";
const lotA = "a3000000-0000-4000-8000-000000000101";
const labTestA = "a4000000-0000-4000-8000-000000000001";
const programmeA = "a5000000-0000-4000-8000-000000000001";
const serviceA = "a6000000-0000-4000-8000-000000000001";
const encounterGrace = "e0000000-0000-4000-8000-000000000004";

function hashId(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function context(tx: Tx, tenantId: string | null, userId: string | null, roles: string[], patientId: string | null = null, actorKind: "staff" | "patient" | "registration" = "staff") {
  await setLocalContext(tx, { tenantId, userId, patientId, actorKind, roles });
}

async function platformContext(tx: Tx, userId: string | null) {
  await setLocalContext(tx, { userId, actorKind: "staff", platformRole: "platform_operator" });
}

const passwordHash = await hashPassword(PASSWORD);
const ugandaCatalogueDigest = await contentDigest(UGANDA_ONBOARDING_CATALOGUE);
const ugandaCadres = new Map(UGANDA_CADRES.map((cadre) => [cadre.code, cadre]));

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
  if (secret) seededTotp.set(email, secret);
  return secret;
}

try {
  const [schema] = await sql`select to_regprocedure('app.current_tenant()') is not null as intact`;
  if (!schema?.intact) {
    throw new Error("app.current_tenant() is missing, so RLS policies are gone; recreate the synthetic schema before seeding (docs/LOCAL_DEVELOPMENT.md)");
  }
  await sql.begin(async (tx) => {
    await tx`
      insert into tenants (id, name, slug, facility_type, city, country, email, phone, status, public_listing,
        service_category, service_subtype, ownership, level_status, equivalent_level, district)
      values (${tenantA}, 'Kampala Community Clinic (synthetic)', 'kampala-community', 'outpatient', 'Kampala', 'Uganda',
        'hello@kampala.example', '+256-000-000-001', 'active', true, 'clinic', 'general-outpatient', 'private-for-profit',
        'medveris-equivalent', 'hc2', 'Kampala'),
        (${tenantB}, 'Entebbe Family Health Centre (synthetic)', 'entebbe-family', 'outpatient', 'Entebbe', 'Uganda',
        'hello@entebbe.example', '+256-000-000-002', 'active', true, 'clinic', 'general-outpatient', 'private-not-for-profit',
        'not-yet-assigned', null, 'Wakiso')
      on conflict (id) do update set name = excluded.name, city = excluded.city, status = 'active', public_listing = true,
        service_category = excluded.service_category, service_subtype = excluded.service_subtype, ownership = excluded.ownership,
        level_status = excluded.level_status, equivalent_level = excluded.equivalent_level, district = excluded.district
    `;

    await person(tx, users.admin, "admin@medveris.local", "Amina Administrator", "Amina", "Administrator", true);
    await person(tx, users.clinician, "clinician@medveris.local", "Dr Daniel Okello", "Daniel", "Okello", true);
    await person(tx, users.reception, "reception@medveris.local", "Rita Reception", "Rita", "Nabirye", true);
    await person(tx, users.nurse, "nurse@medveris.local", "Nurse Sarah Atim", "Sarah", "Atim", true);
    await person(tx, users.clinicianB, "clinician.b@medveris.local", "Dr Peter Ssemakula", "Peter", "Ssemakula", true);
    await person(tx, users.reviewer, "reviewer@medveris.local", "Independent Reviewer", "Irene", "Kagoya", true);
    await person(tx, users.patient, "patient@medveris.local", "Amina Nakato", "Amina", "Nakato", false);
    await person(tx, users.finance, "finance@medveris.local", "Faith Finance", "Faith", "Namuli", true);
    await person(tx, users.pharmacist, "pharmacist@medveris.local", "Paul Pharmacist", "Paul", "Wasswa", true);
    await person(tx, users.laboratory, "lab@medveris.local", "Lydia Laboratory", "Lydia", "Nakimuli", true);
    await person(tx, users.radiology, "radiology@medveris.local", "Dr Ruth Radiologist", "Ruth", "Auma", true);
    await person(tx, users.radiographer, "radiographer@medveris.local", "Robert Radiographer", "Robert", "Kato", true);
    await person(tx, users.labValidator, "labvalidator@medveris.local", "Valerie Validator", "Valerie", "Achieng", true);
    await person(tx, users.wardManager, "wardmanager@medveris.local", "Winnie Ward Manager", "Winnie", "Nansubuga", true);
    await person(tx, users.privacy, "privacy@medveris.local", "Priscilla Privacy Officer", "Priscilla", "Akello", true);
    await person(tx, users.publicHealth, "publichealth@medveris.local", "Patrick Public Health", "Patrick", "Opio", true);
    await person(tx, users.hr, "hr@medveris.local", "Harriet HR", "Harriet", "Nabatanzi", true);
    await person(tx, users.records, "records@medveris.local", "Rose Records", "Rose", "Kirabo", true);
    await person(tx, users.housekeeping, "housekeeping@medveris.local", "Hilda Housekeeping", "Hilda", "Auma", true);
    await person(tx, users.porter, "porter@medveris.local", "Peter Porter", "Peter", "Okwir", true);
    await person(tx, users.mortuary, "mortuary@medveris.local", "Moses Mortuary", "Moses", "Bwire", true);
    await person(tx, users.cssd, "cssd@medveris.local", "Cecilia CSSD", "Cecilia", "Akello", true);
    await person(tx, users.biomedical, "biomedical@medveris.local", "Brian Biomedical", "Brian", "Tumusiime", true);
    await person(tx, users.quality, "quality@medveris.local", "Quinn Quality", "Quinn", "Nansubuga", true);

    await context(tx, tenantA, users.admin, ["facility_admin"], null);
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-admin-a")}, ${tenantA}, ${users.admin}, ${["facility_admin"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-clinician-a")}, ${tenantA}, ${users.clinician}, ${["clinician"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-nurse-a")}, ${tenantA}, ${users.nurse}, ${["nurse"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-reception-a")}, ${tenantA}, ${users.reception}, ${["receptionist"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-finance-a")}, ${tenantA}, ${users.finance}, ${["finance"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-pharmacist-a")}, ${tenantA}, ${users.pharmacist}, ${["pharmacist"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-lab-a")}, ${tenantA}, ${users.laboratory}, ${["laboratory"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-radiology-a")}, ${tenantA}, ${users.radiology}, ${["radiologist"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-radiographer-a")}, ${tenantA}, ${users.radiographer}, ${["radiographer"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-lab-validator-a")}, ${tenantA}, ${users.labValidator}, ${["lab_validator"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-ward-manager-a")}, ${tenantA}, ${users.wardManager}, ${["ward_manager"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-privacy-a")}, ${tenantA}, ${users.privacy}, ${["privacy_officer"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-public-health-a")}, ${tenantA}, ${users.publicHealth}, ${["public_health"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-hr-a")}, ${tenantA}, ${users.hr}, ${["hr"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-records-a")}, ${tenantA}, ${users.records}, ${["records"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-housekeeping-a")}, ${tenantA}, ${users.housekeeping}, ${["housekeeping"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-porter-a")}, ${tenantA}, ${users.porter}, ${["porter"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-mortuary-a")}, ${tenantA}, ${users.mortuary}, ${["mortuary"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-cssd-a")}, ${tenantA}, ${users.cssd}, ${["cssd"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-biomedical-a")}, ${tenantA}, ${users.biomedical}, ${["biomedical"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-quality-a")}, ${tenantA}, ${users.quality}, ${["quality"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;

    await context(tx, tenantB, users.admin, ["facility_admin"], null);
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-admin-b")}, ${tenantB}, ${users.admin}, ${["facility_admin"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;
    await tx`insert into memberships (id, tenant_id, user_id, roles, status) values (${hashId("m-clinician-b")}, ${tenantB}, ${users.clinicianB}, ${["clinician"]}, 'active') on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`;
    await tx`insert into platform_roles (user_id, role) values (${users.reviewer}, 'credential_reviewer') on conflict do nothing`;
    await tx`insert into platform_roles (user_id, role) values (${users.reviewer}, 'platform_operator') on conflict do nothing`;

    await platformContext(tx, users.reviewer);
    await tx`
      update onboarding_catalogues set status = 'retired', retired_by = ${users.reviewer}, retired_at = now()
       where country_code = 'UG' and status = 'published' and version <> ${UGANDA_ONBOARDING_CATALOGUE.version}
    `;
    await tx`
      insert into onboarding_catalogues (id, country_code, version, status, notice, content, content_digest, created_by, published_by, published_at)
      values (${hashId("uganda-catalogue-v1")}, 'UG', ${UGANDA_ONBOARDING_CATALOGUE.version}, 'published',
        ${UGANDA_ONBOARDING_CATALOGUE.notice}, ${tx.json(UGANDA_ONBOARDING_CATALOGUE as never)}, ${ugandaCatalogueDigest},
        ${users.reviewer}, ${users.reviewer}, now())
      on conflict (country_code, version) do update set status = 'published', notice = excluded.notice,
        content = excluded.content, content_digest = excluded.content_digest, published_by = excluded.published_by,
        published_at = excluded.published_at, retired_by = null, retired_at = null
    `;

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
        'Cough and fever (synthetic)', now(), null, ${users.reception}),
        (${encounterGrace}, ${tenantA}, ${patients.grace}, ${users.clinician}, 'inpatient', 'in-progress', 2,
        'Abdominal pain admission (synthetic)', now(), null, ${users.clinician})
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
      insert into wards (id, tenant_id, name, ward_type, description, created_by)
      values (${wardA}, ${tenantA}, 'General Ward A', 'general', 'Synthetic general inpatient ward', ${users.admin})
      on conflict (id) do nothing
    `;
    await tx`
      insert into beds (id, tenant_id, ward_id, label, features)
      values (${bedA1}, ${tenantA}, ${wardA}, 'A-01', ${tx.json({ oxygen: true, monitor: true })}),
        (${bedA2}, ${tenantA}, ${wardA}, 'A-02', ${tx.json({ oxygen: true })})
      on conflict (id) do nothing
    `;
    await tx`
      insert into theatres (id, tenant_id, name, status)
      values (${theatreA}, ${tenantA}, 'Theatre 1', 'available') on conflict (id) do nothing
    `;
    await tx`
      insert into service_catalog (id, tenant_id, code, name, category, price, currency, created_by)
      values (${serviceA}, ${tenantA}, 'CONS-OPD', 'Outpatient consultation', 'consultation', 50000, 'UGX', ${users.admin})
      on conflict (id) do nothing
    `;

    await context(tx, tenantA, users.admin, ["facility_admin"], null);
    await tx`
      insert into organizations (id, name, legal_name, registration_ref, country, kind, ownership, created_by)
      values (${organizationA}, 'Medveris Synthetic Health Group', 'Medveris Synthetic Health Group Ltd', 'SYNTH-ORG-001', 'Uganda',
        'facility-group', 'private-for-profit', ${users.admin})
      on conflict (id) do nothing
    `;
    await tx`
      insert into organization_memberships (id, organization_id, user_id, role)
      values (${hashId("om-admin")}, ${organizationA}, ${users.admin}, 'organization_owner')
      on conflict do nothing
    `;
    for (const tenant of [tenantA, tenantB]) {
      await context(tx, tenant, users.admin, ["facility_admin"], null);
      await tx`update tenants set organization_id = ${organizationA} where id = ${tenant}`;
      await tx`
        insert into organization_links (id, organization_id, tenant_id, status, origin, decided_at, history_visibility, visible_from, decision_note)
        values (${hashId(`org-link-${tenant}`)}, ${organizationA}, ${tenant}, 'active', 'backfill', now(), 'full-history', null,
          'Synthetic seed site of the demonstration group')
        on conflict do nothing
      `;
    }

    await context(tx, tenantA, users.admin, ["facility_admin"], null);
    for (const [index, department] of DEFAULT_DEPARTMENTS.entries()) {
      const departmentId = hashId(`department-${department.code}`);
      await tx`
        insert into departments (id, tenant_id, code, name, department_type, description, sort_order, created_by, catalogue_code)
        values (${departmentId}, ${tenantA}, ${department.code}, ${department.name}, ${department.type},
          'Synthetic default department catalogue entry', ${index}, ${users.admin},
          ${catalogueCodeForDefaultDepartment(department.code)})
        on conflict (tenant_id, code) do update set catalogue_code = excluded.catalogue_code
      `;
      for (const unit of department.units) {
        await tx`
          insert into units (id, tenant_id, department_id, code, name, unit_type)
          values (${hashId(`unit-${department.code}-${unit.code}`)}, ${tenantA}, ${departmentId}, ${unit.code}, ${unit.name}, ${unit.type ?? "general"})
          on conflict (tenant_id, department_id, code) do nothing
        `;
      }
      for (const cadre of department.cadres) {
        const catalogueCadre = ugandaCadres.get(cadre.code);
        await tx`
          insert into cadres (id, tenant_id, code, name, category, catalogue_code, regulator_codes, requires_registration)
          values (${hashId(`cadre-${cadre.code}`)}, ${tenantA}, ${cadre.code}, ${cadre.name}, ${cadre.category},
            ${catalogueCadre ? cadre.code : null}, ${catalogueCadre?.regulatorCodes ?? []}, ${catalogueCadre?.requiresRegistration ?? false})
          on conflict (tenant_id, code) do update set catalogue_code = excluded.catalogue_code,
            regulator_codes = excluded.regulator_codes, requires_registration = excluded.requires_registration
        `;
      }
    }
    for (const privilege of DEFAULT_PRIVILEGES) {
      await tx`
        insert into privilege_catalog (id, tenant_id, code, name, category, requires_credential, description)
        values (${hashId(`privilege-${privilege.code}`)}, ${tenantA}, ${privilege.code}, ${privilege.name},
          ${privilege.category}, ${privilege.requiresCredential}, 'Synthetic privilege catalogue entry')
        on conflict (tenant_id, code) do nothing
      `;
    }
    await tx`
      insert into job_titles (id, tenant_id, name, cadre_id, code, catalogue_code, seniority,
        requires_credential, privilege_codes, suggested_system_roles)
      values (${hashId("job-title-medical-officer")}, ${tenantA}, 'Medical officer', ${hashId("cadre-MED-OFF")},
        'MED-OFF-STD', 'MED-OFF-STD', 'standard', true,
        ${["CLIN-ASSESS", "CLIN-SIGN", "PRESCRIBE", "ORDER-DIAG"]}, ${["clinician"]})
      on conflict (tenant_id, name) do update set code = excluded.code, catalogue_code = excluded.catalogue_code,
        seniority = excluded.seniority, requires_credential = excluded.requires_credential,
        privilege_codes = excluded.privilege_codes, suggested_system_roles = excluded.suggested_system_roles
    `;

    await context(tx, tenantA, users.hr, ["hr"], null);
    await tx`
      insert into staff_persons (id, staff_ref, user_id, given_name, family_name, professional_display_name, email, phone, identity_verification_method, identity_verified_at)
      values
        (${staffClinician}, 'STF-KAMP-0001', ${users.clinician}, 'Daniel', 'Okello', 'Dr Daniel Okello', 'clinician@medveris.local', '+256-700-000-101', 'synthetic-seed', now()),
        (${staffNurse}, 'STF-KAMP-0002', ${users.nurse}, 'Sarah', 'Atim', 'Nurse Sarah Atim', 'nurse@medveris.local', '+256-700-000-102', 'synthetic-seed', now()),
        (${staffPending}, 'STF-KAMP-0003', null, 'Joan', 'Adero', 'Ms Joan Adero', 'joan.dero@example.test', '+256-700-000-103', null, null)
      on conflict (id) do update set professional_display_name = excluded.professional_display_name
    `;
    await tx`
      insert into engagements (id, tenant_id, staff_person_id, employee_number, engagement_type, employer, start_date, status, job_title_id, approved_by, approved_at)
      values
        (${engagementClinician}, ${tenantA}, ${staffClinician}, 'EMP-0001', 'employee', 'Medveris Synthetic Health Group', current_date - 400, 'active', ${hashId("job-title-medical-officer")}, ${users.admin}, now()),
        (${engagementNurse}, ${tenantA}, ${staffNurse}, 'EMP-0002', 'employee', 'Medveris Synthetic Health Group', current_date - 300, 'active', null, ${users.admin}, now()),
        (${engagementPending}, ${tenantA}, ${staffPending}, 'EMP-0003', 'employee', 'Medveris Synthetic Health Group', current_date, 'pending', null, null, null)
      on conflict (id) do update set status = excluded.status, approved_by = excluded.approved_by, approved_at = excluded.approved_at
    `;
    await tx`
      insert into department_assignments (id, tenant_id, engagement_id, department_id, unit_id, is_primary, appointment_title, starts_on, created_by)
      values
        (${hashId("assignment-clinician")}, ${tenantA}, ${engagementClinician}, ${hashId("department-OPD")}, ${hashId("unit-OPD-OPD-GEN")}, true, 'Medical officer', current_date - 400, ${users.hr}),
        (${hashId("assignment-nurse")}, ${tenantA}, ${engagementNurse}, ${hashId("department-WARD")}, ${hashId("unit-WARD-WARD-GEN")}, true, 'Ward nurse', current_date - 300, ${users.hr}),
        (${hashId("assignment-pending")}, ${tenantA}, ${engagementPending}, ${hashId("department-MAT")}, ${hashId("unit-MAT-MAT-LD")}, true, 'Midwife', current_date, ${users.hr})
      on conflict (id) do nothing
    `;
    await tx`
      insert into onboarding_cases (id, tenant_id, staff_person_id, engagement_id, status, current_step, data, created_by)
      values (${onboardingPending}, ${tenantA}, ${staffPending}, ${engagementPending}, 'professional', 4,
        ${tx.json({ cadreId: hashId("cadre-MIDWIFE"), source: "synthetic-seed" })}, ${users.hr})
      on conflict (id) do nothing
    `;
    await tx`
      insert into privilege_grants (id, tenant_id, engagement_id, privilege_id, status, requested_by)
      values (${hashId("privilege-request-clinician")}, ${tenantA}, ${engagementClinician}, ${hashId("privilege-CLIN-SIGN")}, 'requested', ${users.hr})
      on conflict (id) do nothing
    `;
    await tx`
      insert into training_records (id, tenant_id, engagement_id, training_type, completed_on, expires_on, verified_by, verified_at)
      values (${hashId("training-ipc-nurse")}, ${tenantA}, ${engagementNurse}, 'Infection prevention and control induction', current_date - 20, current_date + 345, ${users.quality}, now())
      on conflict (id) do nothing
    `;

    await context(tx, tenantA, users.admin, ["facility_admin"], null);
    const templateFields = [
      { key: "presenting_complaint", label: "Presenting complaint", type: "textarea", required: true, section: "History" },
      { key: "assessment", label: "Assessment", type: "textarea", required: true, section: "Clinical" },
      { key: "plan", label: "Plan", type: "textarea", required: true, section: "Plan" },
    ];
    await tx`
      insert into document_templates (id, tenant_id, template_key, name, description, department_id, context, purpose, sensitivity, status, current_version, created_by)
      values (${templateA}, ${tenantA}, 'opd.consultation-note', 'Outpatient consultation note', 'Structured synthetic outpatient note', ${hashId("department-OPD")},
        'clinical', 'Document an outpatient consultation', 'standard', 'published', 1, ${users.admin})
      on conflict (id) do nothing
    `;
    await tx`
      insert into document_template_versions (id, template_id, tenant_id, version, fields, author_roles, reviewer_roles,
        signing_required, countersign_required, retention_class, published_at, approved_by, approved_at, created_by)
      values (${templateVersionA}, ${templateA}, ${tenantA}, 1, ${tx.json(templateFields as never)}, ${["clinician","nurse"]}, ${["clinician"]},
        true, false, 'clinical-standard', now(), ${users.admin}, now(), ${users.admin})
      on conflict (id) do nothing
    `;
    const documentContent = {
      presenting_complaint: "Synthetic follow-up for raised blood pressure.",
      assessment: "Blood pressure improving on current synthetic treatment.",
      plan: "Continue treatment, review in four weeks.",
    };
    await tx`
      insert into documents (id, tenant_id, template_id, template_version_id, department_id, subject_type, patient_id, encounter_id, title, occurred_at, status, current_version, author_user_id)
      values (${documentA}, ${tenantA}, ${templateA}, ${templateVersionA}, ${hashId("department-OPD")}, 'patient', ${patients.amina}, ${encounterA},
        'Outpatient consultation note', now(), 'draft', 1, ${users.admin})
      on conflict (id) do nothing
    `;
    await tx`
      insert into document_versions (id, document_id, tenant_id, version, status, content, content_digest, change_note, author_user_id)
      values (${hashId("document-version-amina-1")}, ${documentA}, ${tenantA}, 1, 'draft', ${tx.json(documentContent as never)},
        ${await contentDigest(documentContent)}, 'Initial synthetic draft', ${users.admin})
      on conflict (id) do nothing
    `;

    await context(tx, tenantA, users.nurse, ["nurse"], null);
    await tx`
      insert into maternity_episodes (id, tenant_id, patient_id, gravidity, parity, estimated_due_date, dating_basis, risk_level, status, admitted_at, notes, created_by)
      values (${maternityGrace}, ${tenantA}, ${patients.grace}, 2, 1, current_date + 21, 'ultrasound', 'low', 'active', now(),
        'Synthetic active maternity episode', ${users.nurse})
      on conflict (id) do nothing
    `;
    await tx`
      insert into labour_observations (id, tenant_id, episode_id, template_type, clinical_occurred_at, maternal, fetal, notes, recorded_by)
      values (${hashId("labour-observation-grace-1")}, ${tenantA}, ${maternityGrace}, 'partograph', now(),
        ${tx.json({ cervixCm: 4, contractionsPer10Min: 3, bloodPressureSystolic: 118, bloodPressureDiastolic: 74 } as never)},
        ${tx.json({ heartRate: 142, presentation: "cephalic" } as never)}, 'Synthetic labour observation', ${users.nurse})
      on conflict (id) do nothing
    `;

    await context(tx, tenantA, users.housekeeping, ["housekeeping"], null);
    await tx`
      insert into cleaning_tasks (id, tenant_id, bed_id, zone, task_type, risk_level, status, assigned_to_user_id, instructions, created_by)
      values (${hashId("cleaning-bed-a2")}, ${tenantA}, ${bedA2}, 'Ward A', 'routine', 'low', 'assigned', ${users.housekeeping},
        'Routine synthetic bed-area cleaning', ${users.housekeeping})
      on conflict (id) do nothing
    `;

    await context(tx, tenantA, users.porter, ["porter"], null);
    await tx`
      insert into porter_tasks (id, tenant_id, request_type, patient_id, from_location, to_location, status, assigned_to_user_id, requested_by, notes)
      values (${hashId("porter-task-amina")}, ${tenantA}, 'patient-transfer', ${patients.amina}, 'Outpatient clinic', 'Ward A',
        'requested', ${users.porter}, ${users.porter}, 'Synthetic porter request')
      on conflict (id) do nothing
    `;

    await context(tx, tenantA, users.mortuary, ["mortuary"], null);
    await tx`
      insert into mortuary_cases (id, tenant_id, case_ref, deceased_name, identity_status, received_from, storage_location, status, death_confirmed_at, notes, created_by)
      values (${mortarCaseA}, ${tenantA}, 'MOR-2026-00001', 'Unidentified synthetic adult', 'provisional', 'Emergency department',
        'Mortuary bay 1', 'in-custody', now(), 'Synthetic mortuary custody record', ${users.mortuary})
      on conflict (id) do nothing
    `;
    await tx`
      insert into mortuary_movements (id, tenant_id, case_id, movement_type, to_location, identity_checked, verified_by, notes)
      values (${hashId("mortuary-receipt-1")}, ${tenantA}, ${mortarCaseA}, 'receipt', 'Mortuary bay 1', false, ${users.mortuary}, 'Initial synthetic receipt')
      on conflict (id) do nothing
    `;

    await context(tx, tenantA, users.biomedical, ["biomedical"], null);
    await tx`
      insert into engineering_assets (id, tenant_id, asset_ref, name, category, location, next_maintenance_on, created_by)
      values (${assetA}, ${tenantA}, 'ENG-SYNTH-001', 'Synthetic vital-signs monitor', 'monitoring', 'Ward A', current_date + 30, ${users.biomedical})
      on conflict (id) do nothing
    `;
    await tx`
      insert into maintenance_work_orders (id, tenant_id, asset_id, fault, priority, status, created_by)
      values (${hashId("maintenance-monitor-1")}, ${tenantA}, ${assetA}, 'Synthetic intermittent display fault', 'urgent', 'open', ${users.biomedical})
      on conflict (id) do nothing
    `;

    await context(tx, tenantA, users.cssd, ["cssd"], null);
    await tx`
      insert into cssd_cycles (id, tenant_id, sterilizer, cycle_ref, load_count, indicator_result, status, notes, created_by)
      values (${hashId("cssd-cycle-1")}, ${tenantA}, 'Sterilizer 1', 'CSSD-2026-0001', 12, 'pending', 'quarantined', 'Synthetic pending biological indicator', ${users.cssd})
      on conflict (id) do nothing
    `;

    await context(tx, tenantA, users.laboratory, ["laboratory"], null);
    await tx`
      insert into lab_tests (id, tenant_id, name, loinc_version, loinc_code, specimen_type, unit_code, mapped_reviewed, created_by)
      values (${labTestA}, ${tenantA}, 'Blood glucose', '2.80-medveris-synthetic', '2339-0', 'capillary blood', 'mg/dL', true, ${users.laboratory})
      on conflict (id) do nothing
    `;

    await context(tx, tenantA, users.pharmacist, ["pharmacist"], null);
    await tx`
      insert into medicines (id, tenant_id, name, strength, form, route, knowledge_source, created_by)
      values (${medicineA}, ${tenantA}, 'Amlodipine', '5 mg', 'tablet', 'oral', 'Synthetic formulary entry; no real dosing advice', ${users.pharmacist})
      on conflict (id) do nothing
    `;
    await tx`
      insert into stock_lots (id, tenant_id, medicine_id, lot_number, expires_on, quantity, location)
      values (${lotA}, ${tenantA}, ${medicineA}, 'LOT-SYNTH-001', ${new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10)}, 100, 'Pharmacy main')
      on conflict (id) do nothing
    `;

    await context(tx, tenantA, users.clinician, ["clinician"], null);
    await tx`
      insert into programmes (id, tenant_id, name, programme_type, description, created_by)
      values (${programmeA}, ${tenantA}, 'Hypertension continuing care', 'chronic', 'Synthetic chronic-care programme', ${users.clinician})
      on conflict (id) do nothing
    `;
    await tx`
      insert into programme_enrolments (id, tenant_id, patient_id, programme_id, notes, enrolled_by)
      values (${hashId("enrol-amina-htn")}, ${tenantA}, ${patients.amina}, ${programmeA}, 'Synthetic continuing-care enrolment', ${users.clinician})
      on conflict (tenant_id, patient_id, programme_id) do nothing
    `;
    await tx`
      insert into theatre_cases (id, tenant_id, patient_id, encounter_id, procedure_name, procedure_coding, laterality, site, urgency, scheduled_at, theatre_id, surgeon_user_id, anesthetist_user_id, created_by)
      values (${hashId("theatre-grace")}, ${tenantA}, ${patients.grace}, ${encounterGrace}, 'Diagnostic laparoscopy',
        ${tx.json({ system: "http://snomed.info/sct", code: "103693007", display: "Diagnostic procedure" })}, 'not-applicable',
        'Abdomen', 'routine', ${new Date(Date.now() + 2 * 86_400_000)}, ${theatreA}, ${users.clinician}, ${users.clinician}, ${users.clinician})
      on conflict (id) do nothing
    `;
    await tx`
      insert into telehealth_sessions (id, tenant_id, patient_id, clinician_user_id, scheduled_at, created_by)
      values (${hashId("telehealth-amina")}, ${tenantA}, ${patients.amina}, ${users.clinician}, ${new Date(Date.now() + 3 * 86_400_000)}, ${users.clinician})
      on conflict (id) do nothing
    `;

    await context(tx, tenantA, users.admin, ["facility_admin"], null);
    await tx`
      insert into integration_configs (id, tenant_id, adapter, enabled, config, configured_by)
      values (${hashId("integration-lab")}, ${tenantA}, 'laboratory', false, ${tx.json({ status: "disabled", displayName: "Laboratory results", note: "Integration unavailable in this release" })}, ${users.admin})
      on conflict (id) do nothing
    `;

    // Public provider directory, sponsored placement and integration catalogue.
    await platformContext(tx, users.reviewer);
    const facilities = {
      kampala: hashId("dir-facility-kampala"),
      entebbe: hashId("dir-facility-entebbe"),
      naguru: hashId("dir-facility-naguru"),
      jinja: hashId("dir-facility-jinja"),
    } as const;
    const branches = {
      kampala: hashId("dir-branch-kampala"),
      entebbe: hashId("dir-branch-entebbe"),
      naguru: hashId("dir-branch-naguru"),
      jinja: hashId("dir-branch-jinja"),
    } as const;
    await tx`
      insert into directory_facilities (
        id, public_id, slug, name, facility_type, description, country, region, district, locality,
        public_phone, public_email, website, medveris_participation, publication_status, status,
        claimed_tenant_id, claimed_by_user_id, credential_status, capability_status, source_kind,
        source_name, source_license, last_confirmed_on, next_confirmation_on, created_by
      ) values
        (${facilities.kampala}, 'MV-DIR-KLA-01', 'kampala-community-clinic', 'Kampala Community Clinic',
         'clinic', 'Synthetic public listing for a Medveris-connected outpatient clinic.', 'Uganda', 'Central',
         'Kampala', 'Kampala Central', '+256-000-000-101', 'directory@kampala.example', 'https://kampala.example',
         'direct', 'published', 'active', ${tenantA}, ${users.admin}, 'verified', 'verified', 'medveris-registered',
         'Medveris synthetic seed', 'Synthetic data', current_date, current_date + 180, ${users.reviewer}),
        (${facilities.entebbe}, 'MV-DIR-ENT-01', 'entebbe-family-health-centre', 'Entebbe Family Health Centre',
         'health-centre', 'Synthetic family health centre listing.', 'Uganda', 'Central', 'Wakiso', 'Entebbe',
         '+256-000-000-102', 'directory@entebbe.example', null, 'connected', 'published', 'active',
         ${tenantB}, ${users.admin}, 'verified', 'documented', 'medveris-registered',
         'Medveris synthetic seed', 'Synthetic data', current_date, current_date + 180, ${users.reviewer}),
        (${facilities.naguru}, 'MV-DIR-NAG-01', 'naguru-diagnostic-centre', 'Naguru Diagnostic Centre',
         'diagnostic-centre', 'Synthetic diagnostic centre with imaging and laboratory services.', 'Uganda', 'Central',
         'Kampala', 'Naguru', '+256-000-000-103', null, null, 'none', 'published', 'active', null, null,
         'unverified', 'declared', 'facility-submitted', 'Facility submission', null, current_date, current_date + 90, ${users.reviewer}),
        (${facilities.jinja}, 'MV-DIR-JIN-01', 'jinja-road-pharmacy', 'Jinja Road Pharmacy',
         'pharmacy', 'Synthetic community pharmacy pending editorial review.', 'Uganda', 'Central',
         'Kampala', 'Jinja Road', '+256-000-000-104', null, null, 'none', 'pending-review', 'active', null, null,
         'unverified', 'none', 'facility-submitted', 'Facility submission', null, null, current_date + 90, ${users.reviewer})
      on conflict (public_id) do update set name = excluded.name, description = excluded.description,
        publication_status = excluded.publication_status, claimed_tenant_id = excluded.claimed_tenant_id,
        credential_status = excluded.credential_status, capability_status = excluded.capability_status,
        last_confirmed_on = excluded.last_confirmed_on, updated_at = now()
    `;
    await tx`
      insert into directory_branches (
        id, facility_id, name, is_primary, address_line1, city, region, district, locality, country,
        latitude, longitude, coordinate_source, location_status, public_phone, opening_hours, accessibility
      ) values
        (${branches.kampala}, ${facilities.kampala}, 'Kampala Central', true, 'Plot 10 Synthetic Road', 'Kampala',
         'Central', 'Kampala', 'Kampala Central', 'Uganda', 0.313600, 32.581100, 'facility-supplied', 'confirmed',
         '+256-000-000-101', ${tx.json({ mon: "08:00-18:00", tue: "08:00-18:00", wed: "08:00-18:00", thu: "08:00-18:00", fri: "08:00-18:00", sat: "09:00-14:00" })},
         ${tx.json({ wheelchairAccess: true, parking: true })}),
        (${branches.entebbe}, ${facilities.entebbe}, 'Entebbe Main', true, 'Plot 4 Synthetic Avenue', 'Entebbe',
         'Central', 'Wakiso', 'Entebbe', 'Uganda', 0.051200, 32.463700, 'facility-supplied', 'confirmed',
         '+256-000-000-102', ${tx.json({ mon: "08:00-17:00", tue: "08:00-17:00", wed: "08:00-17:00", thu: "08:00-17:00", fri: "08:00-17:00" })},
         ${tx.json({ wheelchairAccess: true })}),
        (${branches.naguru}, ${facilities.naguru}, 'Naguru Main', true, 'Plot 22 Synthetic Close', 'Kampala',
         'Central', 'Kampala', 'Naguru', 'Uganda', 0.347600, 32.600000, 'map-pin', 'unconfirmed',
         '+256-000-000-103', ${tx.json({ mon: "07:00-20:00", tue: "07:00-20:00", wed: "07:00-20:00", thu: "07:00-20:00", fri: "07:00-20:00", sat: "08:00-14:00" })},
         ${tx.json({})}),
        (${branches.jinja}, ${facilities.jinja}, 'Jinja Road', true, 'Plot 8 Synthetic Plaza', 'Kampala',
         'Central', 'Kampala', 'Jinja Road', 'Uganda', 0.326000, 32.610000, 'facility-supplied', 'unconfirmed',
         '+256-000-000-104', ${tx.json({ mon: "08:00-20:00", tue: "08:00-20:00", wed: "08:00-20:00", thu: "08:00-20:00", fri: "08:00-20:00", sat: "08:00-18:00" })},
         ${tx.json({})})
      on conflict (facility_id, name) do update set latitude = excluded.latitude, longitude = excluded.longitude,
        location_status = excluded.location_status, opening_hours = excluded.opening_hours, updated_at = now()
    `;
    await tx`
      insert into directory_services (id, facility_id, code, name, category, description, availability_note)
      values
        (${hashId("dir-svc-kla-opd")}, ${facilities.kampala}, 'OPD', 'Outpatient consultations', 'outpatient', 'General outpatient care (synthetic listing).', 'Weekday walk-in and appointment slots'),
        (${hashId("dir-svc-kla-mat")}, ${facilities.kampala}, 'MAT', 'Maternal health', 'maternal', 'Antenatal and postnatal care (synthetic listing).', null),
        (${hashId("dir-svc-kla-lab")}, ${facilities.kampala}, 'LAB', 'Laboratory testing', 'diagnostics', 'Routine laboratory testing (synthetic listing).', null),
        (${hashId("dir-svc-ent-opd")}, ${facilities.entebbe}, 'OPD', 'Family outpatient care', 'outpatient', 'Family outpatient care (synthetic listing).', null),
        (${hashId("dir-svc-ent-chd")}, ${facilities.entebbe}, 'CHD', 'Child health', 'child-health', 'Child health and immunisation (synthetic listing).', null),
        (${hashId("dir-svc-nag-img")}, ${facilities.naguru}, 'IMG', 'Diagnostic imaging', 'diagnostics', 'Imaging services (synthetic listing).', 'Referral may be required'),
        (${hashId("dir-svc-nag-lab")}, ${facilities.naguru}, 'LAB', 'Laboratory testing', 'diagnostics', 'Laboratory testing (synthetic listing).', null),
        (${hashId("dir-svc-jin-phm")}, ${facilities.jinja}, 'PHM', 'Community pharmacy', 'pharmacy', 'Community pharmacy (synthetic listing).', null)
      on conflict (facility_id, code) do update set name = excluded.name, category = excluded.category, updated_at = now()
    `;
    await tx`
      insert into directory_capabilities (id, facility_id, code, name, status, evidence_source, verified_at, verified_by, notes)
      values
        (${hashId("dir-cap-kla-emg")}, ${facilities.kampala}, 'emergency', 'Emergency care', 'verified', 'Synthetic verification record', now(), ${users.reviewer}, null),
        (${hashId("dir-cap-kla-img")}, ${facilities.kampala}, 'imaging', 'Diagnostic imaging', 'verified', 'Synthetic verification record', now(), ${users.reviewer}, null),
        (${hashId("dir-cap-kla-lab")}, ${facilities.kampala}, 'laboratory', 'Laboratory services', 'verified', 'Synthetic verification record', now(), ${users.reviewer}, null),
        (${hashId("dir-cap-ent-lab")}, ${facilities.entebbe}, 'laboratory', 'Laboratory services', 'documented', 'Synthetic document reference', null, null, null),
        (${hashId("dir-cap-nag-img")}, ${facilities.naguru}, 'imaging', 'Diagnostic imaging', 'declared', 'Facility declaration', null, null, null)
      on conflict (facility_id, code) do update set name = excluded.name, status = excluded.status, updated_at = now()
    `;

    const searchPackage = hashId("sponsored-package-search");
    const campaignId = hashId("sponsored-campaign-kampala");
    const paymentId = hashId("sponsored-payment-kampala");
    await tx`
      insert into sponsored_packages (
        id, code, name, description, price, currency, duration_days, eligible_countries,
        eligible_facility_types, eligible_service_categories, placement_surface, sponsored_slots,
        max_active_per_facility, requirements, cancellation_policy, active, created_by
      ) values (
        ${searchPackage}, 'SEARCH-BOOST-30', 'Search boost (30 days)',
        'Up to two clearly labelled sponsored placements in directory search for 30 days.',
        150000, 'UGX', 30, ${["Uganda"]}, ${["clinic", "hospital", "health-centre"]}, ${[]},
        'search', 2, 1, 'Listing must be published and pass editorial review.',
        'No refund after the campaign starts. Editorial approval is independent of payment.',
        true, ${users.reviewer}
      )
      on conflict (code) do update set name = excluded.name, price = excluded.price, currency = excluded.currency,
        sponsored_slots = excluded.sponsored_slots, active = excluded.active, updated_at = now()
    `;
    await tx`
      insert into sponsored_campaigns (
        id, package_id, facility_id, branch_id, package_name_snapshot, amount_snapshot, currency_snapshot,
        duration_days_snapshot, placement_surface, sponsored_slots, scope_country, service_categories,
        starts_on, ends_on, status, payment_status, editorial_status, created_by, reviewed_by, reviewed_at
      ) values (
        ${campaignId}, ${searchPackage}, ${facilities.kampala}, ${branches.kampala}, 'Search boost (30 days)',
        150000, 'UGX', 30, 'search', 2, 'Uganda', ${["outpatient", "maternal", "diagnostics"]},
        current_date - 1, current_date + 29, 'active', 'paid', 'approved', ${users.admin}, ${users.reviewer}, now()
      )
      on conflict (id) do update set status = excluded.status, payment_status = excluded.payment_status,
        editorial_status = excluded.editorial_status, starts_on = excluded.starts_on, ends_on = excluded.ends_on, updated_at = now()
    `;
    await tx`
      insert into sponsored_payments (
        id, campaign_id, amount, currency, method, provider, provider_reference, status, idempotency_key, confirmed_by, confirmed_at, notes
      ) values (
        ${paymentId}, ${campaignId}, 150000, 'UGX', 'manual', 'manual', 'SYNTH-SPONSOR-0001', 'confirmed',
        'seed:sponsorship:kampala:0001', ${users.finance}, now(), 'Synthetic payment record; no real funds moved'
      )
      on conflict (idempotency_key) do nothing
    `;

    await tx`
      insert into api_products (
        id, code, name, description, service_family, data_classification, required_scopes,
        rate_limit_per_minute, daily_quota, support_level, sandbox_available, commercial_status, enabled
      ) values
        (${hashId("api-product-directory")}, 'directory.read', 'Public directory read',
         'Read published facility, branch, service and capability information.',
         'directory', 'directory', ${["integration.directory.read"]}, 120, 20000, 'standard', true, 'included', true),
        (${hashId("api-product-patient-match")}, 'patient.identity', 'Patient identity matching',
         'Match and link partner patient identifiers after human confirmation. Never returns clinical records.',
         'identity', 'clinical', ${["integration.patient.match", "integration.patient.link"]},
         60, 5000, 'standard', true, 'included', true)
      on conflict (code) do update set name = excluded.name, description = excluded.description,
        required_scopes = excluded.required_scopes, enabled = excluded.enabled, updated_at = now()
    `;
  });

  if (totpExportFile) {
    writeFileSync(totpExportFile, JSON.stringify(Object.fromEntries(seededTotp), null, 2), { mode: 0o600 });
    chmodSync(totpExportFile, 0o600);
  }

  console.log(JSON.stringify({
    ok: true,
    synthetic: true,
    password: stagingSeed ? "(SEED_ACCOUNT_PASSWORD)" : PASSWORD,
    totpSecrets: totpExportFile ? `written to ${totpExportFile} (0600)` : "local development endpoint",
    facilities: { kampala: tenantA, entebbe: tenantB },
    accounts: {
      admin: "admin@medveris.local",
      clinician: "clinician@medveris.local",
      reception: "reception@medveris.local",
      nurse: "nurse@medveris.local",
      clinicianB: "clinician.b@medveris.local",
      reviewer: "reviewer@medveris.local",
      patient: "patient@medveris.local",
      finance: "finance@medveris.local",
      pharmacist: "pharmacist@medveris.local",
      laboratory: "lab@medveris.local",
      radiology: "radiology@medveris.local",
      publicHealth: "publichealth@medveris.local",
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
