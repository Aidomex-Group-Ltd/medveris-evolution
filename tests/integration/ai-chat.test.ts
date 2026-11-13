import { afterAll, describe, expect, it } from "vitest";
import http from "node:http";
import { withContext } from "@medveris/db";
import { createHarness, KAMPALA_TENANT } from "./support.js";

// A tiny stand-in for the sandbox Ollama server so the chat endpoint can run
// end-to-end without a real model. It answers /api/chat and records every request.
const ollamaRequests: Array<{ url: string | undefined; body: unknown }> = [];
const ollamaServer = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/chat") {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try {
        ollamaRequests.push({ url: req.url, body: JSON.parse(raw) });
      } catch {
        ollamaRequests.push({ url: req.url, body: raw });
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        message: { role: "assistant", content: "Synthetic assistant reply for testing" },
        prompt_eval_count: 3,
        eval_count: 5,
      }));
    });
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});
await new Promise<void>((resolve) => ollamaServer.listen(0, "127.0.0.1", resolve));
const address = ollamaServer.address();
const ollamaUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

const h = createHarness("ai-chat", {
  env: { FEATURE_AI: "true", AI_MODE: "sandbox", OLLAMA_URL: ollamaUrl, AI_MODEL: "@cf/test/model" },
});

afterAll(async () => {
  await h.sql.end({ timeout: 5 });
  await new Promise<void>((resolve, reject) => ollamaServer.close((error) => (error ? reject(error) : resolve())));
});

describe("role-aware AI assistant endpoint", () => {
  it("refuses anonymous callers", async () => {
    const response = await h.app.fetch(new Request("http://localhost/api/v1/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    }));
    expect(response.status).toBe(401);
  });

  it("refuses provider mode for facility staff without a clinical role", async () => {
    const reception = await h.login("reception@medveris.local");
    const response = await h.call(reception, "/api/v1/ai/chat", {
      method: "POST",
      body: JSON.stringify({ mode: "provider", messages: [{ role: "user", content: "what should I check at discharge?" }] }),
    });
    expect(response.status).toBe(403);
  });

  it("serves provider mode for a clinician and audits the turn without content", async () => {
    const clinician = await h.login("clinician@medveris.local");
    const response = await h.call(clinician, "/api/v1/ai/chat", {
      method: "POST",
      body: JSON.stringify({ mode: "provider", messages: [{ role: "user", content: "What should I check before discharging an asthma patient?" }] }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { message: string; redFlag: boolean; disclaimer: string };
    expect(body.message).toContain("Synthetic assistant reply");
    expect(body.redFlag).toBe(false);

    expect(ollamaRequests.length).toBe(1);
    const sent = ollamaRequests[0]!.body as { messages: Array<{ role: string; content: string }> };
    expect(sent.messages.some((message) => message.role === "system" && message.content.includes("decision support"))).toBe(true);

    const rows = await withContext(h.sql, { tenantId: KAMPALA_TENANT, actorKind: "staff", roles: ["auditor"] }, async (tx) => tx`
      select actor_kind, metadata from audit_events where action = 'ai.chat.turn' order by occurred_at desc limit 1
    `);
    expect(rows[0]?.actorKind ?? rows[0]?.actor_kind).toBe("staff");
    const metadata = (rows[0]?.metadata ?? {}) as Record<string, unknown>;
    expect(metadata.redFlag).toBe(false);
    expect(metadata.mode).toBe("provider");
    expect(JSON.stringify(metadata)).not.toContain("asthma");
  });

  it("pre-empts a red-flag message before any model call and escalates", async () => {
    const clinician = await h.login("clinician@medveris.local");
    const before = ollamaRequests.length;
    const response = await h.call(clinician, "/api/v1/ai/chat", {
      method: "POST",
      body: JSON.stringify({ mode: "provider", messages: [{ role: "user", content: "my chest pain and pressure won't stop" }] }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { redFlag: boolean; redFlagCategory: string; message: string };
    expect(body.redFlag).toBe(true);
    expect(body.redFlagCategory).toBe("chest_pain");
    expect(body.message).toContain("112");
    // The model must not have been asked to answer an emergency.
    expect(ollamaRequests.length).toBe(before);

    const rows = await withContext(h.sql, { tenantId: KAMPALA_TENANT, actorKind: "staff", roles: ["auditor"] }, async (tx) => tx`
      select actor_kind, metadata from audit_events where action = 'ai.chat.turn' order by occurred_at desc limit 1
    `);
    const metadata = (rows[0]?.metadata ?? {}) as Record<string, unknown>;
    expect(metadata.redFlag).toBe(true);
    expect(metadata.redFlagCategory).toBe("chest_pain");
  });

  it("serves patient mode for a verified patient account", async () => {
    const patient = await h.login("patient@medveris.local");
    const response = await h.call(patient, "/api/v1/ai/chat", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "which foods help lower blood pressure?" }] }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { message: string; redFlag: boolean };
    expect(body.message).toContain("Synthetic assistant reply");

    const profile = await h.call(patient, "/api/v1/me/patient");
    const profileBody = await profile.json() as { patient: { id: string } };
    const rows = await withContext(h.sql, { patientId: profileBody.patient.id, actorKind: "patient", roles: ["patient"] }, async (tx) => tx`
      select actor_kind, metadata from audit_events where action = 'ai.chat.turn' order by occurred_at desc limit 1
    `);
    expect(rows[0]?.actorKind ?? rows[0]?.actor_kind).toBe("patient");
  });

  it("refuses patient mode for staff without a verified patient account", async () => {
    const reception = await h.login("reception@medveris.local");
    const response = await h.call(reception, "/api/v1/ai/chat", {
      method: "POST",
      body: JSON.stringify({ mode: "patient", messages: [{ role: "user", content: "hello" }] }),
    });
    expect(response.status).toBe(403);
  });

  it("refuses provider mode for a patient account", async () => {
    const patient = await h.login("patient@medveris.local");
    const response = await h.call(patient, "/api/v1/ai/chat", {
      method: "POST",
      body: JSON.stringify({ mode: "provider", messages: [{ role: "user", content: "hello" }] }),
    });
    expect(response.status).toBe(403);
  });
});
