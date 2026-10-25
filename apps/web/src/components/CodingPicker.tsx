import { useEffect, useState } from "react";
import { Badge, Button, Input, Notice } from "@medveris/ui";
import { api, errorMessage } from "../lib/api";
import type { Coding } from "../lib/types";

interface Concept extends Coding { synonyms?: string[]; active?: boolean }

const cache = new Map<string, Concept[]>();

export function CodingPicker({ field, label, value, onChange, hint }: { field: string; label: string; value: Coding | null; onChange: (coding: Coding | null) => void; hint?: string }) {
  const [query, setQuery] = useState("");
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<string>("");

  useEffect(() => {
    const key = `${field}:${query}`;
    const cached = cache.get(key);
    if (cached) {
      setConcepts(cached);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api<{ concepts: Concept[]; terminologyMode: string; label: string }>(`/terminology/search?field=${encodeURIComponent(field)}&q=${encodeURIComponent(query)}&limit=12`, { signal: controller.signal })
        .then((result) => {
          cache.set(key, result.concepts);
          setConcepts(result.concepts);
          setMode(result.label);
          setError(null);
        })
        .catch((cause) => {
          if (!controller.signal.aborted) setError(errorMessage(cause));
        });
    }, 220);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [field, query]);

  return (
    <div className="mv-stack" style={{ gap: 8 }}>
      <span className="mv-field__label">{label}</span>
      {value ? (
        <div className="mv-spread mv-note" style={{ padding: 10 }}>
          <div>
            <strong>{value.display}</strong>
            <div className="mv-small mv-muted"><span className="mv-inline-code">{value.code}</span> · {value.system}</div>
            <div className="mv-small mv-muted">Release: {value.version}</div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => onChange(null)}>Change</Button>
        </div>
      ) : (
        <>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search approved concepts…" aria-label={`Search ${label}`} />
          {hint ? <span className="mv-small mv-muted">{hint}</span> : null}
          {mode ? <Badge tone="warning">{mode}</Badge> : null}
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <div className="mv-stack" style={{ gap: 5 }}>
            {concepts.map((concept) => (
              <button key={`${concept.system}:${concept.code}`} type="button" className="mv-note" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => onChange({ system: concept.system, version: concept.version, code: concept.code, display: concept.display })}>
                <strong>{concept.display}</strong>
                <div className="mv-small mv-muted"><span className="mv-inline-code">{concept.code}</span> · {concept.system}</div>
              </button>
            ))}
            {!concepts.length && query ? <span className="mv-small mv-muted">No approved concept matched. Do not enter an unvalidated code.</span> : null}
          </div>
        </>
      )}
    </div>
  );
}
