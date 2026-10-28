import { useMemo, useState, type FormEvent } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Tabs, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";

type Tab = "stock" | "catalogue" | "requisitions" | "transfers" | "counts" | "assets" | "reports";

interface AccessSummary { permissions: string[]; roles: string[] }
interface Location { id: string; code: string; name: string; locationType: string; departmentName: string | null; status: string }
interface Unit { unit: string; conversionFactor: number; isBase: boolean; purchasingUnit: boolean; issuingUnit: boolean }
interface Item { id: string; itemCode: string; name: string; category: string; classification: string; baseUnit: string; criticality: string; unitCost: number; currency: string; status: string; lotTracked: boolean; expiryTracked: boolean; units: Unit[] }
interface StockRow { id: string; locationId: string; itemId: string; lotId: string | null; onHand: number; reserved: number; quarantined: number; available: number; inTransit: number; itemCode: string; itemName: string; category: string; baseUnit: string; criticality: string; unitCost: number; currency: string; locationCode: string; locationName: string; locationType: string; lotNumber: string | null; expiresOn: string | null; lotStatus: string | null; expired: boolean }
interface Requisition { id: string; requestNumber: string; status: string; reason: string; version: number; requestedByName: string | null; fulfillingLocationName: string; requestingLocationName: string | null; lineCount: number; issuedQuantity: number; createdAt: string }
interface Transfer { id: string; transferNumber: string; status: string; version: number; sourceLocationName: string; destinationLocationName: string; lineCount: number; dispatchedQuantity: number; receivedQuantity: number; createdAt: string }
interface CountRow { id: string; countNumber: string; status: string; version: number; locationName: string; countedByName: string | null; lineCount: number; varianceLines: number; createdAt: string }
interface Asset { id: string; assetTag: string; name: string; status: string; custodyStatus: string; version: number; locationName: string | null; departmentName: string | null; custodianName: string | null; nextMaintenanceOn: string | null; nextCalibrationOn: string | null; manufacturer: string | null; model: string | null; serialNumber: string | null }

const ORG_ROLES = ["facility_admin", "auditor", "finance", "quality", "it_admin"];
const APPROVER_ROLES = ["facility_admin", "pharmacist", "biomedical"];

function money(value: number, currency = "UGX"): string {
  return new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 0 }).format(Number(value) || 0);
}

function qty(value: number): string {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(Number(value) || 0);
}

function date(value: string | null): string {
  return value ? new Date(`${value}T00:00:00`).toLocaleDateString() : "—";
}

export function InventoryPage() {
  const access = useQuery<AccessSummary>("/access/summary");
  const [tab, setTab] = useState<Tab>("stock");
  const permissions = useMemo(() => new Set(access.data?.permissions ?? []), [access.data]);
  const roles = access.data?.roles ?? [];
  const can = (permission: string) => permissions.has(permission);
  const orgScope = roles.some((role) => ORG_ROLES.includes(role));

  if (access.loading) return <LoadingState label="Loading inventory permissions" variant="page" />;
  if (access.error) return <ErrorState message={access.error} onRetry={access.reload} />;

  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow="Departmental operations"
        title="Inventory and fixed assets"
        description="Stock is a projection of an immutable movement ledger. Quantities are held in each item's base unit, with received and issued units retained for traceability."
      />
      <Tabs label="Inventory sections" value={tab} onChange={setTab} options={[
        { value: "stock", label: "Stock on hand" },
        { value: "catalogue", label: "Catalogue" },
        { value: "requisitions", label: "Requisitions" },
        { value: "transfers", label: "Transfers" },
        { value: "counts", label: "Counts" },
        { value: "assets", label: "Assets" },
        { value: "reports", label: "Reports" },
      ]} />
      {tab === "stock" ? <StockWorkspace enabled={can("inventory.stock.read")} canReceive={can("inventory.stock.receive")} canIssue={can("inventory.stock.issue")} orgScope={orgScope} /> : null}
      {tab === "catalogue" ? <CatalogueWorkspace canManage={can("inventory.catalogue.manage")} /> : null}
      {tab === "requisitions" ? <RequisitionsWorkspace canRead={can("inventory.stock.read")} canApprove={can("inventory.stock.receive") && roles.some((role) => ["facility_admin", "pharmacist"].includes(role))} /> : null}
      {tab === "transfers" ? <TransfersWorkspace canManage={can("inventory.transfer.manage")} canReceive={can("inventory.stock.receive")} /> : null}
      {tab === "counts" ? <CountsWorkspace canManage={can("inventory.count.manage")} canApprove={can("inventory.stock.adjust") && roles.some((role) => APPROVER_ROLES.includes(role))} /> : null}
      {tab === "assets" ? <AssetsWorkspace canRead={can("inventory.asset.read")} canManage={can("inventory.asset.manage")} roles={roles} /> : null}
      {tab === "reports" ? <ReportsWorkspace enabled={can("inventory.report.read")} orgScope={orgScope} /> : null}
    </div>
  );
}

