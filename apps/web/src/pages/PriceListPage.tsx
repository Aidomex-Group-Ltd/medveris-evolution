import { useMemo, useState, type FormEvent } from "react";
import { BILLABLE_ITEM_TYPE_LABELS, BILLABLE_ITEM_TYPES, CATALOGUE_CATEGORIES, departmentForCategory } from "@medveris/domain";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Tabs, Textarea } from "@medveris/ui";
import { api, ApiError, errorMessage } from "../lib/api";
import { formatDate, formatDateTime, formatMoney } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";
import { departmentLabel } from "../lib/workspace";
import type { CatalogueItem } from "../lib/types";

interface Department { id: string; name: string; enabled: boolean }
interface BillingSettings { allowedCurrencies: string[]; allowZeroPrices: boolean; allowManualCharges: boolean; significantChangePercent: number; version: number }
interface HistoryRow {
  version: number; change: string; previousPrice: string | number | null; newPrice: string | number | null;
  previousCurrency: string | null; newCurrency: string | null; previousStatus: string | null; newStatus: string | null;
  previousActive: boolean | null; newActive: boolean | null; reason: string | null; changedAt: string; changedByName: string | null;
}
interface RateLock {
  id: string; baseCurrency: string; targetCurrency: string; rate: number; provider: string;
  providerTimestamp: string | null; fetchedAt: string; expiresAt: string; sourceAmount: number; convertedAmount: number; catalogVersion: number;
}

const CATEGORY_LABELS: Record<string, string> = {
  consultation: "Consultation", laboratory: "Laboratory", imaging: "Imaging / radiology", theatre: "Theatre", pharmacy: "Pharmacy",
  procedure: "Procedure room", nursing: "Nursing", supply: "General supplies", bed: "Bed / admission", other: "Other",
};

const CURRENCY_LABELS: Record<string, string> = { UGX: "Uganda shilling", KES: "Kenyan shilling", TZS: "Tanzanian shilling", RWF: "Rwandan franc", USD: "US dollar", EUR: "Euro" };

type Filter = "all" | (typeof BILLABLE_ITEM_TYPES)[number];

function PriceStatusBadge({ item }: { item: CatalogueItem }) {
  return item.priceStatus === "approved"
    ? <Badge tone="success">Approved</Badge>
    : <Badge tone="warning">Test price</Badge>;
}

function confirmationReasons(cause: unknown): string[] | null {
  if (cause instanceof ApiError && cause.code === "confirmation_required") {
    const details = cause.details as { reasons?: unknown } | undefined;
    return Array.isArray(details?.reasons) ? details.reasons.map(String) : [];
  }
  return null;
}

