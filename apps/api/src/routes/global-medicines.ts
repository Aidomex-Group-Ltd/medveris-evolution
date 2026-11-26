import { Hono } from "hono";
import { withStaffActor } from "../auth/middleware.js";
import type { AppEnv } from "../types.js";

export const globalMedicinesRoutes = new Hono();

/** Get globally available medicines from the master catalogue.
 *  Accessible to all authenticated users.
 */
globalMedicinesRoutes.get("/medicines", async (c) => {
  const auth = c.get("auth")!;
  const deps = c.get("deps");

  const medicines = await withStaffActor(c, async (tx) => {
    const rows = await tx`
      select mp.id, mp.code, mp.name, mp.description, mp.category, mp.subcategory,
             mp.unit_type, mp.is_service, mp.base_price, mp.currency,
             mp.effective_from, mp.active
      from master_prices mp
      where mp.active = true
      order by mp.name
    `;
    return rows;
  });

  return c.json({ medicines });
});

/** Get medicine by code from the master catalogue.
 *  Useful for dropdown search/lookup.
 */
globalMedicinesRoutes.get("/medicines/code/:code", async (c) => {
  const code = c.req.param("code");

  const medicine = await withStaffActor(c, async (tx) => {
    const row = await tx`
      select mp.id, mp.code, mp.name, mp.description, mp.category, mp.subcategory,
             mp.unit_type, mp.is_service, mp.base_price, mp.currency,
             mp.effective_from, mp.active
      from master_prices mp
      where mp.code = ${code} and mp.active = true
    `;
    return requireRows(row, "Medicine not found");
  });

  return c.json({ medicine });
});

/** Get medicines filtered by category.
 *  Useful for category-based dropdowns.
 */
globalMedicinesRoutes.get("/medicines/category/:category", async (c) => {
  const category = c.req.param("category");

  const medicines = await withStaffActor(c, async (tx) => {
    const rows = await tx`
      select mp.id, mp.code, mp.name, mp.description, mp.category, mp.subcategory,
             mp.unit_type, mp.is_service, mp.base_price, mp.currency,
             mp.effective_from, mp.active
      from master_prices mp
      where mp.category = ${category} and mp.active = true
      order by mp.name
    `;
    return rows;
  });

  return c.json({ medicines });
});

export { globalMedicinesRoutes };
