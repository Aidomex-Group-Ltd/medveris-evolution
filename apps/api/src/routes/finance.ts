import { Hono } from "hono";
import {
  claimSchema,
  invoiceSchema,
  paymentReversalSchema,
  paymentSchema,
  serviceCatalogSchema,
  uuidSchema,
} from "@medveris/contracts";
import { assertFinance, assertMembershipAdmin } from "@medveris/authz";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { parseJson } from "../lib/http.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { ConflictError, ForbiddenError, ValidationError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

export const financeRoutes = new Hono<AppEnv>();

function hasRole(c: Parameters<typeof requireStaff>[0], ...roles: string[]): boolean {
  return requestActor(c).roles.some((role) => roles.includes(role));
}

async function refreshInvoice(tx: Parameters<Parameters<typeof withStaffActor>[1]>[0], tenantId: string, invoiceId: string): Promise<void> {
  const rows = await tx`
    select i.id, i.status, i.currency,
      coalesce((select sum(ii.amount) from invoice_items ii where ii.invoice_id = i.id), 0) as total,
      coalesce((select sum(p.amount) from payments p where p.invoice_id = i.id and p.reversed_at is null), 0) as paid
      from invoices i where i.id = ${invoiceId} and i.tenant_id = ${tenantId} for update
  `;
  const invoice = rows[0];
  if (!invoice) return;
  if (invoice.status === "void") return;
  const total = Number(invoice.total);
  const paid = Number(invoice.paid);
  const status = paid >= total && total > 0 ? "paid" : paid > 0 ? "part-paid" : "open";
  await tx`update invoices set status = ${status} where id = ${invoiceId}`;
}

financeRoutes.get("/service-catalog", async (c) => {
  requireStaff(c);
  assertFinance(requestActor(c));
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select * from service_catalog where tenant_id = ${auth.activeTenant!.id} order by category, name
  `);
  return c.json({ services: rows });
});

financeRoutes.post("/service-catalog", async (c) => {
  requireStaff(c);
  assertMembershipAdmin(requestActor(c));
  if (!hasRole(c, "finance", "facility_admin")) throw new ForbiddenError("The finance role is required");
  const auth = c.get("auth")!;
  const body = await parseJson(c, serviceCatalogSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    await tx`
      insert into service_catalog (id, tenant_id, code, name, category, price, currency, created_by)
      values (${id}, ${auth.activeTenant!.id}, ${body.code}, ${body.name}, ${body.category}, ${body.price}, ${body.currency}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "service.catalog.create", {
      resourceType: "ServiceCatalog", resourceId: id, metadata: { code: body.code, price: body.price, currency: body.currency },
    }));
  });
  return c.json({ ok: true, service: { id } }, 201);
});

financeRoutes.get("/invoices", async (c) => {
  requireStaff(c);
  assertFinance(requestActor(c));
  const auth = c.get("auth")!;
  const status = c.req.query("status");
  const rows = await withStaffActor(c, async (tx) => tx`
    select i.id, i.number, i.patient_id, i.encounter_id, i.currency, i.status, i.notes, i.created_at,
           p.public_id, p.given_name, p.family_name,
           coalesce((select sum(ii.amount) from invoice_items ii where ii.invoice_id = i.id), 0) as total,
           coalesce((select sum(p.amount) from payments p where p.invoice_id = i.id and p.reversed_at is null), 0) as paid
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
    if (body.encounterId) {
      const encounter = await tx`select 1 from encounters where id = ${body.encounterId} and patient_id = ${body.patientId} and tenant_id = ${auth.activeTenant!.id}`;
      if (!encounter[0]) throw new ValidationError("Encounter does not belong to the selected patient");
    }
    const prepared = [];
    for (const item of body.items) {
      let unitPrice = item.unitPrice;
      let currency = "UGX";
      if (item.serviceId) {
        const service = await tx`
          select id, name, price, currency, active from service_catalog
           where id = ${item.serviceId} and tenant_id = ${auth.activeTenant!.id}
        `;
        if (!service[0] || !service[0].active) throw new ValidationError("A selected catalogue service is unavailable");
        if (unitPrice == null) unitPrice = Number(service[0].price);
        currency = String(service[0].currency);
      }
      if (unitPrice == null) throw new ValidationError("A unit price is required for services outside the catalogue");
      prepared.push({ ...item, unitPrice, currency });
    }
    const currency = prepared[0]?.currency ?? "UGX";
    if (prepared.some((item) => item.currency !== currency)) throw new ValidationError("All invoice lines must use the same currency");
    await tx`
      insert into invoices (id, tenant_id, patient_id, encounter_id, number, currency, notes, issued_by)
      values (${invoiceId}, ${auth.activeTenant!.id}, ${body.patientId}, ${body.encounterId ?? null}, ${number}, ${currency}, ${body.notes || null}, ${auth.user.id})
    `;
    for (const item of prepared) {
      await tx`
        insert into invoice_items (id, tenant_id, invoice_id, service_id, description, quantity, unit_price, amount)
        values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${invoiceId}, ${item.serviceId ?? null}, ${item.description},
          ${item.quantity}, ${item.unitPrice}, ${Math.round(item.quantity * item.unitPrice * 100) / 100})
      `;
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "invoice.create", {
      subjectPatientId: body.patientId, resourceType: "Invoice", resourceId: invoiceId,
      metadata: { number, itemCount: prepared.length, currency },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "invoice.created", aggregateId: invoiceId, payload: { number } });
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
    const items = await tx`select * from invoice_items where invoice_id = ${id} order by description`;
    const payments = await tx`
      select p.*, u.display_name as received_by_name, r.display_name as reversed_by_name
        from payments p join users u on u.id = p.received_by left join users r on r.id = p.reversed_by
       where p.invoice_id = ${id} order by p.received_at
    `;
    const claims = await tx`select * from claims where invoice_id = ${id} order by created_at`;
    return { invoice, items, payments, claims };
  });
  await withStaffActor(c, async (tx) => writeAudit(tx, c.get("deps").config, requestAudit(c, "invoice.read", {
    subjectPatientId: String(data.invoice.patientId), resourceType: "Invoice", resourceId: id,
  })));
  return c.json(data);
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
      insert into payments (id, tenant_id, invoice_id, amount, method, reference, notes, received_by)
      values (${paymentId}, ${auth.activeTenant!.id}, ${id}, ${body.amount}, ${body.method}, ${body.reference || null}, ${body.notes || null}, ${auth.user.id})
    `;
    await refreshInvoice(tx, auth.activeTenant!.id, id);
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
    await refreshInvoice(tx, auth.activeTenant!.id, String(payment.invoiceId));
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "payment.reverse", {
      subjectPatientId: String(payment.patientId), resourceType: "Payment", resourceId: id,
      metadata: { invoiceId: payment.invoiceId, reason: body.reason },
    }));
  });
  return c.json({ ok: true });
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
      (select count(*)::int from invoices where tenant_id = ${auth.activeTenant!.id} and status in ('open','part-paid')) as open_invoices
  `);
  return c.json({ summary: rows[0] });
});
