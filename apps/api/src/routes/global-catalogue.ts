import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  CURRENCIES,
  assertPriceListActionRole,
  isCurrencyCode,
  nextPriceListStatus,
  normalizePriceListStatus,
  priceListIsEditable,
  validatePriceList,
  availablePriceListActions,
  type PriceListAction,
} from "@medveris/domain";
import { PRICE_LIST_READ_ROLES, PRICE_LIST_ROLES } from "@medveris/authz";
import type { Tx } from "@medveris/db";
import { isPlatformOperator, requireAuth, requireStaff, withPlatformActor, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { writeAudit } from "../lib/audit.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { parseJson, parseQuery } from "../lib/http.js";
import { uniqueViolation } from "../lib/idempotency.js";
import type { AppEnv } from "../types.js";

/**
 * Global price catalogue and price-list management.
 *
 * Two surfaces with deliberately different authority:
 *  - `/global-catalogue/items` is the platform's canonical price catalogue (`master_prices`).
 *    Only a platform operator may change it; every staff member can read active rows through
 *    `/global-medicines`.
 *  - `/global-catalogue/lists` is a facility's own price list (`price_lists` +
 *    `price_list_prices`), managed by that facility's finance administrators and governed by the
 *    DRAFT → VALIDATED → PENDING_APPROVAL → APPROVED → PUBLISHED → EXPIRED/ARCHIVED lifecycle.
 *
 * No endpoint converts one currency into another: a price is always stated in its own currency
 * and a different currency needs its own approved list.
 */
export const globalCatalogueRoutes = new Hono<AppEnv>();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date");
const currencySchema = z.string().trim().toUpperCase().refine(isCurrencyCode, "Unsupported currency");
const categorySchema = z.string().trim().min(2).max(50);
const codeSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,49}$/, "Invalid code");

function hasRole(c: Context<AppEnv>, ...roles: readonly string[]): boolean {
  return requestActor(c).roles.some((role) => roles.includes(role));
}

function requireOperator(c: Context<AppEnv>): void {
  if (!isPlatformOperator(c)) throw new ForbiddenError("Platform operator permission is required to change the global catalogue");
}

function requirePriceReader(c: Context<AppEnv>): void {
  requireStaff(c);
  if (!hasRole(c, ...PRICE_LIST_READ_ROLES)) throw new ForbiddenError("A price-list role is required to read price lists");
}

/** These are exactly the roles the database's price-list write policies accept for a facility. */
const PRICE_LIST_WRITE_ROLES = ["facility_admin", "finance"] as const;

function requirePriceWriter(c: Context<AppEnv>): void {
  requireStaff(c);
  if (!hasRole(c, ...PRICE_LIST_WRITE_ROLES)) {
    throw new ForbiddenError("Price lists are maintained by facility administrators and finance");
  }
  if (!c.get("auth")?.activeTenant) throw new ForbiddenError("An active facility is required to maintain a price list");
}

function minorDigitsFor(currency: string): number {
  return isCurrencyCode(currency) ? CURRENCIES[currency].minorDigits : 2;
}

