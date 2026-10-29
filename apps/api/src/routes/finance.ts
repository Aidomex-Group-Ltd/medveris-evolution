import { Hono, type Context } from "hono";
import {
  billingWaiverSchema,
  cashPaymentSchema,
  claimSchema,
  encounterBillSchema,
  facilityBillingSettingsSchema,
  invoiceSchema,
  invoiceVoidSchema,
  mobileMoneyRequestSchema,
  paymentRefundSchema,
  paymentReversalSchema,
  paymentSchema,
  priceConversionApplySchema,
  priceConversionQuoteSchema,
  serviceCatalogSchema,
  serviceCatalogUpdateSchema,
  uuidSchema,
} from "@medveris/contracts";
import { assertCashier, assertFinance, assertPriceListManager, PRICE_LIST_ROLES } from "@medveris/authz";
import type { Tx } from "@medveris/db";
import {
  assertFacilityPrice,
  DEFAULT_SIGNIFICANT_PRICE_CHANGE_PERCENT,
  isSignificantPriceChange,
  fitsCurrencyPrecision,
  maskMsisdn,
  normalizeUgandaMsisdn,
  roundMoney,
  roundToCurrency,
  yoSupports,
} from "@medveris/domain";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { auditMeta, ensureMatch, parseJson } from "../lib/http.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { AppError, ConflictError, DependencyError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { idempotencyKey, uniqueViolation } from "../lib/idempotency.js";
import { enforceRateLimit } from "../lib/rate-limit.js";
import { resolveAttribution } from "../lib/scope.js";
import { assertIntegrationAvailable, integrationStatus, isIntegrationAvailable } from "../integrations/registry.js";
import { createYoClient, yoConfigProblems, yoOutcome, YoTransportError, type YoClient } from "../integrations/yo.js";
import { createFxProvider, FxUnavailableError } from "../integrations/fx.js";
import { invoiceNumber, invoiceTotals, receiptNumber, refreshInvoice } from "../services/billing.js";
import { applyMobileMoneyEvidence, type MobileMoneyActor, type MobileMoneyEvidence } from "../services/mobile-money.js";
import type { AppEnv } from "../types.js";

export const financeRoutes = new Hono<AppEnv>();

function hasRole(c: Parameters<typeof requireStaff>[0], ...roles: string[]): boolean {
  return requestActor(c).roles.some((role) => roles.includes(role));
}

/** Price list for every staff member: departments pick what they request or supply; prices change only through finance. */
financeRoutes.get("/service-catalog", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const active = c.req.query("active");
  const category = c.req.query("category");
  const itemType = c.req.query("itemType");
  const { rows, settings } = await withStaffActor(c, async (tx) => ({
    rows: await tx`
      select s.id, s.code, s.name, s.category, s.item_type, s.price, s.currency, s.active, s.price_status, s.department_id, s.description,
             s.unit_of_measure, s.version, s.created_at, s.updated_at, s.approved_at, s.deactivated_at, s.deactivation_reason,
             d.name as department_name, u.display_name as updated_by_name
        from service_catalog s left join departments d on d.id = s.department_id left join users u on u.id = coalesce(s.updated_by, s.created_by)
       where s.tenant_id = ${auth.activeTenant!.id}
         ${active === "true" ? tx`and s.active` : active === "false" ? tx`and not s.active` : tx``}
         ${category ? tx`and s.category = ${category}` : tx``}
         ${itemType ? tx`and s.item_type = ${itemType}` : tx``}
       order by s.category, s.name
    `,
    settings: await facilitySettings(tx, auth.activeTenant!.id),
  }));
  return c.json({ services: rows, canManage: hasRole(c, ...PRICE_LIST_ROLES), settings });
});

async function checkedDepartment(tx: Tx, tenantId: string, departmentId: string | null | undefined): Promise<string | null> {
  if (!departmentId) return null;
  await requireRows(await tx`select id from departments where id = ${departmentId} and tenant_id = ${tenantId}`, "Department not found in this workspace");
  return departmentId;
}

export interface FacilitySettings {
  allowedCurrencies: string[];
  allowZeroPrices: boolean;
  allowManualCharges: boolean;
  significantChangePercent: number;
  version: number;
}

/** The facility's own pricing rules; defaults apply until an administrator saves settings. */
export async function facilitySettings(tx: Tx, tenantId: string): Promise<FacilitySettings> {
  const [row] = await tx`select * from facility_billing_settings where tenant_id = ${tenantId}`;
  return {
    allowedCurrencies: (row?.allowedCurrencies as string[] | undefined) ?? ["UGX"],
    allowZeroPrices: Boolean(row?.allowZeroPrices ?? false),
    allowManualCharges: Boolean(row?.allowManualCharges ?? true),
    significantChangePercent: Number(row?.significantChangePercent ?? DEFAULT_SIGNIFICANT_PRICE_CHANGE_PERCENT),
    version: Number(row?.version ?? 0),
  };
}

function assertPriceRules(settings: FacilitySettings, price: number, currency: string): void {
  if (!settings.allowedCurrencies.includes(currency)) {
    throw new ValidationError(`This facility prices in ${settings.allowedCurrencies.join(" or ")}. Add ${currency} in billing settings first.`, [{ path: "currency", message: "Currency not enabled for this facility" }]);
  }
  try {
    assertFacilityPrice(price, currency, settings.allowZeroPrices);
  } catch (error) {
    throw new ValidationError((error as Error).message, [{ path: "price", message: (error as Error).message }]);
  }
}

/** Why a change to a price-list item needs the administrator's explicit confirmation, if it does. */
async function confirmationReasons(tx: Tx, current: Record<string, unknown>, next: { price: number; currency: string; active: boolean; priceStatus: string }, settings: FacilitySettings): Promise<string[]> {
  const reasons: string[] = [];
  const previous = Number(current.price);
  if (next.currency !== current.currency) reasons.push(`The currency changes from ${current.currency} to ${next.currency}.`);
  else if (isSignificantPriceChange(previous, next.price, settings.significantChangePercent)) {
    reasons.push(`The price changes by more than ${settings.significantChangePercent}% (${previous} to ${next.price} ${next.currency}).`);
  }
  if (current.priceStatus === "test" && next.priceStatus === "approved") reasons.push("Approving this price lets it be charged on patients' bills.");
  if ((current.active && !next.active) || (current.priceStatus === "approved" && next.priceStatus === "test")) {
    const itemId = String(current.id);
    const [use] = await tx`
      select
        (select count(*)::int from care_recommendations r where r.catalog_item_id = ${itemId} and r.status in ('requested','accepted','in-progress')) as open_requests,
        (select count(*)::int from care_supply_usages su where su.catalog_item_id = ${itemId} and su.billing_status = 'unbilled' and su.voided_at is null) as unbilled_supplies,
        (select count(*)::int from invoice_items ii where ii.service_id = ${itemId}) as bill_lines
    `;
    const inUse = Number(use?.openRequests ?? 0) + Number(use?.unbilledSupplies ?? 0);
    if (inUse) reasons.push(`It is in use: ${use!.openRequests} open request(s) and ${use!.unbilledSupplies} unbilled supplied item(s) can no longer be billed at this price.`);
    else if (Number(use?.billLines ?? 0)) reasons.push(`It appears on ${use!.billLines} bill line(s); those bills keep their amounts.`);
  }
  return reasons;
}

financeRoutes.post("/service-catalog", async (c) => {
  requireStaff(c);
  assertPriceListManager(requestActor(c));
  const auth = c.get("auth")!;
  const body = await parseJson(c, serviceCatalogSchema);
  const id = crypto.randomUUID();
  try {
    await withStaffActor(c, async (tx) => {
      assertPriceRules(await facilitySettings(tx, auth.activeTenant!.id), body.price, body.currency);
      const departmentId = await checkedDepartment(tx, auth.activeTenant!.id, body.departmentId);
      await tx`select set_config('app.price_change_reason', ${body.priceStatus === "test" ? "Added as a test price" : "Added"}, true)`;
      await tx`
        insert into service_catalog (id, tenant_id, code, name, category, item_type, price, currency, active, department_id, description, unit_of_measure,
          price_status, approved_by, approved_at, created_by, updated_by)
        values (${id}, ${auth.activeTenant!.id}, ${body.code}, ${body.name}, ${body.category}, ${body.itemType}, ${body.price}, ${body.currency},
          ${body.active}, ${departmentId}, ${body.description || null}, ${body.unitOfMeasure || null}, ${body.priceStatus},
          ${body.priceStatus === "approved" ? auth.user.id : null}, ${body.priceStatus === "approved" ? new Date() : null}, ${auth.user.id}, ${auth.user.id})
      `;
      await writeAudit(tx, c.get("deps").config, requestAudit(c, "service.catalog.create", {
        resourceType: "ServiceCatalog", resourceId: id,
        metadata: { code: body.code, itemType: body.itemType, category: body.category, price: body.price, currency: body.currency, active: body.active, priceStatus: body.priceStatus, departmentId },
      }));
    });
  } catch (error) {
    if (uniqueViolation(error) === "service_catalog_tenant_id_code_key") throw new ConflictError(`Code ${body.code} is already used on this price list`);
    throw error;
  }
  return c.json({ ok: true, service: { id } }, 201);
});

/**
 * Changes one item of this facility's price list. Bills already issued keep their amounts; the new
 * price applies to items billed afterwards. A significant price change, approving a test price,
 * withdrawing an approved price or deactivating an item in use needs `confirm: true`; without it the
 * response is 409 confirmation_required with the reasons to show the administrator.
 */
