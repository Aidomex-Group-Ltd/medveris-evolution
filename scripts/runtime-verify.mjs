/**
 * End-to-end check of the scaling features in a real Workers runtime (`wrangler dev`, or staging
 * with synthetic accounts): Worker cache, Durable Object rate limiting under concurrency,
 * authenticated WebSockets, outbox -> queue -> consumer -> hub delivery, resume/replay, and
 * handshake refusals. Prints statuses and counts only; never tokens, cookies or record content.
 *
 *   VERIFY_ORIGIN=http://localhost:8799 node scripts/runtime-verify.mjs
 *
 * Local runs need `wrangler dev --test-scheduled` with APP_ENV=test, DEV_SHOW_TOTP_SECRETS=true,
 * REALTIME_ENABLED=true and REALTIME_EVENT_TYPES including maintenance.runtime-verify, plus
 * JOBS_DATABASE_URL to insert synthetic outbox events.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import WebSocket from "ws";

try {
  process.loadEnvFile(`${process.cwd()}/.env`);
} catch {
  /* environment may be supplied externally */
}

const origin = process.env.VERIFY_ORIGIN ?? "http://localhost:8799";
const TENANT = process.env.VERIFY_TENANT_ID ?? "11111111-1111-4111-8111-111111111111";
const EVENT_TYPE = "maintenance.runtime-verify";
const results = [];

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

async function json(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

function cookieFrom(response) {
  return (response.headers.getSetCookie?.() ?? []).find((value) => value.startsWith("mv_session="))?.split(";")[0] ?? null;
}

async function login(email) {
  const challenge = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "Medveris!2026" }),
  });
  const body = await json(challenge);
  if (!body.mfaRequired) return { cookie: cookieFrom(challenge), csrf: body.csrfToken };
  const { code } = await json(await fetch(`${origin}/api/v1/auth/totp/dev?email=${encodeURIComponent(email)}`));
  const mfa = await fetch(`${origin}/api/v1/auth/login/mfa`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: body.challengeId, code }),
  });
  const verified = await json(mfa);
  return { cookie: cookieFrom(mfa), csrf: verified.csrfToken };
}

async function ticket(session) {
  const response = await fetch(`${origin}/api/v1/realtime/tickets`, {
    method: "POST",
    headers: { cookie: session.cookie, "x-medveris-csrf": session.csrf, "content-type": "application/json" },
    body: "{}",
  });
  return { status: response.status, body: await json(response) };
}

function open(session, issued, { originHeader = origin } = {}) {
  const url = new URL(issued.path, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url, [issued.protocol, `ticket.${issued.ticket}`], { headers: { cookie: session.cookie, origin: originHeader } });
  const messages = [];
  const waiters = [];
  socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.match(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  const opened = new Promise((resolve) => {
    socket.on("open", () => resolve({ ok: true }));
    socket.on("unexpected-response", (_request, response) => resolve({ ok: false, status: response.statusCode }));
    socket.on("error", () => resolve({ ok: false, status: 0 }));
  });
  const next = (match, timeoutMs = 15_000) => {
    const existing = messages.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve };
      waiters.push(waiter);
      setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
    });
  };
  return { socket, messages, opened, next, send: (value) => socket.send(JSON.stringify(value)) };
}

async function insertEvent(client) {
  const id = randomUUID();
  await client.query(
    `insert into outbox_events (id, tenant_id, event_type, aggregate_id, payload, occurred_at, next_attempt_at)
     values ($1, $2, $3, $4, '{"synthetic":true}'::jsonb, '2000-01-01', '2000-01-01')`,
    [id, TENANT, EVENT_TYPE, randomUUID()],
  );
  return id;
}

async function runCron() {
  const response = await fetch(`${origin}/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*`);
  return response.status;
}

