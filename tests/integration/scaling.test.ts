import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  classifyProbe,
  createSql,
  DatabaseRouter,
  probeReplica,
  readAssignment,
  ReplicaHealthMonitor,
  setAssignmentState,
  ShardRouter,
  SINGLE_SHARD_TOPOLOGY,
  tenantFingerprint,
  withReadOnlyContext,
} from "@medveris/db";
import { createApp } from "../../apps/api/src/app.js";
import { LocalMailSink } from "../../apps/api/src/lib/local-email.js";
import { LocalStorage } from "../../apps/api/src/lib/local-storage.js";
import { CONTEXT_HEADER } from "../../apps/api/src/durable/realtime-hub.js";
import { handleRealtimeUpgrade } from "../../apps/api/src/realtime/upgrade.js";
import { REALTIME_PROTOCOL } from "../../apps/api/src/realtime/tickets.js";
import type { RealtimePublisher } from "../../apps/api/src/realtime/publisher.js";
import type { AppDeps } from "../../apps/api/src/types.js";
import { KAMPALA_TENANT, createHarness, type Session } from "./support.js";

const h = createHarness("scaling");
const TZ = "Africa/Kampala";
const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const migrator = createSql(process.env.MIGRATION_DATABASE_URL!, { max: 1 });
const unreachable = createSql("postgres://medveris_runtime:unused@127.0.0.1:1/medveris_dev", { max: 1, connectTimeoutSeconds: 2 });
const tmp = process.env.TMPDIR ?? "/tmp";

function appWith(overrides: Partial<AppDeps>) {
  const deps: AppDeps = {
    sql: h.sql,
    config: h.config,
    email: new LocalMailSink(`${tmp}/medveris-scaling-mail-${crypto.randomUUID()}`),
    storage: new LocalStorage(`${tmp}/medveris-scaling-storage-${crypto.randomUUID()}`),
    ...overrides,
  };
  return createApp(deps);
}

function call(app: ReturnType<typeof createApp>, session: Session | null, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (session) headers.set("cookie", session.cookie);
  if (session && init.method && init.method !== "GET") headers.set("x-medveris-csrf", session.csrf);
  if (init.body) headers.set("content-type", "application/json");
  return app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
}

let reception: Session;
let operator: Session;

beforeAll(async () => {
  reception = await h.login("reception@medveris.local");
  operator = await h.login("reviewer@medveris.local");
});

afterAll(async () => {
  await setAssignmentState(migrator, KAMPALA_TENANT, { state: "active", reason: "scaling test cleanup" }).catch(() => undefined);
  await Promise.all([h.sql.end({ timeout: 5 }), migrator.end({ timeout: 5 }), unreachable.end({ timeout: 1 })]);
});

describe("HTTP caching", () => {
  it("lets anonymous public reference data be cached with an ETag and answers revalidation with 304", async () => {
    const first = await h.app.fetch(new Request("http://localhost/api/v1/public/config"));
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toMatch(/^public, max-age=\d+/);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const revalidated = await h.app.fetch(new Request("http://localhost/api/v1/public/config", { headers: { "if-none-match": etag! } }));
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe("");
  });

  it("marks the same public route private when the caller is signed in, and every tenant or clinical route private", async () => {
    const signedIn = await h.call(reception, "/api/v1/public/config");
    expect(signedIn.headers.get("cache-control")).toBe("no-store, private");
    expect(signedIn.headers.get("etag")).toBeNull();
    for (const path of ["/api/v1/me", "/api/v1/queues", `/api/v1/reports/daily-activity?from=${today}&to=${today}&timeZone=${TZ}`]) {
      const response = await h.call(reception, path);
      expect(response.headers.get("cache-control"), path).toBe("no-store, private");
    }
    const located = await h.app.fetch(new Request("http://localhost/api/v1/public/directory/facilities?lat=0.31&lng=32.58"));
    expect(located.headers.get("cache-control")).toBe("no-store, private");
  });
});

