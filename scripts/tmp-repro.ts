process.loadEnvFile(".env");
process.env.APP_ENV = "test";
process.env.DEV_SHOW_TOTP_SECRETS = "true";
import { createHarness } from "../tests/integration/support.js";

const h = createHarness("repro");
const session = await h.login("clinician@medveris.local");
const rows = await h.sql`
  select id from encounters where tenant_id = '11111111-1111-4111-8111-111111111111'
   order by opened_at desc limit 1`;
const id = rows[0]?.id as string | undefined;
console.log("encounter id:", id);

const paths = [
  "/api/v1/me",
  `/api/v1/encounters/${id}`,
  `/api/v1/encounters/${id}/workflow`,
  "/api/v1/service-catalog?active=true",
];

for (const path of paths) {
  const response = await h.call(session, path);
  const text = await response.text();
  console.log(`\n${response.status} ${path}\n  ${text.slice(0, 300)}`);
}
await h.sql.end({ timeout: 5 });