/** Services, procedures, supplies and pharmacy items with their department, price, currency and whether they can be used. */
export function PriceListPage() {
  const items = useQuery<{ services: CatalogueItem[]; canManage: boolean }>("/service-catalog");
  const departments = useQuery<{ departments: Department[] }>("/organization/departments");
  const settings = useQuery<{ settings: BillingSettings; canManage: boolean }>("/billing-settings");
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [convertItem, setConvertItem] = useState<CatalogueItem | null>(null);
  const action = useAction();
  const canManage = items.data?.canManage ?? false;

  const rows = useMemo(() => (items.data?.services ?? []).filter((item) =>
    (filter === "all" || item.itemType === filter)
    && (!search.trim() || `${item.name} ${item.code}`.toLowerCase().includes(search.trim().toLowerCase()))), [items.data, filter, search]);

  async function toggle(item: CatalogueItem) {
    const nextActive = !item.active;
    if (!nextActive) {
      const reason = window.prompt(`Why is ${item.name} being deactivated? It will no longer be requestable or billable. (optional)`);
      if (reason === null) return;
      await action.run(item.id, async () => {
        try {
          await api(`/service-catalog/${item.id}`, { method: "PATCH", body: { expectedVersion: item.version, active: false, reason } });
        } catch (cause) {
          const reasons = confirmationReasons(cause);
          if (!reasons) throw cause;
          if (!window.confirm(`Confirm deactivation:\n\n${reasons.join("\n")}`)) return;
          await api(`/service-catalog/${item.id}`, { method: "PATCH", body: { expectedVersion: item.version, active: false, reason, confirm: true } });
        }
        items.reload();
        return `${item.name} is now inactive and cannot be requested or billed.`;
      });
      return;
    }
    await action.run(item.id, async () => {
      await api(`/service-catalog/${item.id}`, { method: "PATCH", body: { expectedVersion: item.version, active: true } });
      items.reload();
      return `${item.name} is active again.`;
    });
  }

  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Billing" title="Price list" description="What this workspace charges for. A recommendation, department work and supplied items are billed at these prices, once each." />
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Notice tone="info" title="Test prices cannot be charged">
        Prices marked as test are for training and set-up only. A bill line using a test price is refused until finance approves the price.
      </Notice>
      {canManage ? <AddItem departments={departments.data?.departments ?? []} currencies={settings.data?.settings.allowedCurrencies ?? ["UGX"]} onSaved={(message) => { action.setMessage(message); items.reload(); }} /> : null}
      {settings.data ? <BillingSettingsCard settings={settings.data.settings} canManage={settings.data.canManage} onSaved={() => { settings.reload(); items.reload(); }} /> : null}
      <Card
        title="Items"
        actions={<Input aria-label="Search the price list" placeholder="Search name or code" value={search} onChange={(event) => setSearch(event.target.value)} />}
      >
        <Tabs label="Item type" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, ...BILLABLE_ITEM_TYPES.map((type) => ({ value: type, label: `${BILLABLE_ITEM_TYPE_LABELS[type]}s` }))]} />
        {items.loading && !items.data ? <LoadingState /> : items.error ? <ErrorState message={items.error} onRetry={items.reload} /> : !rows.length ? (
          <EmptyState title={items.data?.services.length ? "No items match" : "No prices yet"} description={items.data?.services.length ? "Change the filter or search." : "Add the services, procedures and supplies you charge for."} />
        ) : (
          <Table head={["Item", "Type", "Queue / department", "Price", "Status", ""]} caption="Price list">
            {rows.map((item) => editing === item.id ? (
              <tr key={item.id}><td colSpan={6}><EditItem item={item} departments={departments.data?.departments ?? []} onDone={(message) => { setEditing(null); if (message) { action.setMessage(message); items.reload(); } }} /></td></tr>
            ) : (
              <tr key={item.id}>
                <td><strong>{item.name}</strong><div className="mv-small mv-muted mv-id">{item.code}{item.unitOfMeasure ? ` · per ${item.unitOfMeasure}` : ""}</div>{item.deactivationReason ? <div className="mv-small mv-muted">Deactivated: {item.deactivationReason}</div> : null}</td>
                <td>{BILLABLE_ITEM_TYPE_LABELS[item.itemType as keyof typeof BILLABLE_ITEM_TYPE_LABELS] ?? item.itemType}</td>
                <td className="mv-small">{CATEGORY_LABELS[item.category] ?? item.category}{departmentForCategory(item.category) !== "other" ? <div className="mv-muted">Routed to {departmentLabel(departmentForCategory(item.category)).toLowerCase()}</div> : null}{item.departmentName ? <div className="mv-muted">{item.departmentName}</div> : null}</td>
                <td className="mv-money">{formatMoney(item.price, item.currency)}<div className="mv-small mv-muted">{CURRENCY_LABELS[item.currency] ?? item.currency}</div></td>
                <td><div className="mv-row"><Badge tone={item.active ? "success" : "neutral"}>{item.active ? "Active" : "Inactive"}</Badge><PriceStatusBadge item={item} /></div>{item.priceStatus === "approved" && item.approvedAt ? <div className="mv-small mv-muted">approved {formatDate(item.approvedAt)}</div> : null}</td>
                <td>{canManage ? (
                  <div className="mv-row">
                    <Button size="sm" variant="secondary" onClick={() => setEditing(item.id)}>Edit</Button>
                    <Button size="sm" variant="ghost" onClick={() => setHistoryFor(historyFor === item.id ? null : item.id)}>{historyFor === item.id ? "Hide history" : "History"}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setConvertItem(convertItem?.id === item.id ? null : item)}>{convertItem?.id === item.id ? "Close conversion" : "Convert price"}</Button>
                    <Button size="sm" variant="ghost" disabled={action.busy !== null} onClick={() => void toggle(item)}>{item.active ? "Deactivate" : "Activate"}</Button>
                  </div>
                ) : <Button size="sm" variant="ghost" onClick={() => setHistoryFor(historyFor === item.id ? null : item.id)}>{historyFor === item.id ? "Hide history" : "History"}</Button>}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {historyFor ? <HistoryPanel itemId={historyFor} onClose={() => setHistoryFor(null)} /> : null}
      {convertItem ? <ConvertPanel item={convertItem} allowedCurrencies={settings.data?.settings.allowedCurrencies ?? ["UGX"]} onClose={() => setConvertItem(null)} onConverted={(message) => { action.setMessage(message); setConvertItem(null); items.reload(); }} /> : null}
    </div>
  );
}

function AddItem({ departments, currencies, onSaved }: { departments: Department[]; currencies: string[]; onSaved: (message: string) => void }) {
  const blank = { code: "", name: "", itemType: "service", category: "laboratory", price: "", currency: currencies[0] ?? "UGX", priceStatus: "approved", departmentId: "", unitOfMeasure: "", description: "" };
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(blank);
  const action = useAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.code.trim() || form.name.trim().length < 2 || form.price === "" || Number(form.price) < 0) {
      action.setError("Code, name and a price of zero or more are required.");
      return;
    }
    const ok = await action.run("add", async () => {
      await api("/service-catalog", {
        method: "POST",
        body: { ...form, code: form.code.trim(), name: form.name.trim(), price: Number(form.price), departmentId: form.departmentId || null, active: true },
      });
    });
    if (ok) {
      onSaved(`${form.name.trim()} added at ${formatMoney(Number(form.price), form.currency)}.`);
      setForm(blank);
      setOpen(false);
    }
  }
  if (!open) return <div><Button onClick={() => setOpen(true)}>Add an item</Button></div>;
  return (
    <Card title="Add an item">
      <form className="mv-stack" onSubmit={submit}>
        {action.error ? <ErrorState title="Not added" message={action.error} /> : null}
        <div className="mv-form-grid">
          <Field label="Type" htmlFor="pl-type">
            <Select id="pl-type" value={form.itemType} onChange={(event) => setForm({ ...form, itemType: event.target.value, category: event.target.value === "supply" ? "supply" : event.target.value === "pharmacy-item" ? "pharmacy" : form.category })}>
              {BILLABLE_ITEM_TYPES.map((type) => <option key={type} value={type}>{BILLABLE_ITEM_TYPE_LABELS[type]}</option>)}
            </Select>
          </Field>
          <Field label="Queue / category" htmlFor="pl-category" hint="Requests for this item go to this department's queue.">
            <Select id="pl-category" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>
              {CATALOGUE_CATEGORIES.map((category) => <option key={category} value={category}>{CATEGORY_LABELS[category]}</option>)}
            </Select>
          </Field>
          <Field label="Code" htmlFor="pl-code"><Input id="pl-code" value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} maxLength={50} /></Field>
          <Field label="Name" htmlFor="pl-name"><Input id="pl-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} maxLength={300} /></Field>
          <Field label="Price" htmlFor="pl-price"><Input id="pl-price" type="number" min={0} step="any" inputMode="decimal" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} /></Field>
          <Field label="Currency" htmlFor="pl-currency">
            <Select id="pl-currency" value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })}>
              {currencies.map((currency) => <option key={currency} value={currency}>{currency} — {CURRENCY_LABELS[currency] ?? currency}</option>)}
            </Select>
          </Field>
          <Field label="Price status" htmlFor="pl-status" hint="Test prices can never be charged on a bill.">
            <Select id="pl-status" value={form.priceStatus} onChange={(event) => setForm({ ...form, priceStatus: event.target.value })}>
              <option value="approved">Approved for billing</option>
              <option value="test">Test price (cannot be billed)</option>
            </Select>
          </Field>
          <Field label="Unit (optional)" htmlFor="pl-unit" hint="e.g. tablet, test, film"><Input id="pl-unit" value={form.unitOfMeasure} onChange={(event) => setForm({ ...form, unitOfMeasure: event.target.value })} maxLength={40} /></Field>
          {departments.length ? (
            <Field label="Department (optional)" htmlFor="pl-department">
              <Select id="pl-department" value={form.departmentId} onChange={(event) => setForm({ ...form, departmentId: event.target.value })}>
                <option value="">Not assigned</option>
                {departments.filter((department) => department.enabled).map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
              </Select>
            </Field>
          ) : null}
        </div>
        <Field label="Description (optional)" htmlFor="pl-description"><Textarea id="pl-description" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} maxLength={1000} /></Field>
        <div className="mv-row"><Button type="submit" disabled={action.busy !== null}>{action.busy ? "Adding…" : "Add item"}</Button><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button></div>
      </form>
    </Card>
  );
}