describe("read routing", () => {
  it("identifies the local primary as not being a standby, so it is never used as a replica", async () => {
    const probe = await probeReplica(h.sql);
    expect(probe.inRecovery).toBe(false);
    expect(classifyProbe(probe, 5000, Date.now()).reason).toBe("not-a-standby");
  });

  it("runs stale-tolerant reads in a READ ONLY transaction with the caller's RLS context", async () => {
    await expect(withReadOnlyContext(h.sql, { tenantId: KAMPALA_TENANT, actorKind: "staff", roles: ["receptionist"] }, async (tx) => {
      await tx`insert into outbox_events (id, tenant_id, event_type) values (${crypto.randomUUID()}, ${KAMPALA_TENANT}, 'maintenance.read-only-probe')`;
    })).rejects.toMatchObject({ code: "25006" });
  });

  it("reports state their data source, and fall back to the primary when the replica fails mid-query", async () => {
    const options = { maxLagMs: 5000, healthTtlMs: 60_000, healthTimeoutMs: 500 };
    const healthy = new ReplicaHealthMonitor(options, async () => ({ inRecovery: true, lagMs: 10 }));
    const app = appWith({ db: new DatabaseRouter(h.sql, unreachable, healthy, options) });
    const response = await call(app, reception, `/api/v1/reports/daily-activity?from=${today}&to=${today}&timeZone=${TZ}`);
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.metadata.dataSource).toBe("primary");
    expect(healthy.snapshot()?.state).toBe("unhealthy");

    const plain = await h.expectOk(await h.call(reception, `/api/v1/reports/daily-activity?from=${today}&to=${today}&timeZone=${TZ}`));
    expect(plain.metadata).toMatchObject({ dataSource: "primary", maxStalenessSeconds: 0 });
  });

  it("keeps a session that just wrote on the primary for its read-your-writes window", async () => {
    const options = { maxLagMs: 5000, healthTtlMs: 60_000, healthTimeoutMs: 500 };
    const app = appWith({ db: new DatabaseRouter(h.sql, h.sql, new ReplicaHealthMonitor(options, async () => ({ inRecovery: true, lagMs: 0 })), options) });
    const write = await call(app, reception, "/api/v1/reception/patients", {
      method: "POST",
      body: JSON.stringify({ givenName: "Synthetic", familyName: `Ryw${Date.now()}`, dateOfBirth: "1990-01-01", sex: "female", identityConfidence: "confirmed-verbal" }),
    });
    expect(write.status).toBe(201);
    const cookie = write.headers.getSetCookie().find((value) => value.startsWith("mv_ryw="));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    const pinned = { ...reception, cookie: `${reception.cookie}; ${cookie!.split(";")[0]}` };
    const report = await (await call(app, pinned, `/api/v1/reports/daily-activity?from=${today}&to=${today}&timeZone=${TZ}`)).json();
    expect(report.metadata.dataSource).toBe("primary");
    const unpinned = await (await call(app, reception, `/api/v1/reports/daily-activity?from=${today}&to=${today}&timeZone=${TZ}`)).json();
    expect(unpinned.metadata.dataSource).toBe("replica");
  });
});