financeRoutes.patch("/service-catalog/:id", async (c) => {
  requireStaff(c);
  assertPriceListManager(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, serviceCatalogUpdateSchema);
  const result = await withStaffActor(c, async (tx) => {
    const current = await requireRows(await tx`select * from service_catalog where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update`, "Price-list item not found");
    ensureMatch(body.expectedVersion, Number(current.version));
    const settings = await facilitySettings(tx, auth.activeTenant!.id);
    const departmentId = body.departmentId === undefined ? current.departmentId : await checkedDepartment(tx, auth.activeTenant!.id, body.departmentId);
    const next = {
      name: body.name ?? current.name,
      category: body.category ?? current.category,
      itemType: body.itemType ?? current.itemType,
      price: body.price ?? Number(current.price),
      currency: body.currency ?? current.currency,
      active: body.active ?? current.active,
      priceStatus: body.priceStatus ?? current.priceStatus,
      departmentId,
      description: body.description === undefined ? current.description : body.description || null,
      unitOfMeasure: body.unitOfMeasure === undefined ? current.unitOfMeasure : body.unitOfMeasure || null,
    };
    const changed = Object.entries(next).filter(([key, value]) => String(value ?? "") !== String((key === "price" ? Number(current.price) : current[key]) ?? ""));
    if (!changed.length) return { version: Number(current.version) };
    if (body.price !== undefined || body.currency !== undefined) assertPriceRules(settings, next.price, String(next.currency));
    const reasons = await confirmationReasons(tx, current, { price: next.price, currency: String(next.currency), active: Boolean(next.active), priceStatus: String(next.priceStatus) }, settings);
    if (reasons.length && body.confirm !== true) {
      throw new AppError(409, "confirmation_required", "Confirm this price-list change", { reasons });
    }
    const deactivating = current.active && !next.active;
    const approving = current.priceStatus !== "approved" && next.priceStatus === "approved";
    await tx`select set_config('app.price_change_reason', ${body.reason || ""}, true)`;
    await tx`
      update service_catalog set name = ${next.name}, category = ${next.category}, item_type = ${next.itemType}, price = ${next.price},
        currency = ${next.currency}, active = ${next.active}, price_status = ${next.priceStatus}, department_id = ${next.departmentId},
        description = ${next.description}, unit_of_measure = ${next.unitOfMeasure},
        approved_by = ${approving ? auth.user.id : next.priceStatus === "approved" ? current.approvedBy : null},
        approved_at = ${approving ? new Date() : next.priceStatus === "approved" ? current.approvedAt : null},
        deactivated_by = ${deactivating ? auth.user.id : next.active ? null : current.deactivatedBy},
        deactivated_at = ${deactivating ? new Date() : next.active ? null : current.deactivatedAt},
        deactivation_reason = ${deactivating ? body.reason || null : next.active ? null : current.deactivationReason},
        version = version + 1, updated_by = ${auth.user.id}, updated_at = now()
       where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "service.catalog.update", {
      resourceType: "ServiceCatalog", resourceId: id,
      metadata: {
        code: current.code, reason: body.reason || null, confirmed: reasons.length ? reasons : null,
        changes: Object.fromEntries(changed.map(([key, value]) => [key, { from: key === "price" ? Number(current.price) : current[key], to: value }])),
      },
    }));
    return { version: Number(current.version) + 1 };
  });
  return c.json({ ok: true, service: { id, version: result.version } });
});

/** Every version of one item: previous and new price, currency, status and availability, by whom and why. */
financeRoutes.get("/service-catalog/:id/history", async (c) => {
  requireStaff(c);
  if (!hasRole(c, "finance", "facility_admin", "auditor")) throw new ForbiddenError("Price history is available to finance, administrators and auditors");
  const tenantId = c.get("auth")!.activeTenant!.id;
  const id = uuidSchema.parse(c.req.param("id"));
  const history = await withStaffActor(c, async (tx) => {
    await requireRows(await tx`select id from service_catalog where id = ${id} and tenant_id = ${tenantId}`, "Price-list item not found");
    return tx`
      select h.version, h.change, h.previous_price, h.new_price, h.previous_currency, h.new_currency, h.previous_status, h.new_status,
             h.previous_active, h.new_active, h.reason, h.changed_at, u.display_name as changed_by_name
        from service_price_history h left join users u on u.id = h.changed_by
       where h.catalog_item_id = ${id} and h.tenant_id = ${tenantId} order by h.version desc`;
  });
  return c.json({ history });
});

financeRoutes.get("/billing-settings", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const settings = await withStaffActor(c, (tx) => facilitySettings(tx, auth.activeTenant!.id));
  return c.json({ settings, canManage: hasRole(c, "facility_admin") });
});

/** Facility pricing rules: currencies offered, whether zero prices and manual charges are allowed, and the confirmation threshold. */
financeRoutes.put("/billing-settings", async (c) => {
  requireStaff(c);
  if (!hasRole(c, "facility_admin")) throw new ForbiddenError("Only a facility administrator can change billing settings");
  const auth = c.get("auth")!;
  const body = await parseJson(c, facilityBillingSettingsSchema);
  const tenantId = auth.activeTenant!.id;
  const settings = await withStaffActor(c, async (tx) => {
    const before = await facilitySettings(tx, tenantId);
    ensureMatch(body.expectedVersion, before.version);
    const currencies = [...new Set(body.allowedCurrencies)];
    await tx`
      insert into facility_billing_settings (tenant_id, allowed_currencies, allow_zero_prices, allow_manual_charges, significant_change_percent, version, updated_by)
      values (${tenantId}, ${currencies}, ${body.allowZeroPrices}, ${body.allowManualCharges}, ${body.significantChangePercent}, 1, ${auth.user.id})
      on conflict (tenant_id) do update set allowed_currencies = excluded.allowed_currencies, allow_zero_prices = excluded.allow_zero_prices,
        allow_manual_charges = excluded.allow_manual_charges, significant_change_percent = excluded.significant_change_percent,
        version = facility_billing_settings.version + 1, updated_by = excluded.updated_by, updated_at = now()
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "facility.billing-settings.update", {
      resourceType: "FacilityBillingSettings", resourceId: tenantId,
      metadata: { before: { ...before, version: undefined }, after: { allowedCurrencies: currencies, allowZeroPrices: body.allowZeroPrices, allowManualCharges: body.allowManualCharges, significantChangePercent: body.significantChangePercent } },
    }));
    return facilitySettings(tx, tenantId);
  });
  return c.json({ ok: true, settings });
});

/**
 * Quotes a conversion of one price-list item using the configured exchange-rate provider and locks the
 * rate for a short time. Nothing changes until the administrator applies the lock. Without a provider
 * key the operation is unavailable; a rate is never invented or applied silently at billing time.
 */