function EditItem({ item, departments, onDone }: { item: CatalogueItem; departments: Department[]; onDone: (message?: string) => void }) {
  const [form, setForm] = useState({ name: item.name, price: String(item.price), currency: item.currency, category: item.category, itemType: item.itemType, priceStatus: item.priceStatus, departmentId: item.departmentId ?? "", reason: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<string[] | null>(null);

  async function save(confirm: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api(`/service-catalog/${item.id}`, {
        method: "PATCH",
        body: { expectedVersion: item.version, name: form.name.trim(), price: Number(form.price), currency: form.currency, category: form.category, itemType: form.itemType, priceStatus: form.priceStatus, departmentId: form.departmentId || null, reason: form.reason, ...(confirm ? { confirm: true } : {}) },
      });
      onDone(`${form.name.trim()} updated. Bills already issued keep the price they were issued at.`);
    } catch (cause) {
      const found = confirmationReasons(cause);
      if (found) setReasons(found);
      else setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="mv-stack" onSubmit={(event) => { event.preventDefault(); void save(false); }}>
      {error ? <ErrorState title="Not saved" message={error} /> : null}
      {reasons ? (
        <Notice tone="warning" title="Confirm this change">
          <ul>{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          <div className="mv-row">
            <Button type="button" size="sm" onClick={() => void save(true)} disabled={busy}>{busy ? "Saving…" : "Confirm and save"}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setReasons(null)} disabled={busy}>Go back</Button>
          </div>
        </Notice>
      ) : null}
      <div className="mv-form-grid">
        <Field label="Name" htmlFor={`edit-name-${item.id}`}><Input id={`edit-name-${item.id}`} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} maxLength={300} /></Field>
        <Field label="Price" htmlFor={`edit-price-${item.id}`}><Input id={`edit-price-${item.id}`} type="number" min={0} step="any" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} /></Field>
        <Field label="Currency" htmlFor={`edit-currency-${item.id}`}><Input id={`edit-currency-${item.id}`} value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value.toUpperCase() })} maxLength={3} /></Field>
        <Field label="Price status" htmlFor={`edit-status-${item.id}`} hint="Approving a test price makes it chargeable.">
          <Select id={`edit-status-${item.id}`} value={form.priceStatus} onChange={(event) => setForm({ ...form, priceStatus: event.target.value as CatalogueItem["priceStatus"] })}>
            <option value="approved">Approved for billing</option>
            <option value="test">Test price (cannot be billed)</option>
          </Select>
        </Field>
        <Field label="Type" htmlFor={`edit-type-${item.id}`}>
          <Select id={`edit-type-${item.id}`} value={form.itemType} onChange={(event) => setForm({ ...form, itemType: event.target.value })}>
            {BILLABLE_ITEM_TYPES.map((type) => <option key={type} value={type}>{BILLABLE_ITEM_TYPE_LABELS[type]}</option>)}
          </Select>
        </Field>
        <Field label="Queue / category" htmlFor={`edit-category-${item.id}`}>
          <Select id={`edit-category-${item.id}`} value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>
            {CATALOGUE_CATEGORIES.map((category) => <option key={category} value={category}>{CATEGORY_LABELS[category]}</option>)}
          </Select>
        </Field>
        {departments.length ? (
          <Field label="Department" htmlFor={`edit-department-${item.id}`}>
            <Select id={`edit-department-${item.id}`} value={form.departmentId} onChange={(event) => setForm({ ...form, departmentId: event.target.value })}>
              <option value="">Not assigned</option>
              {departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
            </Select>
          </Field>
        ) : null}
        <Field label="Reason for change (optional)" htmlFor={`edit-reason-${item.id}`}><Input id={`edit-reason-${item.id}`} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} maxLength={500} /></Field>
      </div>
      <div className="mv-row"><Button type="submit" size="sm" disabled={busy || Boolean(reasons)}>{busy ? "Saving…" : "Save"}</Button><Button type="button" size="sm" variant="ghost" onClick={() => onDone()}>Cancel</Button></div>
    </form>
  );
}