describe("tenant shard directory", () => {
  it("assigns every facility to the single shard and keeps the runtime role read-only on the directory", async () => {
    expect(await readAssignment(h.sql, KAMPALA_TENANT)).toMatchObject({ shardId: "primary" });
    await expect(h.sql`update tenant_shard_assignments set state = 'frozen' where tenant_id = ${KAMPALA_TENANT}`).rejects.toMatchObject({ code: "42501" });
    await expect(h.sql`select count(*) from tenant_shard_assignment_history`).rejects.toMatchObject({ code: "42501" });
    const [unassigned] = await h.sql`select count(*)::int as n from tenants t where not exists (select 1 from tenant_shard_assignments a where a.tenant_id = t.id)`;
    expect(unassigned!.n).toBe(0);
  });

  it("pauses writes for a frozen facility while reads continue, with an audited, versioned change", async () => {
    const app = appWith({ shards: new ShardRouter(SINGLE_SHARD_TOPOLOGY) });
    const before = await readAssignment(migrator, KAMPALA_TENANT);
    try {
      const frozen = await setAssignmentState(migrator, KAMPALA_TENANT, { state: "frozen", reason: "scaling test freeze" });
      expect(frozen.routingVersion).toBe(before!.routingVersion + 1);
      const write = await call(app, reception, "/api/v1/reception/patients", {
        method: "POST",
        body: JSON.stringify({ givenName: "Synthetic", familyName: "Frozen", dateOfBirth: "1990-01-01", sex: "female", identityConfidence: "confirmed-verbal" }),
      });
      expect(write.status).toBe(503);
      expect(write.headers.get("retry-after")).toBe("60");
      expect((await write.json()).error.code).toBe("tenant_maintenance");
      expect((await call(app, reception, "/api/v1/queues")).status).toBe(200);
    } finally {
      await setAssignmentState(migrator, KAMPALA_TENANT, { state: "active", reason: "scaling test unfreeze" });
    }
    const history = await migrator`
      select from_state, to_state, reason, changed_by from tenant_shard_assignment_history
       where tenant_id = ${KAMPALA_TENANT} order by id desc limit 2
    `;
    expect(history.map((row) => `${row.fromState}>${row.toState}`)).toEqual(["frozen>active", "active>frozen"]);
    expect(history[0]!.changedBy).toBe("medveris_migrator");
    await expect(migrator`delete from tenant_shard_assignments where tenant_id = ${KAMPALA_TENANT}`).rejects.toThrow("never deleted");
  });

  it("fingerprints a tenant deterministically without returning row contents", async () => {
    const admin = new URL(process.env.PGADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/postgres");
    admin.pathname = `/${new URL(process.env.DATABASE_URL!).pathname.slice(1)}`;
    const adminSql = createSql(admin.toString(), { max: 1 });
    try {
      const tables = ["encounters", "tenant_patient_links", "appointments"];
      const [first, second] = [await tenantFingerprint(adminSql, KAMPALA_TENANT, tables), await tenantFingerprint(adminSql, KAMPALA_TENANT, tables)];
      expect(first.digest).toBe(second.digest);
      expect(Object.keys(first.tables)).toEqual(tables);
      expect(JSON.stringify(first)).not.toMatch(/Synthetic/);
      const other = await tenantFingerprint(adminSql, "22222222-2222-4222-8222-222222222222", tables);
      expect(other.digest).not.toBe(first.digest);
    } finally {
      await adminSql.end({ timeout: 5 });
    }
  });
});

describe("rate limiting", () => {
  it("answers 429 with Retry-After once a client address exceeds the sign-in limit", async () => {
    const address = `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    let last: Response | null = null;
    for (let i = 0; i < 13; i += 1) {
      last = await h.app.fetch(new Request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": address },
        body: JSON.stringify({ email: `nobody-${crypto.randomUUID()}@example.invalid`, password: "wrong-password-value" }),
      }));
    }
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("limits failed sign-ins against one account from many addresses, identically whether or not it exists", async () => {
    const email = `target-${crypto.randomUUID()}@example.invalid`;
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const response = await h.app.fetch(new Request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": `198.19.${i}.${Math.floor(Math.random() * 250)}` },
        body: JSON.stringify({ email, password: "wrong-password-value" }),
      }));
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(-1)[0]).toBe(429);
  });

  it("does not let a spoofed X-Forwarded-For escape the limit when the proxy is not trusted", async () => {
    const app = appWith({ config: { ...h.config, rateLimit: { ...h.config.rateLimit, trustForwardedFor: false } } });
    const address = `198.20.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const statuses: number[] = [];
    for (let i = 0; i < 13; i += 1) {
      const response = await app.fetch(new Request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": address, "x-forwarded-for": `203.0.113.${i}` },
        body: JSON.stringify({ email: `nobody-${crypto.randomUUID()}@example.invalid`, password: "wrong-password-value" }),
      }));
      statuses.push(response.status);
    }
    expect(statuses.slice(-1)[0]).toBe(429);
  });
});

describe("database outage", () => {
  it("answers 503 with Retry-After and no internals when the primary is unreachable", async () => {
    const app = appWith({ sql: unreachable });
    const response = await app.fetch(new Request("http://localhost/api/v1/public/facilities"));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    const body = await response.text();
    expect(body).toContain("database_unavailable");
    expect(body).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|postgres/);
    const ready = await app.fetch(new Request("http://localhost/api/v1/health/ready"));
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ status: "unavailable", database: "unreachable", replica: "absent" });
    expect((await app.fetch(new Request("http://localhost/api/v1/health/live"))).status).toBe(200);
  });
});