financeRoutes.post("/service-catalog/:id/convert", async (c) => {
  requireStaff(c);
  assertPriceListManager(requestActor(c));
  const auth = c.get("auth")!;
  const tenantId = auth.activeTenant!.id;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, priceConversionQuoteSchema);
  const targetCurrency = body.targetCurrency;
  const item = await withStaffActor(c, async (tx) => {
    const row = await requireRows(await tx`select * from service_catalog where id = ${id} and tenant_id = ${tenantId}`, "Price-list item not found");
    const settings = await facilitySettings(tx, tenantId);
    if (!settings.allowedCurrencies.includes(targetCurrency)) {
      throw new ValidationError(`Add ${targetCurrency} to this facility's billing settings before converting prices into it.`);
    }
    return row;
  });
  const baseCurrency = String(item.currency);
  if (baseCurrency === targetCurrency) throw new ValidationError(`This item is already priced in ${targetCurrency}`);
  const provider = createFxProvider(c.get("deps").config.fx);
  if (!provider) throw new AppError(503, "integration_unavailable", "Currency conversion is unavailable: no exchange-rate provider key is configured for this deployment.");
  let quote;
  try {
    quote = await provider.rate(baseCurrency, targetCurrency);
  } catch (error) {
    if (error instanceof FxUnavailableError) throw new DependencyError(`${error.message}. No conversion was locked; try again later.`);
    throw error;
  }
  const fetchedAt = new Date();
  const expiresAt = new Date(fetchedAt.getTime() + c.get("deps").config.fx.lockMinutes * 60_000);
  const sourceAmount = roundToCurrency(Number(item.price), baseCurrency);
  const convertedAmount = roundToCurrency(sourceAmount * quote.rate, targetCurrency);
  const lockId = crypto.randomUUID();
  const lock = await withStaffActor(c, async (tx) => {
    const current = await requireRows(await tx`select price, currency, version from service_catalog where id = ${id} and tenant_id = ${tenantId} for update`, "Price-list item not found");
    if (String(current.currency) !== baseCurrency || Number(current.price) !== sourceAmount) {
      throw new ConflictError("This price changed while the rate was being fetched. Quote the conversion again.");
    }
    await tx`
      insert into fx_rate_locks (id, tenant_id, catalog_item_id, base_currency, quote_currency, rate, source_amount, converted_amount,
        provider, provider_timestamp, fetched_at, expires_at, locked_by, catalog_version)
      values (${lockId}, ${tenantId}, ${id}, ${baseCurrency}, ${targetCurrency}, ${quote.rate}, ${sourceAmount}, ${convertedAmount},
        ${quote.provider}, ${quote.providerTimestamp}, ${fetchedAt}, ${expiresAt}, ${auth.user.id}, ${Number(current.version)})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "service.catalog.fx-lock", {
      resourceType: "ServiceCatalog", resourceId: id,
      metadata: { baseCurrency, targetCurrency, rate: quote.rate, provider: quote.provider, providerTimestamp: quote.providerTimestamp, expiresAt, sourceAmount, convertedAmount, lockId },
    }));
    return { id: lockId, baseCurrency, targetCurrency, rate: quote.rate, provider: quote.provider, providerTimestamp: quote.providerTimestamp, fetchedAt, expiresAt, sourceAmount, convertedAmount, catalogVersion: Number(current.version) };
  });
  return c.json({ ok: true, lock, preview: { price: convertedAmount, currency: targetCurrency, previousPrice: sourceAmount, previousCurrency: baseCurrency } }, 201);
});

/** Applies a previously locked rate to the item. The lock must be unexpired, unused and still match the item's version. */
financeRoutes.post("/service-catalog/:id/convert/apply", async (c) => {
  requireStaff(c);
  assertPriceListManager(requestActor(c));
  const auth = c.get("auth")!;
  const tenantId = auth.activeTenant!.id;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, priceConversionApplySchema);
  const result = await withStaffActor(c, async (tx) => {
    const item = await requireRows(await tx`select * from service_catalog where id = ${id} and tenant_id = ${tenantId} for update`, "Price-list item not found");
    ensureMatch(body.expectedVersion, Number(item.version));
    const lock = await requireRows(await tx`
      select * from fx_rate_locks where id = ${body.lockId} and tenant_id = ${tenantId} and catalog_item_id = ${id} for update
    `, "The locked rate was not found for this item");
    if (lock.usedAt) throw new ConflictError("This rate was already used. Quote the conversion again.");
    if (new Date(lock.expiresAt as Date) <= new Date()) throw new ConflictError("The locked rate expired. Quote the conversion again.");
    if (String(lock.catalogVersion) !== String(item.version) || String(lock.baseCurrency) !== String(item.currency)) {
      throw new ConflictError("The item changed since the rate was locked. Quote the conversion again.");
    }
    const settings = await facilitySettings(tx, tenantId);
    if (!settings.allowedCurrencies.includes(String(lock.quoteCurrency))) throw new ValidationError(`Add ${lock.quoteCurrency} to the facility's billing settings first.`);
    const reason = `Converted from ${lock.baseCurrency} at the locked ${lock.provider} rate of ${lock.rate} (locked ${new Date(lock.fetchedAt as Date).toISOString()})`;
    await tx`select set_config('app.fx_rate_lock_id', ${body.lockId}, true)`;
    await tx`select set_config('app.price_change_reason', ${reason}, true)`;
    await tx`
      update service_catalog set price = ${lock.convertedAmount}, currency = ${lock.quoteCurrency}, version = version + 1,
        updated_by = ${auth.user.id}, updated_at = now() where id = ${id}
    `;
    await tx`update fx_rate_locks set used_at = now() where id = ${body.lockId}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "service.catalog.fx-apply", {
      resourceType: "ServiceCatalog", resourceId: id,
      metadata: { lockId: body.lockId, from: { price: Number(lock.sourceAmount), currency: lock.baseCurrency }, to: { price: Number(lock.convertedAmount), currency: lock.quoteCurrency }, rate: Number(lock.rate), provider: lock.provider },
    }));
    return { price: Number(lock.convertedAmount), currency: String(lock.quoteCurrency), version: Number(item.version) + 1 };
  });
  return c.json({ ok: true, service: { id, ...result } });
});

/** The database refuses a bill line whose price is a test price, inactive, or no longer the current price. */
function rethrowPriceGuard(error: unknown): void {
  const message = (error as { message?: string }).message ?? "";
  if (message === "invoice_item_test_price") throw new ValidationError("A test price cannot be charged on a bill. Approve the price first.");
  if (message === "invoice_item_inactive_price") throw new ConflictError("A price-list item was deactivated while billing. Reload and try again.");
  if (message === "invoice_item_price_mismatch") throw new ConflictError("A price changed while billing. Reload to bill at the current price.");
  if (message === "invoice_item_unknown_price") throw new ValidationError("A price-list item does not belong to this facility");
}

// ---------------------------------------------------------------- bills built from a visit

/** What a visit could be charged for: recommended and completed work and supplied items, with what is already on a bill. */
financeRoutes.get("/encounters/:id/billable", async (c) => {
  requireStaff(c);
  assertCashier(requestActor(c));
  const tenantId = c.get("auth")!.activeTenant!.id;
  const id = uuidSchema.parse(c.req.param("id"));
  const data = await withStaffActor(c, async (tx) => {
    const encounter = await requireRows(await tx`
      select e.id, e.state, e.opened_at, e.patient_id, p.public_id, p.given_name, p.family_name
        from encounters e join patients p on p.id = e.patient_id where e.id = ${id} and e.tenant_id = ${tenantId}
    `, "Visit not found");
    const recommendations = await tx`
      select r.id, r.description, r.quantity, r.status, r.billing_status, r.target_department, r.priority, r.catalog_item_id,
             s.code, s.price, s.currency, s.active as item_active, s.price_status, ii.invoice_id, i.number as invoice_number
        from care_recommendations r
        left join service_catalog s on s.id = r.catalog_item_id
        left join invoice_items ii on ii.recommendation_id = r.id
        left join invoices i on i.id = ii.invoice_id
       where r.encounter_id = ${id} and r.tenant_id = ${tenantId} and (r.status not in ('declined','cancelled') or ii.id is not null)
       order by r.created_at
    `;
    const supplies = await tx`
      select su.id, s.name as description, su.quantity, su.billing_status, su.recorded_at, s.code, s.price, s.currency, s.item_type,
             s.active as item_active, s.price_status, ii.invoice_id, i.number as invoice_number
        from care_supply_usages su
        join service_catalog s on s.id = su.catalog_item_id
        left join invoice_items ii on ii.supply_usage_id = su.id
        left join invoices i on i.id = ii.invoice_id
       where su.encounter_id = ${id} and su.tenant_id = ${tenantId} and su.voided_at is null
       order by su.recorded_at
    `;
    const invoices = await tx`
      select i.id, i.number, i.status, i.currency, i.created_at,
        coalesce((select sum(ii.amount) from invoice_items ii where ii.invoice_id = i.id), 0) as total,
        coalesce((select sum(p.amount) from payments p where p.invoice_id = i.id and p.reversed_at is null), 0) as paid
        from invoices i where i.encounter_id = ${id} and i.tenant_id = ${tenantId} and i.status <> 'void' order by i.created_at
    `;
    return { encounter, recommendations, supplies, invoices };
  });
  const line = (row: Record<string, unknown>, kind: "recommendation" | "supply") => ({
    kind, id: row.id, description: row.description, quantity: Number(row.quantity), status: row.status ?? null,
    department: row.targetDepartment ?? null, billingStatus: row.billingStatus, code: row.code ?? null,
    unitPrice: row.price == null ? null : Number(row.price), currency: row.currency ?? null,
    amount: row.price == null ? null : roundMoney(Number(row.price) * Number(row.quantity)),
    priced: row.price != null && row.itemActive !== false && row.priceStatus === "approved",
    priceStatus: row.priceStatus ?? null,
    invoice: row.invoiceId ? { id: row.invoiceId, number: row.invoiceNumber } : null,
  });
  const recommendations = data.recommendations.map((row) => line(row, "recommendation"));
  const supplies = data.supplies.map((row) => line(row, "supply"));
  const all = [...recommendations, ...supplies];
  const unbilled = all.filter((entry) => entry.billingStatus === "unbilled");
  const unpriced = unbilled.filter((entry) => !entry.priced);
  return c.json({
    encounter: {
      id: data.encounter.id, state: data.encounter.state, openedAt: data.encounter.openedAt,
      patient: { id: data.encounter.patientId, publicId: data.encounter.publicId, givenName: data.encounter.givenName, familyName: data.encounter.familyName },
    },
    recommendations,
    supplies,
    checkout: {
      unbilled: unbilled.length,
      unpriced: unpriced.length,
      waived: all.filter((entry) => entry.billingStatus === "waived").length,
      billed: all.filter((entry) => entry.billingStatus !== "unbilled" && entry.billingStatus !== "waived").length,
      message: unpriced.length
        ? `${unpriced.length} unbilled item(s) have no approved price. Add a price, bill as a manual line, or waive with a reason.`
        : unbilled.length ? `${unbilled.length} item(s) are still unbilled.` : "Every recorded item has been billed or waived.",
    },
    invoices: data.invoices.map((row) => ({
      id: row.id, number: row.number, status: row.status, currency: row.currency, createdAt: row.createdAt,
      total: Number(row.total), paid: Number(row.paid), balance: roundMoney(Number(row.total) - Number(row.paid)),
    })),
  });
});

/**
 * Adds selected recommendations and supplied items to the visit's open bill, creating it if needed. Each
 * item can be charged once: an item already on a bill is skipped and reported, and the database refuses a
 * second line for the same item even under concurrent requests.
 */
financeRoutes.post("/encounters/:id/bill", async (c) => {
  requireStaff(c);
  assertCashier(requestActor(c));
  const auth = c.get("auth")!;
  const tenantId = auth.activeTenant!.id;
  const encounterId = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, encounterBillSchema);
  try {
    const result = await withStaffActor(c, async (tx) => {
      const encounter = await requireRows(await tx`
        select id, patient_id, state, department_id, unit_id from encounters where id = ${encounterId} and tenant_id = ${tenantId} for update
      `, "Visit not found");
      if (["cancelled", "entered-in-error"].includes(String(encounter.state))) throw new ConflictError(`This visit is ${encounter.state} and cannot be billed`);
      const recommendations = body.recommendationIds.length ? await tx`
        select r.id, r.description, r.quantity, r.status, r.billing_status, r.catalog_item_id, s.price, s.currency, s.active as item_active, s.price_status
          from care_recommendations r left join service_catalog s on s.id = r.catalog_item_id
         where r.tenant_id = ${tenantId} and r.encounter_id = ${encounterId} and r.id = any(${body.recommendationIds}::uuid[])
         for update of r
      ` : [];
      const supplies = body.supplyUsageIds.length ? await tx`
        select su.id, s.name as description, su.quantity, su.billing_status, su.catalog_item_id, s.price, s.currency, su.voided_at,
               s.active as item_active, s.price_status
          from care_supply_usages su join service_catalog s on s.id = su.catalog_item_id
         where su.tenant_id = ${tenantId} and su.encounter_id = ${encounterId} and su.id = any(${body.supplyUsageIds}::uuid[])
         for update of su
      ` : [];
      if (recommendations.length !== body.recommendationIds.length || supplies.length !== body.supplyUsageIds.length) {
        throw new ValidationError("Some selected items do not belong to this visit");
      }
      const skipped: Array<{ id: string; description: string; reason: string }> = [];
      const lines: Array<{ source: "recommendation" | "supply"; id: string; serviceId: string; description: string; quantity: number; unitPrice: number; currency: string }> = [];
      for (const row of recommendations) {
        if (row.billingStatus !== "unbilled") skipped.push({ id: String(row.id), description: String(row.description), reason: "already on a bill" });
        else if (["cancelled", "declined"].includes(String(row.status))) skipped.push({ id: String(row.id), description: String(row.description), reason: `request ${row.status}` });
        else if (!row.catalogItemId || row.price == null) skipped.push({ id: String(row.id), description: String(row.description), reason: "no price-list item; add a priced line instead" });
        else if (row.priceStatus !== "approved") skipped.push({ id: String(row.id), description: String(row.description), reason: "test price, not approved for billing" });
        else if (!row.itemActive) skipped.push({ id: String(row.id), description: String(row.description), reason: "price-list item is inactive" });
        else lines.push({ source: "recommendation", id: String(row.id), serviceId: String(row.catalogItemId), description: String(row.description), quantity: Number(row.quantity), unitPrice: Number(row.price), currency: String(row.currency) });
      }
      for (const row of supplies) {
        if (row.voidedAt) skipped.push({ id: String(row.id), description: String(row.description), reason: "voided" });
        else if (row.billingStatus !== "unbilled") skipped.push({ id: String(row.id), description: String(row.description), reason: "already on a bill" });
        else if (row.priceStatus !== "approved") skipped.push({ id: String(row.id), description: String(row.description), reason: "test price, not approved for billing" });
        else if (!row.itemActive) skipped.push({ id: String(row.id), description: String(row.description), reason: "price-list item is inactive" });
        else lines.push({ source: "supply", id: String(row.id), serviceId: String(row.catalogItemId), description: String(row.description), quantity: Number(row.quantity), unitPrice: Number(row.price), currency: String(row.currency) });
      }
      if (!lines.length) return { invoice: null, added: 0, skipped };
      const [open] = await tx`
        select id, number, currency from invoices
         where tenant_id = ${tenantId} and encounter_id = ${encounterId} and status in ('open','part-paid')
         order by created_at desc limit 1 for update
      `;
      const currency = open ? String(open.currency) : lines[0]!.currency;
      const mismatch = lines.find((line) => line.currency !== currency);
      if (mismatch) throw new ValidationError(`${mismatch.description} is priced in ${mismatch.currency}, but this bill is in ${currency}`);
      let invoiceId = open ? String(open.id) : crypto.randomUUID();
      let number = open ? String(open.number) : invoiceNumber();
      if (!open) {
        await tx`
          insert into invoices (id, tenant_id, patient_id, encounter_id, number, currency, issued_by, department_id, unit_id)
          values (${invoiceId}, ${tenantId}, ${encounter.patientId}, ${encounterId}, ${number}, ${currency}, ${auth.user.id}, ${encounter.departmentId}, ${encounter.unitId})
        `;
      }
      for (const line of lines) {
        await tx`
          insert into invoice_items (id, tenant_id, invoice_id, service_id, description, quantity, unit_price, amount, source, recommendation_id, supply_usage_id, created_by)
          values (${crypto.randomUUID()}, ${tenantId}, ${invoiceId}, ${line.serviceId}, ${line.description}, ${line.quantity}, ${line.unitPrice},
            ${roundMoney(line.quantity * line.unitPrice)}, ${line.source}, ${line.source === "recommendation" ? line.id : null},
            ${line.source === "supply" ? line.id : null}, ${auth.user.id})
        `;
        if (line.source === "recommendation") {
          await tx`update care_recommendations set billing_status = 'billed', updated_at = now() where id = ${line.id}`;
          await tx`
            insert into care_recommendation_events (id, tenant_id, recommendation_id, event, note, actor_user_id, actor_roles)
            values (${crypto.randomUUID()}, ${tenantId}, ${line.id}, 'billed', ${`Added to bill ${number}`}, ${auth.user.id}, ${auth.activeTenant!.roles})
          `;
        } else {
          await tx`update care_supply_usages set billing_status = 'billed' where id = ${line.id}`;
        }
      }
      await refreshInvoice(tx, tenantId, invoiceId, auth.user.id);
      await writeAudit(tx, c.get("deps").config, requestAudit(c, open ? "invoice.lines.add" : "invoice.create", {
        subjectPatientId: String(encounter.patientId), resourceType: "Invoice", resourceId: invoiceId,
        metadata: { number, encounterId, recommendations: lines.filter((line) => line.source === "recommendation").length, supplies: lines.filter((line) => line.source === "supply").length, skipped: skipped.length },
      }));
      if (!open) await writeOutbox(tx, { tenantId, eventType: "invoice.created", aggregateId: invoiceId, payload: { number } });
      invoiceId = String(invoiceId);
      number = String(number);
      return { invoice: { id: invoiceId, number }, added: lines.length, skipped };
    });
    return c.json({ ok: true, ...result }, result.added ? 201 : 200);
  } catch (error) {
    const constraint = uniqueViolation(error);
    if (constraint === "invoice_items_recommendation_once" || constraint === "invoice_items_supply_once") {
      throw new ConflictError("One of these items was just added to a bill by someone else. Reload the visit to see it.");
    }
    rethrowPriceGuard(error);
    throw error;
  }
});

/** Removes a line from a bill that has no payment yet; a recommended or supplied item becomes billable again. */
financeRoutes.post("/invoices/:id/items/:itemId/remove", async (c) => {
  requireStaff(c);
  assertCashier(requestActor(c));
  const auth = c.get("auth")!;
  const tenantId = auth.activeTenant!.id;
  const invoiceId = uuidSchema.parse(c.req.param("id"));
  const itemId = uuidSchema.parse(c.req.param("itemId"));
  const body = await parseJson(c, paymentReversalSchema);
  await withStaffActor(c, async (tx) => {
    const invoice = await requireRows(await tx`select id, number, patient_id, status from invoices where id = ${invoiceId} and tenant_id = ${tenantId} for update`, "Bill not found");
    if (invoice.status === "void") throw new ConflictError("This bill is void");
    const [payment] = await tx`select 1 from payments where invoice_id = ${invoiceId} and reversed_at is null limit 1`;
    if (payment) throw new ConflictError("This bill has a payment. Reverse the payment before changing its lines.");
    const [pending] = await tx`select 1 from mobile_money_requests where invoice_id = ${invoiceId} and status in ('initiated','pending','indeterminate') limit 1`;
    if (pending) throw new ConflictError("A mobile money prompt for this bill is still unresolved. Check its status first.");
    const item = await requireRows(await tx`select * from invoice_items where id = ${itemId} and invoice_id = ${invoiceId}`, "Bill line not found");
    await tx`delete from invoice_items where id = ${itemId}`;
    if (item.recommendationId) {
      await tx`update care_recommendations set billing_status = 'unbilled', updated_at = now() where id = ${item.recommendationId}`;
      await tx`
        insert into care_recommendation_events (id, tenant_id, recommendation_id, event, note, actor_user_id, actor_roles)
        values (${crypto.randomUUID()}, ${tenantId}, ${item.recommendationId}, 'unbilled', ${`Removed from bill ${invoice.number}: ${body.reason}`}, ${auth.user.id}, ${auth.activeTenant!.roles})
      `;
    }
    if (item.supplyUsageId) await tx`update care_supply_usages set billing_status = 'unbilled' where id = ${item.supplyUsageId}`;
    await refreshInvoice(tx, tenantId, invoiceId, auth.user.id);
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "invoice.line.remove", {
      subjectPatientId: String(invoice.patientId), resourceType: "Invoice", resourceId: invoiceId,
      metadata: { itemId, description: item.description, amount: Number(item.amount), source: item.source, reason: body.reason },
    }));
  });
  return c.json({ ok: true });
});

financeRoutes.get("/invoices", async (c) => {
  requireStaff(c);
  assertFinance(requestActor(c));
  const auth = c.get("auth")!;
  const status = c.req.query("status");
  const rows = await withStaffActor(c, async (tx) => tx`
    select i.id, i.number, i.patient_id, i.encounter_id, i.currency, i.status, i.notes, i.created_at, i.department_id, i.unit_id,
           p.public_id, p.given_name, p.family_name,
           coalesce((select sum(ii.amount) from invoice_items ii where ii.invoice_id = i.id), 0) as total,
           coalesce((select sum(p.amount) from payments p where p.invoice_id = i.id and p.reversed_at is null), 0)
             - coalesce((select sum(r.amount) from payment_refunds r where r.invoice_id = i.id), 0) as paid
      from invoices i join patients p on p.id = i.patient_id
     where i.tenant_id = ${auth.activeTenant!.id}
       ${status ? tx`and i.status = ${status}` : tx``}
     order by i.created_at desc limit 200
  `);
  return c.json({ invoices: rows });
});

financeRoutes.post("/invoices", async (c) => {
  requireStaff(c);
  assertFinance(requestActor(c));
  if (!hasRole(c, "finance", "facility_admin")) throw new ForbiddenError("The finance role is required");
  const auth = c.get("auth")!;
  const body = await parseJson(c, invoiceSchema);
  const invoiceId = crypto.randomUUID();
  const number = `INV-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
  await withStaffActor(c, async (tx) => {
    const linked = await tx`select 1 from tenant_patient_links where tenant_id = ${auth.activeTenant!.id} and patient_id = ${body.patientId}`;
    if (!linked[0]) throw new ValidationError("Patient is not linked to this facility");
    let encounterAttribution: { departmentId: string | null; unitId: string | null } | null = null;
    if (body.encounterId) {
      const encounter = await tx`select department_id, unit_id from encounters where id = ${body.encounterId} and patient_id = ${body.patientId} and tenant_id = ${auth.activeTenant!.id}`;
      if (!encounter[0]) throw new ValidationError("Encounter does not belong to the selected patient");
      encounterAttribution = { departmentId: encounter[0].departmentId ?? null, unitId: encounter[0].unitId ?? null };
    }
    const attribution = !body.departmentId && !body.unitId && encounterAttribution?.departmentId
      ? encounterAttribution
      : await resolveAttribution(tx, c, body.departmentId, body.unitId);
    const settings = await facilitySettings(tx, auth.activeTenant!.id);
    const prepared = [];
    for (const item of body.items) {
      let unitPrice = item.unitPrice;
      let currency = settings.allowedCurrencies[0] ?? "UGX";
      if (item.serviceId) {
        const service = await tx`
          select id, name, price, currency, active, price_status from service_catalog
           where id = ${item.serviceId} and tenant_id = ${auth.activeTenant!.id}
        `;
        if (!service[0] || !service[0].active) throw new ValidationError("A selected catalogue service is unavailable");
        if (service[0].priceStatus !== "approved") throw new ValidationError(`${service[0].name} has a test price that is not approved for billing`);
        if (unitPrice != null && unitPrice !== Number(service[0].price)) {
          throw new ValidationError(`${service[0].name} is charged at its price-list price of ${Number(service[0].price)} ${service[0].currency}; change the price list instead of the bill`);
        }
        unitPrice = Number(service[0].price);
        currency = String(service[0].currency);
      } else if (!settings.allowManualCharges) {
        throw new ValidationError("This facility charges only from its price list. Choose a price-list item for every line.");
      }
      if (unitPrice == null) throw new ValidationError("A unit price is required for services outside the catalogue");
      try {
        assertFacilityPrice(unitPrice, currency, true);
      } catch (error) {
        throw new ValidationError((error as Error).message);
      }
      prepared.push({ ...item, unitPrice, currency });
    }
    const currency = prepared[0]?.currency ?? "UGX";
    if (prepared.some((item) => item.currency !== currency)) throw new ValidationError("All invoice lines must use the same currency");
    await tx`
      insert into invoices (id, tenant_id, patient_id, encounter_id, number, currency, notes, issued_by, department_id, unit_id)
      values (${invoiceId}, ${auth.activeTenant!.id}, ${body.patientId}, ${body.encounterId ?? null}, ${number}, ${currency}, ${body.notes || null}, ${auth.user.id},
        ${attribution.departmentId}, ${attribution.unitId})
    `;
    for (const item of prepared) {
      await tx`
        insert into invoice_items (id, tenant_id, invoice_id, service_id, description, quantity, unit_price, amount)
        values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${invoiceId}, ${item.serviceId ?? null}, ${item.description},
          ${item.quantity}, ${item.unitPrice}, ${roundToCurrency(item.quantity * item.unitPrice, item.currency)})
      `;
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "invoice.create", {
      subjectPatientId: body.patientId, resourceType: "Invoice", resourceId: invoiceId,
      metadata: { number, itemCount: prepared.length, currency },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "invoice.created", aggregateId: invoiceId, payload: { number } });
  }).catch((error: unknown) => {
    rethrowPriceGuard(error);
    throw error;
  });
  return c.json({ ok: true, invoice: { id: invoiceId, number } }, 201);
});

financeRoutes.get("/invoices/:id", async (c) => {
  requireStaff(c);
  assertFinance(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const data = await withStaffActor(c, async (tx) => {
    const invoice = await requireRows(await tx`
      select i.*, p.public_id, p.given_name, p.family_name from invoices i join patients p on p.id = i.patient_id
       where i.id = ${id} and i.tenant_id = ${auth.activeTenant!.id}
    `, "Invoice not found");
    const items = await tx`
      select ii.*, r.status as recommendation_status, r.target_department, su.recorded_at as supplied_at
        from invoice_items ii
        left join care_recommendations r on r.id = ii.recommendation_id
        left join care_supply_usages su on su.id = ii.supply_usage_id
       where ii.invoice_id = ${id} order by ii.created_at nulls first, ii.description
    `;
    const payments = await tx`
      select p.*, u.display_name as received_by_name, r.display_name as reversed_by_name
        from payments p join users u on u.id = p.received_by left join users r on r.id = p.reversed_by
       where p.invoice_id = ${id} order by p.received_at
    `;
    const claims = await tx`select * from claims where invoice_id = ${id} order by created_at`;
    const refunds = await tx`
      select r.*, u.display_name as refunded_by_name from payment_refunds r join users u on u.id = r.refunded_by
       where r.invoice_id = ${id} order by r.refunded_at
    `;
    const mobileMoney = await tx`
      select id, amount, currency, msisdn, status, status_detail, provider_reference, network_reference, payment_id, created_at, updated_at, completed_at, provider_mode
        from mobile_money_requests where invoice_id = ${id} order by created_at desc
    `;
    const totals = await invoiceTotals(tx, auth.activeTenant!.id, id);
    return { invoice, items, payments, refunds, claims, mobileMoney, totals };
  });
  await withStaffActor(c, async (tx) => writeAudit(tx, c.get("deps").config, requestAudit(c, "invoice.read", {
    subjectPatientId: String(data.invoice.patientId), resourceType: "Invoice", resourceId: id,
  })));
  const config = c.get("deps").config;
  return c.json({
    ...data,
    mobileMoney: data.mobileMoney.map((row) => ({ ...row, msisdn: maskMsisdn(String(row.msisdn)) })),
    paymentOptions: {
      cash: data.invoice.status !== "void",
      mobileMoney: data.invoice.status !== "void" && isIntegrationAvailable(config, "payments") && yoSupports(String(data.invoice.currency)),
      mobileMoneyMode: config.yo.mode,
      mobileMoneyReason: !yoSupports(String(data.invoice.currency)) ? "Yo! mobile money collects whole Uganda shillings (UGX) only; this bill is in another currency" : integrationStatus(config, "payments").reason,
    },
  });
});

financeRoutes.post("/invoices/:id/payments", async (c) => {
  requireStaff(c);
  assertFinance(requestActor(c));
  if (!hasRole(c, "finance", "facility_admin")) throw new ForbiddenError("The finance role is required");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, paymentSchema);
  if (body.invoiceId !== id) throw new ValidationError("The payment invoice does not match the route");
  const paymentId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const invoice = await requireRows(await tx`
      select id, patient_id, status from invoices where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Invoice not found");
    if (invoice.status === "void") throw new ConflictError("Payments cannot be recorded against a void invoice");
    await tx`
      insert into payments (id, tenant_id, invoice_id, amount, method, reference, notes, received_by, receipt_number)
      values (${paymentId}, ${auth.activeTenant!.id}, ${id}, ${body.amount}, ${body.method}, ${body.reference || null}, ${body.notes || null}, ${auth.user.id}, ${receiptNumber()})
    `;
    await refreshInvoice(tx, auth.activeTenant!.id, id, auth.user.id);
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "payment.receive", {
      subjectPatientId: String(invoice.patientId), resourceType: "Payment", resourceId: paymentId,
      metadata: { invoiceId: id, amount: body.amount, method: body.method },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "payment.received", aggregateId: paymentId, payload: { invoiceId: id, amount: body.amount } });
  });
  return c.json({ ok: true, payment: { id: paymentId } }, 201);
});

financeRoutes.post("/payments/:id/reverse", async (c) => {
  requireStaff(c);
  assertFinance(requestActor(c));
  if (!hasRole(c, "finance", "facility_admin")) throw new ForbiddenError("The finance role is required");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, paymentReversalSchema);
  await withStaffActor(c, async (tx) => {
    const payment = await requireRows(await tx`
      select p.id, p.invoice_id, p.reversed_at, i.patient_id from payments p join invoices i on i.id = p.invoice_id
       where p.id = ${id} and p.tenant_id = ${auth.activeTenant!.id} for update
    `, "Payment not found");
    if (payment.reversedAt) throw new ConflictError("The payment is already reversed");
    await tx`
      update payments set reversed_at = now(), reversed_by = ${auth.user.id}, reversal_reason = ${body.reason} where id = ${id}
    `;
    await refreshInvoice(tx, auth.activeTenant!.id, String(payment.invoiceId), auth.user.id);
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "payment.reverse", {
      subjectPatientId: String(payment.patientId), resourceType: "Payment", resourceId: id,
      metadata: { invoiceId: payment.invoiceId, reason: body.reason },
    }));
  });
  return c.json({ ok: true });
});

/**
 * Records a refund against a received payment. The original payment is never changed; the refund is an
 * append-only correction in the bill's currency and can never exceed what is left of the payment. Mobile
 * money refunds are recorded as paid out outside Medveris; automated Yo! payouts are not implemented.
 */
financeRoutes.post("/payments/:id/refunds", async (c) => {
  requireStaff(c);
  assertFinance(requestActor(c));
  if (!hasRole(c, "finance", "facility_admin")) throw new ForbiddenError("The finance role is required");
  const auth = c.get("auth")!;
  const tenantId = auth.activeTenant!.id;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, paymentRefundSchema);
  const key = idempotencyKey(c) ?? `refund-${crypto.randomUUID()}`;
  const refundId = crypto.randomUUID();
  const receipt = receiptNumber();
  try {
    const result = await withStaffActor(c, async (tx) => {
      const [replayed] = await tx`select id, receipt_number from payment_refunds where tenant_id = ${tenantId} and idempotency_key = ${key}`;
      if (replayed) return { id: String(replayed.id), receiptNumber: String(replayed.receiptNumber), replayed: true };
      const payment = await requireRows(await tx`
        select p.id, p.invoice_id, p.amount, p.method, p.reversed_at, coalesce(p.currency, i.currency) as currency, i.patient_id, i.number
          from payments p join invoices i on i.id = p.invoice_id
         where p.id = ${id} and p.tenant_id = ${tenantId} for update of p
      `, "Payment not found");
      if (payment.reversedAt) throw new ConflictError("A reversed payment cannot be refunded");
      const [refunded] = await tx`select coalesce(sum(amount), 0) as total from payment_refunds where payment_id = ${id}`;
      const remaining = roundMoney(Number(payment.amount) - Number(refunded?.total ?? 0));
      const amount = roundMoney(body.amount);
      if (amount > remaining) throw new ValidationError(`Up to ${formatAmount(remaining)} can still be refunded from this payment`);
      if (!fitsCurrencyPrecision(amount, String(payment.currency))) throw new ValidationError(`${payment.currency} amounts use at most ${String(payment.currency) === "UGX" ? "whole shillings" : "two decimal places"}`);
      await tx`
        insert into payment_refunds (id, tenant_id, payment_id, invoice_id, amount, currency, method, reference, reason, receipt_number, idempotency_key, refunded_by)
        values (${refundId}, ${tenantId}, ${id}, ${payment.invoiceId}, ${amount}, ${payment.currency}, ${body.method}, ${body.reference || null},
          ${body.reason}, ${receipt}, ${key}, ${auth.user.id})
      `;
      await refreshInvoice(tx, tenantId, String(payment.invoiceId), auth.user.id);
      await writeAudit(tx, c.get("deps").config, requestAudit(c, "payment.refund", {
        subjectPatientId: String(payment.patientId), resourceType: "PaymentRefund", resourceId: refundId,
        metadata: { paymentId: id, invoiceId: payment.invoiceId, number: payment.number, amount, currency: payment.currency, method: body.method, reason: body.reason, receipt },
      }));
      return { id: refundId, receiptNumber: receipt, replayed: false };
    });
    return c.json({ ok: true, refund: result }, result.replayed ? 200 : 201);
  } catch (error) {
    if (uniqueViolation(error) === "payment_refunds_tenant_id_idempotency_key_key") {
      const [existing] = await withStaffActor(c, (tx) => tx`select id, receipt_number from payment_refunds where tenant_id = ${tenantId} and idempotency_key = ${key}`);
      if (existing) return c.json({ ok: true, refund: { id: String(existing.id), receiptNumber: String(existing.receiptNumber), replayed: true } }, 200);
    }
    throw error;
  }
});

function formatAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * Voids an unpaid bill with a reason. Its lines are released so the work can be billed again, and the
 * bill keeps its number and history. A bill with any net payment, or an unresolved mobile money prompt,
 * cannot be voided.
 */
financeRoutes.post("/invoices/:id/void", async (c) => {
  requireStaff(c);
  assertFinance(requestActor(c));
  if (!hasRole(c, "finance", "facility_admin")) throw new ForbiddenError("The finance role is required");
  const auth = c.get("auth")!;
  const tenantId = auth.activeTenant!.id;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, invoiceVoidSchema);
  await withStaffActor(c, async (tx) => {
    const invoice = await requireRows(await tx`
      select id, number, patient_id, status, currency from invoices where id = ${id} and tenant_id = ${tenantId} for update
    `, "Bill not found");
    if (invoice.status === "void") throw new ConflictError("This bill is already void");
    const [net] = await tx`select app.invoice_net_paid(${id}) as paid`;
    if (Number(net?.paid ?? 0) !== 0) throw new ConflictError("This bill has a payment or refund. Settle it before voiding; the original records are kept.");
    const [pending] = await tx`select 1 from mobile_money_requests where invoice_id = ${id} and status in ('initiated','pending','indeterminate') limit 1`;
    if (pending) throw new ConflictError("A mobile money prompt for this bill is still unresolved. Check its status first.");
    const lines = await tx`
      select id, recommendation_id, supply_usage_id from invoice_items where invoice_id = ${id} and released_at is null
    `;
    await tx`update invoice_items set released_at = now() where invoice_id = ${id} and released_at is null`;
    for (const line of lines) {
      if (line.recommendationId) {
        await tx`update care_recommendations set billing_status = 'unbilled', updated_at = now() where id = ${line.recommendationId}`;
        await tx`
          insert into care_recommendation_events (id, tenant_id, recommendation_id, event, note, actor_user_id, actor_roles)
          values (${crypto.randomUUID()}, ${tenantId}, ${line.recommendationId}, 'unbilled', ${`Bill ${invoice.number} voided: ${body.reason}`}, ${auth.user.id}, ${auth.activeTenant!.roles})
        `;
      }
      if (line.supplyUsageId) await tx`update care_supply_usages set billing_status = 'unbilled' where id = ${line.supplyUsageId}`;
    }
    await tx`
      update invoices set status = 'void', void_reason = ${body.reason}, voided_by = ${auth.user.id}, voided_at = now() where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "invoice.void", {
      subjectPatientId: String(invoice.patientId), resourceType: "Invoice", resourceId: id,
      metadata: { number: invoice.number, reason: body.reason, releasedLines: lines.length },
    }));
    await writeOutbox(tx, { tenantId, eventType: "invoice.voided", aggregateId: id, payload: { number: invoice.number, reason: body.reason } });
  });
  return c.json({ ok: true });
});

