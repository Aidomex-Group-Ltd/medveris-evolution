import { Hono } from "hono";
import { resolveFacilityExperience, type FacilityRegistrationLike } from "@medveris/domain";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { ForbiddenError, NotFoundError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

/**
 * The facility's own operating context: which experience it receives, whether it may enter it,
 * and (for a Drugshop) the dashboard's real, facility-scoped figures.
 *
 * The experience is derived from the authenticated active facility's recorded service category
 * and licence records. The browser never decides this for itself: it asks this endpoint, and the
 * route guard and the dispensing endpoint apply the same rule on the server.
 */
export const facilityExperienceRoutes = new Hono<AppEnv>();

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  serviceCategory: string | null;
  workspaceKind: string;
  city: string | null;
  district: string | null;
  region: string | null;
  country: string;
  status: string;
}

async function loadContext(c: Parameters<typeof requireStaff>[0]) {
  const auth = requireStaff(c);
  const tenantId = auth.activeTenant!.id;
  return withStaffActor(c, async (tx) => {
    const rows = await tx`
      select id, name, slug, service_category, workspace_kind, city, district, region, country, status
        from tenants where id = ${tenantId}
    `;
    if (!rows[0]) throw new NotFoundError("Workspace not found");
    const tenant: TenantRow = {
      id: String(rows[0].id),
      name: String(rows[0].name),
      slug: String(rows[0].slug),
      serviceCategory: (rows[0].serviceCategory as string | null) ?? null,
      workspaceKind: String(rows[0].workspaceKind ?? "facility"),
      city: (rows[0].city as string | null) ?? null,
      district: (rows[0].district as string | null) ?? null,
      region: (rows[0].region as string | null) ?? null,
      country: String(rows[0].country),
      status: String(rows[0].status),
    };
    const registrations = await tx`
      select kind, issuer, identifier, valid_from, valid_until, status, verified_at, verification_notes, document_reference
        from facility_registrations where tenant_id = ${tenantId} order by created_at
    `;
    const licenceRows: FacilityRegistrationLike[] = registrations.map((row) => ({
      kind: String(row.kind),
      identifier: String(row.identifier),
      status: String(row.status),
      validUntil: (row.validUntil as string | null) ?? null,
      issuer: (row.issuer as string | null) ?? null,
      verifiedAt: (row.verifiedAt as Date | null)?.toISOString() ?? null,
      documentReference: (row.documentReference as string | null) ?? null,
    }));
    return { tenant, registrations, resolution: resolveFacilityExperience({ serviceCategory: tenant.serviceCategory, registrations: licenceRows }) };
  });
}

facilityExperienceRoutes.get("/facility/experience", async (c) => {
  const { tenant, registrations, resolution } = await loadContext(c);
  return c.json({
    facility: {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status,
      serviceCategory: tenant.serviceCategory,
      workspaceKind: tenant.workspaceKind,
      city: tenant.city,
      district: tenant.district,
      region: tenant.region,
      country: tenant.country,
    },
    experience: resolution.experience,
    access: resolution.access,
    // A licence is optional documentation: its absence changes nothing about platform access.
    licence: resolution.licence,
    licenceStatus: resolution.licenceStatus,
    licenceNotice: resolution.licenceNotice,
    licenceOptional: true,
    licenceKinds: resolution.licenceKinds,
    registrations,
    routes: {
      home: resolution.experience === "drugshop" ? "/drugshop" : "/dashboard",
      priceLists: "/price-lists",
      sales: "/pharmacy-pos",
      licence: "/workspace",
    },
    dispensing: {
      // Catalogue visibility is not dispensing authority. A Drugshop's licence and each item's
      // recorded classification are both checked on the server at the point of sale. This is a
      // transaction-level control; it does not restrict the rest of the workspace.
      catalogueVisibilityImpliesDispensing: false,
      classificationField: "dispensingScope",
      unclassifiedItemsDispensable: false,
      requiresVerifiedLicence: true,
    },
  });
});

/**
 * Drugshop dashboard data, read under the facility's own RLS context.
 * Every figure is real; a workspace with no data receives zeros and empty lists, never invented values.
 */
