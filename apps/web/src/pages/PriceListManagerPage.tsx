import { useState, type FormEvent } from "react";
import {
  PRICE_LIST_STATUS_LABELS,
  PRICE_LIST_STATUSES,
  type PriceListAction,
  type PriceListStatus,
} from "@medveris/domain";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { formatDate, formatDateTime, formatMoney, todayInput } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";
import { MedicineDropdown, type MedicineSelection } from "../components/medicine-dropdown/MedicineDropdown";

interface PriceListRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  approvedAt: string | null;
  active: boolean;
  itemCount: number;
  currency: string | null;
  updatedAt: string | null;
  createdAt: string;
}

interface PriceListDetail {
  list: PriceListRow;
  items: Array<{
    id: string;
    masterPriceCode: string | null;
    name: string;
    description: string | null;
    category: string;
    unitType: string;
    isService: boolean;
    price: string | number;
    currency: string;
    isActive: boolean;
    approvalStatus: string;
    approvedAt: string | null;
    effectiveFrom: string;
    effectiveTo: string | null;
  }>;
  availableActions: PriceListAction[];
  editable: boolean;
}

interface HistoryResponse {
  prices: Array<{
    id: string; changeType: string; previousPrice: string | number | null; newPrice: string | number;
    changedAt: string; reason: string | null; approvalStatusBefore: string | null; approvalStatusAfter: string | null;
    name: string; currency: string;
  }>;
  events: Array<{ id: string; action: string; occurredAt: string; metadata: Record<string, unknown> | null }>;
}

const ACTION_LABELS: Record<PriceListAction, string> = {
  validate: "Validate",
  submit: "Submit for approval",
  approve: "Approve",
  reject: "Send back to draft",
  publish: "Publish",
  expire: "Expire",
  archive: "Archive",
};

const ACTION_CONFIRMATION: Partial<Record<PriceListAction, string>> = {
  publish: "Publishing makes these prices live for this facility. Continue?",
  approve: "Approve this price list? A second check runs before publishing.",
  archive: "Archive this price list? It can no longer be edited.",
  expire: "Expire this price list now?",
};

function statusTone(status: string): "neutral" | "success" | "warning" | "danger" | "info" {
  switch (status) {
    case "PUBLISHED": return "success";
    case "APPROVED": return "info";
    case "PENDING_APPROVAL": return "warning";
    case "DRAFT": return "neutral";
    case "VALIDATED": return "info";
    case "EXPIRED": return "warning";
    default: return "neutral";
  }
}

function statusLabel(status: string): string {
  const key = status.toUpperCase() as PriceListStatus;
  return PRICE_LIST_STATUS_LABELS[key] ?? status;
}

/**
 * A facility's own price list, with the controlled lifecycle
 * DRAFT → VALIDATED → PENDING_APPROVAL → APPROVED → PUBLISHED → EXPIRED / ARCHIVED.
 *
 * Publishing never rewrites a historical bill, and no step converts one currency into another.
 */