/** Waives unbilled visit work with a reason, so it stays visible instead of silently disappearing from the bill. */
financeRoutes.post("/encounters/:id/waive", async (c) => {
  requireStaff(c);
  assertFinance(requestActor(c));
  if (!hasRole(c, "finance", "facility_admin")) throw new ForbiddenError("The finance role is required");
  const auth = c.get("auth")!;
  const tenantId = auth.activeTenant!.id;
  const encounterId = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, billingWaiverSchema);
  const result = await withStaffActor(c, async (tx) => {
    const encounter = await requireRows(await tx`
      select id, patient_id from encounters where id = ${encounterId} and tenant_id = ${tenantId}
    `, "Visit not found");
    let requests = 0;
    let supplies = 0;
    if (body.recommendationIds.length) {
      const rows = await tx`
        update care_recommendations set billing_status = 'waived', waived_by = ${auth.user.id}, waived_at = now(), waive_reason = ${body.reason}, updated_at = now()
         where tenant_id = ${tenantId} and encounter_id = ${encounterId} and id = any(${body.recommendationIds}::uuid[])
           and billing_status = 'unbilled' and status not in ('declined','cancelled')
         returning id
      `;
      for (const row of rows) {
        await tx`
          insert into care_recommendation_events (id, tenant_id, recommendation_id, event, note, actor_user_id, actor_roles)
          values (${crypto.randomUUID()}, ${tenantId}, ${row.id}, 'waived', ${body.reason}, ${auth.user.id}, ${auth.activeTenant!.roles})
        `;
      }
      requests = rows.length;
    }
    if (body.supplyUsageIds.length) {
      const rows = await tx`
        update care_supply_usages set billing_status = 'waived', waived_by = ${auth.user.id}, waived_at = now(), waive_reason = ${body.reason}
         where tenant_id = ${tenantId} and encounter_id = ${encounterId} and id = any(${body.supplyUsageIds}::uuid[])
           and billing_status = 'unbilled' and voided_at is null
         returning id
      `;
      supplies = rows.length;
    }
    if (!requests && !supplies) throw new ConflictError("None of the selected items were unbilled; reload the visit to see its current charges.");
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "billing.waive", {
      subjectPatientId: String(encounter.patientId), resourceType: "Encounter", resourceId: encounterId,
      metadata: { requests, supplies, reason: body.reason },
    }));
    return { requests, supplies };
  });
  return c.json({ ok: true, ...result });
});

