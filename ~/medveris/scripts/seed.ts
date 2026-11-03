import { hashId } from "@medveris/db";
import type { Tenant } from "@medveris/db";
import { context, tx } from "@medveris/db";

export async function seedClinician(ctx: { tenant: Tenant }, users: { clinician: string }) {
  await context(tx, ctx.tenant, users.clinician, ["clinician"], null);

  await tx`
    insert into credentials (id, subject_type, subject_user_id, submitted_by, credential_type, issuer, jurisdiction,
      credential_number, scope, issued_on, expires_on, status)
    values (${hashId("credential-clinician")}, 'practitioner', ${users.clinician}, ${users.clinician}, 'Medical licence',
      'Uganda Medical and Dental Practitioners Council', 'Uganda', 'SYNTH-UMDPC-0001', 'General outpatient medicine',
      '2022-01-15', '2027-01-14', 'verified')
    on conflict (id) do nothing
  `;
}
