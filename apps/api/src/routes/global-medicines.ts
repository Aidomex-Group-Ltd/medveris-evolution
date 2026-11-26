import { Hono } from "hono";
import { withStaffActor } from "../auth/middleware.js";
import { requireRows } from "../lib/actor.js";
import type { AppEnv } from "../types.js";

/**
 * Read-only projection of the global price catalogue's medicine entries.
 *
 * These rows come from `master_prices`: pricing identity (code, price, currency). They are not a
 * regulatory record and carry no NDA registration number, approval classification or country
 * availability — those belong to the medicine master catalogue (migration 147) and must never be
 * inferred from this endpoint.
 */
export const globalMedicinesRoutes = new Hono<AppEnv>();

/** Global price-catalogue entries. Accessible to authenticated staff only. */
globalMedicinesRoutes.get("/global-medicines", async (c) => {
  const medicines = await withStaffActor(c, async (tx) => tx`
    select mp.id, mp.code, mp.name, mp.description, mp.category, mp.subcategory,
           mp.unit_type, mp.is_service, mp.base_price, mp.currency,
           mp.effective_from, mp.active
      from master_prices mp
     where mp.active = true
     order by mp.name
  `);
  return c.json({ medicines });
});

/** One catalogue entry by code, for dropdown lookup. */
globalMedicinesRoutes.get("/global-medicines/code/:code", async (c) => {
  const code = c.req.param("code");
  const medicine = await withStaffActor(c, async (tx) => {
    const rows = await tx`
      select mp.id, mp.code, mp.name, mp.description, mp.category, mp.subcategory,
             mp.unit_type, mp.is_service, mp.base_price, mp.currency,
             mp.effective_from, mp.active
        from master_prices mp
       where mp.code = ${code} and mp.active = true
    `;
    return requireRows(rows, "Medicine not found");
  });
  return c.json({ medicine });
});

/** Catalogue entries filtered by category. */
globalMedicinesRoutes.get("/global-medicines/category/:category", async (c) => {
  const category = c.req.param("category");
  const medicines = await withStaffActor(c, async (tx) => tx`
    select mp.id, mp.code, mp.name, mp.description, mp.category, mp.subcategory,
           mp.unit_type, mp.is_service, mp.base_price, mp.currency,
           mp.effective_from, mp.active
      from master_prices mp
     where mp.category = ${category} and mp.active = true
     order by mp.name
  `);
  return c.json({ medicines });
});