financeRoutes.post("/claims", async (c) => {
  requireStaff(c);
  assertFinance(requestActor(c));
  if (!hasRole(c, "finance", "facility_admin")) throw new ForbiddenError("The finance role is required");
  const auth = c.get("auth")!;
  const body = await parseJson(c, claimSchema);
  const claimId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const invoice = await requireRows(await tx`
      select id, patient_id, status from invoices where id = ${body.invoiceId} and tenant_id = ${auth.activeTenant!.id}
    `, "Invoice not found");
    if (invoice.status === "void") throw new ConflictError("Claims cannot be prepared for a void invoice");
    await tx`
      insert into claims (id, tenant_id, invoice_id, insurer, cover_amount, notes, created_by)
      values (${claimId}, ${auth.activeTenant!.id}, ${body.invoiceId}, ${body.insurer}, ${body.coverAmount}, ${body.notes || null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "claim.prepare", {
      subjectPatientId: String(invoice.patientId), resourceType: "Claim", resourceId: claimId,
      metadata: { invoiceId: body.invoiceId, insurer: body.insurer, coverAmount: body.coverAmount },
    }));
  });
  return c.json({ ok: true, claim: { id: claimId } }, 201);
});

financeRoutes.get("/finance/summary", async (c) => {
  requireStaff(c);
  assertFinance(requestActor(c));
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select
      coalesce((select sum(ii.amount) from invoice_items ii join invoices i on i.id = ii.invoice_id where i.tenant_id = ${auth.activeTenant!.id} and i.status <> 'void'), 0) as billed,
      coalesce((select sum(p.amount) from payments p join invoices i on i.id = p.invoice_id where i.tenant_id = ${auth.activeTenant!.id} and p.reversed_at is null), 0) as collected,
      coalesce((select sum(r.amount) from payment_refunds r where r.tenant_id = ${auth.activeTenant!.id}), 0) as refunded,
      coalesce((select sum(p.amount) from payments p join invoices i on i.id = p.invoice_id where i.tenant_id = ${auth.activeTenant!.id} and p.reversed_at is null), 0)
        - coalesce((select sum(r.amount) from payment_refunds r where r.tenant_id = ${auth.activeTenant!.id}), 0) as net_collected,
      (select count(*)::int from invoices where tenant_id = ${auth.activeTenant!.id} and status in ('open','part-paid')) as open_invoices
  `);
  return c.json({ summary: rows[0] });
});

