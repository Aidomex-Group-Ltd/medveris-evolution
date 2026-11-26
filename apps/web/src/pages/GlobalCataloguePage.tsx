import { useEffect, useMemo, useState, type FormEvent } from "react";
import { CURRENCIES } from "@medveris/domain";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { formatDate, formatDateTime, formatMoney, todayInput } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";

interface CatalogueItem {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: string;
  subcategory: string | null;
  unitType: string;
  isService: boolean;
  basePrice: string | number;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string | null;
}

interface CatalogueResponse {
  items: CatalogueItem[];
  total?: number;
  canManage: boolean;
  categories?: Array<{ category: string; count: number }>;
  duplicates: Array<{ name_key: string; category: string; count: number; codes: string[] }>;
}

const CURRENCY_OPTIONS = Object.entries(CURRENCIES).map(([code, meta]) => ({ code, name: meta.name }));

function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * The platform's canonical price catalogue (`master_prices`).
 *
 * Only a platform operator may change it; every staff member may read active rows. The catalogue
 * is priced items, not a regulatory register: it carries no approval classification or
 * registration number and this page never presents one.
 */
export function GlobalCataloguePage() {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "inactive" | "expired">("all");
  const debouncedSearch = useDebounced(search);
  const query = useMemo(() => {
    const params = new URLSearchParams({ limit: "50", status });
    if (debouncedSearch.trim()) params.set("q", debouncedSearch.trim());
    if (category) params.set("category", category);
    return `/global-catalogue/items?${params.toString()}`;
  }, [category, debouncedSearch, status]);
  const items = useQuery<CatalogueResponse>(query);
  const action = useAction();
  const [editing, setEditing] = useState<CatalogueItem | null>(null);

  const rows = items.data?.items ?? [];
  const canManage = items.data?.canManage ?? false;

  async function withdraw(item: CatalogueItem) {
    const reason = window.prompt(`Withdraw ${item.name} from the global catalogue? It stays visible to operators but is no longer offered. (optional note)`);
    if (reason === null) return;
    await action.run(item.id, async () => {
      await api(`/global-catalogue/items/${item.id}`, { method: "PATCH", body: { active: false, effectiveTo: todayInput() } });
      items.reload();
      return `${item.name} was withdrawn from the global catalogue.`;
    });
  }

  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow="Platform"
        title="Global price catalogue"
        description="Canonical prices every facility can adopt. A catalogue row is a priced item; it is not a regulatory approval and carries no registration number."
      />
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Notice tone="info" title="No currency conversion">
        Prices are stated in their own currency. UGX prices are never converted into KES or USD; a different currency needs its own approved entry.
      </Notice>

      {(items.data?.duplicates ?? []).length ? (
        <Notice tone="warning" title="Possible duplicate entries">
          {items.data!.duplicates.map((group) => `${group.name_key} (${group.codes.join(", ")})`).join("; ")}
        </Notice>
      ) : null}

      {canManage ? <CreateItemForm onSaved={(message) => { action.setMessage(message); items.reload(); }} categories={(items.data?.categories ?? []).map((row) => row.category)} /> : null}

      {editing ? (
        <EditItemForm
          item={editing}
          onDone={(message) => {
            setEditing(null);
            if (message) { action.setMessage(message); items.reload(); }
          }}
        />
      ) : null}

      <Card
        title="Catalogue entries"
        actions={
          <div className="mv-row">
            <Input aria-label="Search the global catalogue" placeholder="Search name, code or description" value={search} onChange={(event) => setSearch(event.target.value)} />
            <Select aria-label="Filter by status" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="inactive">Withdrawn</option>
              <option value="expired">Expired</option>
            </Select>
            <Select aria-label="Filter by category" value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">All categories</option>
              {(items.data?.categories ?? []).map((row) => (
                <option key={row.category} value={row.category}>{row.category} ({row.count})</option>
              ))}
            </Select>
          </div>
        }
      >
        {items.loading && !items.data ? <LoadingState /> : items.error ? <ErrorState message={items.error} onRetry={items.reload} /> : !rows.length ? (
          <EmptyState
            title={items.data?.total ? "No entries match" : "The catalogue is empty"}
            description={items.data?.total ? "Change the search or filter." : canManage ? "Add the first priced item, or import an approved list through the governed workflow." : "A platform operator curates this catalogue."}
          />
        ) : (
          <Table head={["Item", "Category", "Price", "Effective", "Status", canManage ? "Actions" : ""]} caption="Global price catalogue">
            {rows.map((item) => (
              <tr key={item.id}>
                <td>
                  <strong>{item.name}</strong>
                  <div className="mv-small mv-muted mv-id">{item.code}</div>
                  {item.description ? <div className="mv-small mv-muted">{item.description}</div> : null}
                </td>
                <td className="mv-small">{item.category}{item.subcategory ? <div className="mv-muted">{item.subcategory}</div> : null}</td>
                <td className="mv-money">{formatMoney(item.basePrice, item.currency)}</td>
                <td className="mv-small">{formatDate(item.effectiveFrom)}<div className="mv-muted">to {item.effectiveTo ? formatDate(item.effectiveTo) : "open"}</div></td>
                <td>
                  <Badge tone={item.active ? "success" : "neutral"}>{item.active ? "Active" : "Withdrawn"}</Badge>
                  {item.updatedAt ? <div className="mv-small mv-muted">updated {formatDate(item.updatedAt)}</div> : null}
                </td>
                {canManage ? (
                  <td>
                    <div className="mv-row">
                      <Button size="sm" variant="secondary" onClick={() => setEditing(item)}>Edit</Button>
                      {item.active ? <Button size="sm" variant="ghost" onClick={() => void withdraw(item)} disabled={action.busy !== null}>Withdraw</Button> : null}
                    </div>
                  </td>
                ) : null}
              </tr>
            ))}
          </Table>
        )}
        {items.data?.total != null ? <div className="mv-small mv-muted">{rows.length} of {items.data.total} entries</div> : null}
      </Card>
    </div>
  );
}