function decimalsOf(value: number): number {
  const text = String(value);
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

function assertMoney(price: number, currency: string): void {
  if (!Number.isFinite(price) || price < 0) throw new ValidationError("A price must be zero or more");
  if (decimalsOf(price) > minorDigitsFor(currency)) {
    throw new ValidationError(`${currency} is recorded with ${minorDigitsFor(currency)} decimal place(s)`);
  }
}

// ------------------------------------------------------------------ global catalogue (platform)

const masterPriceInput = z.object({
  code: codeSchema,
  name: z.string().trim().min(2).max(255),
  description: z.string().trim().max(2000).nullish(),
  category: categorySchema,
  subcategory: z.string().trim().max(100).nullish(),
  unitType: z.string().trim().min(2).max(50).default("clinical"),
  isService: z.boolean().default(true),
  basePrice: z.number().finite().min(0).max(99_999_999),
  currency: currencySchema,
  effectiveFrom: isoDate.optional(),
  effectiveTo: isoDate.nullish(),
});

const masterPricePatch = masterPriceInput.partial().extend({ active: z.boolean().optional() });

const itemQuery = z.object({
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(50).optional(),
  status: z.enum(["all", "active", "inactive", "expired"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(10_000).optional(),
});

/** Every catalogue row, including withdrawn ones, with duplicate-name detection. */
globalCatalogueRoutes.get("/global-catalogue/items", async (c) => {
  requireAuth(c);
  if (!isPlatformOperator(c)) {
    requireStaff(c);
    const rows = await withStaffActor(c, async (tx) => tx`
      select mp.id, mp.code, mp.name, mp.description, mp.category, mp.subcategory,
             mp.unit_type, mp.is_service, mp.base_price, mp.currency,
             mp.effective_from, mp.effective_to, mp.active, mp.created_at, mp.updated_at
        from master_prices mp
       where mp.active = true
       order by mp.name, mp.code
    `);
    return c.json({ items: rows, canManage: false, duplicates: [] });
  }

  const query = parseQuery(c, itemQuery);
  const limit = query.limit ?? 25;
  const offset = query.offset ?? 0;
  const term = query.q ? `%${query.q.replace(/[%_\\]/g, (match) => `\\${match}`)}%` : null;
  const category = query.category || null;
  const status = query.status ?? "all";

  const result = await withPlatformActor(c, async (tx) => {
    const rows = await tx`
      select mp.id, mp.code, mp.name, mp.description, mp.category, mp.subcategory,
             mp.unit_type, mp.is_service, mp.base_price, mp.currency,
             mp.effective_from, mp.effective_to, mp.active, mp.created_at, mp.updated_at
        from master_prices mp
       where true
         ${category ? tx`and mp.category = ${category}` : tx``}
         ${status === "active" ? tx`and mp.active and (mp.effective_to is null or mp.effective_to >= current_date)` : tx``}
         ${status === "inactive" ? tx`and not mp.active` : tx``}
         ${status === "expired" ? tx`and mp.effective_to is not null and mp.effective_to < current_date` : tx``}
         ${term ? tx`and (mp.name ilike ${term} or mp.code ilike ${term} or coalesce(mp.description, '') ilike ${term})` : tx``}
       order by mp.name, mp.code
       limit ${limit} offset ${offset}
    `;
    const totals = await tx`
      select count(*)::int as total from master_prices mp
       where true
         ${category ? tx`and mp.category = ${category}` : tx``}
         ${status === "active" ? tx`and mp.active and (mp.effective_to is null or mp.effective_to >= current_date)` : tx``}
         ${status === "inactive" ? tx`and not mp.active` : tx``}
         ${status === "expired" ? tx`and mp.effective_to is not null and mp.effective_to < current_date` : tx``}
         ${term ? tx`and (mp.name ilike ${term} or mp.code ilike ${term} or coalesce(mp.description, '') ilike ${term})` : tx``}
    `;
    const categories = await tx`
      select mp.category, count(*)::int as count from master_prices mp group by mp.category order by mp.category
    `;
    const duplicates = await tx`
      select lower(mp.name) as name_key, mp.category, count(*)::int as count, array_agg(mp.code order by mp.code) as codes
        from master_prices mp
       group by lower(mp.name), mp.category
      having count(*) > 1
       order by count desc, name_key
       limit 25
    `;
    return { rows, total: Number(totals[0]?.total ?? 0), categories, duplicates };
  });

  return c.json({
    items: result.rows,
    total: result.total,
    limit,
    offset,
    canManage: true,
    categories: result.categories,
    duplicates: result.duplicates,
  });
});

globalCatalogueRoutes.post("/global-catalogue/items", async (c) => {
  requireOperator(c);
  const body = await parseJson(c, masterPriceInput);
  assertMoney(body.basePrice, body.currency);
  if (body.effectiveTo && body.effectiveTo < (body.effectiveFrom ?? new Date().toISOString().slice(0, 10))) {
    throw new ValidationError("The end date must not be before the start date");
  }
  const auth = c.get("auth")!;
  const id = crypto.randomUUID();
  await withPlatformActor(c, async (tx) => {
    await tx`
      insert into master_prices (id, code, name, description, category, subcategory, unit_type, is_service,
                                 base_price, currency, effective_from, effective_to, active, created_by)
      values (${id}, ${body.code}, ${body.name}, ${body.description ?? null}, ${body.category}, ${body.subcategory ?? null},
              ${body.unitType}, ${body.isService}, ${body.basePrice}, ${body.currency},
              ${body.effectiveFrom ?? new Date().toISOString().slice(0, 10)}, ${body.effectiveTo ?? null}, true, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "price.catalogue.create", {
      resourceType: "MasterPrice",
      resourceId: id,
      metadata: { code: body.code, category: body.category, currency: body.currency, basePrice: body.basePrice },
    }));
  }).catch((error: unknown) => {
    if (uniqueViolation(error)) throw new ConflictError("That catalogue code is already in use");
    throw error;
  });
  return c.json({ ok: true, item: { id } }, 201);
});

globalCatalogueRoutes.patch("/global-catalogue/items/:id", async (c) => {
  requireOperator(c);
  const id = z.string().uuid().parse(c.req.param("id"));
  const body = await parseJson(c, masterPricePatch);
  const auth = c.get("auth")!;
  await withPlatformActor(c, async (tx) => {
    const current = await requireRows(await tx`
      select id, code, name, base_price, currency, effective_from, effective_to, active
        from master_prices where id = ${id} for update
    `, "Catalogue item not found");
    const currency = body.currency ?? String(current.currency);
    const price = body.basePrice ?? Number(current.basePrice);
    assertMoney(price, currency);
    const effectiveFrom = body.effectiveFrom ?? String(current.effectiveFrom);
    const effectiveTo = body.effectiveTo === undefined ? (current.effectiveTo as string | null) : body.effectiveTo;
    if (effectiveTo && effectiveTo < effectiveFrom) throw new ValidationError("The end date must not be before the start date");
    const merged = await requireRows(await tx`
      select description, category, subcategory, unit_type, is_service from master_prices where id = ${id}
    `, "Catalogue item not found");
    await tx`
      update master_prices
         set name = ${body.name ?? current.name},
             description = ${body.description === undefined ? merged.description : body.description},
             category = ${body.category ?? merged.category},
             subcategory = ${body.subcategory === undefined ? merged.subcategory : body.subcategory},
             unit_type = ${body.unitType ?? merged.unitType},
             is_service = ${body.isService ?? merged.isService},
             base_price = ${price},
             currency = ${currency},
             effective_from = ${effectiveFrom},
             effective_to = ${effectiveTo},
             active = ${body.active ?? Boolean(current.active)},
             updated_by = ${auth.user.id},
             updated_at = now()
       where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, body.active === false ? "price.catalogue.withdraw" : "price.catalogue.update", {
      resourceType: "MasterPrice",
      resourceId: id,
      metadata: { code: String(current.code), basePrice: price, currency },
    }));
  });
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ price lists (facility)

const listItemInput = z.object({
  masterPriceCode: z.string().trim().max(50).nullish(),
  name: z.string().trim().min(2).max(255).optional(),
  description: z.string().trim().max(2000).nullish(),
  category: z.string().trim().min(2).max(50).optional(),
  unitType: z.string().trim().min(2).max(50).optional(),
  isService: z.boolean().optional(),
  price: z.number().finite().min(0).max(99_999_999),
  currency: currencySchema.optional(),
  effectiveFrom: isoDate.optional(),
  effectiveTo: isoDate.nullish(),
});

const createListInput = z.object({
  code: codeSchema,
  name: z.string().trim().min(2).max(255),
  description: z.string().trim().max(2000).nullish(),
  effectiveFrom: isoDate,
  effectiveTo: isoDate.nullish(),
  items: z.array(listItemInput).max(500).optional(),
});

const patchListInput = z.object({
  name: z.string().trim().min(2).max(255).optional(),
  description: z.string().trim().max(2000).nullish(),
  effectiveFrom: isoDate.optional(),
  effectiveTo: isoDate.nullish(),
});

const transitionInput = z.object({
  action: z.enum(["validate", "submit", "approve", "reject", "publish", "expire", "archive"]),
  note: z.string().trim().max(500).optional(),
});

async function loadList(tx: Tx, tenantId: string, id: string, lock = false) {
  const rows = await tx`
    select id, code, name, description, facility_id, tenant_id, source_type, source_reference,
           status, effective_from, effective_to, approved_by, approved_at, active, created_at, updated_at
      from price_lists
     where id = ${id} and (facility_id = ${tenantId} or tenant_id = ${tenantId})
     ${lock ? tx`for update` : tx``}
  `;
  return requireRows(rows, "Price list not found");
}

async function listItems(tx: Tx, listId: string) {
  return tx`
    select id, master_price_code, name, description, category, unit_type, is_service, price, currency,
           is_active, approval_status, approved_by, approved_at, effective_from, effective_to, updated_at
      from price_list_prices
     where price_list_id = ${listId}
     order by category, name
  `;
}

globalCatalogueRoutes.get("/global-catalogue/lists", async (c) => {
  requirePriceReader(c);
  const auth = c.get("auth")!;
  const status = c.req.query("status");
  const lists = await withStaffActor(c, async (tx) => tx`
    select pl.id, pl.code, pl.name, pl.description, pl.facility_id, pl.status, pl.effective_from,
           pl.effective_to, pl.approved_at, pl.active, pl.created_at, pl.updated_at,
           (select count(*)::int from price_list_prices p where p.price_list_id = pl.id and p.is_active) as item_count,
           (select min(p.currency) from price_list_prices p where p.price_list_id = pl.id) as currency
      from price_lists pl
     where pl.facility_id = ${auth.activeTenant!.id} or pl.tenant_id = ${auth.activeTenant!.id}
       ${status ? tx`and upper(pl.status) = ${status.toUpperCase()}` : tx``}
     order by pl.updated_at desc nulls last, pl.created_at desc
     limit 200
  `);
  return c.json({
    lists,
    canManage: hasRole(c, ...PRICE_LIST_WRITE_ROLES),
    statuses: { readRoles: PRICE_LIST_READ_ROLES, writeRoles: PRICE_LIST_ROLES },
  });
});

globalCatalogueRoutes.post("/global-catalogue/lists", async (c) => {
  requirePriceWriter(c);
  const body = await parseJson(c, createListInput);
  const auth = c.get("auth")!;
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    await tx`
      insert into price_lists (id, code, name, description, facility_id, tenant_id, source_type, status,
                               effective_from, effective_to, active, created_by)
      values (${id}, ${body.code}, ${body.name}, ${body.description ?? null}, ${auth.activeTenant!.id},
              ${auth.activeTenant!.id}, 'manual', 'DRAFT', ${body.effectiveFrom}, ${body.effectiveTo ?? null}, true, ${auth.user.id})
    `;
    for (const item of body.items ?? []) {
      await insertListItem(tx, {
        listId: id,
        listEffectiveFrom: body.effectiveFrom,
        userId: auth.user.id,
        item,
      });
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "price.list.create", {
      resourceType: "PriceList",
      resourceId: id,
      metadata: { code: body.code, status: "DRAFT", items: (body.items ?? []).length },
    }));
  }).catch((error: unknown) => {
    if (uniqueViolation(error)) throw new ConflictError("That price-list code is already in use");
    throw error;
  });
  return c.json({ ok: true, list: { id, status: "DRAFT" } }, 201);
});