function StockWorkspace({ enabled, canReceive, canIssue, orgScope }: { enabled: boolean; canReceive: boolean; canIssue: boolean; orgScope: boolean }) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState(orgScope ? "all" : "mine");
  const [showEmpty, setShowEmpty] = useState(false);
  const stock = useQuery<{ stock: StockRow[] }>(enabled ? `/inventory/stock?scope=${scope}&includeEmpty=${showEmpty}${query ? `&q=${encodeURIComponent(query)}` : ""}` : null);
  const items = useQuery<{ items: Item[] }>("/inventory/items");
  const locations = useQuery<{ locations: Location[] }>("/inventory/locations");
  const action = useAction();
  const [receipt, setReceipt] = useState({ locationId: "", itemId: "", lotNumber: "", expiresOn: "", quantity: "1", unit: "", reason: "" });
  const selectedItem = items.data?.items.find((item) => item.id === receipt.itemId);

  async function submitReceipt(event: FormEvent) {
    event.preventDefault();
    await action.run("receipt", async () => {
      await api("/inventory/receipts", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: {
          locationId: receipt.locationId,
          itemId: receipt.itemId,
          lotNumber: receipt.lotNumber || undefined,
          expiresOn: receipt.expiresOn || undefined,
          quantity: Number(receipt.quantity),
          unit: receipt.unit || selectedItem?.baseUnit,
          reason: receipt.reason,
        },
      });
      stock.reload();
      setReceipt((current) => ({ ...current, quantity: "1", reason: "" }));
      return "Stock receipt posted to the ledger.";
    });
  }

  if (!enabled) return <EmptyState title="Stock access not enabled" description="Your role does not include inventory stock read access." />;
  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <div className="mv-grid mv-grid--2">
        <Card title="Stock on hand" description="Available excludes reservations and quarantined quantities.">
          <div className="mv-form-grid">
            <Field label="Search"><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Item, code or lot" /></Field>
            <Field label="Scope"><Select value={scope} onChange={(event) => setScope(event.target.value)}><option value="mine">My departments and central store</option>{orgScope ? <option value="all">Organisation-wide</option> : null}</Select></Field>
          </div>
          <label className="mv-small"><input type="checkbox" checked={showEmpty} onChange={(event) => setShowEmpty(event.target.checked)} /> Include zero balances</label>
        </Card>
        {canReceive ? (
          <Card title="Receive stock" description="Posts an idempotent receipt. Lot and expiry are required when tracked.">
            <form className="mv-stack" onSubmit={submitReceipt}>
              <div className="mv-form-grid">
                <Field label="Item"><Select value={receipt.itemId} onChange={(event) => setReceipt({ ...receipt, itemId: event.target.value, unit: items.data?.items.find((item) => item.id === event.target.value)?.baseUnit ?? "", lotNumber: "", expiresOn: "" })} required><option value="">Select item</option>{items.data?.items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>
                <Field label="Location"><Select value={receipt.locationId} onChange={(event) => setReceipt({ ...receipt, locationId: event.target.value })} required><option value="">Select location</option>{locations.data?.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</Select></Field>
                {selectedItem?.lotTracked ? <Field label="Lot number"><Input value={receipt.lotNumber} onChange={(event) => setReceipt({ ...receipt, lotNumber: event.target.value })} required /></Field> : null}
                {selectedItem?.expiryTracked ? <Field label="Expires on"><Input type="date" value={receipt.expiresOn} onChange={(event) => setReceipt({ ...receipt, expiresOn: event.target.value })} required /></Field> : null}
                <Field label="Quantity"><Input type="number" min="0.0001" step="0.0001" value={receipt.quantity} onChange={(event) => setReceipt({ ...receipt, quantity: event.target.value })} required /></Field>
                <Field label="Unit"><Select value={receipt.unit} onChange={(event) => setReceipt({ ...receipt, unit: event.target.value })} required>{selectedItem?.units.map((unit) => <option key={unit.unit} value={unit.unit}>{unit.unit}</option>)}</Select></Field>
              </div>
              <Field label="Reason"><Textarea value={receipt.reason} onChange={(event) => setReceipt({ ...receipt, reason: event.target.value })} required minLength={5} /></Field>
              <Button type="submit" disabled={action.busy !== null || !receipt.itemId || !receipt.locationId || receipt.reason.trim().length < 5}>{action.busy === "receipt" ? "Posting…" : "Post receipt"}</Button>
            </form>
          </Card>
        ) : null}
      </div>
      {stock.loading ? <LoadingState /> : stock.error ? <ErrorState message={stock.error} onRetry={stock.reload} /> : !stock.data?.stock.length ? <EmptyState title="No stock balances" description="Receive stock into a central or departmental store to begin." /> : (
        <Card title={`Balances (${stock.data.stock.length})`} description={canIssue ? "Issues must come from a department store; use the API or requisition workflow for controlled replenishment." : "Read-only view for your role."}>
          <Table head={["Item", "Location", "Lot", "On hand", "Reserved", "Available", "Value"]}>
            {stock.data.stock.map((row) => (
              <tr key={row.id}>
                <td><strong>{row.itemName}</strong><div className="mv-small mv-muted"><span className="mv-id">{row.itemCode}</span> · {row.category}</div></td>
                <td>{row.locationName}<div className="mv-small mv-muted">{row.locationType}</div></td>
                <td>{row.lotNumber || "—"}{row.expiresOn ? <div className={`mv-small ${row.expired ? "mv-danger" : "mv-muted"}`}>Expires {date(row.expiresOn)}</div> : null}</td>
                <td>{qty(row.onHand)} {row.baseUnit}</td>
                <td>{qty(row.reserved)}</td>
                <td><Badge tone={row.available > 0 ? "success" : "warning"}>{qty(row.available)}</Badge></td>
                <td>{money(row.onHand * row.unitCost, row.currency)}</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </div>
  );
}

function CatalogueWorkspace({ canManage }: { canManage: boolean }) {
  const items = useQuery<{ items: Item[] }>("/inventory/items");
  const action = useAction();
  const [form, setForm] = useState({ itemCode: "", name: "", category: "", classification: "consumable", baseUnit: "piece", criticality: "standard", unitCost: "0", currency: "UGX", lotTracked: false, expiryTracked: false });
  async function createItem(event: FormEvent) {
    event.preventDefault();
    await action.run("item", async () => {
      await api("/inventory/items", {
        method: "POST",
        body: {
          itemCode: form.itemCode, name: form.name, category: form.category, classification: form.classification,
          baseUnit: form.baseUnit, criticality: form.criticality, unitCost: Number(form.unitCost), currency: form.currency,
          lotTracked: form.lotTracked, expiryTracked: form.expiryTracked,
          units: [{ unit: form.baseUnit, conversionFactor: 1, isBase: true, purchasingUnit: false, issuingUnit: true }],
        },
      });
      items.reload();
      setForm({ ...form, itemCode: "", name: "", category: "" });
      return "Catalogue item created.";
    });
  }
  if (items.loading) return <LoadingState />;
  if (items.error) return <ErrorState message={items.error} onRetry={items.reload} />;
  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      {canManage ? (
        <Card title="Add catalogue item" description="Items are never hard-deleted; discontinuation preserves ledger history.">
          <form className="mv-stack" onSubmit={createItem}>
            <div className="mv-form-grid">
              <Field label="Item code"><Input value={form.itemCode} onChange={(event) => setForm({ ...form, itemCode: event.target.value })} required /></Field>
              <Field label="Name"><Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></Field>
              <Field label="Category"><Input value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} required /></Field>
              <Field label="Classification"><Select value={form.classification} onChange={(event) => setForm({ ...form, classification: event.target.value })}><option value="consumable">Consumable</option><option value="reusable">Reusable</option><option value="returnable">Returnable</option><option value="asset">Asset</option></Select></Field>
              <Field label="Base unit"><Input value={form.baseUnit} onChange={(event) => setForm({ ...form, baseUnit: event.target.value })} required /></Field>
              <Field label="Criticality"><Select value={form.criticality} onChange={(event) => setForm({ ...form, criticality: event.target.value })}><option value="standard">Standard</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></Select></Field>
              <Field label="Unit cost"><Input type="number" min="0" step="0.01" value={form.unitCost} onChange={(event) => setForm({ ...form, unitCost: event.target.value })} /></Field>
              <Field label="Currency"><Input value={form.currency} maxLength={3} onChange={(event) => setForm({ ...form, currency: event.target.value.toUpperCase() })} /></Field>
            </div>
            <div className="mv-row">
              <label><input type="checkbox" checked={form.lotTracked} onChange={(event) => setForm({ ...form, lotTracked: event.target.checked })} /> Lot tracked</label>
              <label><input type="checkbox" checked={form.expiryTracked} onChange={(event) => setForm({ ...form, expiryTracked: event.target.checked })} /> Expiry tracked</label>
            </div>
            <Button type="submit" disabled={action.busy !== null || !form.itemCode || !form.name || !form.category}>{action.busy === "item" ? "Saving…" : "Create item"}</Button>
          </form>
        </Card>
      ) : null}
      {!items.data?.items.length ? <EmptyState title="No catalogue items" description="Create the first item to begin stock control." /> : (
        <Card title={`Catalogue (${items.data.items.length})`} description="Unit conversion factors are retained on every movement.">
          <Table head={["Item", "Category", "Type", "Units", "Cost", "Status"]}>
            {items.data.items.map((item) => (
              <tr key={item.id}>
                <td><strong>{item.name}</strong><div className="mv-small mv-muted"><span className="mv-id">{item.itemCode}</span></div></td>
                <td>{item.category}</td>
                <td>{item.classification}{item.lotTracked ? <Badge tone="info">lot</Badge> : null}</td>
                <td>{item.units.map((unit) => `${unit.unit}${unit.isBase ? " (base)" : ` ×${unit.conversionFactor}`}`).join(", ")}</td>
                <td>{money(item.unitCost, item.currency)}</td>
                <td><Badge tone={item.status === "active" ? "success" : "neutral"}>{item.status}</Badge></td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </div>
  );
}

function RequisitionsWorkspace({ canRead, canApprove }: { canRead: boolean; canApprove: boolean }) {
  const list = useQuery<{ requisitions: Requisition[] }>(canRead ? "/inventory/requisitions" : null);
  const items = useQuery<{ items: Item[] }>("/inventory/items");
  const locations = useQuery<{ locations: Location[] }>("/inventory/locations");
  const action = useAction();
  const [form, setForm] = useState({ fulfillingLocationId: "", requestingLocationId: "", itemId: "", quantity: "1", unit: "", reason: "" });

  async function create(event: FormEvent) {
    event.preventDefault();
    await action.run("create", async () => {
      await api("/inventory/requisitions", {
        method: "POST",
        body: {
          fulfillingLocationId: form.fulfillingLocationId,
          requestingLocationId: form.requestingLocationId || undefined,
          reason: form.reason,
          lines: [{ itemId: form.itemId, quantity: Number(form.quantity), unit: form.unit }],
        },
      });
      list.reload();
      return "Requisition created as a draft.";
    });
  }
  async function decide(row: Requisition, decision: "approve" | "reject") {
    await action.run(`${decision}-${row.id}`, async () => {
      await api(`/inventory/requisitions/${row.id}/decision`, {
        method: "POST",
        body: { decision, reason: decision === "approve" ? "Approved after stock and budget review" : "Rejected after stock review", expectedVersion: row.version },
      });
      list.reload();
      return `Requisition ${row.requestNumber} ${decision === "approve" ? "approved" : "rejected"}.`;
    });
  }
  if (!canRead) return <EmptyState title="Requisitions not enabled" description="Stock read access is required." />;
  if (list.loading) return <LoadingState />;
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />;
  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title="Request stock" description="Requests follow submit, independent approval and issue. Requester and approver must differ.">
        <form className="mv-stack" onSubmit={create}>
          <div className="mv-form-grid">
            <Field label="Fulfilling store"><Select value={form.fulfillingLocationId} onChange={(event) => setForm({ ...form, fulfillingLocationId: event.target.value })} required><option value="">Select store</option>{locations.data?.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</Select></Field>
            <Field label="Deliver to"><Select value={form.requestingLocationId} onChange={(event) => setForm({ ...form, requestingLocationId: event.target.value })}><option value="">Issue without destination</option>{locations.data?.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</Select></Field>
            <Field label="Item"><Select value={form.itemId} onChange={(event) => setForm({ ...form, itemId: event.target.value, unit: items.data?.items.find((item) => item.id === event.target.value)?.baseUnit ?? "" })} required><option value="">Select item</option>{items.data?.items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>
            <Field label="Quantity"><Input type="number" min="0.0001" step="0.0001" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} required /></Field>
            <Field label="Unit"><Select value={form.unit} onChange={(event) => setForm({ ...form, unit: event.target.value })} required>{items.data?.items.find((item) => item.id === form.itemId)?.units.map((unit) => <option key={unit.unit} value={unit.unit}>{unit.unit}</option>)}</Select></Field>
          </div>
          <Field label="Reason"><Textarea value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} required minLength={5} /></Field>
          <Button type="submit" disabled={action.busy !== null || !form.fulfillingLocationId || !form.itemId || form.reason.trim().length < 5}>{action.busy === "create" ? "Creating…" : "Create draft"}</Button>
        </form>
      </Card>
      <Card title="Requisitions" description="Rejected and issued requests remain visible for audit.">
        <Table head={["Number", "Status", "From", "To", "Lines", "Issued", "Actions"]}>
          {list.data?.requisitions.map((row) => (
            <tr key={row.id}>
              <td><span className="mv-id">{row.requestNumber}</span><div className="mv-small mv-muted">{row.requestedByName ?? "—"}</div></td>
              <td><Badge tone={row.status === "issued" ? "success" : row.status === "rejected" ? "danger" : row.status === "submitted" ? "warning" : "info"}>{row.status}</Badge></td>
              <td>{row.fulfillingLocationName}</td>
              <td>{row.requestingLocationName ?? "—"}</td>
              <td>{row.lineCount}</td>
              <td>{qty(row.issuedQuantity)}</td>
              <td>{canApprove && row.status === "submitted" ? <div className="mv-row"><Button size="sm" variant="secondary" disabled={action.busy !== null} onClick={() => void decide(row, "approve")}>Approve</Button><Button size="sm" variant="ghost" disabled={action.busy !== null} onClick={() => void decide(row, "reject")}>Reject</Button></div> : "—"}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

function TransfersWorkspace({ canManage, canReceive }: { canManage: boolean; canReceive: boolean }) {
  const list = useQuery<{ transfers: Transfer[] }>("/inventory/transfers");
  const items = useQuery<{ items: Item[] }>("/inventory/items");
  const locations = useQuery<{ locations: Location[] }>("/inventory/locations");
  const action = useAction();
  const [form, setForm] = useState({ sourceLocationId: "", destinationLocationId: "", itemId: "", quantity: "1", unit: "" });

  async function create(event: FormEvent) {
    event.preventDefault();
    await action.run("create", async () => {
      await api("/inventory/transfers", {
        method: "POST",
        body: { sourceLocationId: form.sourceLocationId, destinationLocationId: form.destinationLocationId, lines: [{ itemId: form.itemId, quantity: Number(form.quantity), unit: form.unit }] },
      });
      list.reload();
      return "Transfer created as a draft.";
    });
  }
  async function dispatch(row: Transfer) {
    await action.run(`dispatch-${row.id}`, async () => {
      await api(`/inventory/transfers/${row.id}/dispatch`, { method: "POST", body: { expectedVersion: row.version } });
      list.reload();
      return `Transfer ${row.transferNumber} dispatched and moved to in-transit.`;
    });
  }
  async function receive(row: Transfer) {
    await action.run(`receive-${row.id}`, async () => {
      const detail = await api<{ transfer: { version: number }; lines: Array<{ id: string; dispatchedQuantity: number; receivedQuantity: number; rejectedQuantity: number }> }>(`/inventory/transfers/${row.id}`);
      const lines = detail.lines
        .map((line) => ({ lineId: line.id, receivedQuantity: line.dispatchedQuantity - line.receivedQuantity - line.rejectedQuantity, rejectedQuantity: 0 }))
        .filter((line) => line.receivedQuantity > 0);
      await api(`/inventory/transfers/${row.id}/receive`, { method: "POST", body: { lines, expectedVersion: detail.transfer.version } });
      list.reload();
      return `Transfer ${row.transferNumber} received.`;
    });
  }
  if (list.loading) return <LoadingState />;
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />;
  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      {canManage ? (
        <Card title="Create an internal transfer" description="Dispatch removes stock from the source and records it as in transit until receipt.">
          <form className="mv-stack" onSubmit={create}>
            <div className="mv-form-grid">
              <Field label="Source"><Select value={form.sourceLocationId} onChange={(event) => setForm({ ...form, sourceLocationId: event.target.value })} required><option value="">Select source</option>{locations.data?.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</Select></Field>
              <Field label="Destination"><Select value={form.destinationLocationId} onChange={(event) => setForm({ ...form, destinationLocationId: event.target.value })} required><option value="">Select destination</option>{locations.data?.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</Select></Field>
              <Field label="Item"><Select value={form.itemId} onChange={(event) => setForm({ ...form, itemId: event.target.value, unit: items.data?.items.find((item) => item.id === event.target.value)?.baseUnit ?? "" })} required><option value="">Select item</option>{items.data?.items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>
              <Field label="Quantity"><Input type="number" min="0.0001" step="0.0001" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} required /></Field>
              <Field label="Unit"><Select value={form.unit} onChange={(event) => setForm({ ...form, unit: event.target.value })} required>{items.data?.items.find((item) => item.id === form.itemId)?.units.map((unit) => <option key={unit.unit} value={unit.unit}>{unit.unit}</option>)}</Select></Field>
            </div>
            <Button type="submit" disabled={action.busy !== null || !form.sourceLocationId || !form.destinationLocationId || !form.itemId}>{action.busy === "create" ? "Creating…" : "Create transfer"}</Button>
          </form>
        </Card>
      ) : null}
      <Card title="Transfers" description="Receivers must differ from dispatchers; discrepancies are retained.">
        <Table head={["Number", "Status", "From", "To", "Dispatched", "Received", "Actions"]}>
          {list.data?.transfers.map((row) => (
            <tr key={row.id}>
              <td><span className="mv-id">{row.transferNumber}</span></td>
              <td><Badge tone={row.status === "received" ? "success" : row.status === "in-transit" ? "warning" : "neutral"}>{row.status}</Badge></td>
              <td>{row.sourceLocationName}</td>
              <td>{row.destinationLocationName}</td>
              <td>{qty(row.dispatchedQuantity)}</td>
              <td>{qty(row.receivedQuantity)}</td>
              <td>
                {canManage && row.status === "draft" ? <Button size="sm" variant="secondary" disabled={action.busy !== null} onClick={() => void dispatch(row)}>Dispatch</Button> : null}
                {canReceive && ["in-transit", "partially-received"].includes(row.status) ? <Button size="sm" variant="secondary" disabled={action.busy !== null} onClick={() => void receive(row)}>Receive all</Button> : null}
                {row.status === "draft" && !canManage ? "—" : null}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

function CountsWorkspace({ canManage, canApprove }: { canManage: boolean; canApprove: boolean }) {
  const list = useQuery<{ counts: CountRow[] }>("/inventory/counts");
  const items = useQuery<{ items: Item[] }>("/inventory/items");
  const locations = useQuery<{ locations: Location[] }>("/inventory/locations");
  const action = useAction();
  const [form, setForm] = useState({ locationId: "", itemId: "", countedQuantity: "0", reasonCode: "miscount" });

  async function create(event: FormEvent) {
    event.preventDefault();
    await action.run("create", async () => {
      await api("/inventory/counts", {
        method: "POST",
        body: { locationId: form.locationId, blind: true, note: "Cycle count from inventory workspace", lines: [{ itemId: form.itemId, countedQuantity: Number(form.countedQuantity), reasonCode: form.reasonCode }] },
      });
      list.reload();
      return "Count submitted for independent review.";
    });
  }
  async function post(row: CountRow) {
    await action.run(`post-${row.id}`, async () => {
      await api(`/inventory/counts/${row.id}/decision`, { method: "POST", body: { decision: "approve", reason: "Count evidence reviewed and accepted", expectedVersion: row.version } });
      list.reload();
      return `Count ${row.countNumber} posted with variance adjustments.`;
    });
  }
  if (list.loading) return <LoadingState />;
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />;
  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      {canManage ? (
        <Card title="Submit a blind count" description="The system snapshot is hidden and preserved. Posting adjusts balances without overwriting history.">
          <form className="mv-stack" onSubmit={create}>
            <div className="mv-form-grid">
              <Field label="Location"><Select value={form.locationId} onChange={(event) => setForm({ ...form, locationId: event.target.value })} required><option value="">Select location</option>{locations.data?.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</Select></Field>
              <Field label="Item"><Select value={form.itemId} onChange={(event) => setForm({ ...form, itemId: event.target.value })} required><option value="">Select item</option>{items.data?.items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>
              <Field label="Counted quantity"><Input type="number" min="0" step="0.0001" value={form.countedQuantity} onChange={(event) => setForm({ ...form, countedQuantity: event.target.value })} required /></Field>
              <Field label="Variance reason"><Select value={form.reasonCode} onChange={(event) => setForm({ ...form, reasonCode: event.target.value })}><option value="miscount">Miscount</option><option value="breakage">Breakage</option><option value="expiry">Expiry</option><option value="loss">Loss</option><option value="other">Other</option></Select></Field>
            </div>
            <Button type="submit" disabled={action.busy !== null || !form.locationId || !form.itemId}>{action.busy === "create" ? "Submitting…" : "Submit count"}</Button>
          </form>
        </Card>
      ) : null}
      <Card title="Stock counts" description="Counters cannot approve their own count.">
        <Table head={["Number", "Location", "Status", "Lines", "Variances", "Counted by", "Actions"]}>
          {list.data?.counts.map((row) => (
            <tr key={row.id}>
              <td><span className="mv-id">{row.countNumber}</span></td>
              <td>{row.locationName}</td>
              <td><Badge tone={row.status === "posted" ? "success" : row.status === "rejected" ? "danger" : "warning"}>{row.status}</Badge></td>
              <td>{row.lineCount}</td>
              <td>{row.varianceLines}</td>
              <td>{row.countedByName ?? "—"}</td>
              <td>{canApprove && row.status === "submitted" ? <Button size="sm" variant="secondary" disabled={action.busy !== null} onClick={() => void post(row)}>Post count</Button> : "—"}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

function AssetsWorkspace({ canRead, canManage, roles }: { canRead: boolean; canManage: boolean; roles: string[] }) {
  const list = useQuery<{ assets: Asset[] }>(canRead ? "/inventory/assets" : null);
  const locations = useQuery<{ locations: Location[] }>("/inventory/locations");
  const action = useAction();
  const technical = roles.some((role) => ["facility_admin", "biomedical"].includes(role));
  const [form, setForm] = useState({ assetTag: "", name: "", locationId: "", manufacturer: "", model: "", serialNumber: "", nextMaintenanceOn: "" });

  async function create(event: FormEvent) {
    event.preventDefault();
    await action.run("asset", async () => {
      await api("/inventory/assets", {
        method: "POST",
        body: { assetTag: form.assetTag, name: form.name, locationId: form.locationId || undefined, manufacturer: form.manufacturer, model: form.model, serialNumber: form.serialNumber, nextMaintenanceOn: form.nextMaintenanceOn || undefined },
      });
      list.reload();
      return "Fixed asset registered.";
    });
  }
  async function event(row: Asset, eventType: "commission" | "fault" | "service-release") {
    await action.run(`${eventType}-${row.id}`, async () => {
      const body = eventType === "commission"
        ? { eventType, note: "Commissioned after incoming inspection", toStatus: "in-service", toCustody: "in-use", expectedVersion: row.version }
        : eventType === "fault"
          ? { eventType, note: "Fault reported from asset workspace", toStatus: "out-of-service", toCustody: "maintenance", expectedVersion: row.version }
          : { eventType, note: "Service release verified by biomedical engineering", toStatus: "in-service", toCustody: "in-use", expectedVersion: row.version };
      await api(`/inventory/assets/${row.id}/events`, { method: "POST", body });
      list.reload();
      return `Asset ${row.assetTag} updated.`;
    });
  }
  if (!canRead) return <EmptyState title="Asset register not enabled" description="Asset read access is required." />;
  if (list.loading) return <LoadingState />;
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />;
  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      {canManage && technical ? (
        <Card title="Register a fixed asset" description="Custody and service history are append-only.">
          <form className="mv-stack" onSubmit={create}>
            <div className="mv-form-grid">
              <Field label="Asset tag"><Input value={form.assetTag} onChange={(event) => setForm({ ...form, assetTag: event.target.value })} required /></Field>
              <Field label="Name"><Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></Field>
              <Field label="Location"><Select value={form.locationId} onChange={(event) => setForm({ ...form, locationId: event.target.value })}><option value="">Unassigned</option>{locations.data?.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</Select></Field>
              <Field label="Manufacturer"><Input value={form.manufacturer} onChange={(event) => setForm({ ...form, manufacturer: event.target.value })} /></Field>
              <Field label="Model"><Input value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} /></Field>
              <Field label="Serial number"><Input value={form.serialNumber} onChange={(event) => setForm({ ...form, serialNumber: event.target.value })} /></Field>
              <Field label="Next maintenance"><Input type="date" value={form.nextMaintenanceOn} onChange={(event) => setForm({ ...form, nextMaintenanceOn: event.target.value })} /></Field>
            </div>
            <Button type="submit" disabled={action.busy !== null || !form.assetTag || !form.name}>{action.busy === "asset" ? "Saving…" : "Register asset"}</Button>
          </form>
        </Card>
      ) : null}
      <Card title="Fixed assets" description="Service release requires biomedical or facility-administration authority.">
        <Table head={["Asset", "Status", "Custody", "Location", "Maintenance", "Actions"]}>
          {list.data?.assets.map((row) => (
            <tr key={row.id}>
              <td><strong>{row.name}</strong><div className="mv-small mv-muted"><span className="mv-id">{row.assetTag}</span> · {[row.manufacturer, row.model].filter(Boolean).join(" ")}</div></td>
              <td><Badge tone={row.status === "in-service" ? "success" : row.status === "out-of-service" ? "danger" : "warning"}>{row.status}</Badge></td>
              <td>{row.custodyStatus}</td>
              <td>{row.locationName ?? "Unassigned"}</td>
              <td>{row.nextMaintenanceOn ? date(row.nextMaintenanceOn) : "—"}</td>
              <td>
                {canManage && technical && row.status === "pending-commissioning" ? <Button size="sm" variant="secondary" disabled={action.busy !== null} onClick={() => void event(row, "commission")}>Commission</Button> : null}
                {canManage && technical && row.status === "in-service" ? <Button size="sm" variant="ghost" disabled={action.busy !== null} onClick={() => void event(row, "fault")}>Report fault</Button> : null}
                {canManage && technical && ["under-maintenance", "out-of-service"].includes(row.status) ? <Button size="sm" variant="secondary" disabled={action.busy !== null} onClick={() => void event(row, "service-release")}>Service release</Button> : null}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

function ReportsWorkspace({ enabled, orgScope }: { enabled: boolean; orgScope: boolean }) {
  const [scope, setScope] = useState(orgScope ? "all" : "mine");
  const lowStock = useQuery<{ report: Array<{ itemCode: string; itemName: string; locationName: string; available: number; minimumQuantity: number; criticality: string; alert: string }> }>(enabled ? `/inventory/reports/low-stock?scope=${scope}` : null);
  const expiry = useQuery<{ report: Array<{ itemCode: string; itemName: string; lotNumber: string; expiresOn: string; available: number; expiryBand: string; locationName: string | null }> }>(enabled ? `/inventory/reports/expiry?scope=${scope}` : null);
  const maintenance = useQuery<{ report: Array<{ assetTag: string; name: string; nextMaintenanceOn: string | null; nextCalibrationOn: string | null; status: string }> }>(enabled ? `/inventory/reports/maintenance-due?scope=${scope}` : null);
  if (!enabled) return <EmptyState title="Reports not enabled" description="Reporting permission is required." />;
  return (
    <div className="mv-stack">
      <Card title="Reporting scope" description="Organisation-wide reports require explicit scope and reporting permission.">
        <Field label="Scope"><Select value={scope} onChange={(event) => setScope(event.target.value)}><option value="mine">My departments and central store</option>{orgScope ? <option value="all">Organisation-wide</option> : null}</Select></Field>
      </Card>
      <div className="mv-grid mv-grid--2">
        <Card title="Low stock" description="Policies compare available quantity against local minimums.">
          {lowStock.loading ? <LoadingState /> : lowStock.error ? <ErrorState message={lowStock.error} onRetry={lowStock.reload} /> : !lowStock.data?.report.length ? <EmptyState title="No low-stock alerts" description="All policies are above their configured threshold." /> : (
            <Table head={["Item", "Location", "Available", "Minimum", "Alert"]}>{lowStock.data.report.map((row) => <tr key={`${row.itemCode}-${row.locationName}`}><td>{row.itemName}</td><td>{row.locationName}</td><td>{qty(row.available)}</td><td>{qty(row.minimumQuantity)}</td><td><Badge tone={row.alert === "stock-out" ? "danger" : "warning"}>{row.alert}</Badge></td></tr>)}</Table>
          )}
        </Card>
        <Card title="Expiry watch" description="Lots with remaining stock inside the expiry horizon.">
          {expiry.loading ? <LoadingState /> : expiry.error ? <ErrorState message={expiry.error} onRetry={expiry.reload} /> : !expiry.data?.report.length ? <EmptyState title="No expiry alerts" description="No tracked lots are nearing expiry." /> : (
            <Table head={["Item", "Lot", "Expires", "Available"]}>{expiry.data.report.map((row) => <tr key={`${row.lotNumber}-${row.expiresOn}`}><td>{row.itemName}</td><td>{row.lotNumber}</td><td>{date(row.expiresOn)}</td><td><Badge tone={row.expiryBand === "expired" ? "danger" : "warning"}>{qty(row.available)}</Badge></td></tr>)}</Table>
          )}
        </Card>
      </div>
      <Card title="Maintenance and calibration due" description="Assets due within 30 days, including overdue equipment.">
        {maintenance.loading ? <LoadingState /> : maintenance.error ? <ErrorState message={maintenance.error} onRetry={maintenance.reload} /> : !maintenance.data?.report.length ? <EmptyState title="No maintenance due" description="No asset is due in the next 30 days." /> : (
          <Table head={["Asset", "Status", "Maintenance", "Calibration"]}>{maintenance.data.report.map((row) => <tr key={row.assetTag}><td><strong>{row.name}</strong><div className="mv-small mv-muted">{row.assetTag}</div></td><td>{row.status}</td><td>{date(row.nextMaintenanceOn)}</td><td>{date(row.nextCalibrationOn)}</td></tr>)}</Table>
        )}
      </Card>
      <Card title="Export" description="CSV exports are recorded in the export audit trail.">
        <div className="mv-row">
          <a className="mv-button mv-button--secondary mv-button--sm" href={`/api/v1/inventory/reports/stock-on-hand?scope=${scope}&format=csv`}>Stock on hand CSV</a>
          <a className="mv-button mv-button--secondary mv-button--sm" href={`/api/v1/inventory/reports/valuation?scope=${scope}&format=csv`}>Valuation CSV</a>
          <a className="mv-button mv-button--secondary mv-button--sm" href={`/api/v1/inventory/reports/count-variance?scope=${scope}&format=csv`}>Count variance CSV</a>
        </div>
      </Card>
    </div>
  );
}