function CreateItemForm({ onSaved, categories }: { onSaved: (message: string) => void; categories: string[] }) {
  const action = useAction();
  const [form, setForm] = useState({
    code: "",
    name: "",
    category: "",
    subcategory: "",
    description: "",
    unitType: "clinical",
    isService: true,
    basePrice: "",
    currency: "UGX",
    effectiveFrom: todayInput(),
    effectiveTo: "",
  });

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run("create", async () => {
      await api("/global-catalogue/items", {
        method: "POST",
        body: {
          code: form.code.trim(),
          name: form.name.trim(),
          category: form.category.trim(),
          subcategory: form.subcategory.trim() || null,
          description: form.description.trim() || null,
          unitType: form.unitType.trim(),
          isService: form.isService,
          basePrice: Number(form.basePrice),
          currency: form.currency,
          effectiveFrom: form.effectiveFrom,
          effectiveTo: form.effectiveTo || null,
        },
      });
      setForm((previous) => ({ ...previous, code: "", name: "", description: "", basePrice: "" }));
      onSaved(`${form.name} was added to the global catalogue.`);
      return "Catalogue entry created.";
    });
  }

  return (
    <Card title="Add a catalogue entry" description="Codes are permanent once used, so that facilities can adopt them safely.">
      {action.error ? <ErrorState message={action.error} /> : null}
      <form className="mv-stack" onSubmit={submit}>
        <div className="mv-form-grid">
          <Field label="Code" htmlFor="catalogue-code"><Input id="catalogue-code" value={form.code} onChange={(event) => update("code", event.target.value.toUpperCase())} required minLength={2} maxLength={50} placeholder="e.g. PH-AMOX-500" /></Field>
          <Field label="Item name" htmlFor="catalogue-name"><Input id="catalogue-name" value={form.name} onChange={(event) => update("name", event.target.value)} required minLength={2} /></Field>
          <Field label="Category" htmlFor="catalogue-category">
            <Input id="catalogue-category" list="catalogue-categories" value={form.category} onChange={(event) => update("category", event.target.value)} required minLength={2} placeholder="medicine, consultation, laboratory…" />
            <datalist id="catalogue-categories">{categories.map((name) => <option key={name} value={name} />)}</datalist>
          </Field>
          <Field label="Subcategory" htmlFor="catalogue-subcategory"><Input id="catalogue-subcategory" value={form.subcategory} onChange={(event) => update("subcategory", event.target.value)} /></Field>
          <Field label="Price" htmlFor="catalogue-price"><Input id="catalogue-price" type="number" min={0} step="0.01" value={form.basePrice} onChange={(event) => update("basePrice", event.target.value)} required /></Field>
          <Field label="Currency">
            <Select aria-label="Currency" value={form.currency} onChange={(event) => update("currency", event.target.value)}>
              {CURRENCY_OPTIONS.map((currency) => <option key={currency.code} value={currency.code}>{currency.code} — {currency.name}</option>)}
            </Select>
          </Field>
          <Field label="Effective from" htmlFor="catalogue-from"><Input id="catalogue-from" type="date" value={form.effectiveFrom} onChange={(event) => update("effectiveFrom", event.target.value)} required /></Field>
          <Field label="Effective to" htmlFor="catalogue-to"><Input id="catalogue-to" type="date" value={form.effectiveTo} onChange={(event) => update("effectiveTo", event.target.value)} /></Field>
        </div>
        <Field label="Description" htmlFor="catalogue-description"><Textarea id="catalogue-description" value={form.description} onChange={(event) => update("description", event.target.value)} rows={2} /></Field>
        <Button type="submit" disabled={action.busy !== null || !form.code || !form.name || !form.category || form.basePrice === ""}>
          {action.busy === "create" ? "Saving…" : "Add to catalogue"}
        </Button>
      </form>
    </Card>
  );
}