async function waitForStatus(client, id, wanted, timeoutMs = 30_000) {
  const started = Date.now();
  for (;;) {
    const { rows } = await client.query("select status from outbox_events where id = $1", [id]);
    if (rows[0]?.status === wanted) return true;
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const db = new pg.Client({ connectionString: process.env.JOBS_DATABASE_URL });
await db.connect();
try {
  // Worker cache: allowlisted anonymous route, second request served by the Cache API.
  await fetch(`${origin}/api/v1/public/directory/meta`);
  const cached = await fetch(`${origin}/api/v1/public/directory/meta`);
  record("worker cache serves the second anonymous request", cached.headers.get("x-medveris-cache") === "hit", `x-medveris-cache=${cached.headers.get("x-medveris-cache")}`);
  const signedInCache = await fetch(`${origin}/api/v1/public/directory/meta`, { headers: { cookie: "mv_session=not-a-real-session" } });
  record("credentialed requests bypass the shared cache", signedInCache.headers.get("x-medveris-cache") === null && signedInCache.headers.get("cache-control") === "no-store, private");

  const reception = await login("reception@medveris.local");
  record("synthetic staff sign-in", Boolean(reception.cookie && reception.csrf));

  // Real-time: ticket, handshake, subscription authorization.
  const issued = await ticket(reception);
  record("ticket issued to signed-in staff", issued.status === 200 && issued.body.channels?.includes("tenant"), `status=${issued.status}`);
  const live = open(reception, issued.body);
  const opened = await live.opened;
  record("authenticated WebSocket accepted", opened.ok, opened.ok ? "" : `status=${opened.status}`);
  await live.next((message) => message.type === "ready");
  live.send({ type: "subscribe", channel: "operations" });
  const forbidden = await live.next((message) => message.type === "error");
  record("unauthorised channel refused", forbidden.code === "forbidden-channel");
  live.send({ type: "subscribe", channel: "tenant", tenantId: TENANT });
  const invalid = await live.next((message) => message.type === "error" && message.code === "invalid-message");
  record("unexpected message fields rejected", Boolean(invalid));
  live.send({ type: "subscribe", channel: "tenant" });
  const subscribed = await live.next((message) => message.type === "subscribed");
  const baseSeq = subscribed.seq;

  const reuse = open(reception, issued.body);
  const reused = await reuse.opened;
  record("ticket cannot be used twice", !reused.ok, `status=${reused.status ?? "open"}`);
  reuse.socket.terminate();

  const crossIssued = await ticket(reception);
  const cross = open(reception, crossIssued.body, { originHeader: "https://evil.example" });
  const crossOpened = await cross.opened;
  record("cross-origin handshake refused", !crossOpened.ok && crossOpened.status === 403, `status=${crossOpened.status}`);
  cross.socket.terminate();

  // Outbox -> queue -> consumer -> hub -> socket.
  const first = await insertEvent(db);
  record("cron relay accepted", (await runCron()) === 200);
  const delivered = await live.next((message) => message.type === "event" && message.event === EVENT_TYPE, 30_000).catch(() => null);
  record("committed outbox event delivered live through the queue", Boolean(delivered), delivered ? `seq=${delivered.seq}` : "no event");
  record("live event carries a reference, not record content", Boolean(delivered) && Object.keys(delivered).sort().join() === "at,channel,event,ref,seq,type");
  record("outbox row processed by the queue consumer", await waitForStatus(db, first, "processed"));

  // Disconnect, miss an event, reconnect and resume from the last sequence number.
  live.socket.close(1000);
  const second = await insertEvent(db);
  await runCron();
  await waitForStatus(db, second, "processed");
  const resumedTicket = await ticket(reception);
  const resumed = open(reception, resumedTicket.body);
  await resumed.opened;
  await resumed.next((message) => message.type === "ready");
  resumed.send({ type: "subscribe", channel: "tenant", afterSeq: delivered?.seq ?? baseSeq });
  const replayed = await resumed.next((message) => message.type === "event" && message.replayed === true, 10_000).catch(() => null);
  record("missed event replayed after reconnect", Boolean(replayed) && replayed.seq === (delivered?.seq ?? baseSeq) + 1, replayed ? `seq=${replayed.seq}` : "none");
  resumed.socket.close(1000);

  // Durable Object rate limiting: concurrent attempts from one address against one counter.
  const address = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
  const attempts = await Promise.all(Array.from({ length: 30 }, () => fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": address },
    body: JSON.stringify({ email: `nobody-${randomUUID()}@example.invalid`, password: "wrong-password-value" }),
  }).then((response) => response.status)));
  const limited = attempts.filter((status) => status === 429).length;
  const allowed = attempts.filter((status) => status === 401).length;
  record("rate limit admits exactly the policy limit under 30 concurrent attempts", allowed === 12 && limited === 18, `401=${allowed} 429=${limited}`);

  const ready = await json(await fetch(`${origin}/api/v1/health/ready`));
  record("readiness reports the primary and replica state", ready.status === "ready" && ready.replica === "absent", JSON.stringify(ready));
} finally {
  await db.end();
}

const failed = results.filter((result) => !result.ok);
console.log(JSON.stringify({ origin, passed: results.length - failed.length, failed: failed.length }));
process.exit(failed.length ? 1 : 0);