// ---------------------------------------------------------------- point of sale

async function lockPayableInvoice(tx: Tx, tenantId: string, invoiceId: string) {
  const invoice = await requireRows(await tx`
    select id, number, patient_id, status, currency from invoices where id = ${invoiceId} and tenant_id = ${tenantId} for update
  `, "Bill not found");
  if (invoice.status === "void") throw new ConflictError("This bill is void and cannot take payments");
  const totals = (await invoiceTotals(tx, tenantId, invoiceId))!;
  if (totals.total <= 0) throw new ConflictError("This bill has no charges yet");
  if (totals.balance <= 0) throw new ConflictError("This bill is already fully paid");
  return { invoice, totals };
}

/** Cash at the till. The amount applied never exceeds the balance; any excess tendered is returned as change. */
financeRoutes.post("/invoices/:id/cash", async (c) => {
  requireStaff(c);
  assertCashier(requestActor(c));
  const auth = c.get("auth")!;
  const tenantId = auth.activeTenant!.id;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, cashPaymentSchema);
  const key = idempotencyKey(c);
  if (!key) throw new ValidationError("An Idempotency-Key header is required so a retried payment is not taken twice");
  const replay = async () => {
    const [existing] = await withStaffActor(c, async (tx) => tx`select id, invoice_id, receipt_number from payments where tenant_id = ${tenantId} and idempotency_key = ${key}`);
    if (!existing) return null;
    if (existing.invoiceId !== id) throw new ConflictError("This Idempotency-Key was already used for another bill");
    return { id: String(existing.id), receiptNumber: String(existing.receiptNumber) };
  };
  const replayed = await replay();
  if (replayed) return c.json({ ok: true, payment: replayed, replayed: true }, 200);
  const paymentId = crypto.randomUUID();
  const receipt = receiptNumber();
  try {
    const result = await withStaffActor(c, async (tx) => {
      const { invoice, totals } = await lockPayableInvoice(tx, tenantId, id);
      const amount = roundMoney(body.amount);
      if (amount > totals.balance) throw new ValidationError(`The balance due is ${totals.balance} ${totals.currency}; enter the amount tendered separately to give change`);
      if (!fitsCurrencyPrecision(amount, String(invoice.currency))) throw new ValidationError(`${invoice.currency} amounts use at most ${String(invoice.currency) === "UGX" ? "whole shillings" : "two decimal places"}`);
      const tendered = body.amountTendered != null ? roundMoney(body.amountTendered) : null;
      if (tendered != null && tendered < amount) throw new ValidationError("The amount tendered is less than the amount being paid");
      const change = tendered != null ? roundMoney(tendered - amount) : null;
      await tx`
        insert into payments (id, tenant_id, invoice_id, amount, method, notes, received_by, receipt_number, amount_tendered, change_due, idempotency_key)
        values (${paymentId}, ${tenantId}, ${id}, ${amount}, 'cash', ${body.notes || null}, ${auth.user.id}, ${receipt}, ${tendered}, ${change}, ${key})
      `;
      const after = await refreshInvoice(tx, tenantId, id, auth.user.id);
      await writeAudit(tx, c.get("deps").config, requestAudit(c, "payment.receive", {
        subjectPatientId: String(invoice.patientId), resourceType: "Payment", resourceId: paymentId,
        metadata: { invoiceId: id, amount, method: "cash", receipt, tendered, change },
      }));
      await writeOutbox(tx, { tenantId, eventType: "payment.received", aggregateId: paymentId, payload: { invoiceId: id, amount, method: "cash" } });
      return { change, balance: after?.balance ?? null, status: after?.status ?? null };
    });
    return c.json({ ok: true, payment: { id: paymentId, receiptNumber: receipt, change: result.change }, invoice: { balance: result.balance, status: result.status } }, 201);
  } catch (error) {
    if (uniqueViolation(error) === "payments_idempotency") {
      const raced = await replay();
      if (raced) return c.json({ ok: true, payment: raced, replayed: true }, 200);
    }
    throw error;
  }
});