function EditItemForm({ item, onDone }: { item: CatalogueItem; onDone: (message?: string) => void }) {
  const action = useAction();
  const [price, setPrice] = useState(String(Number(item.basePrice)));
  const [currency, setCurrency] = useState(item.currency);
  const [effectiveTo, setEffectiveTo] = useState(item.effectiveTo ?? "");

  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run("save", async () => {
      await api(`/global-catalogue/items/${item.id}`, {
        method: "PATCH",
        body: { basePrice: Number(price), currency, effectiveTo: effectiveTo || null },
      });
      onDone(`${item.name} saved.`);
      return "Saved.";
    });
  }

  return (
    <Card title={`Edit ${item.name}`} description={`${item.code} · changing a price is audited and never rewrites a historical bill.`}>
      {action.error ? <ErrorState message={action.error} /> : null}
      <form className="mv-stack" onSubmit={submit}>
        <div className="mv-form-grid">
          <Field label="Price" htmlFor="edit-price"><Input id="edit-price" type="number" min={0} step="0.01" value={price} onChange={(event) => setPrice(event.target.value)} required /></Field>
          <Field label="Currency">
            <Select aria-label="Currency" value={currency} onChange={(event) => setCurrency(event.target.value)}>
              {CURRENCY_OPTIONS.map((option) => <option key={option.code} value={option.code}>{option.code} — {option.name}</option>)}
            </Select>
          </Field>
          <Field label="Effective to" htmlFor="edit-to"><Input id="edit-to" type="date" value={effectiveTo} onChange={(event) => setEffectiveTo(event.target.value)} /></Field>
        </div>
        <div className="mv-row">
          <Button type="submit" disabled={action.busy !== null}>{action.busy === "save" ? "Saving…" : "Save changes"}</Button>
          <Button type="button" variant="ghost" onClick={() => onDone()}>Cancel</Button>
        </div>
        <div className="mv-small mv-muted">Last updated {formatDateTime(item.updatedAt ?? item.createdAt)}</div>
      </form>
    </Card>
  );
}
