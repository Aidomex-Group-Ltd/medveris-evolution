import { Hono } from "hono";
import { listIntegrations } from "../integrations/registry.js";
import { loadVerifications } from "../integrations/verification.js";
import { loadAiStatus } from "../integrations/ollama.js";
import { UNAVAILABLE_LABEL } from "../terminology/unavailable.js";
import { createTerminology } from "../terminology/index.js";
import type { AppEnv } from "../types.js";

export const publicRoutes = new Hono<AppEnv>();

publicRoutes.get("/public/facilities", async (c) => {
  const rows = await c.get("deps").sql`
    select id, name, facility_type, city, country
      from tenants where status = 'active' and public_listing = true
     order by name limit 100
  `;
  return c.json({
    facilities: rows.map((r) => ({
      id: r.id,
      name: r.name,
      facilityType: r.facilityType,
      city: r.city,
      country: r.country,
      verificationLabel: "Facility registration does not establish credential verification",
    })),
  });
});

publicRoutes.get("/public/config", async (c) => {
  const config = c.get("deps").config;
  const terminology = createTerminology(config);
  return c.json({
    appEnv: config.appEnv,
    terminology: {
      mode: config.terminologyMode,
      synthetic: config.terminologyMode === "synthetic",
      available: config.terminologyMode !== "unavailable",
      label: config.terminologyMode === "synthetic"
        ? "Synthetic development terminology"
        : config.terminologyMode === "unavailable" ? UNAVAILABLE_LABEL : "Production terminology adapter configured",
      /** Surface the live terminology status so the web app and operators can distinguish configured+reachable from configured+unverified from unavailable. */
      status: terminology.status,
    },
    features: Object.fromEntries(listIntegrations(config, await loadVerifications(c.get("deps").sql, config)).map((integration) => [integration.id, integration.state === "available"])),
    // Only advertise development sign-in helpers when this server actually serves them, so the
    // web app does not offer a button that would 404 on a local machine with the flag off.
    devTotpCodes: config.devShowTotpSecrets && config.appEnv !== "production",
    release: "M1 outpatient foundation",
  });
});

/**
 * Active, operator-initiated reachability check for the configured production terminology provider.
 * It is intentionally not called automatically on every request: a failed provider must not make the
 * whole API pay a probe latency, and a slow provider must not stall clinical validation. This endpoint
 * is the sanctioned way to verify connectivity and to populate the adapter status on demand.
 *
 * It is fetch-only: no patient data, no clinical coding, no value set expansion.
 */
publicRoutes.post("/public/terminology/status", async (c) => {
  const config = c.get("deps").config;
  if (config.terminologyMode !== "production" || !config.terminologyProviderUrl) {
    return c.json({ ok: false, error: "A production terminology provider is not configured for this environment" }, 409);
  }
  const terminology = createTerminology(config);
  await terminology.verifyConnection();
  return c.json({ ok: true, status: terminology.status });
});

/** Read-only status of the configured terminology service; no authentication required because it
 * contains no patient data and only describes the configured provider and its last verification. */
publicRoutes.get("/public/terminology/status", async (c) => {
  const config = c.get("deps").config;
  const terminology = createTerminology(config);
  return c.json({ status: terminology.status });
});

/** Read-only status of the configured AI provider; no authentication required because it contains
 * no patient data and only describes the configured provider and its last verification. For the live
 * Ollama path this includes the discovered model inventory from the provider, so the UI never
 * advertises a model the server does not actually expose. */
publicRoutes.get("/public/ai/status", async (c) => {
  const config = c.get("deps").config;
  const status = await loadAiStatus(c.get("deps").sql, config);
  return c.json({
    mode: config.modes.ai,
    requested: Boolean(config.features.ai),
    configured: Boolean(config.features.ai && config.ai.baseUrl && config.ai.token && config.aiModel.model),
    providerBaseUrl: config.ai.baseUrl,
    model: config.aiModel.model,
    connection: status,
  });
});

publicRoutes.get("/health/live", (c) => c.json({ status: "ok" }));
