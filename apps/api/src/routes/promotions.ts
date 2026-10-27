import { Hono } from "hono";
import type { Context } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  sponsoredCampaignSchema,
  sponsoredPackageSchema,
  sponsorshipDecisionSchema,
  promotionPaymentConfirmSchema,
  promotionPaymentInitiateSchema,
} from "@medveris/contracts";
import { sha256Hex } from "@medveris/domain";
import { withContext, type Tx } from "@medveris/db";
import { permissionsForRoles, type Permission } from "@medveris/authz";
import {
  isPlatformOperator,
  requireAuth,
  requireStaff,
  withPlatformActor,
  withStaffActor,
} from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { parseJson, requireIdempotency } from "../lib/http.js";
import { writeAudit } from "../lib/audit.js";
import { ConflictError, ForbiddenError, ValidationError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

export const promotionRoutes = new Hono<AppEnv>();

function requirePermission(c: Context<AppEnv>, permission: Permission): void {
  const auth = requireAuth(c);
  if (auth.platformRoles.includes("platform_operator")) return;
  if (!permissionsForRoles(requestActor(c).roles).has(permission)) {
    throw new ForbiddenError(`Permission ${permission} is required for this operation`);
  }
}

function provider(c: Context<AppEnv>): ReturnType<typeof requireStaff> {
  requireStaff(c);
  if (!isPlatformOperator(c)) requirePermission(c, "promotion.manage");
  return c.get("auth")!;
}

promotionRoutes.get("/promotions/packages", async (c) => {
  const auth = requireAuth(c);
  if (auth.activeTenant) requirePermission(c, "promotion.manage");
  const rows = auth.activeTenant
    ? await withStaffActor(c, async (tx) => tx`
        select * from sponsored_packages where active order by price, name
      `)
    : await withPlatformActor(c, async (tx) => tx`select * from sponsored_packages order by price, name`);
  return c.json({ packages: rows });
});

promotionRoutes.post("/promotions/packages", async (c) => {
  if (!isPlatformOperator(c)) throw new ForbiddenError("Platform operator permission is required");
  const body = await parseJson(c, sponsoredPackageSchema);
  const id = crypto.randomUUID();
  await withPlatformActor(c, async (tx) => {
    await tx`
      insert into sponsored_packages (
        id, code, name, description, price, currency, duration_days, eligible_countries,
        eligible_facility_types, eligible_service_categories, placement_surface, sponsored_slots,
        max_active_per_facility, requirements, cancellation_policy, starts_on, ends_on, active, created_by
      ) values (
        ${id}, ${body.code}, ${body.name}, ${body.description || null}, ${body.price}, ${body.currency},
        ${body.durationDays}, ${body.eligibleCountries}, ${body.eligibleFacilityTypes},
        ${body.eligibleServiceCategories}, ${body.placementSurface}, ${body.sponsoredSlots},
        ${body.maxActivePerFacility}, ${body.requirements || null}, ${body.cancellationPolicy || null},
        ${body.startsOn ?? null}, ${body.endsOn ?? null}, ${body.active}, ${c.get("auth")!.user.id}
      )
    `;
  });
  return c.json({ ok: true, package: { id } }, 201);
});

promotionRoutes.get("/promotions/campaigns", async (c) => {
  const auth = requireAuth(c);
  if (!auth.activeTenant && !isPlatformOperator(c)) throw new ForbiddenError("An active facility or operator context is required");
  const platform = isPlatformOperator(c);
  const rows = platform
    ? await withPlatformActor(c, async (tx) => tx`
        select c.*, f.public_id, f.name as facility_name
          from sponsored_campaigns c join directory_facilities f on f.id = c.facility_id
         order by c.created_at desc limit 500
      `)
    : await withStaffActor(c, async (tx) => tx`
        select c.*, f.public_id, f.name as facility_name
          from sponsored_campaigns c join directory_facilities f on f.id = c.facility_id
         where f.claimed_tenant_id = ${auth.activeTenant!.id}
         order by c.created_at desc limit 200
      `);
  return c.json({ campaigns: rows });
});

promotionRoutes.post("/promotions/campaigns", async (c) => {
  const auth = provider(c);
  const body = await parseJson(c, sponsoredCampaignSchema);
  if (new Date(body.endsOn) < new Date(body.startsOn)) throw new ValidationError("The campaign end date must be on or after the start date");
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const pkg = await requireRows(await tx`
      select * from sponsored_packages where id = ${body.packageId} and active
    `, "Sponsored package not found or inactive");
    const facility = await requireRows(await tx`
      select * from directory_facilities
       where id = ${body.facilityId} and claimed_tenant_id = ${auth.activeTenant!.id}
    `, "Claimed facility listing not found");
    if ((pkg.eligibleCountries as string[]).length > 0
      && !(pkg.eligibleCountries as string[]).map((value) => value.toLowerCase()).includes(facility.country.toLowerCase())) {
      throw new ValidationError("This package is not available in the facility country");
    }
    if ((pkg.eligibleFacilityTypes as string[]).length > 0 && !(pkg.eligibleFacilityTypes as string[]).includes(facility.facilityType)) {
      throw new ValidationError("This package is not available for the facility type");
    }
    if ((pkg.eligibleServiceCategories as string[]).length > 0) {
      const invalid = body.serviceCategories.filter((category) => !(pkg.eligibleServiceCategories as string[]).includes(category));
      if (invalid.length > 0) throw new ValidationError(`Service categories not covered by this package: ${invalid.join(", ")}`);
    }
    if (body.branchId) {
      const branch = await tx`select id from directory_branches where id = ${body.branchId} and facility_id = ${facility.id}`;
      if (!branch[0]) throw new ValidationError("The selected branch does not belong to the facility");
    }
    const activeCount = await tx`
      select count(*)::int as count from sponsored_campaigns
       where facility_id = ${facility.id} and package_id = ${body.packageId}
         and status in ('pending-review','approved','scheduled','active','paused')
         and ends_on >= current_date
    `;
    if (Number(activeCount[0]?.count ?? 0) >= Number(pkg.maxActivePerFacility)) {
      throw new ConflictError("The maximum number of active sponsorships for this facility has been reached");
    }
    await tx`
      insert into sponsored_campaigns (
        id, package_id, facility_id, branch_id, package_name_snapshot, amount_snapshot, currency_snapshot,
        duration_days_snapshot, placement_surface, sponsored_slots, scope_country, scope_region,
        scope_district, scope_locality, service_categories, starts_on, ends_on, status, payment_status,
        editorial_status, created_by
      ) values (
        ${id}, ${pkg.id}, ${facility.id}, ${body.branchId ?? null}, ${pkg.name}, ${pkg.price}, ${pkg.currency},
        ${pkg.durationDays}, ${pkg.placementSurface}, ${pkg.sponsoredSlots},
        ${body.scopeCountry || null}, ${body.scopeRegion || null}, ${body.scopeDistrict || null},
        ${body.scopeLocality || null}, ${body.serviceCategories}, ${body.startsOn}, ${body.endsOn},
        'pending-review', 'unpaid', 'pending', ${auth.user.id}
      )
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "promotion.campaign.submit", {
      resourceType: "SponsoredCampaign", resourceId: id, metadata: { facilityId: facility.id, packageId: pkg.id },
    }));
  });
  return c.json({ ok: true, campaign: { id, status: "pending-review", paymentStatus: "unpaid" } }, 201);
});

promotionRoutes.post("/promotions/campaigns/:id/payments", async (c) => {
  const auth = provider(c);
  const id = c.req.param("id");
  const body = await parseJson(c, promotionPaymentInitiateSchema);
  const key = await requireIdempotency(c, `promotion.payment.${id}`, body);
  let resolvedPaymentId: string = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const campaign = await requireRows(await tx`
      select c.* from sponsored_campaigns c join directory_facilities f on f.id = c.facility_id
       where c.id = ${id} and f.claimed_tenant_id = ${auth.activeTenant!.id} and c.status = 'pending-review'
         and c.payment_status in ('unpaid','pending') for update
    `, "Pending campaign not found");
    const existing = await tx`select id, status from sponsored_payments where idempotency_key = ${key}`;
    if (existing[0]) {
      resolvedPaymentId = existing[0].id as unknown as string;
      return;
    }
    await tx`
      insert into sponsored_payments (id, campaign_id, amount, currency, method, provider, provider_reference, idempotency_key, notes)
      values (${resolvedPaymentId}, ${id}, ${campaign.amountSnapshot}, ${campaign.currencySnapshot}, ${body.method},
        ${body.provider || "manual"}, ${body.providerReference || null}, ${key},
        ${body.notes || "Initiated from the provider workspace; no card data is stored by Medveris"})
    `;
    await tx`update sponsored_campaigns set payment_status = 'pending' where id = ${id}`;
  });
  return c.json({ ok: true, payment: { id: resolvedPaymentId, status: "pending" } }, 201);
});

promotionRoutes.get("/promotions/campaigns/:id/payments", async (c) => {
  const auth = requireAuth(c);
  if (!auth.activeTenant && !isPlatformOperator(c)) throw new ForbiddenError("An active facility or operator context is required");
  const id = c.req.param("id");
  const rows = isPlatformOperator(c)
    ? await withPlatformActor(c, async (tx) => tx`
        select id, campaign_id, amount, currency, method, provider, provider_reference, status,
               confirmed_at, created_at
          from sponsored_payments where campaign_id = ${id} order by created_at desc limit 50
      `)
    : await withStaffActor(c, async (tx) => tx`
        select p.id, p.campaign_id, p.amount, p.currency, p.method, p.provider, p.provider_reference, p.status,
               p.confirmed_at, p.created_at
          from sponsored_payments p
          join sponsored_campaigns c on c.id = p.campaign_id
          join directory_facilities f on f.id = c.facility_id
         where p.campaign_id = ${id} and f.claimed_tenant_id = ${auth.activeTenant!.id}
         order by p.created_at desc limit 50
      `);
  return c.json({ payments: rows });
});

promotionRoutes.post("/promotions/payments/:id/confirm", async (c) => {
  const auth = requireAuth(c);
  if (!isPlatformOperator(c)) requirePermission(c, "promotion.billing.manage");
  const body = await parseJson(c, promotionPaymentConfirmSchema);
  const id = c.req.param("id");
  await (isPlatformOperator(c) ? withPlatformActor(c, async (tx) => confirmPayment(tx, c, id, body, auth.user.id))
    : withStaffActor(c, async (tx) => confirmPayment(tx, c, id, body, auth.user.id)));
  return c.json({ ok: true });
});

async function confirmPayment(
  tx: Tx,
  c: Context<AppEnv>,
  id: string,
  body: ReturnType<typeof promotionPaymentConfirmSchema.parse>,
  userId: string,
): Promise<void> {
  const payment = await requireRows(await tx`
    select * from sponsored_payments where id = ${id} for update
  `, "Payment not found");
  if (payment.status === "confirmed") return;
  if (payment.status !== "pending") throw new ConflictError("Only pending payments can be confirmed");
  await tx`
    update sponsored_payments set status = 'confirmed', confirmed_by = ${userId}, confirmed_at = now(),
      provider_reference = ${body.providerReference}, notes = ${body.notes || payment.notes}, updated_at = now()
     where id = ${id}
  `;
  await tx`update sponsored_campaigns set payment_status = 'paid', updated_at = now() where id = ${payment.campaignId}`;
  await tx`
    insert into sponsored_payment_events (id, payment_id, provider, external_event_id, signature_verified, status)
    values (${crypto.randomUUID()}, ${id}, 'manual', ${`manual:${id}:confirmed`}, true, 'applied')
    on conflict (provider, external_event_id) do nothing
  `;
  await tx`
    insert into directory_events (id, facility_id, event_type, actor_user_id, note)
    select ${crypto.randomUUID()}, facility_id, 'sponsorship-paid', ${userId},
      'Campaign payment confirmed; editorial review still required'
      from sponsored_campaigns where id = ${payment.campaignId}
  `;
  await writeAudit(tx, c.get("deps").config, {
    actorUserId: userId, actorKind: "staff", action: "promotion.payment.confirm",
    resourceType: "SponsoredPayment", resourceId: id,
    metadata: { campaignId: payment.campaignId, amount: payment.amount, currency: payment.currency },
  });
}

promotionRoutes.post("/promotions/campaigns/:id/decision", async (c) => {
  if (!isPlatformOperator(c)) throw new ForbiddenError("Platform operator permission is required");
  const body = await parseJson(c, sponsorshipDecisionSchema);
  const id = c.req.param("id");
  await withPlatformActor(c, async (tx) => {
    const campaign = await requireRows(await tx`select * from sponsored_campaigns where id = ${id} for update`, "Campaign not found");
    if (!["pending-review", "scheduled", "active"].includes(campaign.status)) throw new ConflictError("The campaign is not awaiting an editorial decision");
    if (body.decision === "approve" && campaign.paymentStatus !== "paid" && campaign.paymentStatus !== "waived") {
      throw new ConflictError("Payment must be confirmed before a campaign can be activated");
    }
    const today = new Date().toISOString().slice(0, 10);
    const status = body.decision === "reject"
      ? "rejected"
      : campaign.endsOn < today
        ? "expired"
        : campaign.startsOn > today ? "scheduled" : "active";
    await tx`
      update sponsored_campaigns set status = ${status}, editorial_status = ${body.decision === "approve" ? "approved" : "rejected"},
        reviewed_by = ${c.get("auth")!.user.id}, reviewed_at = now(), decision_reason = ${body.note},
        version = version + 1, updated_at = now()
       where id = ${id}
    `;
    await tx`
      insert into directory_events (id, facility_id, event_type, actor_user_id, note)
      values (${crypto.randomUUID()}, ${campaign.facilityId}, 'sponsorship-reviewed', ${c.get("auth")!.user.id},
        ${`Campaign ${body.decision}: editorial review is separate from organic ranking`})
    `;
  });
  return c.json({ ok: true });
});

promotionRoutes.post("/promotions/campaigns/:id/pause", async (c) => {
  const auth = provider(c);
  const id = c.req.param("id");
  await withStaffActor(c, async (tx) => {
    const campaign = await requireRows(await tx`
      select c.* from sponsored_campaigns c join directory_facilities f on f.id = c.facility_id
       where c.id = ${id} and f.claimed_tenant_id = ${auth.activeTenant!.id} for update
    `, "Campaign not found");
    if (!["active", "scheduled"].includes(campaign.status)) throw new ConflictError("Only active or scheduled campaigns can be paused");
    await tx`update sponsored_campaigns set status = 'paused', paused_at = now(), updated_at = now() where id = ${id}`;
  });
  return c.json({ ok: true });
});

promotionRoutes.post("/promotions/campaigns/:id/cancel", async (c) => {
  const auth = provider(c);
  const id = c.req.param("id");
  await withStaffActor(c, async (tx) => {
    const campaign = await requireRows(await tx`
      select c.* from sponsored_campaigns c join directory_facilities f on f.id = c.facility_id
       where c.id = ${id} and f.claimed_tenant_id = ${auth.activeTenant!.id} for update
    `, "Campaign not found");
    if (["expired", "cancelled", "rejected"].includes(campaign.status)) throw new ConflictError("The campaign is already closed");
    await tx`update sponsored_campaigns set status = 'cancelled', cancelled_at = now(), updated_at = now() where id = ${id}`;
  });
  return c.json({ ok: true });
});

promotionRoutes.get("/promotions/campaigns/:id/metrics", async (c) => {
  const auth = requireAuth(c);
  if (!auth.activeTenant && !isPlatformOperator(c)) throw new ForbiddenError("An active facility or operator context is required");
  const id = c.req.param("id");
  const rows = isPlatformOperator(c)
    ? await withPlatformActor(c, async (tx) => tx`
        select * from sponsored_daily_metrics where campaign_id = ${id} order by metric_date desc, surface limit 400
      `)
    : await withStaffActor(c, async (tx) => tx`
        select m.* from sponsored_daily_metrics m
          join sponsored_campaigns c on c.id = m.campaign_id
          join directory_facilities f on f.id = c.facility_id
         where m.campaign_id = ${id} and f.claimed_tenant_id = ${auth.activeTenant!.id}
         order by m.metric_date desc, m.surface limit 400
      `);
  return c.json({ metrics: rows });
});

promotionRoutes.post("/public/promotions/webhooks/payments", async (c) => {
  const config = c.get("deps").config;
  if (!config.promotions.webhookSecret) {
    return c.json({ error: { code: "not_configured", message: "Payment webhooks are not configured" } }, 503);
  }
  const raw = await c.req.text();
  const signature = c.req.header("x-medveris-signature") ?? "";
  const expected = createHmac("sha256", config.promotions.webhookSecret).update(raw).digest("hex");
  const supplied = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  const valid = supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!valid) return c.json({ error: { code: "invalid_signature", message: "Webhook signature verification failed" } }, 401);
  let body: { provider?: string; eventId?: string; providerReference?: string; status?: string };
  try {
    body = JSON.parse(raw);
  } catch {
    throw new ValidationError("Webhook payload must be valid JSON");
  }
  if (!body.provider || !body.eventId || !body.providerReference || !body.status) {
    throw new ValidationError("Webhook payload is missing required fields");
  }
  const status = body.status === "confirmed" ? "confirmed" : body.status === "failed" ? "failed" : body.status === "refunded" ? "refunded" : null;
  if (!status) throw new ValidationError("Unsupported webhook status");
  const result = await withContext(c.get("deps").sql, {
    actorKind: "system", platformRole: "platform_operator",
  }, async (tx) => {
    const inserted = await tx`
      insert into sponsored_payment_events (id, payment_id, provider, external_event_id, signature_verified, status, payload_digest)
      select ${crypto.randomUUID()}, p.id, ${body.provider!}, ${body.eventId!}, true, 'received', ${await sha256Hex(raw)}
        from sponsored_payments p
       where p.provider_reference = ${body.providerReference!} and p.provider = ${body.provider!}
      on conflict (provider, external_event_id) do nothing
      returning id
    `;
    if (!inserted[0]) return { duplicate: true };
    const payment = await requireRows(await tx`
      select * from sponsored_payments where provider_reference = ${body.providerReference!} and provider = ${body.provider!} for update
    `, "Payment not found");
    await tx`update sponsored_payments set status = ${status}, updated_at = now() where id = ${payment.id}`;
    if (status === "confirmed") {
      await tx`update sponsored_campaigns set payment_status = 'paid', updated_at = now() where id = ${payment.campaignId}`;
    } else if (status === "refunded") {
      await tx`update sponsored_campaigns set payment_status = 'refunded', status = 'paused', updated_at = now() where id = ${payment.campaignId}`;
    }
    return { duplicate: false };
  });
  return c.json({ ok: true, duplicate: result.duplicate });
});
