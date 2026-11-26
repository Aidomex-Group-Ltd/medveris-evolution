import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Badge, Button, Notice, Select } from "@medveris/ui";
import { api, errorMessage } from "../../lib/api";

/**
 * Medicine picker backed by the global price catalogue (`/global-medicines/search`).
 *
 * Search runs on the server, one page at a time, so a large catalogue is never loaded into the
 * browser. Rows are pricing records: the catalogue carries no NDA registration number or approval
 * classification, and this component never implies one — each result is marked unverified.
 *
 * `onSelect` receives the whole record, not just a label, so the calling workflow can persist the
 * catalogue code, strength, form, route and category it actually needs.
 */

export interface MedicineSelection {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: string | null;
  subcategory: string | null;
  strength: string | null;
  form: string | null;
  route: string | null;
  packSize: string | null;
  unitType: string | null;
  isService: boolean;
  basePrice: string | number | null;
  currency: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  active: boolean;
  recordType: "price-catalogue-entry";
  regulatoryStatus: "unverified";
  regulatorySource: string | null;
  registrationIdentifier: string | null;
  verifiedAt: string | null;
}

interface SearchResponse {
  medicines: MedicineSelection[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  notice?: string;
}

interface CategoryResponse {
  categories: Array<{ category: string; count: number }>;
}

interface MedicineDropdownProps {
  onSelect: (medicine: MedicineSelection | null) => void;
  label?: string;
  placeholder?: string;
  /** Kept for callers that previously passed it; search is always server-side. */
  showSearch?: boolean;
  /** Characters required before a search runs. */
  minimumSearchLength?: number;
  disabled?: boolean;
  hint?: string;
}

const PAGE_SIZE = 20;
const DEBOUNCE_MS = 250;

export function MedicineDropdown({
  onSelect,
  label = "Medicine",
  placeholder = "Search by name, code or description",
  showSearch = true,
  minimumSearchLength = 2,
  disabled = false,
  hint,
}: MedicineDropdownProps) {
  const listId = useId();
  const [term, setTerm] = useState("");
  const [debounced, setDebounced] = useState("");
  const [category, setCategory] = useState("");
  const [results, setResults] = useState<MedicineSelection[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [selected, setSelected] = useState<MedicineSelection | null>(null);
  const [categories, setCategories] = useState<Array<{ category: string; count: number }>>([]);
  const [reloadToken, setReloadToken] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [term]);

  useEffect(() => {
    let cancelled = false;
    api<CategoryResponse>("/global-medicines/categories")
      .then((data) => {
        if (!cancelled) setCategories(data.categories.filter((row) => row.category));
      })
      .catch(() => {
        if (!cancelled) setCategories([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const search = useCallback(async (query: string, cat: string, offset: number, signal: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (query) params.set("q", query);
      if (cat) params.set("category", cat);
      const data = await api<SearchResponse>(`/global-medicines/search?${params.toString()}`, { signal });
      const unique = new Map<string, MedicineSelection>();
      for (const row of data.medicines) unique.set(row.id, row);
      setResults((previous) => {
        const merged = offset === 0 ? unique : new Map(previous.map((row) => [row.id, row] as const));
        if (offset > 0) for (const [id, row] of unique) merged.set(id, row);
        return [...merged.values()];
      });
      setTotal(data.total);
      setHasMore(data.hasMore);
      setActiveIndex(0);
    } catch (cause) {
      if (signal.aborted) return;
      setError(errorMessage(cause));
      if (offset === 0) setResults([]);
      setHasMore(false);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!showSearch || disabled) return;
    if (debounced.length < minimumSearchLength) {
      setResults([]);
      setTotal(0);
      setHasMore(false);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    void search(debounced, category, 0, controller.signal);
    return () => controller.abort();
  }, [category, debounced, disabled, minimumSearchLength, reloadToken, search, showSearch]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const showPrompt = debounced.length < minimumSearchLength && !category;
  const empty = !loading && !error && !showPrompt && results.length === 0;

  function choose(medicine: MedicineSelection) {
    setSelected(medicine);
    setOpen(false);
    setTerm("");
    setDebounced("");
    onSelect(medicine);
  }

  function clear() {
    setSelected(null);
    setResults([]);
    onSelect(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => Math.min(index + 1, Math.max(0, results.length - 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      if (open && results[activeIndex]) {
        event.preventDefault();
        choose(results[activeIndex]!);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  const statusBadge = useMemo(() => {
    if (!selected) return null;
    if (!selected.active) return <Badge tone="neutral">Inactive in catalogue</Badge>;
    return <Badge tone="warning">Unverified — not a regulatory approval</Badge>;
  }, [selected]);

  return (
    <div className="mv-stack" ref={containerRef}>
      <div className="mv-field">
        <span className="mv-field__label">{label}</span>
        {selected ? (
          <div className="mv-note">
            <div className="mv-spread">
              <div>
                <strong>{selected.name}</strong>
                <div className="mv-small mv-muted mv-id">{selected.code}</div>
                <div className="mv-small">
                  {[selected.strength, selected.form, selected.route, selected.packSize ? `pack of ${selected.packSize}` : null]
                    .filter(Boolean)
                    .join(" · ") || "No strength, form or route recorded in the catalogue"}
                </div>
                {selected.category ? <div className="mv-small mv-muted">Category: {selected.category}</div> : null}
                <div className="mv-small mv-muted">
                  Regulatory source: not recorded. No registration number is shown because none is verified.
                </div>
              </div>
              <div className="mv-row">
                {statusBadge}
                <Button size="sm" variant="ghost" onClick={clear} disabled={disabled}>Change</Button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="mv-row">
              <input
                className="mv-input"
                role="combobox"
                aria-expanded={open}
                aria-controls={listId}
                aria-activedescendant={open && results[activeIndex] ? `${listId}-${activeIndex}` : undefined}
                aria-autocomplete="list"
                autoComplete="off"
                disabled={disabled}
                placeholder={placeholder}
                value={term}
                onChange={(event) => {
                  setTerm(event.target.value);
                  setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                onKeyDown={onKeyDown}
              />
              <Select
                aria-label="Filter by category"
                value={category}
                disabled={disabled}
                onChange={(event) => setCategory(event.target.value)}
              >
                <option value="">All categories</option>
                {categories.map((row) => (
                  <option key={row.category} value={row.category}>{row.category} ({row.count})</option>
                ))}
              </Select>
            </div>
            {open ? (
              <div className="mv-note">
                <div id={listId} role="listbox" aria-label="Medicine results">
                {loading ? <div className="mv-small mv-muted">Searching the catalogue…</div> : null}
                {error ? (
                  <div className="mv-stack">
                    <Notice tone="danger" title="The catalogue could not be searched">{error}</Notice>
                    <Button size="sm" variant="secondary" onClick={() => setReloadToken((token) => token + 1)}>Try again</Button>
                  </div>
                ) : null}
                {showPrompt ? (
                  <div className="mv-small mv-muted">Type at least {minimumSearchLength} characters, or choose a category.</div>
                ) : null}
                {empty ? (
                  <div className="mv-small mv-muted">
                    No catalogue entries match. A platform operator curates the global catalogue; nothing is created from this picker.
                  </div>
                ) : null}
                {results.map((medicine, index) => (
                  <div
                    key={medicine.id}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    tabIndex={-1}
                    className={index === activeIndex ? "mv-row mv-note" : "mv-row"}
                    style={{ cursor: "pointer", padding: "6px 8px", borderRadius: 6, background: index === activeIndex ? "var(--mv-surface-2, #f4f5f7)" : undefined }}
                    onMouseEnter={() => setActiveIndex(index)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      choose(medicine);
                    }}
                  >
                    <div>
                      <strong>{medicine.name}</strong>
                      <div className="mv-small mv-muted mv-id">{medicine.code}</div>
                      <div className="mv-small">
                        {[medicine.strength, medicine.form, medicine.route].filter(Boolean).join(" · ") || medicine.category}
                      </div>
                    </div>
                    <Badge tone="warning">Unverified</Badge>
                  </div>
                ))}
                </div>
                {hasMore ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      const controller = new AbortController();
                      void search(debounced, category, results.length, controller.signal);
                    }}
                    disabled={loading}
                  >
                    {loading ? "Loading…" : `Load more (${results.length} of ${total})`}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
        <span className="mv-field__hint">
          {hint ?? "Catalogue entries are priced items, not regulatory approvals. No registration number is shown unless a verified source supplies one."}
        </span>
      </div>
    </div>
  );
}
