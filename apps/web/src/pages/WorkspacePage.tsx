import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { MODULES, OWNERSHIP_TYPES, REGISTRATION_KINDS, serviceCategory, type LevelStatus } from "@medveris/domain";
import { Badge, Button, Card, DataList, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Tabs, Textarea } from "@medveris/ui";
import { LevelFields, OWNERSHIP_LABELS, RegistrationFields, classificationPayload, registrationsPayload, type ClassificationValue, type RegistrationValue } from "../components/LevelFields";
import { WORKSPACE_KIND_LABELS } from "../components/WorkspaceSignup";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { inventoryScope } from "../lib/inventoryScope";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";

interface LevelDisplay { status: LevelStatus; label: string; source: string; official: boolean }

interface WorkspaceResponse {
  workspace: {
    id: string; name: string; workspaceKind: string; serviceCategory: string; serviceSubtype: string | null; ownership: string | null;
    levelStatus: LevelStatus; officialLevel: string | null; officialLevelSource: string | null; officialLevelReference: string | null;
    equivalentLevel: string | null; equivalentJustification: string | null; levelUpdatedAt: string | null;
    city: string | null; district: string | null; region: string | null; address: string | null; country: string | null;
    hostTenantId: string | null; enabledModules: string[]; organizationId: string | null;
  };
  level: LevelDisplay;
  rollUpLevel: (LevelDisplay & { hostName: string }) | null;
  recommendations: { modules: string[]; reports: string[]; hmisCandidates: string[]; notes: string[] };
  registrations: Array<{ id: string; kind: string; issuer: string | null; identifier: string; status: string; validUntil: string | null }>;
  levelHistory: Array<{ recordedAt: string; reason: string | null; recordedByName: string | null; display: LevelDisplay }>;
  organizationLink: { organizationName: string; status: string } | null;
  permissions: { manage: boolean; link: boolean };
}

type Section = "profile" | "registrations" | "modules" | "organization" | "supply";

const LEVEL_TONE: Record<LevelStatus, "success" | "warning" | "neutral" | "info"> = {
  official: "success",
  "medveris-equivalent": "warning",
  "not-applicable": "neutral",
  "not-yet-assigned": "info",
};

export function LevelBadge({ level }: { level: LevelDisplay }) {
  return <span className="mv-level-badge"><Badge tone={LEVEL_TONE[level.status]}>{level.label}</Badge></span>;
}

export function WorkspacePage() {
  const [section, setSection] = useState<Section>("profile");
  const workspace = useQuery<WorkspaceResponse>("/workspace");
  if (workspace.loading && !workspace.data) return <LoadingState variant="page" />;
  if (workspace.error || !workspace.data) return <ErrorState message={workspace.error ?? "Workspace not found"} onRetry={workspace.reload} />;
  const data = workspace.data;
  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow={WORKSPACE_KIND_LABELS[data.workspace.workspaceKind] ?? "Workspace"}
        title={data.workspace.name}
        description="Category, level of care and licences are recorded separately. A level never proves that a service is offered at this site."
        actions={<LevelBadge level={data.level} />}
      />
      <Tabs label="Workspace sections" value={section} onChange={setSection} options={[
        { value: "profile", label: "Profile and level" },
        { value: "registrations", label: "Licences and registry IDs" },
        { value: "modules", label: "Modules" },
        { value: "organization", label: "Organization" },
        { value: "supply", label: "Shared supply" },
      ]} />
      {section === "profile" ? <Profile data={data} onSaved={workspace.reload} /> : null}
      {section === "registrations" ? <Registrations data={data} onSaved={workspace.reload} /> : null}
      {section === "modules" ? <Modules data={data} onSaved={workspace.reload} /> : null}
      {section === "organization" ? <OrganizationLink onChanged={workspace.reload} /> : null}
      {section === "supply" ? <SharedSupply /> : null}
    </div>
  );
}

