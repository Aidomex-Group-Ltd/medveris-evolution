import { Hono } from "hono";
import { listIntegrations } from "../integrations/registry.js";
import { UNAVAILABLE_LABEL } from "../terminology/unavailable.js";
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
  return c.json({
    appEnv: config.appEnv,
    terminology: {
      mode: config.terminologyMode,
      synthetic: config.terminologyMode === "synthetic",
      available: config.terminologyMode !== "unavailable",
      label: config.terminologyMode === "synthetic"
        ? "Synthetic development terminology"
        : config.terminologyMode === "unavailable" ? UNAVAILABLE_LABEL : "Production terminology adapter configured",
    },
    features: Object.fromEntries(listIntegrations(config).map((integration) => [integration.id, integration.state === "available"])),
    release: "M1 outpatient foundation",
  });
});

publicRoutes.get("/health/live", (c) => c.json({ status: "ok" }));

publicRoutes.get("/health/ready", async (c) => {
  try {
    await c.get("deps").sql`select 1 as ok`;
    return c.json({ status: "ready", database: "reachable" });
  } catch {
    return c.json({ status: "unavailable", database: "unreachable" }, 503);
  }
});