function yoClient(c: Context<AppEnv>): YoClient {
  const deps = c.get("deps");
  return createYoClient(deps.config.yo, deps.yoTransport);
}

function staffActor(c: Context<AppEnv>): MobileMoneyActor {
  const auth = c.get("auth")!;
  const meta = auditMeta(c);
  return { kind: "staff", userId: auth.user.id, roles: auth.activeTenant!.roles, correlationId: meta.correlationId, ipAddress: meta.ipAddress };
}

async function presentMobileMoney(tx: Tx, tenantId: string, requestId: string) {
  const request = await requireRows(await tx`
    select r.id, r.invoice_id, r.amount, r.currency, r.msisdn, r.status, r.status_detail, r.provider_reference, r.network_reference, r.provider_mode,
           r.payment_id, r.created_at, r.updated_at, r.completed_at, r.last_checked_at, p.receipt_number
      from mobile_money_requests r left join payments p on p.id = r.payment_id
     where r.id = ${requestId} and r.tenant_id = ${tenantId}
  `, "Mobile money request not found");
  const totals = await invoiceTotals(tx, tenantId, String(request.invoiceId));
  return {
    request: {
      id: request.id, invoiceId: request.invoiceId, amount: Number(request.amount), currency: request.currency, msisdn: maskMsisdn(String(request.msisdn)),
      status: request.status, statusDetail: request.statusDetail, providerReference: request.providerReference, networkReference: request.networkReference,
      mode: request.providerMode, paymentId: request.paymentId, receiptNumber: request.receiptNumber ?? null,
      createdAt: request.createdAt, updatedAt: request.updatedAt, completedAt: request.completedAt, lastCheckedAt: request.lastCheckedAt,
    },
    invoice: totals,
  };
}

/**
 * Sends a Yo! mobile money prompt to the payer's phone. Idempotent per Idempotency-Key, and only one
 * unresolved prompt may exist per bill, so a retried click or a refreshed page never prompts twice.
 */