describe("real-time handshake", () => {
  const published: Array<{ tenantId: string; type: string }> = [];
  const realtime: RealtimePublisher = {
    publish: async (tenantId, event) => { published.push({ tenantId, type: event.type }); },
    revokeUser: async () => undefined,
  };
  const config = { ...h.config, realtime: { ...h.config.realtime, enabled: true, allowedOrigins: ["http://localhost:5173"] } };

  function fakeHubs() {
    const forwarded: Request[] = [];
    return {
      forwarded,
      hubs: {
        idFromName: (name: string) => name,
        get: (id: unknown) => ({
          fetch: async (input: Request | string) => {
            const request = typeof input === "string" ? new Request(input) : input;
            forwarded.push(new Request(request.url, { headers: request.headers }));
            (forwarded[forwarded.length - 1] as unknown as { hub: unknown }).hub = id;
            return new Response(null, { status: 204 });
          },
        }),
      },
    };
  }

  it("issues tickets only when live updates are enabled, to authenticated callers, with server-chosen channels", async () => {
    expect((await h.call(reception, "/api/v1/realtime/tickets", { method: "POST", body: "{}" })).status).toBe(503);
    const app = appWith({ config, realtime });
    expect((await call(app, null, "/api/v1/realtime/tickets", { method: "POST", body: "{}" })).status).toBe(401);
    const issued = await (await call(app, reception, "/api/v1/realtime/tickets", { method: "POST", body: "{}" })).json();
    expect(issued.protocol).toBe(REALTIME_PROTOCOL);
    expect(issued.channels).toContain("tenant");
    expect(issued.channels).not.toContain("operations");
    expect(issued.path).toBe("/api/v1/realtime/connect");
  });

  it("refuses upgrades from other origins, without a session, or with another session's ticket", async () => {
    const app = appWith({ config, realtime });
    const { ticket } = await (await call(app, reception, "/api/v1/realtime/tickets", { method: "POST", body: "{}" })).json();
    const { hubs, forwarded } = fakeHubs();
    const upgrade = (headers: Record<string, string>) => handleRealtimeUpgrade(new Request("http://localhost/api/v1/realtime/connect", {
      headers: { upgrade: "websocket", "sec-websocket-protocol": `${REALTIME_PROTOCOL}, ticket.${ticket}`, ...headers },
    }), { sql: h.sql, config, hubs });
    expect((await upgrade({ origin: "https://evil.example", cookie: reception.cookie })).status).toBe(403);
    expect((await upgrade({ origin: "http://localhost:5173" })).status).toBe(401);
    const otherSession = await h.login("reception@medveris.local");
    expect((await upgrade({ origin: "http://localhost:5173", cookie: otherSession.cookie })).status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  it("forwards an authenticated upgrade to the facility hub with a server-built context only", async () => {
    const app = appWith({ config, realtime });
    const { ticket } = await (await call(app, reception, "/api/v1/realtime/tickets", { method: "POST", body: "{}" })).json();
    const { hubs, forwarded } = fakeHubs();
    await handleRealtimeUpgrade(new Request("http://localhost/api/v1/realtime/connect", {
      headers: {
        upgrade: "websocket", origin: "http://localhost:5173", cookie: reception.cookie,
        "sec-websocket-protocol": `${REALTIME_PROTOCOL}, ticket.${ticket}`,
        [CONTEXT_HEADER]: JSON.stringify({ uid: "x", tid: "22222222-2222-4222-8222-222222222222", channels: ["operations"] }),
      },
    }), { sql: h.sql, config, hubs });
    expect(forwarded).toHaveLength(1);
    expect((forwarded[0] as unknown as { hub: string }).hub).toBe(`tenant:${KAMPALA_TENANT}`);
    const context = JSON.parse(forwarded[0]!.headers.get(CONTEXT_HEADER)!);
    expect(context.tid).toBe(KAMPALA_TENANT);
    expect(context.channels).not.toContain("operations");
    expect(context.expiresAt).toBeLessThanOrEqual(Date.now() + config.realtime.maxConnectionSeconds * 1000);
    expect(forwarded[0]!.headers.get("cookie")).toBeNull();
    expect(forwarded[0]!.headers.get("sec-websocket-protocol")).toBeNull();
  });
});

describe("operations status", () => {
  it("gives platform operators aggregate backlog and dependency state, and nobody else", async () => {
    expect((await h.call(reception, "/api/v1/ops/status")).status).toBe(403);
    const status = await h.expectOk(await h.call(operator, "/api/v1/ops/status"));
    expect(status.outbox.every((row: Record<string, unknown>) => Object.keys(row).sort().join() === "events,maxAttempts,oldestSeconds,status")).toBe(true);
    expect(status.database.replica.state).toBe("absent");
    expect(JSON.stringify(status)).not.toMatch(/tenant_id|patient|@medveris/);
  });
});