facilityExperienceRoutes.get("/drugshop/overview", async (c) => {
  const { tenant, resolution } = await loadContext(c);
  if (resolution.experience !== "drugshop") {
    throw new ForbiddenError("This workspace is not registered as a Drugshop");
  }
  const tenantId = tenant.id;

  const data = await withStaffActor(c, async (tx) => {
    const stock = await tx`
      select
        count(*) filter (where coalesce(bal.on_hand, 0) > 0)::int as stocked_items,
        count(*) filter (where i.reorder_threshold is not null and coalesce(bal.on_hand, 0) > 0
                            and coalesce(bal.on_hand, 0) <= i.reorder_threshold)::int as low_stock,
        count(*) filter (where coalesce(bal.on_hand, 0) <= 0)::int as out_of_stock
        from inventory_items i
        left join (
          select item_id, sum(on_hand - reserved - quarantined) as on_hand
            from inventory_balances where tenant_id = ${tenantId} group by item_id
        ) bal on bal.item_id = i.id
       where i.tenant_id = ${tenantId} and i.status = 'active'
    `;

    const classifications = await tx`
      select dispensing_scope, count(*)::int as count
        from inventory_items
       where tenant_id = ${tenantId} and status = 'active'
       group by dispensing_scope
       order by dispensing_scope
    `;

    const today = await tx`
      select count(*)::int as transactions, coalesce(sum(total), 0)::float8 as total,
             min(currency) as currency
        from pharmacy_sales
       where tenant_id = ${tenantId} and status = 'completed' and created_at >= current_date
    `;

    const recentSales = await tx`
      select id, sale_number, total::float8 as total, currency, payment_method, status, created_at
        from pharmacy_sales
       where tenant_id = ${tenantId}
       order by created_at desc
       limit 5
    `;

    const expiring = await tx`
      select l.id, l.lot_number, l.expires_on, i.name, coalesce(b.on_hand, 0)::float8 as on_hand
        from inventory_lots l
        join inventory_items i on i.id = l.item_id
        join (
          select lot_id, sum(on_hand) as on_hand
            from inventory_balances where tenant_id = ${tenantId} group by lot_id
        ) b on b.lot_id = l.id
       where l.tenant_id = ${tenantId} and l.status = 'available' and l.expires_on is not null
         and l.expires_on <= current_date + interval '90 days'
       order by l.expires_on
       limit 10
    `;

    const pendingReceipts = await tx`
      select po.id, po.po_number, po.status, po.expected_on, s.name as supplier_name
        from purchase_orders po
        left join suppliers s on s.id = po.supplier_id
       where po.tenant_id = ${tenantId} and po.status in ('submitted', 'approved', 'partially-received')
       order by po.expected_on nulls last, po.created_at desc
       limit 10
    `;

    // A published list wins over a newer draft, so the dashboard shows what staff would actually charge.
    const priceLists = await tx`
      select pl.id, pl.code, pl.name, pl.status, pl.effective_from, pl.effective_to, pl.active,
             (select count(*)::int from price_list_prices p where p.price_list_id = pl.id and p.is_active) as item_count,
             (select min(p.currency) from price_list_prices p where p.price_list_id = pl.id) as currency
        from price_lists pl
       where pl.facility_id = ${tenantId} or pl.tenant_id = ${tenantId}
       order by (upper(pl.status) = 'PUBLISHED') desc, pl.updated_at desc nulls last, pl.created_at desc
       limit 5
    `;

    return { stock: stock[0] ?? {}, classifications, today: today[0] ?? {}, recentSales, expiring, pendingReceipts, priceLists };
  });

  const now = new Date().toISOString();
  return c.json({
    facility: { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status, city: tenant.city, district: tenant.district, country: tenant.country },
    licence: resolution.licence,
    licenceStatus: resolution.licenceStatus,
    licenceNotice: resolution.licenceNotice,
    access: resolution.access,
    generatedAt: now,
    stock: {
      stockedItems: Number((data.stock as Record<string, unknown>).stockedItems ?? 0),
      lowStock: Number((data.stock as Record<string, unknown>).lowStock ?? 0),
      outOfStock: Number((data.stock as Record<string, unknown>).outOfStock ?? 0),
    },
    classifications: data.classifications,
    today: {
      transactions: Number((data.today as Record<string, unknown>).transactions ?? 0),
      total: Number((data.today as Record<string, unknown>).total ?? 0),
      currency: ((data.today as Record<string, unknown>).currency as string | null) ?? "UGX",
    },
    recentSales: data.recentSales,
    expiring: data.expiring,
    pendingReceipts: data.pendingReceipts,
    priceLists: data.priceLists,
    activePriceList: data.priceLists[0] ?? null,
  });
});
