import { Hono } from "hono";
import type { Context } from "hono";
import {
  directoryBranchSchema,
  directoryCapabilitySchema,
  directoryClaimDecisionSchema,
  directoryClaimSchema,
  directoryConfirmationSchema,
  directoryDuplicateReviewSchema,
  directoryEditDecisionSchema,
  directoryEditRequestSchema,
  directoryEventSchema,
  directoryFacilityCreateSchema,
  directoryFacilityUpdateSchema,
  directoryModerationSchema,
  directoryReportResolutionSchema,
  directoryReportSchema,
  directoryServiceSchema,
} from "@medveris/contracts";
import { permissionsForRoles, type Permission } from "@medveris/authz";
import { withAnonymous } from "@medveris/db";
import type { Tx } from "@medveris/db";
import { requireAuth, requireStaff, withPlatformActor, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { ensureMatch, parseJson } from "../lib/http.js";
import { writeAudit } from "../lib/audit.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import type { AppConfig } from "../config.js";
import type { AppEnv } from "../types.js";

export const directoryRoutes = new Hono<AppEnv>();

const PANEL_SURFACES = ["search", "featured-card", "map", "category"];

function isPlatformOperator(c: Context<AppEnv>): boolean {
  return requireAuth(c).platformRoles.includes("platform_operator");
}

function requirePermission(c: Context<AppEnv>, permission: Permission): void {
  const auth = requireAuth(c);
  if (auth.platformRoles.includes("platform_operator")) return;
  if (!permissionsForRoles(requestActor(c).roles).has(permission)) {
    throw new ForbiddenError(`Permission ${permission} is required for this operation`);
  }
}

function requireProvider(c: Context<AppEnv>): ReturnType<typeof requireStaff> {
  requireStaff(c);
  if (!isPlatformOperator(c)) requirePermission(c, "directory.manage");
  return c.get("auth")!;
}

function numberFrom(value: string | undefined): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

interface DirectoryQuery {
  q?: string;
  country?: string;
  region?: string;
  district?: string;
  locality?: string;
  facilityTypes: string[];
  service?: string;
  capability?: string;
  participation?: string;
  bbox?: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  lat?: number;
  lng?: number;
  radiusKm?: number;
  sort: "relevance" | "distance";
  surface: "search" | "featured-card" | "map" | "category";
  limit: number;
  offset: number;
}

function parseQuery(c: Context<AppEnv>, config: AppConfig): DirectoryQuery {
  const limit = Math.max(1, Math.min(Number.parseInt(c.req.query("limit") ?? "20", 10) || 20, config.directory.maxResults));
  const offset = Math.max(0, Math.min(Number.parseInt(c.req.query("offset") ?? "0", 10) || 0, 5000));
  const types = (c.req.query("facilityType") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const minLat = numberFrom(c.req.query("minLat"));
  const maxLat = numberFrom(c.req.query("maxLat"));
  const minLng = numberFrom(c.req.query("minLng"));
  const maxLng = numberFrom(c.req.query("maxLng"));
  const lat = numberFrom(c.req.query("lat"));
  const lng = numberFrom(c.req.query("lng"));
  const radius = numberFrom(c.req.query("radiusKm"));
  if ((lat != null && (lat < -90 || lat > 90)) || (lng != null && (lng < -180 || lng > 180))) {
    throw new ValidationError("Coordinates are outside valid latitude/longitude bounds");
  }
  if ((lat == null) !== (lng == null)) throw new ValidationError("Both lat and lng are required for a location search");
  const bbox = minLat != null && maxLat != null && minLng != null && maxLng != null
    ? { minLat, maxLat, minLng, maxLng }
    : undefined;
  const rawSurface = c.req.query("surface") ?? "search";
  return {
    q: c.req.query("q")?.trim() || undefined,
    country: c.req.query("country")?.trim() || undefined,
    region: c.req.query("region")?.trim() || undefined,
    district: c.req.query("district")?.trim() || undefined,
    locality: c.req.query("locality")?.trim() || undefined,
    facilityTypes: types,
    service: c.req.query("service")?.trim() || undefined,
    capability: c.req.query("capability")?.trim() || undefined,
    participation: c.req.query("participation")?.trim() || undefined,
    bbox,
    lat,
    lng,
    radiusKm: radius == null ? undefined : Math.max(1, Math.min(radius, config.directory.maxRadiusKm)),
    sort: c.req.query("sort") === "distance" ? "distance" : "relevance",
    surface: PANEL_SURFACES.includes(rawSurface) ? (rawSurface as DirectoryQuery["surface"]) : "search",
    limit,
    offset,
  };
}

function distanceSql(tx: Tx, lat: number | undefined, lng: number | undefined) {
  if (lat == null || lng == null) return tx`null::float8`;
  return tx`(6371 * acos(least(1, greatest(-1,
    sin(radians(${lat}::float8)) * sin(radians(b.latitude::float8)) +
    cos(radians(${lat}::float8)) * cos(radians(b.latitude::float8)) *
    cos(radians(b.longitude::float8 - ${lng}::float8))
  ))))`;
}

function facilityFilter(tx: Tx, query: DirectoryQuery) {
  return tx`
    and (${query.country ?? null}::text is null or lower(f.country) = lower(${query.country ?? ""}))
    and (${query.region ?? null}::text is null or lower(f.region) = lower(${query.region ?? ""}))
    and (${query.district ?? null}::text is null or lower(f.district) = lower(${query.district ?? ""}))
    and (${query.locality ?? null}::text is null or lower(f.locality) = lower(${query.locality ?? ""}))
    and (${query.participation ?? null}::text is null or f.medveris_participation = ${query.participation ?? ""})
    and (cardinality(${query.facilityTypes}::text[]) = 0 or f.facility_type = any(${query.facilityTypes}::text[]))
    and (${query.q ?? null}::text is null or f.name ilike ${`%${query.q ?? ""}%`} or f.description ilike ${`%${query.q ?? ""}%`}
      or exists (select 1 from directory_services s where s.facility_id = f.id and s.status = 'active'
        and (s.name ilike ${`%${query.q ?? ""}%`} or s.code ilike ${`%${query.q ?? ""}%`})))
    and (${query.service ?? null}::text is null or exists (
      select 1 from directory_services s where s.facility_id = f.id and s.status = 'active'
       and (s.category = ${query.service ?? ""} or s.code = ${query.service ?? ""})))
    and (${query.capability ?? null}::text is null or exists (
      select 1 from directory_capabilities c where c.facility_id = f.id and c.code = ${query.capability ?? ""} and c.status <> 'suspended'))
    and (${query.bbox?.minLat ?? null}::float8 is null or (
      b.latitude between ${query.bbox?.minLat ?? 0} and ${query.bbox?.maxLat ?? 0}
      and b.longitude between ${query.bbox?.minLng ?? 0} and ${query.bbox?.maxLng ?? 0}))
  `;
}

function facilityColumns(tx: Tx) {
  return tx`
    f.id, f.public_id, f.slug, f.name, f.facility_type, f.description,
    f.country, f.region, f.district, f.locality,
    f.public_phone, f.public_email, f.website,
    f.medveris_participation, f.integration_state, f.credential_status, f.capability_status,
    f.publication_status, f.status, f.last_confirmed_on, f.next_confirmation_on,
    f.source_kind, f.source_name, f.source_license, f.source_retrieved_on,
    f.claimed_tenant_id is not null as claimed,
    (select jsonb_agg(jsonb_build_object(
        'id', s.id, 'code', s.code, 'name', s.name, 'category', s.category,
        'description', s.description, 'availabilityNote', s.availability_note,
        'publicContact', s.public_contact, 'branchId', s.branch_id
      ) order by s.name) from directory_services s where s.facility_id = f.id and s.status = 'active') as services,
    (select jsonb_agg(jsonb_build_object(
        'code', c.code, 'name', c.name, 'status', c.status,
        'evidenceSource', c.evidence_source, 'verifiedAt', c.verified_at
      ) order by c.name) from directory_capabilities c where c.facility_id = f.id and c.status <> 'suspended') as capabilities
  `;
}

function branchJson(tx: Tx) {
  return tx`(
    select jsonb_agg(jsonb_build_object(
      'id', b.id, 'name', b.name, 'isPrimary', b.is_primary,
      'addressLine1', b.address_line1, 'addressLine2', b.address_line2,
      'city', b.city, 'region', b.region, 'district', b.district, 'locality', b.locality,
      'country', b.country, 'latitude', b.latitude, 'longitude', b.longitude,
      'coordinateSource', b.coordinate_source, 'locationStatus', b.location_status,
      'publicPhone', b.public_phone, 'publicEmail', b.public_email, 'website', b.website,
      'openingHours', b.opening_hours, 'openingExceptions', b.opening_exceptions,
      'accessibility', b.accessibility, 'status', b.status
    ) order by b.is_primary desc, b.name)
    from directory_branches b where b.facility_id = f.id and b.status = 'active'
  )`;
}

function mapFacility(row: any): any {
  return {
    id: row.id,
    publicId: row.publicId,
    slug: row.slug,
    name: row.name,
    facilityType: row.facilityType,
    description: row.description,
    country: row.country,
    region: row.region,
    district: row.district,
    locality: row.locality,
    publicPhone: row.publicPhone,
    publicEmail: row.publicEmail,
    website: row.website,
    medverisParticipation: row.medverisParticipation,
    integrationState: row.integrationState,
    credentialStatus: row.credentialStatus,
    capabilityStatus: row.capabilityStatus,
    publicationStatus: row.publicationStatus,
    status: row.status,
    lastConfirmedOn: row.lastConfirmedOn,
    nextConfirmationOn: row.nextConfirmationOn,
    source: {
      kind: row.sourceKind,
      name: row.sourceName,
      license: row.sourceLicense,
      retrievedOn: row.sourceRetrievedOn,
    },
    claimed: row.claimed,
    services: row.services ?? [],
    capabilities: row.capabilities ?? [],
    branches: row.branches ?? [],
    distanceKm: row.distanceKm == null ? null : Math.round(Number(row.distanceKm) * 10) / 10,
    sponsored: Boolean(row.campaignId),
    promotion: row.campaignId
      ? {
          campaignId: row.campaignId,
          surface: row.placementSurface,
          label: "Sponsored",
          startsOn: row.campaignStartsOn,
          endsOn: row.campaignEndsOn,
        }
      : null,
  };
}

async function sponsoredFor(sql: ReturnType<Context<AppEnv>["get"]> | any, config: AppConfig, query: DirectoryQuery): Promise<any[]> {
  if (!config.directory.sponsoredListingsEnabled) return [];
  return withAnonymous(sql, async (tx) => {
    const rows = await tx`
      select c.id as campaign_id, c.placement_surface, c.sponsored_slots,
             c.starts_on as campaign_starts_on, c.ends_on as campaign_ends_on,
             ${facilityColumns(tx)}, ${branchJson(tx)} as branches, ${distanceSql(tx, query.lat, query.lng)} as distance_km
        from sponsored_campaigns c
        join directory_facilities f on f.id = c.facility_id
        left join lateral (
          select * from directory_branches b
           where b.facility_id = f.id and b.status = 'active'
             and (c.branch_id is null or b.id = c.branch_id)
           order by b.is_primary desc, b.name limit 1
        ) b on true
       where c.status = 'active' and c.payment_status = 'paid' and c.editorial_status = 'approved'
         and current_date between c.starts_on and c.ends_on
         and c.placement_surface = ${query.surface}
         and f.publication_status = 'published' and f.status = 'active'
         and (c.scope_country is null or c.scope_country = '' or lower(f.country) = lower(c.scope_country))
         and (c.scope_region is null or c.scope_region = '' or lower(f.region) = lower(c.scope_region))
         and (c.scope_district is null or c.scope_district = '' or lower(f.district) = lower(c.scope_district))
         and (c.scope_locality is null or c.scope_locality = '' or lower(f.locality) = lower(c.scope_locality))
         and (cardinality(c.service_categories) = 0 or exists (
           select 1 from directory_services s where s.facility_id = f.id and s.status = 'active'
            and s.category = any(c.service_categories)))
         ${facilityFilter(tx, query)}
       order by md5(c.id::text || to_char(now(), 'YYYY-MM-DD-HH24'))
       limit 12
    `;
    const slots = rows.reduce((sum, row) => sum + Number(row.sponsoredSlots ?? 1), 0);
    return rows.slice(0, Math.max(1, Math.min(slots, 6))).map(mapFacility);
  });
}

directoryRoutes.get("/public/directory/facilities", async (c) => {
  const config = c.get("deps").config;
  const sql = c.get("deps").sql;
  const query = parseQuery(c, config);
  const sponsored = await sponsoredFor(sql, config, query);
  const sponsoredIds = sponsored.map((item) => item.id);
  const data = await withAnonymous(sql, async (tx) => {
    const rows = await tx`
      select ${facilityColumns(tx)}, ${branchJson(tx)} as branches,
             ${distanceSql(tx, query.lat, query.lng)} as distance_km,
             count(*) over()::int as total_count
        from directory_facilities f
        left join lateral (
          select * from directory_branches b
           where b.facility_id = f.id and b.status = 'active'
           order by b.is_primary desc, b.name limit 1
        ) b on true
       where f.publication_status = 'published' and f.status = 'active'
         and f.id <> all(${sponsoredIds}::uuid[])
         ${facilityFilter(tx, query)}
         ${query.lat != null && query.lng != null && query.radiusKm != null
           ? tx`and b.latitude is not null and ${distanceSql(tx, query.lat, query.lng)} <= ${query.radiusKm}`
           : tx``}
       order by
         ${query.sort === "distance" && query.lat != null && query.lng != null
           ? tx`${distanceSql(tx, query.lat, query.lng)} asc nulls last`
           : tx`f.last_confirmed_on desc nulls last`},
         f.name
       limit ${query.limit} offset ${query.offset}
    `;
    return { facilities: rows.map(mapFacility), total: Number(rows[0]?.totalCount ?? 0) };
  });
  return c.json({
    facilities: data.facilities,
    sponsored,
    total: data.total,
    page: { limit: query.limit, offset: query.offset },
    ranking: {
      organic: ["service and capability match", "information freshness", "straight-line distance when supplied", "facility name"],
      sponsored: "Paid placements are labelled and rotated hourly. Payment never changes organic order, verification or emergency routing.",
      distance: "Straight-line distance only; no route distance or travel time is calculated.",
    },
  });
});

directoryRoutes.get("/public/directory/facilities/:publicId", async (c) => {
  const config = c.get("deps").config;
  const sql = c.get("deps").sql;
  const publicId = c.req.param("publicId");
  const data = await withAnonymous(sql, async (tx) => {
    const rows = await tx`
      select ${facilityColumns(tx)}, ${branchJson(tx)} as branches, null::float8 as distance_km
        from directory_facilities f
       where f.public_id = ${publicId} and f.publication_status = 'published' and f.status = 'active'
       limit 1
    `;
    return rows[0] ? mapFacility(rows[0]) : null;
  });
  if (!data) throw new NotFoundError("Facility listing not found");
  if (!config.directory.sponsoredListingsEnabled) return c.json({ facility: data, sponsor: null });
  const sponsor = await withAnonymous(sql, async (tx) => {
    const rows = await tx`
      select c.id, c.placement_surface, c.starts_on, c.ends_on
        from sponsored_campaigns c
       where c.facility_id = ${data.id} and c.status = 'active' and c.payment_status = 'paid'
         and c.editorial_status = 'approved' and current_date between c.starts_on and c.ends_on
       order by c.starts_on desc limit 1
    `;
    return rows[0] ? {
      campaignId: rows[0].id,
      surface: rows[0].placementSurface,
      label: "Sponsored",
      startsOn: rows[0].startsOn,
      endsOn: rows[0].endsOn,
    } : null;
  });
  return c.json({ facility: data, sponsor });
});

directoryRoutes.get("/public/directory/meta", async (c) => {
  const config = c.get("deps").config;
  const sql = c.get("deps").sql;
  const data = await withAnonymous(sql, async (tx) => {
    const geographies = await tx`
      select distinct country, region, district from directory_facilities
       where publication_status = 'published' and status = 'active'
       order by country, region nulls last, district nulls last limit 500
    `;
    const services = await tx`
      select distinct s.category from directory_services s
        join directory_facilities f on f.id = s.facility_id
       where f.publication_status = 'published' and f.status = 'active' and s.status = 'active'
       order by s.category
    `;
    const capabilities = await tx`
      select distinct c.code, c.name from directory_capabilities c
        join directory_facilities f on f.id = c.facility_id
       where f.publication_status = 'published' and f.status = 'active' and c.status <> 'suspended'
       order by c.name limit 200
    `;
    return {
      geographies,
      serviceCategories: services.map((row) => row.category),
      capabilities,
      facilityTypes: ["hospital","clinic","health-centre","diagnostic-centre","pharmacy","dental","eye","mental-health","rehabilitation","maternity","other"],
    };
  });
  return c.json({ ...data, defaults: { country: config.directory.defaultCountry, maxRadiusKm: config.directory.maxRadiusKm } });
});

directoryRoutes.get("/public/directory/map-config", async (c) => {
  const config = c.get("deps").config;
  return c.json({
    renderer: config.map.renderer,
    providerState: config.map.providerState,
    tileUrl: config.map.tileUrl,
    attribution: config.map.attribution,
    minZoom: config.map.minZoom,
    maxZoom: config.map.maxZoom,
    geolocationEnabled: config.map.geolocationEnabled,
    geocodingEnabled: config.map.geocodingEnabled,
    routingEnabled: config.map.routingEnabled,
    distanceMode: "straight-line",
    privacy: "Only public facility coordinates are mapped. Browser location is used transiently on request and is never retained by Medveris.",
  });
});

directoryRoutes.post("/public/directory/events", async (c) => {
  const body = await parseJson(c, directoryEventSchema);
  const sql = c.get("deps").sql;
  const columns = {
    impression: "impressions",
    "detail-open": "detail_opens",
    "pin-interaction": "pin_interactions",
    "contact-click": "contact_clicks",
    "directions-click": "directions_clicks",
    "booking-initiation": "booking_initiations",
  } as const;
  const result = await withAnonymous(sql, async (tx) => {
    const facility = await tx`
      select id from directory_facilities
       where public_id = ${body.facilityPublicId} and publication_status = 'published' and status = 'active'
    `;
    if (!facility[0]) return false;
    if (!body.campaignId) return true;
    const campaign = await tx`
      select c.id from sponsored_campaigns c
       where c.id = ${body.campaignId} and c.facility_id = ${facility[0].id}
         and c.status = 'active' and c.payment_status = 'paid' and c.editorial_status = 'approved'
    `;
    if (!campaign[0]) return false;
    const column = columns[body.eventType];
    await tx.unsafe(
      `insert into sponsored_daily_metrics (id, campaign_id, facility_id, metric_date, surface, ${column})
       values ($1, $2, $3, current_date, $4, 1)
       on conflict (campaign_id, metric_date, surface) do update
         set ${column} = sponsored_daily_metrics.${column} + 1, updated_at = now()`,
      [crypto.randomUUID(), body.campaignId, facility[0].id, body.surface],
    );
    return true;
  });
  return c.json({ ok: result }, result ? 202 : 404);
});

directoryRoutes.post("/public/directory/reports", async (c) => {
  const body = await parseJson(c, directoryReportSchema);
  const facilityPublicId = c.req.query("facility") ?? "";
  const auth = c.get("auth");
  const sql = c.get("deps").sql;
  const id = crypto.randomUUID();
  const ok = await withAnonymous(sql, async (tx) => {
    const facility = await tx`
      select id from directory_facilities
       where public_id = ${facilityPublicId} and publication_status = 'published' and status = 'active'
    `;
    if (!facility[0]) return false;
    await tx`
      insert into directory_reports (id, facility_id, report_type, detail, reporter_user_id, reporter_contact)
      values (${id}, ${facility[0].id}, ${body.reportType}, ${body.detail}, ${auth?.user.id ?? null}, ${body.contact || null})
    `;
    return true;
  });
  if (!ok) throw new NotFoundError("Facility listing not found");
  return c.json({ ok: true, report: { id } }, 201);
});

// Provider workspace ----------------------------------------------------------

directoryRoutes.get("/directory/facilities", async (c) => {
  requireProvider(c);
  const auth = c.get("auth")!;
  const platform = isPlatformOperator(c);
  const rows = await (platform ? withPlatformActor(c, async (tx) => tx`
    select f.id, f.public_id, f.name, f.facility_type, f.publication_status, f.status,
           f.credential_status, f.capability_status, f.last_confirmed_on, f.next_confirmation_on,
           f.claimed_tenant_id, f.version, f.updated_at
      from directory_facilities f
     order by f.updated_at desc limit 500
  `) : withStaffActor(c, async (tx) => tx`
    select f.id, f.public_id, f.name, f.facility_type, f.publication_status, f.status,
           f.credential_status, f.capability_status, f.last_confirmed_on, f.next_confirmation_on,
           f.claimed_tenant_id, f.version, f.updated_at
      from directory_facilities f
     where f.claimed_tenant_id = ${auth.activeTenant!.id}
     order by f.updated_at desc limit 200
  `));
  return c.json({ facilities: rows });
});

directoryRoutes.post("/directory/facilities", async (c) => {
  const platform = isPlatformOperator(c);
  if (!platform) requireProvider(c);
  const auth = c.get("auth")!;
  const body = await parseJson(c, directoryFacilityCreateSchema);
  const id = crypto.randomUUID();
  const publicId = `MV-${crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
  const slug = body.slug ?? `${body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120)}-${publicId.slice(-6).toLowerCase()}`;
  const publication = platform ? "draft" : "pending-review";
  await (platform ? withPlatformActor(c, async (tx) => {
    await insertFacility(tx, c, { id, publicId, slug, publication, body, tenantId: null, userId: auth.user.id });
  }) : withStaffActor(c, async (tx) => {
    await insertFacility(tx, c, { id, publicId, slug, publication, body, tenantId: auth.activeTenant!.id, userId: auth.user.id });
  }));
  return c.json({ ok: true, facility: { id, publicId, slug, publicationStatus: publication } }, 201);
});

async function insertFacility(tx: Tx, c: Context<AppEnv>, input: {
  id: string;
  publicId: string;
  slug: string;
  publication: string;
  body: ReturnType<typeof directoryFacilityCreateSchema.parse>;
  tenantId: string | null;
  userId: string;
}): Promise<void> {
  const { body } = input;
  await tx`
    insert into directory_facilities (
      id, public_id, slug, name, facility_type, description, country, region, district, locality,
      public_phone, public_email, website, medveris_participation, publication_status,
      claimed_tenant_id, claimed_by_user_id, source_kind, source_name, source_url, source_license,
      source_retrieved_on, next_confirmation_on, created_by
    ) values (
      ${input.id}, ${input.publicId}, ${input.slug}, ${body.name}, ${body.facilityType}, ${body.description || null},
      ${body.country}, ${body.region || null}, ${body.district || null}, ${body.locality || null},
      ${body.publicPhone || null}, ${body.publicEmail || null}, ${body.website || null},
      ${body.medverisParticipation}, ${input.publication},
      ${input.tenantId}, ${input.tenantId ? input.userId : null}, ${body.sourceKind},
      ${body.sourceName || null}, ${body.sourceUrl || null}, ${body.sourceLicense || null},
      ${body.sourceRetrievedOn ?? null}, ${body.nextConfirmationOn ?? null}, ${input.userId}
    )
  `;
  for (const branch of body.branches) {
    const branchId = crypto.randomUUID();
    await tx`
      insert into directory_branches (
        id, facility_id, name, is_primary, address_line1, address_line2, city, region, district, locality,
        country, latitude, longitude, coordinate_source, location_status, public_phone, public_email,
        website, opening_hours, opening_exceptions, accessibility, status
      ) values (
        ${branchId}, ${input.id}, ${branch.name}, ${branch.isPrimary}, ${branch.addressLine1 || null},
        ${branch.addressLine2 || null}, ${branch.city || null}, ${branch.region || null},
        ${branch.district || null}, ${branch.locality || null}, ${branch.country},
        ${branch.latitude ?? null}, ${branch.longitude ?? null}, ${branch.coordinateSource},
        ${branch.locationStatus}, ${branch.publicPhone || null}, ${branch.publicEmail || null},
        ${branch.website || null}, ${tx.json(branch.openingHours as never)}, ${tx.json(branch.openingExceptions as never)},
        ${tx.json(branch.accessibility as never)}, ${branch.status}
      )
    `;
  }
  for (const service of body.services) {
    await tx`
      insert into directory_services (id, facility_id, code, name, category, description, availability_note, public_contact)
      values (${crypto.randomUUID()}, ${input.id}, ${service.code}, ${service.name}, ${service.category},
        ${service.description || null}, ${service.availabilityNote || null}, ${service.publicContact || null})
    `;
  }
  for (const capability of body.capabilities) {
    if (capability.status === "verified" && !isPlatformOperator(c)) {
      throw new ForbiddenError("Only Medveris operators can verify a capability");
    }
    await tx`
      insert into directory_capabilities (id, facility_id, code, name, status, evidence_source, verified_at, verified_by)
      values (${crypto.randomUUID()}, ${input.id}, ${capability.code}, ${capability.name}, ${capability.status},
        ${capability.evidenceSource || null}, ${capability.status === "verified" ? new Date() : null},
        ${capability.status === "verified" ? input.userId : null})
    `;
  }
  await writeAudit(tx, c.get("deps").config, requestAudit(c, "directory.facility.create", {
    resourceType: "DirectoryFacility", resourceId: input.id, metadata: { publicId: input.publicId, publicationStatus: input.publication },
  }));
}

directoryRoutes.patch("/directory/facilities/:id", async (c) => {
  const platform = isPlatformOperator(c);
  if (!platform) requireProvider(c);
  const body = await parseJson(c, directoryFacilityUpdateSchema);
  const id = c.req.param("id");
  await (platform ? withPlatformActor(c, async (tx) => updateFacility(tx, c, id, body, true))
    : withStaffActor(c, async (tx) => updateFacility(tx, c, id, body, false)));
  return c.json({ ok: true });
});

async function updateFacility(
  tx: Tx,
  c: Context<AppEnv>,
  id: string,
  body: ReturnType<typeof directoryFacilityUpdateSchema.parse>,
  platform: boolean,
): Promise<void> {
  const rows = await tx`
    select id, version, publication_status from directory_facilities
     where id = ${id} ${platform ? tx`` : tx`and claimed_tenant_id = ${c.get("auth")!.activeTenant!.id}`}
     for update
  `;
  const facility = await requireRows(rows, "Facility listing not found");
  ensureMatch(body.version, facility.version);
  const publication = !platform && facility.publicationStatus === "published" ? "pending-review" : facility.publicationStatus;
  await tx`
    update directory_facilities set
      name = ${body.name ?? tx`name`},
      description = ${body.description ?? tx`description`},
      public_phone = ${body.publicPhone ?? tx`public_phone`},
      public_email = ${body.publicEmail ?? tx`public_email`},
      website = ${body.website ?? tx`website`},
      publication_status = ${publication},
      version = version + 1, updated_at = now()
     where id = ${id}
  `;
  await tx`
    insert into directory_events (id, facility_id, event_type, actor_user_id, actor_tenant_id, note)
    values (${crypto.randomUUID()}, ${id}, 'profile-updated', ${c.get("auth")!.user.id},
      ${c.get("auth")!.activeTenant?.id ?? null}, ${platform ? "Operator updated the listing" : "Provider updated the listing"})
  `;
  if (!platform) {
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "directory.facility.update", {
      resourceType: "DirectoryFacility", resourceId: id, metadata: { version: body.version + 1 },
    }));
  }
}

directoryRoutes.post("/directory/facilities/:id/branches", async (c) => {
  requireProvider(c);
  const body = await parseJson(c, directoryBranchSchema);
  const id = c.req.param("id");
  const branchId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const facility = await tx`
      select id from directory_facilities
       where id = ${id} and claimed_tenant_id = ${c.get("auth")!.activeTenant!.id}
    `;
    if (!facility[0]) throw new NotFoundError("Claimed facility listing not found");
    await tx`
      insert into directory_branches (
        id, facility_id, name, is_primary, address_line1, address_line2, city, region, district, locality,
        country, latitude, longitude, coordinate_source, location_status, public_phone, public_email,
        website, opening_hours, opening_exceptions, accessibility, status
      ) values (
        ${branchId}, ${id}, ${body.name}, ${body.isPrimary}, ${body.addressLine1 || null},
        ${body.addressLine2 || null}, ${body.city || null}, ${body.region || null},
        ${body.district || null}, ${body.locality || null}, ${body.country},
        ${body.latitude ?? null}, ${body.longitude ?? null}, ${body.coordinateSource},
        ${body.locationStatus}, ${body.publicPhone || null}, ${body.publicEmail || null},
        ${body.website || null}, ${tx.json(body.openingHours as never)}, ${tx.json(body.openingExceptions as never)},
        ${tx.json(body.accessibility as never)}, ${body.status}
      )
    `;
  });
  return c.json({ ok: true, branch: { id: branchId } }, 201);
});

directoryRoutes.post("/directory/facilities/:id/services", async (c) => {
  requireProvider(c);
  const body = await parseJson(c, directoryServiceSchema);
  const id = c.req.param("id");
  const serviceId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const facility = await tx`
      select id from directory_facilities where id = ${id} and claimed_tenant_id = ${c.get("auth")!.activeTenant!.id}
    `;
    if (!facility[0]) throw new NotFoundError("Claimed facility listing not found");
    await tx`
      insert into directory_services (id, facility_id, branch_id, code, name, category, description, availability_note, public_contact)
      values (${serviceId}, ${id}, ${body.branchId ?? null}, ${body.code}, ${body.name}, ${body.category},
        ${body.description || null}, ${body.availabilityNote || null}, ${body.publicContact || null})
    `;
  });
  return c.json({ ok: true, service: { id: serviceId } }, 201);
});

directoryRoutes.post("/directory/facilities/:id/capabilities", async (c) => {
  requireProvider(c);
  const body = await parseJson(c, directoryCapabilitySchema);
  if (body.status === "verified" && !isPlatformOperator(c)) {
    throw new ForbiddenError("Only Medveris operators can verify a capability");
  }
  const id = c.req.param("id");
  const capabilityId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const facility = await tx`
      select id from directory_facilities where id = ${id} and claimed_tenant_id = ${c.get("auth")!.activeTenant!.id}
    `;
    if (!facility[0]) throw new NotFoundError("Claimed facility listing not found");
    await tx`
      insert into directory_capabilities (id, facility_id, code, name, status, evidence_source, verified_at, verified_by, notes)
      values (${capabilityId}, ${id}, ${body.code}, ${body.name}, ${body.status}, ${body.evidenceSource || null},
        ${body.status === "verified" ? new Date() : null}, ${body.status === "verified" ? c.get("auth")!.user.id : null}, ${body.notes || null})
    `;
  });
  return c.json({ ok: true, capability: { id: capabilityId } }, 201);
});

directoryRoutes.post("/directory/facilities/:id/confirm", async (c) => {
  requireProvider(c);
  const body = await parseJson(c, directoryConfirmationSchema);
  const id = c.req.param("id");
  await withStaffActor(c, async (tx) => {
    const facility = await tx`
      select id, version from directory_facilities
       where id = ${id} and claimed_tenant_id = ${c.get("auth")!.activeTenant!.id} for update
    `;
    if (!facility[0]) throw new NotFoundError("Claimed facility listing not found");
    await tx`
      insert into directory_confirmations (id, facility_id, confirmed_by, next_due_on, note)
      values (${crypto.randomUUID()}, ${id}, ${c.get("auth")!.user.id}, ${body.nextDueOn ?? null}, ${body.note || null})
    `;
    await tx`
      update directory_facilities set last_confirmed_on = current_date,
        next_confirmation_on = coalesce(${body.nextDueOn ?? null}, current_date + 180),
        version = version + 1, updated_at = now()
       where id = ${id}
    `;
  });
  return c.json({ ok: true });
});

directoryRoutes.post("/directory/facilities/:id/edit-requests", async (c) => {
  requireProvider(c);
  const body = await parseJson(c, directoryEditRequestSchema);
  const id = c.req.param("id");
  const requestId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const facility = await tx`
      select id from directory_facilities where id = ${id} and claimed_tenant_id = ${c.get("auth")!.activeTenant!.id}
    `;
    if (!facility[0]) throw new NotFoundError("Claimed facility listing not found");
    await tx`
      insert into directory_edit_requests (id, facility_id, requested_by, payload)
      values (${requestId}, ${id}, ${c.get("auth")!.user.id}, ${tx.json(body.payload as never)})
    `;
  });
  return c.json({ ok: true, request: { id: requestId } }, 201);
});

// Claims and moderation --------------------------------------------------------

directoryRoutes.post("/directory/claims", async (c) => {
  const auth = requireStaff(c);
  const body = await parseJson(c, directoryClaimSchema);
  const publicId = c.req.query("facility") ?? "";
  const claimId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const facility = await tx`select id from directory_facilities where public_id = ${publicId}`;
    if (!facility[0]) throw new NotFoundError("Facility listing not found");
    await tx`
      insert into directory_claims (
        id, facility_id, claimant_user_id, claimant_tenant_id, representative_name, role_title,
        email, phone, authority_basis, evidence
      ) values (
        ${claimId}, ${facility[0].id}, ${auth.user.id}, ${auth.activeTenant!.id}, ${body.representativeName},
        ${body.roleTitle}, ${body.email}, ${body.phone || null}, ${body.authorityBasis}, ${body.evidence || null}
      )
    `;
    await tx`
      insert into directory_events (id, facility_id, event_type, actor_user_id, actor_tenant_id, note)
      values (${crypto.randomUUID()}, ${facility[0].id}, 'claim-submitted', ${auth.user.id}, ${auth.activeTenant!.id},
        'Facility claim submitted for verification')
    `;
  });
  return c.json({ ok: true, claim: { id: claimId, status: "submitted" } }, 201);
});

directoryRoutes.get("/directory/claims", async (c) => {
  const auth = requireStaff(c);
  const rows = await withStaffActor(c, async (tx) => tx`
    select id, facility_id, representative_name, role_title, status, created_at, decision_reason
      from directory_claims
     where claimant_user_id = ${auth.user.id} or claimant_tenant_id = ${auth.activeTenant!.id}
     order by created_at desc limit 100
  `);
  return c.json({ claims: rows });
});

directoryRoutes.post("/directory/claims/:id/decision", async (c) => {
  if (!isPlatformOperator(c)) throw new ForbiddenError("Platform operator permission is required");
  const body = await parseJson(c, directoryClaimDecisionSchema);
  const claimId = c.req.param("id");
  await withPlatformActor(c, async (tx) => {
    const rows = await tx`select * from directory_claims where id = ${claimId} for update`;
    const claim = await requireRows(rows, "Claim not found");
    if (claim.status !== "submitted" && claim.status !== "under-review") throw new ConflictError("Claim has already been decided");
    const status = body.decision === "verify" ? "verified" : body.decision === "reject" ? "rejected" : "withdrawn";
    await tx`
      update directory_claims set status = ${status}, reviewed_by = ${c.get("auth")!.user.id},
        reviewed_at = now(), decision_reason = ${body.reason}
       where id = ${claimId}
    `;
    if (body.decision === "verify") {
      if (!claim.claimantTenantId) throw new ValidationError("The claimant must belong to a facility organization before verification");
      await tx`
        update directory_facilities set claimed_tenant_id = ${claim.claimantTenantId},
          claimed_by_user_id = ${claim.claimantUserId}, publication_status = 'pending-review',
          source_kind = 'claim', version = version + 1, updated_at = now()
         where id = ${claim.facilityId}
      `;
    }
    await tx`
      insert into directory_events (id, facility_id, event_type, actor_user_id, actor_tenant_id, note, metadata)
      values (${crypto.randomUUID()}, ${claim.facilityId}, 'claim-reviewed', ${c.get("auth")!.user.id}, null,
        ${`Claim ${status}`}, ${tx.json({ decision: body.decision, claimId } as never)})
    `;
  });
  return c.json({ ok: true });
});

directoryRoutes.get("/directory/moderation", async (c) => {
  if (!isPlatformOperator(c)) throw new ForbiddenError("Platform operator permission is required");
  const data = await withPlatformActor(c, async (tx) => {
    const facilities = await tx`
      select id, public_id, name, facility_type, publication_status, credential_status, capability_status,
             claimed_tenant_id, created_at
        from directory_facilities
       where publication_status in ('draft','pending-review')
       order by created_at limit 200
    `;
    const claims = await tx`
      select id, facility_id, representative_name, role_title, authority_basis, status, created_at
        from directory_claims where status in ('submitted','under-review') order by created_at limit 200
    `;
    const reports = await tx`
      select r.id, r.facility_id, r.report_type, r.detail, r.reporter_contact, r.status, r.created_at,
             f.public_id, f.name
        from directory_reports r join directory_facilities f on f.id = r.facility_id
       where r.status = 'open' order by r.created_at limit 200
    `;
    const editRequests = await tx`
      select id, facility_id, requested_by, payload, status, created_at
        from directory_edit_requests where status = 'pending' order by created_at limit 200
    `;
    return { facilities, claims, reports, editRequests };
  });
  return c.json(data);
});

directoryRoutes.post("/directory/facilities/:id/moderation", async (c) => {
  if (!isPlatformOperator(c)) throw new ForbiddenError("Platform operator permission is required");
  const body = await parseJson(c, directoryModerationSchema);
  const id = c.req.param("id");
  await withPlatformActor(c, async (tx) => {
    const facility = await requireRows(await tx`select id, publication_status from directory_facilities where id = ${id} for update`, "Facility listing not found");
    if (body.decision === "approve-profile" && !facility.publicationStatus) throw new ConflictError("No profile is pending approval");
    const publication = body.decision === "publish" ? "published" : body.decision === "suspend" ? "suspended" : body.decision === "archive" ? "archived" : facility.publicationStatus;
    await tx`
      update directory_facilities set publication_status = ${publication}, suspended_reason = ${body.decision === "suspend" ? body.note : null},
        version = version + 1, updated_at = now() where id = ${id}
    `;
    await tx`
      insert into directory_events (id, facility_id, event_type, actor_user_id, note)
      values (${crypto.randomUUID()}, ${id}, ${`moderation-${body.decision}`}, ${c.get("auth")!.user.id}, ${body.note})
    `;
  });
  return c.json({ ok: true });
});

directoryRoutes.post("/directory/reports/:id/resolution", async (c) => {
  if (!isPlatformOperator(c)) throw new ForbiddenError("Platform operator permission is required");
  const body = await parseJson(c, directoryReportResolutionSchema);
  const id = c.req.param("id");
  await withPlatformActor(c, async (tx) => {
    const result = await tx`
      update directory_reports set status = ${body.decision === "resolved" ? "resolved" : "dismissed"},
        resolution = ${body.resolution}, reviewed_by = ${c.get("auth")!.user.id}, reviewed_at = now()
       where id = ${id} and status = 'open'
    `;
    if (result.count === 0) throw new NotFoundError("Open report not found");
  });
  return c.json({ ok: true });
});

directoryRoutes.post("/directory/duplicates/:id/review", async (c) => {
  if (!isPlatformOperator(c)) throw new ForbiddenError("Platform operator permission is required");
  const body = await parseJson(c, directoryDuplicateReviewSchema);
  const id = c.req.param("id");
  await withPlatformActor(c, async (tx) => {
    const review = await requireRows(await tx`select * from directory_duplicate_reviews where id = ${id} for update`, "Duplicate review not found");
    await tx`
      update directory_duplicate_reviews set status = ${body.decision === "merge" ? "merged" : "rejected"},
        reviewed_by = ${c.get("auth")!.user.id}, reviewed_at = now(), note = ${body.note}
       where id = ${id}
    `;
    if (body.decision === "merge") {
      await tx`
        update directory_facilities set status = 'merged', publication_status = 'archived', version = version + 1, updated_at = now()
         where id = ${review.candidateFacilityId}
      `;
      await tx`
        update directory_services set status = 'inactive' where facility_id = ${review.candidateFacilityId}
      `;
    }
  });
  return c.json({ ok: true });
});

directoryRoutes.post("/directory/edit-requests/:id/decision", async (c) => {
  if (!isPlatformOperator(c)) throw new ForbiddenError("Platform operator permission is required");
  const body = await parseJson(c, directoryEditDecisionSchema);
  const id = c.req.param("id");
  await withPlatformActor(c, async (tx) => {
    const request = await requireRows(await tx`select * from directory_edit_requests where id = ${id} for update`, "Edit request not found");
    await tx`
      update directory_edit_requests set status = ${body.decision === "approve" ? "approved" : "rejected"},
        reviewed_by = ${c.get("auth")!.user.id}, reviewed_at = now(), decision_reason = ${body.reason}
       where id = ${id}
    `;
    if (body.decision === "approve") {
      await tx`
        update directory_facilities set description = coalesce(${request.payload.description ?? null}, description),
          public_phone = coalesce(${request.payload.publicPhone ?? null}, public_phone),
          public_email = coalesce(${request.payload.publicEmail ?? null}, public_email),
          website = coalesce(${request.payload.website ?? null}, website),
          version = version + 1, updated_at = now()
         where id = ${request.facilityId}
      `;
    }
  });
  return c.json({ ok: true });
});
