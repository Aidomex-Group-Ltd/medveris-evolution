import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select } from "@medveris/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

interface Medicine {
  id: string;
  code: string;
  name: string;
  description?: string;
  category?: string;
  subcategory?: string;
  strength?: string;
  form?: string;
  route?: string;
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
  minimumSearchLength = 2
}: MedicineDropdownProps) {
  const { me } = useAuth();
  const [value, setValue] = useState<string>("");
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [isSearching, setIsSearching] = useState(false);

  const loadMedicines = useCallback(async (search = "") => {
    if (search.length < (minimumSearchLength || 2) && !defaultValue) {
      setMedicines([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await api("/api/v1/global-medicines/medicines", {
        method: "GET",
      });
      const data = await response.json();
      let filtered = data.medicines || [];

      if (searchTerm && searchTerm.trim()) {
        const term = searchTerm.trim().toLowerCase();
        filtered = data.medicines.filter(
          (m: Medicine) =>
            m.name.toLowerCase().includes(term) ||
            m.code.toLowerCase().includes(term) ||
            (m.description && m.description.toLowerCase().includes(term))
        );
      }

      setMedicines(filtered);
      setValue("");
    } catch (err) {
      setError("Failed to load medicines");
      setMedicines([]);
    } finally {
      setLoading(false);
    }
  }, [searchTerm]);

  useEffect(() => {
    loadMedicines();
  }, [loadMedicines]);

  useEffect(() => {
    loadMedicines(searchTerm);
  }, [searchTerm, loadMedicines]);

  const handleChange = (event: any) => {
    const newValue = event.target.value;
    setValue(newValue);
    setSearchTerm(newValue);
    if (newValue.length >= (minimumSearchLength || 2)) {
      loadMedicines(newValue);
    } else {
      setMedicines([]);
    }
  };

  const handleSelect = (optionValue: string) => {
    onSelect(
      medicines.find((m) => m.id === optionValue) || null
    );
    setValue(optionValue);
    setSearchTerm("");
    setMedicines([]);
    setIsSearching(false);
  };

  return (
    <Field label="Medicine">
      <Select
        value={value}
        onChange={handleChange}
        placeholder="Search medicines..."
        onSearch={showSearch ? (trigger: string) => setSearchTerm(trigger) : undefined}
        loading={loading}
        error={error}
      >
        <option value="">Select a medicine…</option>
        {medicines.map((med) => (
          <option key={med.id} value={med.id}>
            <span>
              <strong>{med.name}</strong>
              {med.strength ? ` · ${med.strength}` : ""}
              {med.form ? ` ({med.form})` : ""}
            </span>
            {med.category && <span className="mv-small mv-muted">[{med.category}]</span>}
          </option>
        ))}
        {isSearching && loading && <option value="">Loading…</option>}
      </Select>
      {error && <ErrorState message={error} /> }
    </Field>
  );
}