function HistoryPanel({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const history = useQuery<{ history: HistoryRow[] }>(`/service-catalog/${itemId}/history`);
  return (
    <Card title="Price history" description="Every price, currency and status change, with who made it and why. Bills keep the price they were issued at." actions={<Button size="sm" variant="ghost" onClick={onClose}>Close</Button>}>
      {history.loading ? <LoadingState /> : history.error ? <ErrorState message={history.error} onRetry={history.reload} /> : !history.data?.history.length ? <EmptyState title="No changes yet" description="Changes to this item will appear here." /> : (
        <Table head={["When", "Version", "Change", "Price", "Status", "Reason", "By"]} caption="Price history">
          {history.data.history.map((row) => (
            <tr key={row.version}>
              <td className="mv-small">{formatDateTime(row.changedAt)}</td>
              <td>v{row.version}</td>
              <td>{row.change}</td>
              <td className="mv-small">
                {row.previousPrice == null ? "—" : formatMoney(row.previousPrice, row.previousCurrency ?? "UGX")}
                <div>→ {row.newPrice == null ? "—" : formatMoney(row.newPrice, row.newCurrency ?? "UGX")}</div>
              </td>
              <td className="mv-small">{row.previousStatus ?? "—"} / {row.previousActive == null ? "—" : row.previousActive ? "active" : "inactive"}<div>→ {row.newStatus ?? "—"} / {row.newActive == null ? "—" : row.newActive ? "active" : "inactive"}</div></td>
              <td className="mv-small">{row.reason ?? "—"}</td>
              <td className="mv-small">{row.changedByName ?? "system"}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

function ConvertPanel({ item, allowedCurrencies, onClose, onConverted }: { item: CatalogueItem; allowedCurrencies: string[]; onClose: () => void; onConverted: (message: string) => void }) {
  const targets = allowedCurrencies.filter((currency) => currency !== item.currency);
  const [target, setTarget] = useState(targets[0] ?? "");
  const [lock, setLock] = useState<RateLock | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function quote() {
    setBusy("quote");
    setError(null);
    setLock(null);
    try {
      const result = await api<{ lock: RateLock }>(`/service-catalog/${item.id}/convert`, { method: "POST", body: { targetCurrency: target } });
      setLock(result.lock);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!lock) return;
    setBusy("apply");
    setError(null);
    try {
      await api(`/service-catalog/${item.id}/convert/apply`, { method: "POST", body: { lockId: lock.id, expectedVersion: item.version, confirm: true } });
      onConverted(`${item.name} converted to ${formatMoney(lock.convertedAmount, lock.targetCurrency)} at the locked rate. Bills already issued keep their currency.`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title={`Convert ${item.name}`} description={`Currently ${formatMoney(item.price, item.currency)}. A conversion locks a timestamped exchange rate and changes nothing until you confirm.`} actions={<Button size="sm" variant="ghost" onClick={onClose}>Close</Button>}>
      {error ? <ErrorState message={error} /> : null}
      {!targets.length ? <Notice tone="info">Add another currency in billing settings before converting a price.</Notice> : (
        <div className="mv-stack">
          <div className="mv-form-grid">
            <Field label="Convert into" htmlFor="convert-target">
              <Select id="convert-target" value={target} onChange={(event) => { setTarget(event.target.value); setLock(null); }}>
                {targets.map((currency) => <option key={currency} value={currency}>{currency} — {CURRENCY_LABELS[currency] ?? currency}</option>)}
              </Select>
            </Field>
            <div className="mv-row" style={{ alignItems: "flex-end" }}>
              <Button onClick={() => void quote()} disabled={!target || busy !== null}>{busy === "quote" ? "Fetching rate…" : "Get a locked rate"}</Button>
            </div>
          </div>
          {lock ? (
            <div className="mv-note mv-stack">
              <p><strong>{formatMoney(lock.sourceAmount, lock.baseCurrency)} → {formatMoney(lock.convertedAmount, lock.targetCurrency)}</strong></p>
              <p className="mv-small mv-muted">Rate {lock.rate} from {lock.provider}{lock.providerTimestamp ? `, provider time ${formatDateTime(lock.providerTimestamp)}` : ""}. Locked {formatDateTime(lock.fetchedAt)} until {formatDateTime(lock.expiresAt)}.</p>
              <div className="mv-row">
                <Button onClick={() => void apply()} disabled={busy !== null}>{busy === "apply" ? "Applying…" : "Apply this rate"}</Button>
                <Button variant="ghost" onClick={() => setLock(null)} disabled={busy !== null}>Discard</Button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function BillingSettingsCard({ settings, canManage, onSaved }: { settings: BillingSettings; canManage: boolean; onSaved: () => void }) {
  const [currencies, setCurrencies] = useState(settings.allowedCurrencies.join(", "));
  const [zero, setZero] = useState(settings.allowZeroPrices);
  const [manual, setManual] = useState(settings.allowManualCharges);
  const [threshold, setThreshold] = useState(String(settings.significantChangePercent));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    const allowed = currencies.split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);
    try {
      await api("/billing-settings", {
        method: "PUT",
        body: { expectedVersion: settings.version, allowedCurrencies: [...new Set(allowed)], allowZeroPrices: zero, allowManualCharges: manual, significantChangePercent: Number(threshold) },
      });
      setMessage(`Billing settings saved. Unless an administrator changes them, the facility prices in ${[...new Set(allowed)].join(" or ")}.`);
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Facility billing settings" description="Which currencies may be used, whether zero and manual prices are allowed, and when a price change needs confirmation.">
      {error ? <ErrorState message={error} /> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      {canManage ? (
        <form className="mv-stack" onSubmit={save}>
          <div className="mv-form-grid">
            <Field label="Allowed currencies" htmlFor="settings-currencies" hint="Comma separated, e.g. UGX, KES. Add a currency before pricing in it."><Input id="settings-currencies" value={currencies} onChange={(event) => setCurrencies(event.target.value.toUpperCase())} /></Field>
            <Field label="Confirmation threshold (%)" htmlFor="settings-threshold" hint="Changes above this need an explicit confirmation."><Input id="settings-threshold" type="number" min={1} max={100} value={threshold} onChange={(event) => setThreshold(event.target.value)} /></Field>
          </div>
          <label className="mv-check"><input type="checkbox" checked={zero} onChange={(event) => setZero(event.target.checked)} /><span>Allow zero prices</span></label>
          <label className="mv-check"><input type="checkbox" checked={manual} onChange={(event) => setManual(event.target.checked)} /><span>Allow manual charges at the till</span></label>
          <div><Button type="submit" size="sm" disabled={busy}>{busy ? "Saving…" : "Save billing settings"}</Button></div>
        </form>
      ) : (
        <Table head={["Currencies", "Zero prices", "Manual charges", "Change threshold"]} caption="Billing settings">
          <tr><td>{settings.allowedCurrencies.join(", ")}</td><td>{settings.allowZeroPrices ? "Allowed" : "Not allowed"}</td><td>{settings.allowManualCharges ? "Allowed" : "Not allowed"}</td><td>{settings.significantChangePercent}%</td></tr>
        </Table>
      )}
    </Card>
  );
}
