import { Hono } from "hono";
import { withStaffActor } from "../auth/middleware.js";
import { requireRows } from "../lib/actor.js";
import { ValidationError } from "../lib/errors.js";
import { parseQuery } from "../lib/http.js";
import { z } from "zod";
import type { AppEnv } from "../types.js";

/**
 * Read-only projection of the global price catalogue's entries.
 *
 * These rows come from `master_prices`: pricing identity (code, price, currency). They are not a
 * regulatory record and carry no NDA registration number, approval classification or country
 * availability — those belong to the medicine master catalogue (migration 147) and must never be
 * inferred from this endpoint. Every row is returned with `regulatoryStatus: "unverified"` so no
 * caller can mistake a catalogue entry for an approved medicine.
 */
export const globalMedicinesRoutes = new Hono<AppEnv>();

const searchSchema = z.object({
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(50).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  offset: z.coerce.number().int().min(0).max(5000).optional(),
});

/**
 * Server-side search for the medicine picker. Only the requested page is returned, so a large
 * catalogue never has to be loaded into the browser. Categories filter the same rows.
 */
globalMedicinesRoutes.get("/global-medicines/search", async (c) => {
  const query = parseQuery(c, searchSchema);
  const limit = query.limit ?? 20;
  const offset = query.offset ?? 0;
  const term = query.q?.trim() ? `%${query.q.trim().replace(/[%_\\]/g, (match) => `\\${match}`)}%` : null;
  const category = query.category?.trim() || null;

  const result = await withStaffActor(c, async (tx) => {
    const rows = await tx`
      select mp.id, mp.code, mp.name, mp.description, mp.category, mp.subcategory,
             mp.unit_type, mp.is_service, mp.base_price, mp.currency,
             mp.effective_from, mp.effective_to, mp.active
        from master_prices mp
       where mp.active = true
         ${category ? tx`and mp.category = ${category}` : tx``}
         ${term ? tx`and (mp.name ilike ${term} or mp.code ilike ${term}
                          or coalesce(mp.description, '') ilike ${term}
                          or coalesce(mp.subcategory, '') ilike ${term})` : tx``}
       order by mp.name, mp.code
       limit ${limit + 1} offset ${offset}
    `;
    const total = await tx`
      select count(*)::int as total
        from master_prices mp
       where mp.active = true
         ${category ? tx`and mp.category = ${category}` : tx``}
         ${term ? tx`and (mp.name ilike ${term} or mp.code ilike ${term}
                          or coalesce(mp.description, '') ilike ${term}
                          or coalesce(mp.subcategory, '') ilike ${term})` : tx``}
    `;
    return { rows, total: Number(total[0]?.total ?? 0) };
  });

  const hasMore = result.rows.length > limit;
  const items = (hasMore ? result.rows.slice(0, limit) : result.rows).map((row) => ({
    ...row,
    recordType: "price-catalogue-entry" as const,
    regulatoryStatus: "unverified" as const,
    regulatorySource: null,
    registrationIdentifier: null,
    verifiedAt: null,
  }));
  return c.json({
    medicines: items,
    total: result.total,
    limit,
    offset,
    hasMore,
    notice: "Catalogue entries are priced items, not regulatory approvals. Registration status is only shown where a verified source supplies it.",
  });
});

/** Therapeutic categories present in the catalogue, with counts, for the picker's filter. */
globalMedicinesRoutes.get("/global-medicines/categories", async (c) => {
  const categories = await withStaffActor(c, async (tx) => tx`
    select mp.category, count(*)::int as count
      from master_prices mp
     where mp.active = true
     group by mp.category
     order by mp.category
  `);
  return c.json({ categories });
});

/** Global price-catalogue entries. Accessible to authenticated staff only. */
globalMedicinesRoutes.get("/global-medicines", async (c) => {
  const medicines = await withStaffActor(c, async (tx) => tx`
    select mp.id, mp.code, mp.name, mp.description, mp.category, mp.subcategory,
           mp.unit_type, mp.is_service, mp.base_price, mp.currency,
           mp.effective_from, mp.effective_to, mp.active
      from master_prices mp
     where mp.active = true
     order by mp.name
  `);
  return c.json({ medicines });
});

/** One catalogue entry by code, for dropdown lookup. */
globalMedicinesRoutes.get("/global-medicines/code/:code", async (c) => {
  const code = c.req.param("code");
  if (!code || code.length > 50) throw new ValidationError("A medicine code is required");
  const medicine = await withStaffActor(c, async (tx) => {
    const rows = await tx`
      select mp.id, mp.code, mp.name, mp.description, mp.category, mp.subcategory,
             mp.unit_type, mp.is_service, mp.base_price, mp.currency,
             mp.effective_from, mp.effective_to, mp.active
        from master_prices mp
       where mp.code = ${code} and mp.active = true
    `;
    return requireRows(rows, "Medicine not found");
  });
  return c.json({
    medicine: { ...medicine, recordType: "price-catalogue-entry", regulatoryStatus: "unverified" },
  });
});

/** Catalogue entries filtered by category. */
globalMedicinesRoutes.get("/global-medicines/category/:category", async (c) => {
  const category = c.req.param("category");
  const medicines = await withStaffActor(c, async (tx) => tx`
    select mp.id, mp.code, mp.name, mp.description, mp.category, mp.subcategory,
           mp.unit_type, mp.is_service, mp.base_price, mp.currency,
           mp.effective_from, mp.effective_to, mp.active
      from master_prices mp
     where mp.category = ${category} and mp.active = true
     order by mp.name
  `);
  return c.json({ medicines });
});