interface InsertItemOptions {
  listId: string;
  listEffectiveFrom: string;
  userId: string;
  item: z.infer<typeof listItemInput>;
}

async function insertListItem(tx: Tx, options: InsertItemOptions): Promise<string> {
  const { item } = options;
  const source = item.masterPriceCode
    ? await tx`
        select code, name, description, category, unit_type, is_service, base_price, currency, effective_from, effective_to
          from master_prices where code = ${item.masterPriceCode} and active = true
      `
    : [];
  const master = source[0];
  const name = item.name ?? (master?.name as string | undefined);
  const category = item.category ?? (master?.category as string | undefined);
  const currency = item.currency ?? (master?.currency as string | undefined) ?? "UGX";
  if (!name) throw new ValidationError("Choose a catalogue item or give the price a name");
  if (!category) throw new ValidationError("Every price needs a category");
  assertMoney(item.price, currency);
  const id = crypto.randomUUID();
  await tx`
    insert into price_list_prices (id, price_list_id, master_price_code, name, description, category, unit_type,
                                   is_service, price, currency, is_active, requires_approval, approval_status,
                                   effective_from, effective_to, created_by)
    values (${id}, ${options.listId}, ${item.masterPriceCode ?? null}, ${name}, ${item.description ?? (master?.description as string | null | undefined) ?? null},
            ${category}, ${item.unitType ?? (master?.unitType as string | undefined) ?? "clinical"},
            ${item.isService ?? (master?.isService as boolean | undefined) ?? true}, ${item.price}, ${currency}, true, true, 'pending',
            ${item.effectiveFrom ?? options.listEffectiveFrom}, ${item.effectiveTo ?? null}, ${options.userId})
  `;
  return id;
}

