import { useState } from "react";
import { Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table } from "@medveris/ui";
import { useQuery } from "../lib/useQuery";

interface Capability { code: string; name: string; category: string; description?: string; active: boolean }
interface Specialty { code: string; name: string; cadreCodes: string[]; departmentCodes: string[]; active: boolean }
interface Regulator { code: string; name: string; regulatorType: string; country: string; active: boolean }
interface Cadre { code: string; name: string; category: string; active: boolean }

export function ClinicalGovernancePage() {
  const [cadreCode, setCadreCode] = useState("");
  const [specialtyCodes, setSpecialtyCodes] = useState("");
  const capabilities = useQuery<{ capabilities: Capability[] }>(`/reference/capabilities${cadreCode ? `?cadreCode=${encodeURIComponent(cadreCode)}` : ""}${specialtyCodes ? `${cadreCode ? "&" : "?"}specialtyCodes=${encodeURIComponent(specialtyCodes)}` : ""}`);
  const specialties = useQuery<{ specialties: Specialty[] }>("/reference/specialties");
  const regulators = useQuery<{ regulators: Regulator[] }>("/reference/regulators");
  const cadres = useQuery<{ cadres: Cadre[] }>("/reference/cadres");

  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Governance" title="Clinical governance" description="Reference capabilities, specialties and regulators. Selections are suggestions only; privileges require explicit approval." />
      <Card title="Capability suggestions" description="Filter the shared capability catalogue by cadre or specialties. This never grants a privilege.">
        <div className="mv-form-grid">
          <Field label="Cadre"><Select value={cadreCode} onChange={(event) => setCadreCode(event.target.value)}><option value="">Any cadre</option>{cadres.data?.cadres.map((c) => <option key={c.code} value={c.code}>{c.name} ({c.code})</option>)}</Select></Field>
          <Field label="Specialty codes (comma-separated)" htmlFor="spec-codes"><Input id="spec-codes" value={specialtyCodes} onChange={(event) => setSpecialtyCodes(event.target.value)} placeholder="Enter specialty codes" /></Field>
        </div>
        {capabilities.loading ? <LoadingState /> : capabilities.error ? <ErrorState message={capabilities.error} onRetry={capabilities.reload} /> : !capabilities.data?.capabilities.length ? <EmptyState title="No capabilities" description="Adjust the cadre or specialty filter." /> : (
          <Table head={["Code", "Capability", "Category"]} caption="Capabilities">
            {capabilities.data.capabilities.map((c) => <tr key={c.code}><td className="mv-id">{c.code}</td><td><strong>{c.name}</strong>{c.description ? <div className="mv-small mv-muted">{c.description}</div> : null}</td><td>{c.category}</td></tr>)}
          </Table>
        )}
      </Card>
      <div className="mv-grid mv-grid--2">
        <Card title="Specialties" description={`${specialties.data?.specialties.length ?? 0} catalogue specialties.`}>
          {specialties.loading ? <LoadingState /> : specialties.error ? <ErrorState message={specialties.error} onRetry={specialties.reload} /> : !specialties.data?.specialties.length ? <EmptyState title="No specialties" description="The specialty catalogue is empty." /> : (
            <Table head={["Code", "Specialty", "Cadres"]} caption="Specialties">
              {specialties.data.specialties.map((s) => <tr key={s.code}><td className="mv-id">{s.code}</td><td><strong>{s.name}</strong></td><td className="mv-small">{s.cadreCodes.join(", ")}</td></tr>)}
            </Table>
          )}
        </Card>
        <Card title="Regulators" description={`${regulators.data?.regulators.length ?? 0} regulatory bodies.`}>
          {regulators.loading ? <LoadingState /> : regulators.error ? <ErrorState message={regulators.error} onRetry={regulators.reload} /> : !regulators.data?.regulators.length ? <EmptyState title="No regulators" description="The regulator catalogue is empty." /> : (
            <Table head={["Code", "Regulator", "Type"]} caption="Regulators">
              {regulators.data.regulators.map((r) => <tr key={r.code}><td className="mv-id">{r.code}</td><td><strong>{r.name}</strong><div className="mv-small mv-muted">{r.country}</div></td><td>{r.regulatorType}</td></tr>)}
            </Table>
          )}
        </Card>
      </div>
      <Notice>Reference data is platform-governed. Facilities may record local extensions without changing the global catalogue.</Notice>
    </div>
  );
}
