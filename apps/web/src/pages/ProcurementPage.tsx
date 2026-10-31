import { useState, type FormEvent } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Tabs } from "@medveris/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { inventoryScope } from "../lib/inventoryScope";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";

interface Supplier { id: string; code: string; name: string; contactName: string | null; phone: string | null; email: string | null; licenceReference: string | null; status: string }
interface PurchaseOrderRow {
  id: string; poNumber: string; status: string; currency: string; expectedOn: string | null; createdAt: string; version: number;
  supplierName: string; locationName: string; departmentName: string | null; unitName: string | null; totalAmount: string; lineCount: number;
}
interface OrderDetail {
  order: { id: string; poNumber: string; status: string; version: number; currency: string; createdBy: string; cancelReason: string | null; notes: string | null };
  lines: Array<{ id: string; itemId: string; itemCode: string; itemName: string; unit: string; quantityOrdered: string; quantityReceived: string; unitPrice: string; lotTracked: boolean; expiryTracked: boolean }>;
  receipts: Array<{ id: string; quantity: string; unit: string; occurredAt: string; itemName: string; lotNumber: string | null; actorName: string }>;
}
interface ItemRow { id: string; itemCode: string; name: string; baseUnit: string; units: Array<{ unit: string; purchasingUnit: boolean }> | null }
interface LocationRow { id: string; code: string; name: string; departmentId: string | null; departmentName: string | null }
interface Department { id: string; name: string }

const STATUS_TONE: Record<string, "success" | "warning" | "info" | "neutral" | "danger"> = {
  draft: "neutral", submitted: "info", approved: "warning", "partially-received": "warning", received: "success", cancelled: "neutral",
};

export function ProcurementPage() {
  const [tab, setTab] = useState<"orders" | "suppliers">("orders");
  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Inventory" title="Purchasing" description="Suppliers and purchase orders for this workspace. Receipts post to this workspace's own stock ledger with lots and expiry." />
      <Tabs label="Purchasing sections" value={tab} onChange={setTab} options={[{ value: "orders", label: "Purchase orders" }, { value: "suppliers", label: "Suppliers" }]} />
      {tab === "orders" ? <Orders /> : <Suppliers />}
    </div>
  );
}

