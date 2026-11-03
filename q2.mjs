import { Client } from 'pg';
const url = process.env.DATABASE_URL;
const u = new URL(url);
const client = new Client({ host: u.hostname, port: u.port, database: u.pathname.slice(1), user: 'medveris_runtime', password: 'medveris_runtime_dev' });
await client.connect();
try {
  await client.query("BEGIN");
  const orgId = 'a0000000-b000-4000-8000-000000000001';
  await client.query(`select set_config('app.tenant_id', '11111111-1111-4111-8111-111111111111', true), set_config('app.user_id', '', true), set_config('app.actor_kind', 'staff', true)`);
  const r = await client.query('insert into organizations (id, name, legal_name, registration_ref, country) values ($1, $2, $3, $4, $5)', [orgId, 'X', null, null, 'Uganda']);
  console.log("INSERT OK", r.command);
  await client.query("ROLLBACK");
} catch(e) {
  await client.query("ROLLBACK").catch(()=>{});
  console.log("INSERT FAILED:", e.message.split('\n')[0]);
}
await client.end();
