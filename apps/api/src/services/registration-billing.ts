import type { Tx } from "@medveris/db";
import { roundMoney } from "@medveris/domain";
import { invoiceNumber } from "./billing.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import type { AppConfig } from "../config.js";

export interface RegistrationBillingResult {
  status: "billed" | "already_billed" | "disabled" | "not_configured" | "unavailable";
  invoiceId?: string;
  invoiceItemId?: string;
  amount?: number;
  currency?: string;
  reason?: string;
}

interface AuditMeta {
  correlationId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Idempotently creates/links the facility's default initial registration/consultation charge for a patient.
 * - Runs inside the caller's transaction (registration/enrollment) so retries cannot duplicate records.
 * - Creates an open invoice line (not delivered, not paid) when a facility has an enabled, approved, active catalog item configured.
 * - Safe no-op when disabled or not configured. Never throws for configuration gaps; registration must still succeed.
 */
export async function ensureInitialRegistrationBilling(tx: Tx, args: {
  tenantId: string;
  patientId: string;
  actorUserId: string;
  actorRoles: string[];
  auditMeta?: AuditMeta;
  config: AppConfig;
}): Promise<RegistrationBillingResult> {
  // Serialize per (facility, patient) to make check+create idempotent within a transaction.
  await tx`select pg_advisory_xact_lock(hashtext(${`registration-billing:${args.tenantId}:${args.patientId}`}))`;

  const [existing] = await tx`
    select id, invoice_id, invoice_item_id, amount, currency, status, reason
      from patient_registration_billing
     where tenant_id = ${args.tenantId} and patient_id = ${args.patientId}
  `;
  if (existing) {
    return {
      status: "already_billed",
      invoiceId: String(existing.invoiceId),
      invoiceItemId: String(existing.invoiceItemId),
      amount: Number(existing.amount),
      currency: String(existing.currency),
      reason: existing.reason ? String(existing.reason) : undefined,
    };
  }

  const [settings] = await tx`
    select registration_charge_enabled, registration_charge_catalog_id, allowed_currencies
      from facility_billing_settings where tenant_id = ${args.tenantId}
  `;
  if (!settings?.registrationChargeEnabled) return { status: "disabled" };
  const catalogItemId = settings.registrationChargeCatalogId as string | null;
  if (!catalogItemId) return { status: "not_configured", reason: "Registration charge enabled without a configured price-list item" };

  const [item] = await tx`
    select id, name, price, currency, active, price_status, code
      from service_catalog
     where id = ${catalogItemId} and tenant_id = ${args.tenantId}
  `;
  if (!item || !item.active || item.priceStatus !== "approved") {
    return { status: "unavailable", reason: "Configured registration charge item is missing, inactive, or not approved" };
  }
  const allowed = (settings.allowedCurrencies as string[] | undefined) ?? [];
  if (allowed.length && !allowed.includes(String(item.currency))) {
    return { status: "unavailable", reason: "Configured registration charge currency is not enabled for this facility" };
  }

  const amount = roundMoney(Number(item.price));
  const currency = String(item.currency);
  const invoiceId = crypto.randomUUID();
  const invoiceItemId = crypto.randomUUID();
  const markerId = crypto.randomUUID();
  const number = invoiceNumber();
  const description = `Registration / initial consultation: ${item.name}`;

  await tx`
    insert into invoices (id, tenant_id, patient_id, encounter_id, number, currency, notes, issued_by)
    values (${invoiceId}, ${args.tenantId}, ${args.patientId}, ${null}, ${number}, ${currency},
      ${"Auto-generated initial registration charge (not a service delivery or payment record)."}, ${args.actorUserId})
  `;
  await tx`
    insert into invoice_items (id, tenant_id, invoice_id, service_id, description, quantity, unit_price, amount, source, created_by)
    values (${invoiceItemId}, ${args.tenantId}, ${invoiceId}, ${item.id}, ${description}, ${1}, ${amount}, ${amount}, ${"registration"}, ${args.actorUserId})
  `;
  await tx`
    insert into patient_registration_billing (id, tenant_id, patient_id, invoice_id, invoice_item_id, catalog_item_id, amount, currency, status, reason, created_by)
    values (${markerId}, ${args.tenantId}, ${args.patientId}, ${invoiceId}, ${invoiceItemId}, ${item.id}, ${amount}, ${currency}, 'billed', ${`Auto-created on registration (${item.code ?? item.name})`}, ${args.actorUserId})
  `;

  await writeAudit(tx, args.config, {
    tenantId: args.tenantId,
    actorKind: "staff",
    actorUserId: args.actorUserId,
    actorRoles: args.actorRoles,
    action: "patient.registration-billing.create",
    subjectPatientId: args.patientId,
    resourceType: "Invoice",
    resourceId: invoiceId,
    correlationId: args.auditMeta?.correlationId ?? undefined,
    ipAddress: args.auditMeta?.ipAddress ?? null,
    metadata: { invoiceNumber: number, catalogItemId: String(item.id), amount, currency, source: "registration" },
  });
  await writeOutbox(tx, {
    tenantId: args.tenantId,
    eventType: "patient.registration-billing.created",
    aggregateId: invoiceId,
    payload: { patientId: args.patientId, invoiceId, invoiceNumber: number, amount, currency, catalogItemId: String(item.id) },
  });

  return { status: "billed", invoiceId, invoiceItemId, amount, currency };
}