financeRoutes.post("/invoices/:id/mobile-money", async (c) => {
  requireStaff(c);
  assertCashier(requestActor(c));
  const auth = c.get("auth")!;
  const deps = c.get("deps");
  const tenantId = auth.activeTenant!.id;
  const id = uuidSchema.parse(c.req.param("id"));
  await enforceRateLimit(c, "payments.mobile-money", auth.user.id);
  assertIntegrationAvailable(deps.config, "payments", "mobile-money.collect", "no prompt was sent; take cash or try again once mobile money is configured");
  const body = await parseJson(c, mobileMoneyRequestSchema);
  const key = idempotencyKey(c);
  if (!key) throw new ValidationError("An Idempotency-Key header is required so a retried request does not prompt the payer twice");
  const msisdn = normalizeUgandaMsisdn(body.msisdn);
  if (!msisdn) throw new ValidationError("Enter a Ugandan mobile number, for example 0772 123456", [{ path: "msisdn", message: "Invalid mobile number" }]);
  const [existing] = await withStaffActor(c, async (tx) => tx`select id, invoice_id from mobile_money_requests where tenant_id = ${tenantId} and idempotency_key = ${key}`);
  if (existing) {
    if (existing.invoiceId !== id) throw new ConflictError("This Idempotency-Key was already used for another bill");
    return c.json({ ok: true, replayed: true, ...(await withStaffActor(c, (tx) => presentMobileMoney(tx, tenantId, String(existing.id)))) }, 200);
  }
  const requestId = crypto.randomUUID();
  const externalReference = `MV-${requestId.replace(/-/g, "").toUpperCase()}`;
  let invoiceNumberText = "";
  try {
    await withStaffActor(c, async (tx) => {
      const { invoice, totals } = await lockPayableInvoice(tx, tenantId, id);
      if (invoice.currency !== "UGX") throw new ValidationError("Mobile money collections are in UGX only");
      const amount = roundMoney(body.amount);
      if (!Number.isInteger(amount)) throw new ValidationError("UGX amounts are whole shillings");
      if (amount > totals.balance) throw new ValidationError(`The balance due is ${totals.balance} UGX`);
      invoiceNumberText = String(invoice.number);
      await tx`
        insert into mobile_money_requests (id, tenant_id, invoice_id, provider, provider_mode, amount, currency, msisdn, external_reference, idempotency_key, requested_by, status_detail)
        values (${requestId}, ${tenantId}, ${id}, 'yo', ${deps.config.yo.mode}, ${amount}, 'UGX', ${msisdn}, ${externalReference}, ${key}, ${auth.user.id}, 'Sending the prompt to Yo!')
      `;
      await writeAudit(tx, deps.config, requestAudit(c, "payment.mobile-money.request", {
        subjectPatientId: String(invoice.patientId), resourceType: "MobileMoneyRequest", resourceId: requestId,
        metadata: { invoiceId: id, amount, provider: "yo", mode: deps.config.yo.mode, msisdn: maskMsisdn(msisdn) },
      }));
    });
  } catch (error) {
    const constraint = uniqueViolation(error);
    if (constraint === "mobile_money_requests_one_open") {
      throw new ConflictError("A mobile money prompt for this bill is still waiting. Check its status before sending another.");
    }
    if (constraint === "mobile_money_requests_tenant_id_idempotency_key_key") {
      const [raced] = await withStaffActor(c, async (tx) => tx`select id from mobile_money_requests where tenant_id = ${tenantId} and idempotency_key = ${key}`);
      if (raced) return c.json({ ok: true, replayed: true, ...(await withStaffActor(c, (tx) => presentMobileMoney(tx, tenantId, String(raced.id)))) }, 200);
    }
    throw error;
  }
  const facility = auth.activeTenant!.name.slice(0, 60);
  let evidence: MobileMoneyEvidence;
  try {
    const response = await yoClient(c).depositFunds({
      msisdn, amount: roundMoney(body.amount), externalReference,
      narrative: `Payment for bill ${invoiceNumberText} at ${facility}`,
      providerReferenceText: `${facility} bill ${invoiceNumberText}`,
    });
    evidence = {
      kind: "initiate", dedupeKey: "initiate", outcome: yoOutcome(response), signatureVerified: null,
      providerStatus: [response.status, response.statusCode, response.transactionStatus].filter((part) => part !== null && part !== "").join(" "),
      providerReference: response.transactionReference, networkReference: response.mnoTransactionReferenceId,
      statusMessage: response.status === "ERROR" ? `Yo! refused the request: ${response.errorMessage ?? response.statusMessage ?? "no reason given"}` : null,
      detail: { errorCode: response.errorMessageCode ?? null },
    };
  } catch (error) {
    if (!(error instanceof YoTransportError)) throw error;
    evidence = {
      kind: "initiate", dedupeKey: "initiate", outcome: "indeterminate", signatureVerified: null, providerStatus: null,
      statusMessage: `${error.message}. The prompt may or may not have been sent; check its status before trying again.`,
    };
  }
  const outcome = await withStaffActor(c, async (tx) => {
    await applyMobileMoneyEvidence(tx, deps.config, tenantId, requestId, evidence, staffActor(c));
    return presentMobileMoney(tx, tenantId, requestId);
  });
  return c.json({ ok: true, ...outcome }, 201);
});

financeRoutes.get("/mobile-money/:id", async (c) => {
  requireStaff(c);
  assertCashier(requestActor(c));
  const tenantId = c.get("auth")!.activeTenant!.id;
  const id = uuidSchema.parse(c.req.param("id"));
  return c.json(await withStaffActor(c, (tx) => presentMobileMoney(tx, tenantId, id)));
});

/** Asks Yo! for the transaction's current state and reconciles the bill; safe to repeat. */
financeRoutes.post("/mobile-money/:id/check", async (c) => {
  requireStaff(c);
  assertCashier(requestActor(c));
  const auth = c.get("auth")!;
  const deps = c.get("deps");
  const tenantId = auth.activeTenant!.id;
  const id = uuidSchema.parse(c.req.param("id"));
  await enforceRateLimit(c, "payments.mobile-money", auth.user.id);
  const [request] = await withStaffActor(c, async (tx) => tx`
    select id, status, external_reference, provider_reference from mobile_money_requests where id = ${id} and tenant_id = ${tenantId}
  `);
  if (!request) throw new NotFoundError("Mobile money request not found");
  if (request.status === "succeeded") return c.json(await withStaffActor(c, (tx) => presentMobileMoney(tx, tenantId, id)));
  const problems = yoConfigProblems(deps.config).filter((problem) => !problem.startsWith("YO_PUBLIC_KEY"));
  if (problems.length) throw new AppError(503, "integration_unavailable", `Yo! status checks are unavailable: ${problems.join("; ")}`);
  let evidence: MobileMoneyEvidence;
  try {
    const response = await yoClient(c).checkStatus({ transactionReference: request.providerReference ?? null, externalReference: String(request.externalReference) });
    const outcome = response.status === "ERROR" && !response.transactionStatus ? "indeterminate" : yoOutcome(response);
    evidence = {
      kind: "status-check", dedupeKey: `check:${crypto.randomUUID()}`, outcome, signatureVerified: null,
      providerStatus: [response.status, response.statusCode, response.transactionStatus].filter((part) => part !== null && part !== "").join(" "),
      providerReference: response.transactionReference, networkReference: response.mnoTransactionReferenceId,
      confirmedAmount: response.amount != null && response.amount !== "" ? Number(response.amount.replace(/,/g, "")) : null,
      confirmedCurrency: response.currencyCode || null,
      statusMessage: response.status === "ERROR" ? `Yo! could not report a status: ${response.errorMessage ?? response.statusMessage ?? "no reason given"}` : null,
    };
  } catch (error) {
    if (!(error instanceof YoTransportError)) throw error;
    throw new DependencyError(`${error.message}. Try checking again shortly.`);
  }
  const result = await withStaffActor(c, async (tx) => {
    await applyMobileMoneyEvidence(tx, deps.config, tenantId, id, evidence, staffActor(c));
    return presentMobileMoney(tx, tenantId, id);
  });
  return c.json(result);
});

/** Receipt for one payment: facility, bill, lines, amount, method, reference and the balance after it. */
financeRoutes.get("/payments/:id/receipt", async (c) => {
  requireStaff(c);
  assertCashier(requestActor(c));
  const tenantId = c.get("auth")!.activeTenant!.id;
  const id = uuidSchema.parse(c.req.param("id"));
  const data = await withStaffActor(c, async (tx) => {
    const payment = await requireRows(await tx`
      select p.id, p.invoice_id, p.amount, p.method, p.reference, p.receipt_number, p.received_at, p.amount_tendered, p.change_due, p.reversed_at,
             p.reversal_reason, u.display_name as cashier, i.number as invoice_number, i.currency, i.patient_id, pt.public_id, pt.given_name, pt.family_name,
             t.name as facility_name, t.city, t.district, m.msisdn, m.provider_mode
        from payments p join invoices i on i.id = p.invoice_id join patients pt on pt.id = i.patient_id join tenants t on t.id = p.tenant_id
        join users u on u.id = p.received_by left join mobile_money_requests m on m.id = p.mobile_money_request_id
       where p.id = ${id} and p.tenant_id = ${tenantId}
    `, "Payment not found");
    const items = await tx`select description, quantity, unit_price, amount from invoice_items where invoice_id = ${payment.invoiceId} order by created_at nulls first, description`;
    const [paidBefore] = await tx`
      select coalesce(sum(amount), 0) as paid from payments
       where invoice_id = ${payment.invoiceId} and reversed_at is null and (received_at < ${payment.receivedAt} or (received_at = ${payment.receivedAt} and id < ${id}))
    `;
    const refunds = await tx`
      select r.id, r.amount, r.method, r.reference, r.reason, r.receipt_number, r.refunded_at, u.display_name as refunded_by_name
        from payment_refunds r join users u on u.id = r.refunded_by
       where r.payment_id = ${id} order by r.refunded_at
    `;
    const totals = await invoiceTotals(tx, tenantId, String(payment.invoiceId));
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "payment.receipt.read", { subjectPatientId: String(payment.patientId), resourceType: "Payment", resourceId: id }));
    return { payment, items, refunds, paidBefore: Number(paidBefore?.paid ?? 0), totals };
  });
  const { payment, totals } = data;
  const total = totals?.total ?? 0;
  const refunded = roundMoney(data.refunds.reduce((sum, row) => sum + Number(row.amount), 0));
  const balanceAfter = roundMoney(total - data.paidBefore - (payment.reversedAt ? 0 : Number(payment.amount)) + refunded);
  return c.json({
    receipt: {
      number: payment.receiptNumber ?? `PAY-${String(payment.id).slice(0, 8).toUpperCase()}`,
      facility: { name: payment.facilityName, city: payment.city, district: payment.district },
      invoiceNumber: payment.invoiceNumber, currency: payment.currency,
      patient: { publicId: payment.publicId, name: `${payment.givenName} ${payment.familyName}` },
      items: data.items.map((item) => ({ description: item.description, quantity: Number(item.quantity), unitPrice: Number(item.unitPrice), amount: Number(item.amount) })),
      total, amount: Number(payment.amount), method: payment.method, reference: payment.reference,
      mobileMoney: payment.msisdn ? { msisdn: maskMsisdn(String(payment.msisdn)), mode: payment.providerMode } : null,
      amountTendered: payment.amountTendered == null ? null : Number(payment.amountTendered),
      change: payment.changeDue == null ? null : Number(payment.changeDue),
      refunded,
      refunds: data.refunds.map((row) => ({ id: row.id, amount: Number(row.amount), method: row.method, reference: row.reference, reason: row.reason, receiptNumber: row.receiptNumber, refundedAt: row.refundedAt, refundedBy: row.refundedByName })),
      balanceAfter, currentBalance: totals?.balance ?? null,
      receivedAt: payment.receivedAt, cashier: payment.cashier,
      reversed: payment.reversedAt ? { at: payment.reversedAt, reason: payment.reversalReason } : null,
    },
  });
});