export function PriceListManagerPage() {
  const lists = useQuery<{ lists: PriceListRow[]; canManage: boolean }>("/global-catalogue/lists");
  const [selected, setSelected] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | PriceListStatus>("all");
  const action = useAction();

  const rows = (lists.data?.lists ?? []).filter((row) => statusFilter === "all" || row.status.toUpperCase() === statusFilter);

  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow="Billing"
        title="Price lists"
        description="Draft, validate, approve and publish this facility's prices. Each step is recorded; publishing is a deliberate, separate action."
      />
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Notice tone="info" title="One currency per list">
        A price list uses a single currency. Prices in another currency need their own approved list — they are never converted at a fixed rate.
      </Notice>

      {lists.data?.canManage ? (
        <CreateListForm onSaved={(id, message) => { action.setMessage(message); lists.reload(); setSelected(id); }} />
      ) : null}

      <Card
        title="Price lists"
        actions={
          <Select aria-label="Filter by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
            <option value="all">All statuses</option>
            {PRICE_LIST_STATUSES.map((status) => <option key={status} value={status}>{PRICE_LIST_STATUS_LABELS[status]}</option>)}
          </Select>
        }
      >
        {lists.loading && !lists.data ? <LoadingState /> : lists.error ? <ErrorState message={lists.error} onRetry={lists.reload} /> : !rows.length ? (
          <EmptyState
            title={lists.data?.lists.length ? "No lists match" : "No price lists yet"}
            description={lists.data?.lists.length ? "Change the status filter." : "Create a draft, add catalogue items, then validate and submit it for approval."}
          />
        ) : (
          <Table head={["List", "Status", "Items", "Effective", "Updated", ""]} caption="Price lists">
            {rows.map((row) => (
              <tr key={row.id}>
                <td><strong>{row.name}</strong><div className="mv-small mv-muted mv-id">{row.code}</div>{row.description ? <div className="mv-small mv-muted">{row.description}</div> : null}</td>
                <td><Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>{row.approvedAt ? <div className="mv-small mv-muted">approved {formatDate(row.approvedAt)}</div> : null}</td>
                <td className="mv-small">{row.itemCount}{row.currency ? <div className="mv-muted">{row.currency}</div> : null}</td>
                <td className="mv-small">{formatDate(row.effectiveFrom)}<div className="mv-muted">to {row.effectiveTo ? formatDate(row.effectiveTo) : "open"}</div></td>
                <td className="mv-small">{row.updatedAt ? formatDateTime(row.updatedAt) : formatDateTime(row.createdAt)}</td>
                <td><Button size="sm" variant={selected === row.id ? "secondary" : "ghost"} onClick={() => setSelected(selected === row.id ? null : row.id)}>{selected === row.id ? "Close" : "Open"}</Button></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {selected ? (
        <ListDetail
          key={selected}
          id={selected}
          canManage={lists.data?.canManage ?? false}
          onChanged={(message) => { action.setMessage(message); lists.reload(); }}
        />
      ) : null}
    </div>
  );
}

function CreateListForm({ onSaved }: { onSaved: (id: string, message: string) => void }) {
  const action = useAction();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(todayInput());
  const [effectiveTo, setEffectiveTo] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run("create", async () => {
      const result = await api<{ list: { id: string } }>("/global-catalogue/lists", {
        method: "POST",
        body: { code: code.trim(), name: name.trim(), description: description.trim() || null, effectiveFrom, effectiveTo: effectiveTo || null },
      });
      onSaved(result.list.id, `${name} was created as a draft.`);
      setCode("");
      setName("");
      setDescription("");
      return "Draft created.";
    });
  }

  return (
    <Card title="Create a price list" description="A new list starts as a draft and is invisible to billing until it is published.">
      {action.error ? <ErrorState message={action.error} /> : null}
      <form className="mv-stack" onSubmit={submit}>
        <div className="mv-form-grid">
          <Field label="Code" htmlFor="list-code"><Input id="list-code" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} required minLength={2} maxLength={50} placeholder="e.g. UGX-OPD-2027" /></Field>
          <Field label="Name" htmlFor="list-name"><Input id="list-name" value={name} onChange={(event) => setName(event.target.value)} required minLength={2} /></Field>
          <Field label="Effective from" htmlFor="list-from"><Input id="list-from" type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} required /></Field>
          <Field label="Effective to" htmlFor="list-to"><Input id="list-to" type="date" value={effectiveTo} onChange={(event) => setEffectiveTo(event.target.value)} /></Field>
        </div>
        <Field label="Description" htmlFor="list-description"><Textarea id="list-description" rows={2} value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
        <Button type="submit" disabled={action.busy !== null || !code || !name}>{action.busy === "create" ? "Creating…" : "Create draft"}</Button>
      </form>
    </Card>
  );
}

function ListDetail({ id, canManage, onChanged }: { id: string; canManage: boolean; onChanged: (message: string) => void }) {
  const detail = useQuery<PriceListDetail>(`/global-catalogue/lists/${id}`);
  const action = useAction();
  const [showHistory, setShowHistory] = useState(false);
  const history = useQuery<HistoryResponse>(showHistory ? `/global-catalogue/lists/${id}/history` : null);
  const [selection, setSelection] = useState<MedicineSelection | null>(null);
  const [price, setPrice] = useState("");
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [itemPrice, setItemPrice] = useState("");
  const [header, setHeader] = useState<{ name: string; effectiveFrom: string; effectiveTo: string; description: string } | null>(null);

  const list = detail.data?.list;
  const editable = detail.data?.editable ?? false;
  const items = (detail.data?.items ?? []).filter((item) => item.isActive);

  function headerValues() {
    if (header && list) return header;
    return list ? { name: list.name, effectiveFrom: list.effectiveFrom, effectiveTo: list.effectiveTo ?? "", description: list.description ?? "" } : null;
  }

  async function transition(step: PriceListAction) {
    const confirmation = ACTION_CONFIRMATION[step];
    if (confirmation && !window.confirm(confirmation)) return;
    await action.run(step, async () => {
      const result = await api<{ status: PriceListStatus }>(`/global-catalogue/lists/${id}/transition`, { method: "POST", body: { action: step } });
      detail.reload();
      onChanged(`${list?.name ?? "The price list"} is now ${statusLabel(result.status).toLowerCase()}.`);
      return `Moved to ${statusLabel(result.status).toLowerCase()}.`;
    });
  }

  async function saveHeader(event: FormEvent) {
    event.preventDefault();
    const values = headerValues();
    if (!values) return;
    await action.run("header", async () => {
      await api(`/global-catalogue/lists/${id}`, {
        method: "PATCH",
        body: { name: values.name, description: values.description || null, effectiveFrom: values.effectiveFrom, effectiveTo: values.effectiveTo || null },
      });
      setHeader(null);
      detail.reload();
      onChanged("Price list details saved.");
      return "Saved.";
    });
  }

  async function duplicate() {
    await action.run("duplicate", async () => {
      const result = await api<{ list: { code: string } }>(`/global-catalogue/lists/${id}/duplicate`, { method: "POST" });
      onChanged(`Copied to a new draft, ${result.list.code}.`);
      return "Draft copy created.";
    });
  }

  async function addItem(event: FormEvent) {
    event.preventDefault();
    if (!selection) return;
    await action.run("add", async () => {
      await api(`/global-catalogue/lists/${id}/items`, {
        method: "POST",
        body: {
          masterPriceCode: selection.code,
          price: Number(price || selection.basePrice || 0),
          currency: selection.currency ?? undefined,
        },
      });
      setSelection(null);
      setPrice("");
      detail.reload();
      onChanged(`${selection.name} was added to the price list.`);
      return "Added.";
    });
  }

  async function saveItemPrice(itemId: string) {
    await action.run(itemId, async () => {
      await api(`/global-catalogue/lists/${id}/items/${itemId}`, { method: "PATCH", body: { price: Number(itemPrice) } });
      setEditingItem(null);
      detail.reload();
      onChanged("Price updated.");
      return "Saved.";
    });
  }

  async function removeItem(itemId: string, name: string) {
    if (!window.confirm(`Remove ${name} from this draft?`)) return;
    await action.run(itemId, async () => {
      await api(`/global-catalogue/lists/${id}/items/${itemId}`, { method: "DELETE" });
      detail.reload();
      onChanged(`${name} was removed.`);
      return "Removed.";
    });
  }

  if (detail.loading && !detail.data) return <LoadingState />;
  if (detail.error) return <ErrorState message={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return null;

  const values = headerValues();
  const actions = detail.data.availableActions;

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}

      <Card
        title={list!.name}
        description={`${list!.code} · ${statusLabel(list!.status)}`}
        actions={
          <div className="mv-row">
            {canManage ? actions.map((step) => (
              <Button
                key={step}
                size="sm"
                variant={step === "publish" || step === "approve" ? "primary" : step === "archive" || step === "reject" ? "ghost" : "secondary"}
                onClick={() => void transition(step)}
                disabled={action.busy !== null}
              >
                {action.busy === step ? "Working…" : ACTION_LABELS[step]}
              </Button>
            )) : null}
            {canManage ? <Button size="sm" variant="ghost" onClick={() => void duplicate()} disabled={action.busy !== null}>Duplicate</Button> : null}
          </div>
        }
      >
        <div className="mv-small mv-muted">
          {actions.length ? `Next steps: ${actions.map((step) => ACTION_LABELS[step]).join(", ")}.` : "This list is closed and can no longer change."}
        </div>
        {editable && canManage && values ? (
          <form className="mv-stack" onSubmit={saveHeader} style={{ marginTop: 12 }}>
            <div className="mv-form-grid">
              <Field label="Name" htmlFor="detail-name"><Input id="detail-name" value={values.name} onChange={(event) => setHeader({ ...values, name: event.target.value })} required minLength={2} /></Field>
              <Field label="Effective from" htmlFor="detail-from"><Input id="detail-from" type="date" value={values.effectiveFrom} onChange={(event) => setHeader({ ...values, effectiveFrom: event.target.value })} required /></Field>
              <Field label="Effective to" htmlFor="detail-to"><Input id="detail-to" type="date" value={values.effectiveTo} onChange={(event) => setHeader({ ...values, effectiveTo: event.target.value })} /></Field>
            </div>
            <div className="mv-row">
              <Button size="sm" type="submit" disabled={action.busy !== null || !header}>{action.busy === "header" ? "Saving…" : "Save details"}</Button>
              {header ? <Button size="sm" type="button" variant="ghost" onClick={() => setHeader(null)}>Discard</Button> : null}
            </div>
          </form>
        ) : null}
      </Card>

      <Card title="Items" description="Prices are set per item in the list's currency.">
        {editable && canManage ? (
          <form className="mv-stack" onSubmit={addItem} style={{ marginBottom: 16 }}>
            <MedicineDropdown
              label="Add a catalogue item"
              placeholder="Search the global catalogue"
              onSelect={(medicine) => {
                setSelection(medicine);
                setPrice(medicine ? String(Number(medicine.basePrice ?? 0)) : "");
              }}
            />
            {selection ? (
              <div className="mv-row">
                <Field label="Price in this list" htmlFor="new-item-price">
                  <Input id="new-item-price" type="number" min={0} step="0.01" value={price} onChange={(event) => setPrice(event.target.value)} required />
                </Field>
                <div className="mv-small mv-muted">
                  {selection.currency ?? "UGX"} · {selection.category ?? "uncategorised"}
                  <div>Independently approved for this facility; the catalogue price is only a starting point.</div>
                </div>
                <Button type="submit" disabled={action.busy !== null || price === ""}>{action.busy === "add" ? "Adding…" : "Add item"}</Button>
              </div>
            ) : null}
          </form>
        ) : null}

        {!items.length ? <EmptyState title="No items yet" description="Add catalogue items, set each price, then validate the list." /> : (
          <Table head={["Item", "Category", "Price", "Approval", editable && canManage ? "" : ""]} caption="Price list items">
            {items.map((item) => (
              <tr key={item.id}>
                <td><strong>{item.name}</strong><div className="mv-small mv-muted mv-id">{item.masterPriceCode ?? "local item"}</div></td>
                <td className="mv-small">{item.category}</td>
                <td className="mv-money">
                  {editingItem === item.id ? (
                    <div className="mv-row">
                      <Input aria-label={`Price for ${item.name}`} type="number" min={0} step="0.01" value={itemPrice} onChange={(event) => setItemPrice(event.target.value)} />
                      <Button size="sm" onClick={() => void saveItemPrice(item.id)} disabled={action.busy !== null}>Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingItem(null)}>Cancel</Button>
                    </div>
                  ) : formatMoney(item.price, item.currency)}
                </td>
                <td><Badge tone={item.approvalStatus === "approved" ? "success" : "warning"}>{item.approvalStatus}</Badge></td>
                {editable && canManage ? (
                  <td>
                    <div className="mv-row">
                      <Button size="sm" variant="secondary" onClick={() => { setEditingItem(item.id); setItemPrice(String(Number(item.price))); }}>Set price</Button>
                      <Button size="sm" variant="ghost" onClick={() => void removeItem(item.id, item.name)} disabled={action.busy !== null}>Remove</Button>
                    </div>
                  </td>
                ) : null}
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card
        title="History"
        actions={<Button size="sm" variant="ghost" onClick={() => setShowHistory((value) => !value)}>{showHistory ? "Hide" : "Show history"}</Button>}
      >
        {!showHistory ? <div className="mv-small mv-muted">Price changes and lifecycle steps are kept for audit.</div> : history.loading ? <LoadingState /> : history.error ? <ErrorState message={history.error} onRetry={history.reload} /> : (
          <div className="mv-stack">
            <div>
              <strong className="mv-small">Lifecycle</strong>
              {!history.data?.events.length ? <div className="mv-small mv-muted">No lifecycle events are visible to your role.</div> : (
                <ul className="mv-small">
                  {history.data.events.map((event) => (
                    <li key={event.id}>{formatDateTime(event.occurredAt)} · {event.action}</li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <strong className="mv-small">Price changes</strong>
              {!history.data?.prices.length ? <div className="mv-small mv-muted">No price changes recorded yet.</div> : (
                <Table head={["When", "Item", "Change", "Price", "Approval"]} caption="Price history">
                  {history.data.prices.map((row) => (
                    <tr key={row.id}>
                      <td className="mv-small">{formatDateTime(row.changedAt)}</td>
                      <td>{row.name}</td>
                      <td className="mv-small">{row.changeType}</td>
                      <td className="mv-small">{formatMoney(row.previousPrice, row.currency)} → {formatMoney(row.newPrice, row.currency)}</td>
                      <td className="mv-small">{row.approvalStatusBefore ?? "—"} → {row.approvalStatusAfter ?? "—"}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

/** Lifecycle statuses are also exposed for tests and other surfaces. */
export const PRICE_LIST_STATUS_ORDER = PRICE_LIST_STATUSES;
export type { PriceListStatus };
