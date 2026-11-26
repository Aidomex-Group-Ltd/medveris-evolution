import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { Field, Input, Select } from "@medveris/ui";
import { api } from "../../lib/api";

/**
 * Medicine picker backed by the global price catalogue (`/global-medicines/medicines`).
 *
 * The rows are catalogue entries with a code, name, category and unit; strength, form and route
 * are optional because the price catalogue does not always carry them. This component never
 * implies a regulatory approval — that data lives in the medicine master catalogue.
 */
interface Medicine {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  category?: string | null;
  subcategory?: string | null;
  strength?: string | null;
  form?: string | null;
  route?: string | null;
}

interface MedicineDropdownProps {
  defaultValue?: string;
  onSelect: (medicine: Medicine | null) => void;
  showSearch?: boolean;
  minimumSearchLength?: number;
}

export function MedicineDropdown({
  defaultValue,
  onSelect,
  showSearch = true,
  minimumSearchLength = 2,
}: MedicineDropdownProps) {
  const [value, setValue] = useState<string>(defaultValue ?? "");
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ medicines: Medicine[] }>("/global-medicines");
      setMedicines(data.medicines ?? []);
    } catch (cause) {
      setMedicines([]);
      setError(cause instanceof Error ? cause.message : "The medicine catalogue could not be loaded");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (defaultValue) setValue(defaultValue);
  }, [defaultValue]);

  useEffect(() => {
    if (!showSearch) return;
    if (searchTerm.trim().length < minimumSearchLength) return;
    void load();
  }, [load, minimumSearchLength, searchTerm, showSearch]);

  const term = searchTerm.trim().toLowerCase();
  const visible = term.length < minimumSearchLength
    ? medicines
    : medicines.filter((medicine) =>
        medicine.name.toLowerCase().includes(term)
        || medicine.code.toLowerCase().includes(term)
        || (medicine.description ?? "").toLowerCase().includes(term));

  function handleChange(event: ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value;
    setValue(next);
    onSelect(medicines.find((medicine) => medicine.id === next) ?? null);
  }

  const label = (medicine: Medicine) => {
    const details = [medicine.strength, medicine.form].filter(Boolean).join(" · ");
    return details ? `${medicine.name} — ${details}` : medicine.name;
  };

  return (
    <Field label="Medicine" error={error ?? undefined} hint={loading ? "Loading the catalogue…" : undefined}>
      {showSearch ? (
        <Input
          type="search"
          placeholder="Search by name or code"
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
          aria-label="Search medicines"
        />
      ) : null}
      <Select value={value} onChange={handleChange} aria-label="Medicine">
        <option value="">Select a medicine…</option>
        {visible.map((medicine) => (
          <option key={medicine.id} value={medicine.id}>{label(medicine)}</option>
        ))}
      </Select>
    </Field>
  );
}