globalCatalogueRoutes.get("/global-catalogue/lists/:id", async (c) => {
  requirePriceReader(c);
  const id = z.string().uuid().parse(c.req.param("id"));
  const auth = c.get("auth")!;
  const result = await withStaffActor(c, async (tx) => {
    const list = await loadList(tx, auth.activeTenant!.id, id);
    const items = await listItems(tx, id);
    return { list, items };
  });
  const status = normalizePriceListStatus(String(result.list.status));
  return c.json({
    ...result,
    list: { ...result.list, status },
    availableActions: availablePriceListActions(status),
    editable: priceListIsEditable(status),
  });
});

globalCatalogueRoutes.patch("/global-catalogue/lists/:id", async (c) => {
  requirePriceWriter(c);
  const id = z.string().uuid().parse(c.req.param("id"));
  const body = await parseJson(c, patchListInput);
  const auth = c.get("auth")!;
  await withStaffActor(c, async (tx) => {
    const list = await loadList(tx, auth.activeTenant!.id, id, true);
    const status = normalizePriceListStatus(String(list.status));
    if (!priceListIsEditable(status)) {
      throw new ConflictError(`A ${status.toLowerCase()} price list can no longer be edited`);
    }
    const effectiveFrom = body.effectiveFrom ?? String(list.effectiveFrom);
    const effectiveTo = body.effectiveTo === undefined ? (list.effectiveTo as string | null) : body.effectiveTo;
    if (effectiveTo && effectiveTo <= effectiveFrom) throw new ValidationError("The end date must be after the start date");
    await tx`
      update price_lists
         set name = ${body.name ?? list.name},
             description = ${body.description === undefined ? list.description : body.description},
             effective_from = ${effectiveFrom},
             effective_to = ${effectiveTo},
             updated_by = ${auth.user.id},
             updated_at = now()
       where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "price.list.update", {
      resourceType: "PriceList",
      resourceId: id,
      metadata: { name: body.name ?? list.name },
    }));
  });
  return c.json({ ok: true });
});

globalCatalogueRoutes.post("/global-catalogue/lists/:id/duplicate", async (c) => {
  requirePriceWriter(c);
  const id = z.string().uuid().parse(c.req.param("id"));
  const auth = c.get("auth")!;
  const newId = crypto.randomUUID();
  const newCode = await withStaffActor(c, async (tx) => {
    const list = await loadList(tx, auth.activeTenant!.id, id);
    const items = await listItems(tx, id);
    let code = `${String(list.code)}-COPY`;
    for (let attempt = 0; attempt < 20; attempt++) {
      const existing = await tx`select 1 from price_lists where code = ${code}`;
      if (!existing[0]) break;
      code = `${String(list.code)}-COPY${attempt + 2}`;
    }
    await tx`
      insert into price_lists (id, code, name, description, facility_id, tenant_id, source_type, source_reference, status,
                               effective_from, effective_to, active, created_by)
      values (${newId}, ${code}, ${`${String(list.name)} (copy)`}, ${list.description ?? null}, ${auth.activeTenant!.id},
              ${auth.activeTenant!.id}, 'copy', ${String(list.code)}, 'DRAFT', ${String(list.effectiveFrom)},
              ${(list.effectiveTo as string | null) ?? null}, true, ${auth.user.id})
    `;
    for (const item of items) {
      await tx`
        insert into price_list_prices (id, price_list_id, master_price_code, name, description, category, unit_type,
                                       is_service, price, currency, is_active, requires_approval, approval_status,
                                       effective_from, effective_to, created_by)
        values (${crypto.randomUUID()}, ${newId}, ${item.masterPriceCode ?? null}, ${String(item.name)},
                ${item.description ?? null}, ${String(item.category)}, ${String(item.unitType)}, ${Boolean(item.isService)},
                ${Number(item.price)}, ${String(item.currency)}, true, true, 'pending',
                ${String(item.effectiveFrom)}, ${(item.effectiveTo as string | null) ?? null}, ${auth.user.id})
      `;
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "price.list.duplicate", {
      resourceType: "PriceList",
      resourceId: newId,
      metadata: { sourceListId: id, copies: items.length },
    }));
    return code;
  });
  return c.json({ ok: true, list: { id: newId, code: newCode, status: "DRAFT" } }, 201);
});

globalCatalogueRoutes.post("/global-catalogue/lists/:id/items", async (c) => {
  requirePriceWriter(c);
  const id = z.string().uuid().parse(c.req.param("id"));
  const body = await parseJson(c, listItemInput);
  const auth = c.get("auth")!;
  const itemId = await withStaffActor(c, async (tx) => {
    const list = await loadList(tx, auth.activeTenant!.id, id, true);
    const status = normalizePriceListStatus(String(list.status));
    if (!priceListIsEditable(status)) throw new ConflictError("Only a draft or validated price list can take new items");
    if (body.masterPriceCode) {
      const duplicate = await tx`
        select 1 from price_list_prices where price_list_id = ${id} and master_price_code = ${body.masterPriceCode} and is_active
      `;
      if (duplicate[0]) throw new ConflictError("That catalogue item is already in this price list");
    }
    const created = await insertListItem(tx, {
      listId: id,
      listEffectiveFrom: String(list.effectiveFrom),
      userId: auth.user.id,
      item: body,
    });
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "price.list.item.add", {
      resourceType: "PriceList",
      resourceId: id,
      metadata: { masterPriceCode: body.masterPriceCode ?? null, price: body.price },
    }));
    return created;
  });
  return c.json({ ok: true, item: { id: itemId } }, 201);
});

const patchItemInput = z.object({
  price: z.number().finite().min(0).max(99_999_999).optional(),
  isActive: z.boolean().optional(),
  effectiveFrom: isoDate.optional(),
  effectiveTo: isoDate.nullish(),
  note: z.string().trim().max(500).optional(),
});

globalCatalogueRoutes.patch("/global-catalogue/lists/:id/items/:itemId", async (c) => {
  requirePriceWriter(c);
  const id = z.string().uuid().parse(c.req.param("id"));
  const itemId = z.string().uuid().parse(c.req.param("itemId"));
  const body = await parseJson(c, patchItemInput);
  const auth = c.get("auth")!;
  await withStaffActor(c, async (tx) => {
    const list = await loadList(tx, auth.activeTenant!.id, id, true);
    const status = normalizePriceListStatus(String(list.status));
    if (!priceListIsEditable(status)) throw new ConflictError("Only a draft or validated price list can be changed");
    const item = await requireRows(await tx`
      select id, price, currency, is_active, effective_from, effective_to from price_list_prices
       where id = ${itemId} and price_list_id = ${id} for update
    `, "Price not found in this list");
    const price = body.price ?? Number(item.price);
    assertMoney(price, String(item.currency));
    await tx`
      update price_list_prices
         set price = ${price},
             is_active = ${body.isActive ?? Boolean(item.isActive)},
             effective_from = ${body.effectiveFrom ?? String(item.effectiveFrom)},
             effective_to = ${body.effectiveTo === undefined ? (item.effectiveTo as string | null) : body.effectiveTo},
             updated_by = ${auth.user.id},
             updated_at = now()
       where id = ${itemId}
    `;
    if (body.note) {
      await tx`select set_config('app.price_change_reason', ${body.note}, true)`;
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "price.list.item.update", {
      resourceType: "PriceList",
      resourceId: id,
      metadata: { itemId, price, isActive: body.isActive ?? Boolean(item.isActive) },
    }));
  });
  return c.json({ ok: true });
});

globalCatalogueRoutes.delete("/global-catalogue/lists/:id/items/:itemId", async (c) => {
  requirePriceWriter(c);
  const id = z.string().uuid().parse(c.req.param("id"));
  const itemId = z.string().uuid().parse(c.req.param("itemId"));
  const auth = c.get("auth")!;
  await withStaffActor(c, async (tx) => {
    const list = await loadList(tx, auth.activeTenant!.id, id, true);
    const status = normalizePriceListStatus(String(list.status));
    if (!priceListIsEditable(status)) throw new ConflictError("Only a draft or validated price list can be changed");
    // Withdrawn, not deleted: the price-history trigger needs a stable row and an actor.
    const updated = await tx`
      update price_list_prices
         set is_active = false, updated_by = ${auth.user.id}, updated_at = now()
       where id = ${itemId} and price_list_id = ${id}
      returning id
    `;
    if (!updated[0]) throw new NotFoundError("Price not found in this list");
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "price.list.item.remove", {
      resourceType: "PriceList",
      resourceId: id,
      metadata: { itemId },
    }));
  });
  return c.json({ ok: true });
});

globalCatalogueRoutes.post("/global-catalogue/lists/:id/transition", async (c) => {
  requirePriceWriter(c);
  const id = z.string().uuid().parse(c.req.param("id"));
  const body = await parseJson(c, transitionInput);
  const auth = c.get("auth")!;
  const operator = isPlatformOperator(c);
  const result = await withStaffActor(c, async (tx) => {
    const list = await loadList(tx, auth.activeTenant!.id, id, true);
    const status = normalizePriceListStatus(String(list.status));
    const action = body.action as PriceListAction;
    assertPriceListActionRole(action, requestActor(c).roles, operator);

    let next;
    try {
      next = nextPriceListStatus(status, action);
    } catch (error) {
      throw new ConflictError((error as Error).message);
    }

    const items = await listItems(tx, id);
    const active = items.filter((item) => item.isActive);
    if (action === "validate" || action === "submit" || action === "approve" || action === "publish") {
      const issues = validatePriceList({
        code: String(list.code),
        name: String(list.name),
        effectiveFrom: String(list.effectiveFrom),
        effectiveTo: (list.effectiveTo as string | null) ?? null,
        items: active.map((item) => ({
          masterPriceCode: (item.masterPriceCode as string | null) ?? null,
          name: String(item.name),
          category: String(item.category),
          price: Number(item.price),
          currency: String(item.currency),
        })),
      });
      if (issues.length) {
        throw new ValidationError("This price list is not ready for that step", issues);
      }
    }

    const approving = action === "approve" || action === "publish";
    await tx`
      update price_lists
         set status = ${next},
             approved_by = ${approving ? auth.user.id : (list.approvedBy as string | null) ?? null},
             approved_at = ${approving ? new Date() : (list.approvedAt as Date | null) ?? null},
             active = ${next === "ARCHIVED" ? false : true},
             updated_by = ${auth.user.id},
             updated_at = now()
       where id = ${id}
    `;
    if (action === "publish") {
      await tx`
        update price_list_prices
           set approval_status = 'approved', approved_by = ${auth.user.id}, approved_at = now(),
               updated_by = ${auth.user.id}, updated_at = now()
         where price_list_id = ${id} and is_active and approval_status <> 'approved'
      `;
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, `price.list.${action}`, {
      resourceType: "PriceList",
      resourceId: id,
      metadata: { from: status, to: next, note: body.note ?? null, items: active.length },
    }));
    return { status: next, availableActions: availablePriceListActions(next) };
  });
  return c.json({ ok: true, ...result });
});

globalCatalogueRoutes.get("/global-catalogue/lists/:id/history", async (c) => {
  requirePriceReader(c);
  const id = z.string().uuid().parse(c.req.param("id"));
  const auth = c.get("auth")!;
  const result = await withStaffActor(c, async (tx) => {
    await loadList(tx, auth.activeTenant!.id, id);
    const prices = await tx`
      select h.id, h.change_type, h.previous_price, h.new_price, h.changed_by, h.changed_at, h.reason,
             h.approval_status_before, h.approval_status_after, p.name, p.currency
        from price_history h join price_list_prices p on p.id = h.price_list_price_id
       where p.price_list_id = ${id}
       order by h.changed_at desc
       limit 200
    `;
    // Lifecycle events live in the tamper-evident audit trail; a role that cannot read it sees none.
    const events = await tx`
      select id, action, occurred_at, actor_user_id, metadata
        from audit_events
       where tenant_id = ${auth.activeTenant!.id} and resource_type = 'PriceList' and resource_id = ${id}
       order by occurred_at desc
       limit 100
    `;
    return { prices, events };
  });
  return c.json(result);
});