function Profile({ data, onSaved }: { data: WorkspaceResponse; onSaved: () => void }) {
  const ws = data.workspace;
  const [editing, setEditing] = useState(false);
  const [details, setDetails] = useState({ name: ws.name, ownership: ws.ownership ?? "private-for-profit", city: ws.city ?? "", district: ws.district ?? "", region: ws.region ?? "", address: ws.address ?? "" });
  const [classification, setClassification] = useState<ClassificationValue>({
    serviceCategory: ws.serviceCategory, serviceSubtype: ws.serviceSubtype ?? "", levelStatus: ws.levelStatus,
    officialLevel: ws.officialLevel ?? "", officialLevelSource: ws.officialLevelSource ?? "nhfr", officialLevelReference: ws.officialLevelReference ?? "",
    equivalentLevel: ws.equivalentLevel ?? "", equivalentJustification: ws.equivalentJustification ?? "",
  });
  const [reason, setReason] = useState("");
  const action = useAction();

  async function save(event: FormEvent) {
    event.preventDefault();
    const ok = await action.run("save", async () => {
      await api("/workspace/profile", { method: "PUT", body: { ...details, ...classificationPayload(classification), reason } });
      return "Workspace profile saved. Level changes are kept in the level history.";
    });
    if (ok) {
      setEditing(false);
      onSaved();
    }
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <div className="mv-grid mv-grid--2">
        <Card title="Classification" actions={data.permissions.manage && !editing ? <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Edit</Button> : null}>
          <DataList items={[
            { label: "Category", value: `${serviceCategory(ws.serviceCategory).label}${ws.serviceSubtype ? ` · ${ws.serviceSubtype.replace(/-/g, " ")}` : ""}` },
            { label: "Level of care", value: <><LevelBadge level={data.level} /><div className="mv-small mv-muted">{data.level.source}</div></> },
            ...(ws.levelStatus === "medveris-equivalent" && ws.equivalentJustification ? [{ label: "Scope note", value: ws.equivalentJustification }] : []),
            ...(data.rollUpLevel ? [{ label: "Roll-up level", value: <>{data.rollUpLevel.label}<div className="mv-small mv-muted">{data.rollUpLevel.source} ({data.rollUpLevel.hostName})</div></> }] : []),
            { label: "Ownership", value: OWNERSHIP_LABELS[ws.ownership ?? ""] ?? "Not recorded" },
            { label: "Location", value: [ws.address, ws.city, ws.district, ws.region, ws.country].filter(Boolean).join(", ") || "Not recorded" },
            { label: "Organization", value: data.organizationLink ? `${data.organizationLink.organizationName} (${data.organizationLink.status})` : "Independent workspace" },
          ]} />
        </Card>
        <Card title="Recommended setup" description="Starting points from category and level; enable only what the site actually provides.">
          <div className="mv-stack mv-small" style={{ gap: 8 }}>
            <div><strong>Modules:</strong> {data.recommendations.modules.map((code) => MODULES.find((module) => module.code === code)?.label ?? code).join(", ")}</div>
            <div><strong>Reports:</strong> {data.recommendations.reports.join(", ")}</div>
            <div><strong>National HMIS forms to confirm:</strong> {data.recommendations.hmisCandidates.length ? <>{data.recommendations.hmisCandidates.join(", ")} — <Link to="/ehmis">eHMIS reporting</Link></> : "None for this category"}</div>
            {data.recommendations.notes.map((note) => <div className="mv-muted" key={note}>{note}</div>)}
          </div>
        </Card>
      </div>
      {editing ? (
        <Card title="Edit profile and level" description="An official level is never replaced silently; give a reason when you change it.">
          <form className="mv-stack" onSubmit={save}>
            <div className="mv-form-grid">
              <Field label="Name" htmlFor="wp-name"><Input id="wp-name" value={details.name} onChange={(event) => setDetails({ ...details, name: event.target.value })} required minLength={2} maxLength={200} /></Field>
              <Field label="Ownership" htmlFor="wp-ownership">
                <Select id="wp-ownership" value={details.ownership} onChange={(event) => setDetails({ ...details, ownership: event.target.value })}>
                  {OWNERSHIP_TYPES.map((type) => <option key={type} value={type}>{OWNERSHIP_LABELS[type]}</option>)}
                </Select>
              </Field>
              <Field label="District" htmlFor="wp-district"><Input id="wp-district" value={details.district} onChange={(event) => setDetails({ ...details, district: event.target.value })} maxLength={120} /></Field>
              <Field label="Town or city" htmlFor="wp-city"><Input id="wp-city" value={details.city} onChange={(event) => setDetails({ ...details, city: event.target.value })} maxLength={120} /></Field>
              <Field label="Region" htmlFor="wp-region"><Input id="wp-region" value={details.region} onChange={(event) => setDetails({ ...details, region: event.target.value })} maxLength={120} /></Field>
              <Field label="Address" htmlFor="wp-address"><Input id="wp-address" value={details.address} onChange={(event) => setDetails({ ...details, address: event.target.value })} maxLength={300} /></Field>
            </div>
            <LevelFields idPrefix="wp" value={classification} onChange={setClassification} />
            <Field label="Reason for the change" htmlFor="wp-reason" hint="Required when an official level is removed."><Textarea id="wp-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} /></Field>
            <div className="mv-row">
              <Button type="submit" disabled={action.busy !== null}>{action.busy ? "Saving…" : "Save"}</Button>
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </form>
        </Card>
      ) : null}
      <Card title="Level history" description="Every recorded level with its source and who recorded it.">
        {!data.levelHistory.length ? <EmptyState title="No history" description="Level changes appear here." /> : (
          <Table head={["Recorded", "Level", "Source", "By", "Reason"]} caption="Level of care history">
            {data.levelHistory.map((entry, index) => (
              <tr key={`${entry.recordedAt}-${index}`}>
                <td className="mv-small">{new Date(entry.recordedAt).toLocaleString()}</td>
                <td><LevelBadge level={entry.display} /></td>
                <td className="mv-small">{entry.display.source}</td>
                <td className="mv-small">{entry.recordedByName ?? "—"}</td>
                <td className="mv-small">{entry.reason ?? "—"}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function Registrations({ data, onSaved }: { data: WorkspaceResponse; onSaved: () => void }) {
  const [entries, setEntries] = useState<RegistrationValue[]>([]);
  const action = useAction();
  const kindLabel = (code: string) => REGISTRATION_KINDS.find((kind) => kind.code === code)?.label ?? code;

  async function add(event: FormEvent) {
    event.preventDefault();
    const ok = await action.run("add", async () => {
      for (const entry of registrationsPayload(entries)) await api("/workspace/registrations", { method: "POST", body: entry });
      return "Identifiers recorded. They are shown as recorded until verified.";
    });
    if (ok) {
      setEntries([]);
      onSaved();
    }
  }

  async function withdraw(id: string) {
    if (!window.confirm("Withdraw this identifier? It stays in the audit trail.")) return;
    if (await action.run(`withdraw-${id}`, async () => { await api(`/workspace/registrations/${id}/status`, { method: "POST", body: { status: "withdrawn" } }); })) onSaved();
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Notice tone="info" title="Recorded, not verified">Medveris has no approved National Health Facility Registry interface yet, so NHFR IDs and licences are entered by hand and are not checked against the registry.</Notice>
      <Card title="Licences and registry identifiers">
        {!data.registrations.length ? <EmptyState title="No identifiers recorded" description="Add the regulator licence or NHFR ID that applies to this workspace." /> : (
          <Table head={["Type", "Identifier", "Issuer", "Status", ""]} caption="Recorded identifiers">
            {data.registrations.map((entry) => (
              <tr key={entry.id}>
                <td>{kindLabel(entry.kind)}</td>
                <td className="mv-id">{entry.identifier}</td>
                <td className="mv-small">{entry.issuer ?? "—"}</td>
                <td><Badge tone={entry.status === "verified" ? "success" : entry.status === "recorded" ? "info" : "neutral"}>{entry.status}</Badge></td>
                <td>{data.permissions.manage && entry.status !== "withdrawn" ? <Button size="sm" variant="ghost" onClick={() => void withdraw(entry.id)}>Withdraw</Button> : null}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {data.permissions.manage ? (
        <Card title="Add identifiers">
          <form className="mv-stack" onSubmit={add}>
            <RegistrationFields idPrefix="wr" category={data.workspace.serviceCategory} value={entries} onChange={setEntries} />
            {entries.length ? <div><Button type="submit" disabled={action.busy !== null}>Save identifiers</Button></div> : null}
          </form>
        </Card>
      ) : null}
    </div>
  );
}

function Modules({ data, onSaved }: { data: WorkspaceResponse; onSaved: () => void }) {
  const [selected, setSelected] = useState<string[]>(data.workspace.enabledModules);
  const action = useAction();
  const recommended = new Set(data.recommendations.modules);
  async function save() {
    if (await action.run("modules", async () => {
      await api("/workspace/modules", { method: "PUT", body: { modules: selected } });
      return "Module selection saved.";
    })) onSaved();
  }
  return (
    <Card title="Modules in use" description="Choose the services this site actually provides. Recommendations come from the category and level and can be changed at any time.">
      <div className="mv-stack">
        {action.error ? <ErrorState message={action.error} /> : null}
        {action.message ? <Notice tone="success">{action.message}</Notice> : null}
        <div className="mv-form-grid">
          {MODULES.map((module) => (
            <label key={module.code} className="mv-row mv-small">
              <input type="checkbox" disabled={!data.permissions.manage} checked={selected.includes(module.code)}
                onChange={(event) => setSelected(event.target.checked ? [...selected, module.code] : selected.filter((code) => code !== module.code))} />
              {module.label}
              {recommended.has(module.code) ? <Badge tone="info">suggested</Badge> : null}
            </label>
          ))}
        </div>
        {data.permissions.manage ? <div><Button onClick={() => void save()} disabled={action.busy !== null}>Save modules</Button></div> : null}
      </div>
    </Card>
  );
}

interface LinkResponse {
  link: null | {
    id: string; status: string; organizationName: string; organizationKind: string; requestedAt: string; decidedAt: string | null;
    historyVisibility: string; visibleFrom: string | null; inventoryMode: string; inventoryModeProposed: string | null; duplicateFindings: unknown[];
  };
  history: Array<{ id: string; status: string; organizationName: string; requestedAt: string; endedAt: string | null; endReason: string | null }>;
  events: Array<{ event: string; occurredAt: string; actorName: string | null; detail: Record<string, unknown> }>;
  permissions: { manage: boolean };
}

function OrganizationLink({ onChanged }: { onChanged: () => void }) {
  const query = useQuery<LinkResponse>("/workspace/organization");
  const action = useAction();
  const [joinCode, setJoinCode] = useState("");
  const [shareHistory, setShareHistory] = useState(false);
  const [note, setNote] = useState("");
  if (query.loading && !query.data) return <LoadingState />;
  if (query.error || !query.data) return <ErrorState message={query.error ?? "Unavailable"} onRetry={query.reload} />;
  const { link, permissions } = query.data;
  const done = () => { query.reload(); onChanged(); };

  async function request(event: FormEvent) {
    event.preventDefault();
    if (await action.run("request", async () => {
      const result = await api<{ possibleDuplicates: number }>("/workspace/organization/link-request", { method: "POST", body: { joinCode: joinCode.trim(), historyVisibility: shareHistory ? "full-history" : "from-link-date" } });
      setJoinCode("");
      return result.possibleDuplicates
        ? "Request sent. The organization found sites that may be the same as this workspace and must resolve that before approving."
        : "Request sent. Nothing is shared until an organization administrator approves.";
    })) done();
  }

  async function post(key: string, path: string, body: unknown, message: string) {
    if (await action.run(key, async () => { await api(path, { method: "POST", body }); return message; })) done();
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Notice tone="info" title="What a parent organization can see">Organization staff see aggregate counts and amounts for linked sites from the approval date, unless you share earlier history. They never open patient records through the link, and every record stays with this workspace if the link ends.</Notice>
      {link ? (
        <Card title={link.organizationName} description={`Link ${link.status}`}>
          <DataList items={[
            { label: "Status", value: <Badge tone={link.status === "active" ? "success" : "info"}>{link.status}</Badge> },
            { label: "Requested", value: new Date(link.requestedAt).toLocaleString() },
            { label: "History in roll-ups", value: link.historyVisibility === "full-history" ? "Full history shared" : link.visibleFrom ? `From ${new Date(link.visibleFrom).toLocaleDateString()}` : "From approval" },
            { label: "Inventory", value: link.inventoryMode === "shared-supply" ? "Shared supply with other sites" : "Independent stock" },
          ]} />
          {permissions.manage ? (
            <div className="mv-stack" style={{ marginTop: 12 }}>
              {link.inventoryModeProposed ? (
                <Notice tone="warning" title="Inventory change proposed">
                  The organization proposes <strong>{link.inventoryModeProposed === "shared-supply" ? "shared supply" : "independent stock"}</strong>. Shared supply lets this site send stock to and receive stock from other shared-supply sites; each site keeps its own ledger.
                </Notice>
              ) : null}
              <Field label="Note" htmlFor="ol-note" hint="Recorded with your decision (at least 10 characters for history or leaving)."><Textarea id="ol-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} /></Field>
              <div className="mv-row">
                {link.status === "pending" ? <Button variant="secondary" onClick={() => void post("withdraw", "/workspace/organization/withdraw", {}, "Request withdrawn.")}>Withdraw request</Button> : null}
                {link.historyVisibility !== "full-history" ? <Button variant="secondary" disabled={note.trim().length < 10} onClick={() => void post("history", "/workspace/organization/history", { reason: note }, "Earlier history is now included in the organization's aggregate reports.")}>Share earlier history</Button> : null}
                {link.inventoryModeProposed ? (
                  <>
                    <Button disabled={note.trim().length < 3} onClick={() => void post("accept", "/workspace/organization/inventory-mode", { accept: true, note }, "Inventory change accepted.")}>Accept inventory change</Button>
                    <Button variant="ghost" disabled={note.trim().length < 3} onClick={() => void post("decline", "/workspace/organization/inventory-mode", { accept: false, note }, "Inventory change declined.")}>Decline</Button>
                  </>
                ) : null}
                {link.status === "active" ? <Button variant="danger" disabled={note.trim().length < 10} onClick={() => { if (window.confirm("Leave this organization? Your records stay here; the organization loses access to new activity.")) void post("end", "/workspace/organization/end", { reason: note }, "The workspace has left the organization."); }}>Leave organization</Button> : null}
              </div>
            </div>
          ) : null}
        </Card>
      ) : (
        <Card title="Independent workspace" description="This workspace operates on its own. To join a hospital or facility group, ask its administrator for a join code.">
          {permissions.manage ? (
            <form className="mv-stack" onSubmit={request}>
              <Field label="Join code" htmlFor="ol-code"><Input id="ol-code" value={joinCode} onChange={(event) => setJoinCode(event.target.value)} minLength={12} maxLength={64} required autoComplete="off" /></Field>
              <label className="mv-row mv-small"><input type="checkbox" checked={shareHistory} onChange={(event) => setShareHistory(event.target.checked)} /> Include activity from before approval in aggregate reports</label>
              <div><Button type="submit" disabled={action.busy !== null}>Request to join</Button></div>
            </form>
          ) : <p className="mv-small mv-muted">Only the workspace owner or administrator can request a link.</p>}
        </Card>
      )}
      {query.data.events.length ? (
        <Card title="Link activity">
          <Table head={["When", "Event", "By"]} caption="Organization link events">
            {query.data.events.map((event, index) => (
              <tr key={index}><td className="mv-small">{new Date(event.occurredAt).toLocaleString()}</td><td>{event.event.replace(/-/g, " ")}</td><td className="mv-small">{event.actorName ?? "—"}</td></tr>
            ))}
          </Table>
        </Card>
      ) : null}
      {query.data.history.filter((entry) => !["pending", "active"].includes(entry.status)).length ? (
        <Card title="Earlier links">
          <Table head={["Organization", "Status", "Requested", "Ended"]} caption="Earlier organization links">
            {query.data.history.filter((entry) => !["pending", "active"].includes(entry.status)).map((entry) => (
              <tr key={entry.id}><td>{entry.organizationName}</td><td>{entry.status}</td><td className="mv-small">{new Date(entry.requestedAt).toLocaleDateString()}</td><td className="mv-small">{entry.endedAt ? `${new Date(entry.endedAt).toLocaleDateString()} — ${entry.endReason ?? ""}` : "—"}</td></tr>
            ))}
          </Table>
        </Card>
      ) : null}
    </div>
  );
}

interface SupplyResponse {
  sites: Array<{ tenantId: string; name: string }>;
  transfers: Array<{
    id: string; transferNumber: string; status: string; itemCode: string; itemName: string; lotNumber: string | null; expiresOn: string | null;
    quantity: string; unit: string; baseQuantity: string; receivedQuantity: string | null; reason: string; dispatchedAt: string;
    sourceName: string; destinationName: string; outgoing: boolean;
  }>;
  permissions: { transfer: boolean };
}

interface ItemRow { id: string; itemCode: string; name: string; baseUnit: string; units: Array<{ unit: string }> | null }
interface LocationRow { id: string; code: string; name: string }
interface StockRow { lotId: string | null; lotNumber: string | null; expiresOn: string | null; available: number }

function SharedSupply() {
  const { me } = useAuth();
  const scope = inventoryScope(me?.activeTenant?.roles);
  const supply = useQuery<SupplyResponse>("/workspace/shared-supply");
  const items = useQuery<{ items: ItemRow[] }>("/inventory/items?status=active");
  const locations = useQuery<{ locations: LocationRow[] }>(`/inventory/locations?${scope}`);
  const action = useAction();
  const [form, setForm] = useState({ destinationTenantId: "", sourceLocationId: "", itemId: "", lotId: "", quantity: "", unit: "", reason: "" });
  const [receiving, setReceiving] = useState<SupplyResponse["transfers"][number] | null>(null);
  const [receipt, setReceipt] = useState({ destinationLocationId: "", destinationItemId: "", receivedQuantity: "", discrepancyNote: "" });
  const stock = useQuery<{ stock: StockRow[] }>(form.itemId && form.sourceLocationId ? `/inventory/stock?${scope}&locationId=${form.sourceLocationId}&itemId=${form.itemId}` : null);
  const item = items.data?.items.find((entry) => entry.id === form.itemId);

  useEffect(() => {
    if (!receiving || !items.data) return;
    const match = items.data.items.find((entry) => entry.itemCode === receiving.itemCode);
    setReceipt({ destinationLocationId: "", destinationItemId: match?.id ?? "", receivedQuantity: receiving.baseQuantity, discrepancyNote: "" });
  }, [receiving, items.data]);

  if (supply.loading && !supply.data) return <LoadingState />;
  if (supply.error || !supply.data) return <ErrorState message={supply.error ?? "Unavailable"} onRetry={supply.reload} />;

  async function dispatch(event: FormEvent) {
    event.preventDefault();
    if (await action.run("dispatch", async () => {
      const result = await api<{ transfer: { transferNumber: string } }>("/workspace/shared-supply/transfers", {
        method: "POST", body: { ...form, lotId: form.lotId || null, quantity: Number(form.quantity) },
      });
      setForm({ ...form, quantity: "", reason: "" });
      return `Transfer ${result.transfer.transferNumber} dispatched; the stock has left this site's books.`;
    })) supply.reload();
  }

  async function receive(event: FormEvent) {
    event.preventDefault();
    if (!receiving) return;
    if (await action.run("receive", async () => {
      await api(`/workspace/shared-supply/transfers/${receiving.id}/receive`, { method: "POST", body: { ...receipt, receivedQuantity: Number(receipt.receivedQuantity) } });
      setReceiving(null);
      return "Transfer received into this site's stock.";
    })) supply.reload();
  }

  async function cancel(id: string) {
    const reason = window.prompt("Why is this transfer cancelled? (at least 10 characters)");
    if (!reason || reason.trim().length < 10) return;
    if (await action.run(`cancel-${id}`, async () => { await api(`/workspace/shared-supply/transfers/${id}/cancel`, { method: "POST", body: { reason } }); return "Transfer cancelled and the stock returned."; })) supply.reload();
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Notice tone="info" title="Inventory stays independent by default">Stock moves between sites only when the organization proposed shared supply and both sites accepted it. Each site posts the movement to its own ledger.</Notice>
      {supply.data.permissions.transfer && supply.data.sites.length ? (
        <Card title="Send stock to another site">
          <form className="mv-stack" onSubmit={dispatch}>
            <div className="mv-form-grid">
              <Field label="Destination site" htmlFor="ss-dest"><Select id="ss-dest" value={form.destinationTenantId} onChange={(event) => setForm({ ...form, destinationTenantId: event.target.value })} required>
                <option value="">Choose a site</option>{supply.data.sites.map((site) => <option key={site.tenantId} value={site.tenantId}>{site.name}</option>)}
              </Select></Field>
              <Field label="From location" htmlFor="ss-loc"><Select id="ss-loc" value={form.sourceLocationId} onChange={(event) => setForm({ ...form, sourceLocationId: event.target.value, lotId: "" })} required>
                <option value="">Choose a location</option>{locations.data?.locations.map((location) => <option key={location.id} value={location.id}>{location.name} ({location.code})</option>)}
              </Select></Field>
              <Field label="Item" htmlFor="ss-item"><Select id="ss-item" value={form.itemId} onChange={(event) => { const next = items.data?.items.find((entry) => entry.id === event.target.value); setForm({ ...form, itemId: event.target.value, unit: next?.baseUnit ?? "", lotId: "" }); }} required>
                <option value="">Choose an item</option>{items.data?.items.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} ({entry.itemCode})</option>)}
              </Select></Field>
              <Field label="Lot" htmlFor="ss-lot"><Select id="ss-lot" value={form.lotId} onChange={(event) => setForm({ ...form, lotId: event.target.value })}>
                <option value="">No lot</option>{stock.data?.stock.filter((row) => row.lotId).map((row) => <option key={row.lotId!} value={row.lotId!}>{row.lotNumber} · exp {row.expiresOn?.slice(0, 10) ?? "—"} · {row.available} available</option>)}
              </Select></Field>
              <Field label="Quantity" htmlFor="ss-qty"><Input id="ss-qty" type="number" min="0" step="any" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} required /></Field>
              <Field label="Unit" htmlFor="ss-unit"><Select id="ss-unit" value={form.unit} onChange={(event) => setForm({ ...form, unit: event.target.value })} required>
                {(item?.units ?? [{ unit: item?.baseUnit ?? "" }]).map((unit) => <option key={unit.unit} value={unit.unit}>{unit.unit}</option>)}
              </Select></Field>
            </div>
            <Field label="Reason" htmlFor="ss-reason"><Input id="ss-reason" value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} minLength={3} maxLength={500} required /></Field>
            <div><Button type="submit" disabled={action.busy !== null}>Dispatch</Button></div>
          </form>
        </Card>
      ) : !supply.data.sites.length ? <EmptyState title="No shared-supply partners" description="Shared supply is available only between sites of the same organization that have each accepted it." /> : null}
      {receiving ? (
        <Card title={`Receive ${receiving.transferNumber}`} description={`${receiving.baseQuantity} base units of ${receiving.itemName} from ${receiving.sourceName}`}>
          <form className="mv-stack" onSubmit={receive}>
            <div className="mv-form-grid">
              <Field label="Into location" htmlFor="sr-loc"><Select id="sr-loc" value={receipt.destinationLocationId} onChange={(event) => setReceipt({ ...receipt, destinationLocationId: event.target.value })} required>
                <option value="">Choose a location</option>{locations.data?.locations.map((location) => <option key={location.id} value={location.id}>{location.name} ({location.code})</option>)}
              </Select></Field>
              <Field label="As item" htmlFor="sr-item" hint="This site's own catalogue item."><Select id="sr-item" value={receipt.destinationItemId} onChange={(event) => setReceipt({ ...receipt, destinationItemId: event.target.value })} required>
                <option value="">Choose an item</option>{items.data?.items.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} ({entry.itemCode})</option>)}
              </Select></Field>
              <Field label="Quantity received (base unit)" htmlFor="sr-qty"><Input id="sr-qty" type="number" min="0" step="any" value={receipt.receivedQuantity} onChange={(event) => setReceipt({ ...receipt, receivedQuantity: event.target.value })} required /></Field>
            </div>
            <Field label="Discrepancy note" htmlFor="sr-note" hint="Required when the quantity differs from what was dispatched."><Input id="sr-note" value={receipt.discrepancyNote} onChange={(event) => setReceipt({ ...receipt, discrepancyNote: event.target.value })} maxLength={1000} /></Field>
            <div className="mv-row"><Button type="submit" disabled={action.busy !== null}>Receive</Button><Button type="button" variant="ghost" onClick={() => setReceiving(null)}>Cancel</Button></div>
          </form>
        </Card>
      ) : null}
      <Card title="Inter-site transfers">
        {!supply.data.transfers.length ? <EmptyState title="No transfers" description="Dispatched and received inter-site transfers appear here." /> : (
          <Table head={["Number", "Direction", "Item", "Quantity", "Status", ""]} caption="Inter-site transfers">
            {supply.data.transfers.map((transfer) => (
              <tr key={transfer.id}>
                <td className="mv-id">{transfer.transferNumber}<div className="mv-small mv-muted">{new Date(transfer.dispatchedAt).toLocaleString()}</div></td>
                <td className="mv-small">{transfer.outgoing ? `To ${transfer.destinationName}` : `From ${transfer.sourceName}`}</td>
                <td>{transfer.itemName}<div className="mv-small mv-muted">{transfer.lotNumber ? `Lot ${transfer.lotNumber}` : transfer.itemCode}</div></td>
                <td>{transfer.quantity} {transfer.unit}{transfer.receivedQuantity ? <div className="mv-small mv-muted">received {transfer.receivedQuantity}</div> : null}</td>
                <td><Badge tone={transfer.status === "received" ? "success" : transfer.status === "dispatched" ? "info" : "neutral"}>{transfer.status}</Badge></td>
                <td>
                  {transfer.status === "dispatched" && !transfer.outgoing ? <Button size="sm" onClick={() => setReceiving(transfer)}>Receive</Button> : null}
                  {transfer.status === "dispatched" && transfer.outgoing && supply.data!.permissions.transfer ? <Button size="sm" variant="ghost" onClick={() => void cancel(transfer.id)}>Cancel</Button> : null}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