function Suppliers() {
  const suppliers = useQuery<{ suppliers: Supplier[] }>("/procurement/suppliers");
  const action = useAction();
  const [form, setForm] = useState({ code: "", name: "", contactName: "", phone: "", email: "", licenceReference: "" });
  async function create(event: FormEvent) {
    event.preventDefault();
    if (await action.run("create", async () => {
      await api("/procurement/suppliers", { method: "POST", body: form });
      setForm({ code: "", name: "", contactName: "", phone: "", email: "", licenceReference: "" });
      return "Supplier added.";
    })) suppliers.reload();
  }
  async function toggle(supplier: Supplier) {
    if (await action.run(`toggle-${supplier.id}`, async () => {
      await api(`/procurement/suppliers/${supplier.id}/status`, { method: "POST", body: { status: supplier.status === "active" ? "inactive" : "active" } });
    })) suppliers.reload();
  }
  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title="Add a supplier">
        <form className="mv-stack" onSubmit={create}>
          <div className="mv-form-grid">
            <Field label="Code" htmlFor="sup-code" hint="Capital letters, digits and dashes."><Input id="sup-code" value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value.toUpperCase() })} required pattern="[A-Z0-9][A-Z0-9-]{1,39}" /></Field>
            <Field label="Name" htmlFor="sup-name"><Input id="sup-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required minLength={2} maxLength={200} /></Field>
            <Field label="Contact person" htmlFor="sup-contact"><Input id="sup-contact" value={form.contactName} onChange={(event) => setForm({ ...form, contactName: event.target.value })} maxLength={160} /></Field>
            <Field label="Phone" htmlFor="sup-phone"><Input id="sup-phone" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} maxLength={40} /></Field>
            <Field label="Email" htmlFor="sup-email"><Input id="sup-email" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></Field>
            <Field label="Licence (e.g. NDA wholesale)" htmlFor="sup-licence"><Input id="sup-licence" value={form.licenceReference} onChange={(event) => setForm({ ...form, licenceReference: event.target.value })} maxLength={120} /></Field>
          </div>
          <div><Button type="submit" disabled={action.busy !== null}>Add supplier</Button></div>
        </form>
      </Card>
      <Card title="Suppliers">
        {suppliers.loading && !suppliers.data ? <LoadingState /> : suppliers.error ? <ErrorState message={suppliers.error} onRetry={suppliers.reload} /> : !suppliers.data?.suppliers.length ? <EmptyState title="No suppliers" description="Add the suppliers this workspace buys from." /> : (
          <Table head={["Supplier", "Contact", "Licence", "Status", ""]} caption="Suppliers">
            {suppliers.data.suppliers.map((supplier) => (
              <tr key={supplier.id}>
                <td><strong>{supplier.name}</strong><div className="mv-small mv-muted mv-id">{supplier.code}</div></td>
                <td className="mv-small">{[supplier.contactName, supplier.phone, supplier.email].filter(Boolean).join(" · ") || "—"}</td>
                <td className="mv-small">{supplier.licenceReference ?? "—"}</td>
                <td><Badge tone={supplier.status === "active" ? "success" : "neutral"}>{supplier.status}</Badge></td>
                <td><Button size="sm" variant="ghost" onClick={() => void toggle(supplier)}>{supplier.status === "active" ? "Deactivate" : "Reactivate"}</Button></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

interface LineInput { itemId: string; unit: string; quantity: string; unitPrice: string }

function Orders() {
  const { me } = useAuth();
  const scope = inventoryScope(me?.activeTenant?.roles);
  const orders = useQuery<{ purchaseOrders: PurchaseOrderRow[] }>("/procurement/purchase-orders");
  const suppliers = useQuery<{ suppliers: Supplier[] }>("/procurement/suppliers");
  const items = useQuery<{ items: ItemRow[] }>("/inventory/items?status=active");
  const locations = useQuery<{ locations: LocationRow[] }>(`/inventory/locations?${scope}`);
  const departments = useQuery<{ departments: Department[] }>("/organization/departments");
  const action = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState({ supplierId: "", destinationLocationId: "", departmentId: "", expectedOn: "", notes: "" });
  const [lines, setLines] = useState<LineInput[]>([{ itemId: "", unit: "", quantity: "", unitPrice: "0" }]);

  function setLine(index: number, patch: Partial<LineInput>) {
    setLines(lines.map((line, position) => position === index ? { ...line, ...patch } : line));
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    const location = locations.data?.locations.find((entry) => entry.id === form.destinationLocationId);
    if (await action.run("create", async () => {
      const result = await api<{ purchaseOrder: { id: string; poNumber: string } }>("/procurement/purchase-orders", { method: "POST", body: {
        supplierId: form.supplierId, destinationLocationId: form.destinationLocationId, departmentId: form.departmentId || location?.departmentId || null,
        expectedOn: form.expectedOn, notes: form.notes,
        lines: lines.map((line) => ({ itemId: line.itemId, unit: line.unit, quantity: Number(line.quantity), unitPrice: Number(line.unitPrice || 0) })),
      } });
      setLines([{ itemId: "", unit: "", quantity: "", unitPrice: "0" }]);
      setOpen(result.purchaseOrder.id);
      return `Purchase order ${result.purchaseOrder.poNumber} created as a draft.`;
    })) orders.reload();
  }

  const activeSuppliers = suppliers.data?.suppliers.filter((supplier) => supplier.status === "active") ?? [];
  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      {open ? <OrderPanel id={open} onClose={() => setOpen(null)} onChanged={orders.reload} /> : null}
      <Card title="Purchase orders">
        {orders.loading && !orders.data ? <LoadingState /> : orders.error ? <ErrorState message={orders.error} onRetry={orders.reload} /> : !orders.data?.purchaseOrders.length ? <EmptyState title="No purchase orders" description="Raise a purchase order below." /> : (
          <Table head={["Number", "Supplier", "Deliver to", "Lines", "Total", "Status", ""]} caption="Purchase orders">
            {orders.data.purchaseOrders.map((order) => (
              <tr key={order.id}>
                <td className="mv-id">{order.poNumber}<div className="mv-small mv-muted">{new Date(order.createdAt).toLocaleDateString()}</div></td>
                <td>{order.supplierName}</td>
                <td className="mv-small">{order.locationName}{order.departmentName ? <div className="mv-muted">{order.departmentName}{order.unitName ? ` · ${order.unitName}` : ""}</div> : null}</td>
                <td>{order.lineCount}</td>
                <td>{Number(order.totalAmount).toLocaleString()} {order.currency}</td>
                <td><Badge tone={STATUS_TONE[order.status] ?? "neutral"}>{order.status}</Badge></td>
                <td><Button size="sm" variant="secondary" onClick={() => setOpen(order.id)}>Open</Button></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="Raise a purchase order" description="Orders are drafted, submitted, approved and then received against.">
        {!activeSuppliers.length ? <EmptyState title="Add a supplier first" description="Purchase orders need an active supplier." /> : (
          <form className="mv-stack" onSubmit={create}>
            <div className="mv-form-grid">
              <Field label="Supplier" htmlFor="po-supplier"><Select id="po-supplier" value={form.supplierId} onChange={(event) => setForm({ ...form, supplierId: event.target.value })} required>
                <option value="">Choose a supplier</option>{activeSuppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
              </Select></Field>
              <Field label="Deliver to" htmlFor="po-location"><Select id="po-location" value={form.destinationLocationId} onChange={(event) => setForm({ ...form, destinationLocationId: event.target.value })} required>
                <option value="">Choose a stock location</option>{locations.data?.locations.map((location) => <option key={location.id} value={location.id}>{location.name}{location.departmentName ? ` (${location.departmentName})` : ""}</option>)}
              </Select></Field>
              <Field label="Department" htmlFor="po-department" hint="Defaults to the location's department."><Select id="po-department" value={form.departmentId} onChange={(event) => setForm({ ...form, departmentId: event.target.value })}>
                <option value="">From the location</option>{departments.data?.departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
              </Select></Field>
              <Field label="Expected delivery" htmlFor="po-expected"><Input id="po-expected" type="date" value={form.expectedOn} onChange={(event) => setForm({ ...form, expectedOn: event.target.value })} /></Field>
            </div>
            {lines.map((line, index) => {
              const item = items.data?.items.find((entry) => entry.id === line.itemId);
              return (
                <div className="mv-form-grid" key={index}>
                  <Field label="Item" htmlFor={`po-item-${index}`}><Select id={`po-item-${index}`} value={line.itemId} onChange={(event) => {
                    const next = items.data?.items.find((entry) => entry.id === event.target.value);
                    setLine(index, { itemId: event.target.value, unit: next?.units?.find((unit) => unit.purchasingUnit)?.unit ?? next?.baseUnit ?? "" });
                  }} required>
                    <option value="">Choose an item</option>{items.data?.items.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} ({entry.itemCode})</option>)}
                  </Select></Field>
                  <Field label="Unit" htmlFor={`po-unit-${index}`}><Select id={`po-unit-${index}`} value={line.unit} onChange={(event) => setLine(index, { unit: event.target.value })} required>
                    {(item?.units ?? [{ unit: item?.baseUnit ?? "", purchasingUnit: true }]).map((unit) => <option key={unit.unit} value={unit.unit}>{unit.unit}</option>)}
                  </Select></Field>
                  <Field label="Quantity" htmlFor={`po-qty-${index}`}><Input id={`po-qty-${index}`} type="number" min="0" step="any" value={line.quantity} onChange={(event) => setLine(index, { quantity: event.target.value })} required /></Field>
                  <Field label="Unit price" htmlFor={`po-price-${index}`}><Input id={`po-price-${index}`} type="number" min="0" step="any" value={line.unitPrice} onChange={(event) => setLine(index, { unitPrice: event.target.value })} /></Field>
                  <div>{lines.length > 1 ? <Button type="button" size="sm" variant="ghost" onClick={() => setLines(lines.filter((_, position) => position !== index))}>Remove line</Button> : null}</div>
                </div>
              );
            })}
            <div className="mv-row">
              <Button type="button" variant="secondary" size="sm" onClick={() => setLines([...lines, { itemId: "", unit: "", quantity: "", unitPrice: "0" }])}>Add line</Button>
              <Button type="submit" disabled={action.busy !== null}>Create draft</Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}

function OrderPanel({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const detail = useQuery<OrderDetail>(`/procurement/purchase-orders/${id}`);
  const action = useAction();
  const [receipt, setReceipt] = useState<Record<string, { quantity: string; lotNumber: string; expiresOn: string }>>({});
  if (detail.loading && !detail.data) return <LoadingState />;
  if (detail.error || !detail.data) return <ErrorState message={detail.error ?? "Purchase order not found"} onRetry={detail.reload} />;
  const { order, lines, receipts } = detail.data;
  const done = () => { detail.reload(); onChanged(); };
  const [supplierInvoice, setSupplierInvoice] = useState("");

  async function act(kind: "submit" | "approve" | "cancel") {
    const reason = kind === "cancel" ? window.prompt("Why is this purchase order cancelled?") : undefined;
    if (kind === "cancel" && (!reason || reason.trim().length < 3)) return;
    if (await action.run(kind, async () => {
      await api(`/procurement/purchase-orders/${id}/action`, { method: "POST", body: { action: kind, expectedVersion: order.version, ...(reason ? { reason } : {}) } });
    })) done();
  }

  async function receive(event: FormEvent) {
    event.preventDefault();
    const entries = lines.map((line) => ({ line, input: receipt[line.id] }))      .filter((entry) => entry.input && Number(entry.input.quantity) > 0);
    if (!entries.length) return;
    if (await action.run("receive", async () => {
      const result = await api<{ status: string }>(`/procurement/purchase-orders/${id}/receive`, { method: "POST", body: {
        expectedVersion: order.version,
        supplierInvoiceNumber: supplierInvoice || undefined,
        lines: entries.map(({ line, input }) => ({ lineId: line.id, quantity: Number(input!.quantity), lotNumber: input!.lotNumber, expiresOn: input!.expiresOn })),
      } });
      setReceipt({});
      setSupplierInvoice("");
      return `Received into stock; the order is now ${result.status}.`;
    })) done();
  }

  const receivable = ["approved", "partially-received"].includes(order.status);
  return (
    <Card title={`Purchase order ${order.poNumber}`} description={`Status: ${order.status}`} actions={<Button size="sm" variant="ghost" onClick={onClose}>Close</Button>}>
      <div className="mv-stack">
        {action.error ? <ErrorState message={action.error} /> : null}
        {action.message ? <Notice tone="success">{action.message}</Notice> : null}
        {order.cancelReason ? <Notice tone="warning" title="Cancelled">{order.cancelReason}</Notice> : null}
        <form className="mv-stack" onSubmit={receive}>
          {receivable ? (
            <div className="mv-form-grid">
              <Field label="Supplier invoice number" htmlFor="po-invoice" hint="Recorded on the receipt and its stock lots. A second receipt cannot reuse the same invoice from this supplier.">
                <Input id="po-invoice" value={supplierInvoice} onChange={(event) => setSupplierInvoice(event.target.value)} maxLength={80} />
              </Field>
            </div>
          ) : null}
          <Table head={["Item", "Ordered", "Received", "Unit price", ...(receivable ? ["Receive now", "Lot", "Expiry"] : [])]} caption="Order lines">
            {lines.map((line) => {
              const input = receipt[line.id] ?? { quantity: "", lotNumber: "", expiresOn: "" };
              const set = (patch: Partial<typeof input>) => setReceipt({ ...receipt, [line.id]: { ...input, ...patch } });
              const outstanding = Number(line.quantityOrdered) - Number(line.quantityReceived);
              return (
                <tr key={line.id}>
                  <td>{line.itemName}<div className="mv-small mv-muted">{line.itemCode}</div></td>
                  <td>{Number(line.quantityOrdered)} {line.unit}</td>
                  <td>{Number(line.quantityReceived)} {line.unit}</td>
                  <td>{Number(line.unitPrice).toLocaleString()} {order.currency}</td>
                  {receivable ? (
                    <>
                      <td><Input aria-label={`Quantity of ${line.itemName} to receive`} type="number" min="0" max={outstanding} step="any" value={input.quantity} onChange={(event) => set({ quantity: event.target.value })} disabled={outstanding <= 0} /></td>
                      <td>{line.lotTracked ? <Input aria-label={`Lot of ${line.itemName}`} value={input.lotNumber} onChange={(event) => set({ lotNumber: event.target.value })} maxLength={80} /> : <span className="mv-small mv-muted">not tracked</span>}</td>
                      <td>{line.expiryTracked ? <Input aria-label={`Expiry of ${line.itemName}`} type="date" value={input.expiresOn} onChange={(event) => set({ expiresOn: event.target.value })} /> : <span className="mv-small mv-muted">not tracked</span>}</td>
                    </>
                  ) : null}
                </tr>
              );
            })}
          </Table>
          <div className="mv-row">
            {order.status === "draft" ? <Button type="button" onClick={() => void act("submit")}>Submit for approval</Button> : null}
            {order.status === "submitted" ? <Button type="button" onClick={() => void act("approve")}>Approve</Button> : null}
            {receivable ? <Button type="submit" disabled={action.busy !== null}>Receive into stock</Button> : null}
            {["draft", "submitted", "approved"].includes(order.status) ? <Button type="button" variant="ghost" onClick={() => void act("cancel")}>Cancel order</Button> : null}
          </div>
        </form>
        {receipts.length ? (
          <Table head={["Received", "Item", "Quantity", "Lot", "By"]} caption="Receipts posted to the stock ledger">
            {receipts.map((entry) => <tr key={entry.id}><td className="mv-small">{new Date(entry.occurredAt).toLocaleString()}</td><td>{entry.itemName}</td><td>{Number(entry.quantity)} {entry.unit}</td><td className="mv-small">{entry.lotNumber ?? "—"}</td><td className="mv-small">{entry.actorName}</td></tr>)}
          </Table>
        ) : null}
      </div>
    </Card>
  );
}
