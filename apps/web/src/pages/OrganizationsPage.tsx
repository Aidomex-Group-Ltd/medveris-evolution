import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { OWNERSHIP_TYPES, WORKSPACE_KINDS, serviceCategory, type LevelStatus } from "@medveris/domain";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Tabs } from "@medveris/ui";
import { LevelFields, OWNERSHIP_LABELS, RegistrationFields, classificationPayload, initialClassification, registrationsPayload, type ClassificationValue, type RegistrationValue } from "../components/LevelFields";
import { WORKSPACE_KIND_LABELS } from "../components/WorkspaceSignup";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";
import { LevelBadge } from "./WorkspacePage";

interface OrganizationSummary { id: string; name: string; kind: string; ownership: string | null; status: string; role: string; activeSites: number; pendingLinks: number }

interface LevelDisplay { status: LevelStatus; label: string; source: string; official: boolean }

interface Site {
  linkId: string; tenantId: string; name: string; workspaceKind: string; serviceCategory: string | null; ownership: string | null;
  status: string; origin: string; historyVisibility: string; visibleFrom: string | null; inventoryMode: string; inventoryModeProposed: string | null;
  duplicateFindings: Array<{ tenantId: string; name: string; reason: string }>; requestedAt: string; hostTenantId: string | null;
  registrations: Array<{ kind: string; identifier: string; status: string }>; district: string | null; city: string | null;
  level: LevelDisplay; rollUpLevel: (LevelDisplay & { hostName: string }) | null;
}

interface OrganizationDetail {
  role: string;
  organization: { id: string; name: string; kind: string; ownership: string | null; status: string; contactEmail: string | null };
  sites: Site[];
  members: Array<{ id: string; role: string; displayName: string; email: string; createdAt: string }>;
  invitations: Array<{ id: string; email: string; role: string; expiresAt: string; acceptedAt: string | null; revokedAt: string | null }>;
  joinCodes: Array<{ id: string; label: string; maxUses: number; uses: number; expiresAt: string; revokedAt: string | null }>;
  events: Array<{ event: string; occurredAt: string; siteName: string; actorName: string | null }>;
  permissions: { manage: boolean };
}

type Section = "sites" | "requests" | "add" | "members" | "reports";

const ROLE_LABELS: Record<string, string> = {
  organization_owner: "Organization owner",
  organization_admin: "Organization administrator",
  organization_reporting: "Reporting (read-only aggregates)",
};

export function OrganizationsPage() {
  const [params, setParams] = useSearchParams();
  const list = useQuery<{ organizations: OrganizationSummary[] }>("/organizations");
  const [selected, setSelected] = useState<string | null>(params.get("id"));
  const invitation = params.get("invitation");

  useEffect(() => {
    if (!selected && list.data?.organizations.length === 1) setSelected(list.data.organizations[0]!.id);
  }, [list.data, selected]);

  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Organizations" title="Hospitals, groups and their sites" description="An organization links independent workspaces as sites. Each site keeps its own records, users, inventory and reports; the organization sees aggregate roll-ups only." />
      {invitation ? <AcceptInvitation token={invitation} onDone={() => { setParams({}); list.reload(); }} /> : null}
      {list.loading && !list.data ? <LoadingState /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : (
        <div className="mv-grid mv-grid--2">
          <Card title="Your organizations">
            {!list.data?.organizations.length ? <EmptyState title="No organizations" description="Create one below, or accept an invitation from an organization administrator." /> : (
              <Table head={["Organization", "Your role", "Sites", ""]} caption="Organizations you belong to">
                {list.data.organizations.map((organization) => (
                  <tr key={organization.id}>
                    <td><strong>{organization.name}</strong><div className="mv-small mv-muted">{organization.kind.replace(/-/g, " ")}</div></td>
                    <td className="mv-small">{ROLE_LABELS[organization.role] ?? organization.role}</td>
                    <td className="mv-small">{organization.activeSites} active{organization.pendingLinks ? <> · <Badge tone="warning">{organization.pendingLinks} pending</Badge></> : null}</td>
                    <td><Button size="sm" variant={selected === organization.id ? "primary" : "secondary"} onClick={() => { setSelected(organization.id); setParams({ id: organization.id }); }}>Open</Button></td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
          <CreateOrganization onCreated={(id) => { list.reload(); setSelected(id); setParams({ id }); }} />
        </div>
      )}
      {selected ? <OrganizationConsole key={selected} id={selected} onChanged={list.reload} /> : null}
    </div>
  );
}

function AcceptInvitation({ token, onDone }: { token: string; onDone: () => void }) {
  const action = useAction();
  return (
    <Card title="Organization invitation" description="Accepting gives you organization-level access to aggregate reports for its linked sites. It never opens patient records.">
      {action.error ? <ErrorState message={action.error} /> : null}
      <Button disabled={action.busy !== null} onClick={() => void action.run("accept", async () => {
        await api("/organizations/invitations/accept", { method: "POST", body: { token } });
        onDone();
      })}>Accept invitation</Button>
    </Card>
  );
}

function CreateOrganization({ onCreated }: { onCreated: (id: string) => void }) {
  const { me } = useAuth();
  const administersActive = me?.activeTenant?.roles.includes("facility_admin") ?? false;
  const [form, setForm] = useState({ name: "", kind: "facility-group", ownership: "private-for-profit", linkActiveWorkspace: false, shareHistory: false });
  const action = useAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run("create", async () => {
      const result = await api<{ organization: { id: string } }>("/organizations", { method: "POST", body: {
        name: form.name, kind: form.kind, ownership: form.ownership, linkActiveWorkspace: form.linkActiveWorkspace,
        historyVisibility: form.shareHistory ? "full-history" : "from-link-date",
      } });
      onCreated(result.organization.id);
    });
  }
  return (
    <Card title="Create an organization" description="You become its owner. Add sites, or give join codes to independent workspaces.">
      <form className="mv-stack" onSubmit={submit}>
        {action.error ? <ErrorState message={action.error} /> : null}
        <Field label="Name" htmlFor="co-name"><Input id="co-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required minLength={2} maxLength={200} /></Field>
        <div className="mv-form-grid">
          <Field label="Kind" htmlFor="co-kind"><Select id="co-kind" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}>
            <option value="hospital">Hospital</option><option value="health-system">Health system</option><option value="facility-group">Facility group</option><option value="faith-based-network">Faith-based network</option><option value="other">Other</option>
          </Select></Field>
          <Field label="Ownership" htmlFor="co-ownership"><Select id="co-ownership" value={form.ownership} onChange={(event) => setForm({ ...form, ownership: event.target.value })}>
            {OWNERSHIP_TYPES.map((type) => <option key={type} value={type}>{OWNERSHIP_LABELS[type]}</option>)}
          </Select></Field>
        </div>
        {administersActive ? (
          <>
            <label className="mv-row mv-small"><input type="checkbox" checked={form.linkActiveWorkspace} onChange={(event) => setForm({ ...form, linkActiveWorkspace: event.target.checked })} /> Link {me?.activeTenant?.name} as the first site</label>
            {form.linkActiveWorkspace ? <label className="mv-row mv-small"><input type="checkbox" checked={form.shareHistory} onChange={(event) => setForm({ ...form, shareHistory: event.target.checked })} /> Include its earlier activity in aggregate reports</label> : null}
          </>
        ) : null}
        <div><Button type="submit" disabled={action.busy !== null}>Create organization</Button></div>
      </form>
    </Card>
  );
}

function OrganizationConsole({ id, onChanged }: { id: string; onChanged: () => void }) {
  const detail = useQuery<OrganizationDetail>(`/organizations/${id}`);
  const [section, setSection] = useState<Section>("sites");
  if (detail.loading && !detail.data) return <LoadingState />;
  if (detail.error || !detail.data) return <ErrorState message={detail.error ?? "Organization not found"} onRetry={detail.reload} />;
  const data = detail.data;
  const reload = () => { detail.reload(); onChanged(); };
  const pending = data.sites.filter((site) => site.status === "pending");
  const options: { value: Section; label: string }[] = [
    { value: "sites", label: "Sites" },
    ...(data.permissions.manage ? [{ value: "requests" as Section, label: `Join requests${pending.length ? ` (${pending.length})` : ""}` }, { value: "add" as Section, label: "Add a site" }, { value: "members" as Section, label: "Members" }] : []),
    { value: "reports", label: "Consolidated reports" },
  ];
  return (
    <div className="mv-stack">
      <Card title={data.organization.name} description={`${data.organization.kind.replace(/-/g, " ")} · ${OWNERSHIP_LABELS[data.organization.ownership ?? ""] ?? "ownership not recorded"} · your role: ${ROLE_LABELS[data.role] ?? data.role}`}>
        <Tabs label="Organization sections" value={section} onChange={setSection} options={options} />
      </Card>
      {section === "sites" ? <Sites data={data} onChanged={reload} /> : null}
      {section === "requests" ? <JoinRequests data={data} onChanged={reload} /> : null}
      {section === "add" ? <AddSite data={data} onChanged={reload} /> : null}
      {section === "members" ? <Members data={data} onChanged={reload} /> : null}
      {section === "reports" ? <Reports data={data} /> : null}
    </div>
  );
}

function Sites({ data, onChanged }: { data: OrganizationDetail; onChanged: () => void }) {
  const action = useAction();
  const active = data.sites.filter((site) => site.status === "active");
  async function inventoryMode(site: Site, mode: "independent" | "shared-supply") {
    const note = window.prompt(mode === "shared-supply" ? "Why should this site share supply with other sites? The site administrator must accept." : "Note for returning the site to independent stock:");
    if (!note || note.trim().length < 3) return;
    if (await action.run(`mode-${site.linkId}`, async () => {
      const result = await api<{ pending: boolean }>(`/organizations/${data.organization.id}/links/${site.linkId}/inventory-mode`, { method: "POST", body: { mode, note } });
      return result.pending ? `Shared supply proposed to ${site.name}; it applies once the site administrator accepts.` : `${site.name} now keeps independent stock.`;
    })) onChanged();
  }
  async function end(site: Site) {
    const reason = window.prompt(`Why is ${site.name} leaving the organization? (at least 10 characters) Its records stay with the site.`);
    if (!reason || reason.trim().length < 10) return;
    if (await action.run(`end-${site.linkId}`, async () => { await api(`/organizations/${data.organization.id}/links/${site.linkId}/end`, { method: "POST", body: { reason } }); return `${site.name} is no longer linked.`; })) onChanged();
  }
  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title="Active sites" description="Category, official level and Medveris equivalent are shown as each site recorded them. Units inside a facility inherit the host level for roll-ups only.">
        {!active.length ? <EmptyState title="No active sites" description="Add a site or approve a join request." /> : (
          <Table head={["Site", "Category", "Level", "Identifiers", "History", "Inventory", ""]} caption="Active sites">
            {active.map((site) => (
              <tr key={site.linkId}>
                <td><strong>{site.name}</strong><div className="mv-small mv-muted">{WORKSPACE_KIND_LABELS[site.workspaceKind] ?? site.workspaceKind}{site.district ? ` · ${site.district}` : ""}</div></td>
                <td className="mv-small">{site.serviceCategory ? serviceCategory(site.serviceCategory).label : "—"}</td>
                <td><LevelBadge level={site.level} /><div className="mv-small mv-muted">{site.level.source}</div>{site.rollUpLevel ? <div className="mv-small mv-muted">Roll-up: {site.rollUpLevel.label} (host {site.rollUpLevel.hostName})</div> : null}</td>
                <td className="mv-small">{site.registrations.length ? site.registrations.map((entry) => `${entry.kind}: ${entry.identifier}`).join("; ") : "—"}</td>
                <td className="mv-small">{site.historyVisibility === "full-history" ? "Full history" : site.visibleFrom ? `From ${new Date(site.visibleFrom).toLocaleDateString()}` : "From approval"}</td>
                <td className="mv-small">{site.inventoryMode === "shared-supply" ? "Shared supply" : "Independent"}{site.inventoryModeProposed ? <div><Badge tone="warning">proposed: {site.inventoryModeProposed}</Badge></div> : null}</td>
                <td>{data.permissions.manage ? (
                  <div className="mv-row">
                    {site.inventoryMode === "independent" && !site.inventoryModeProposed ? <Button size="sm" variant="secondary" onClick={() => void inventoryMode(site, "shared-supply")}>Propose shared supply</Button> : null}
                    {site.inventoryMode === "shared-supply" ? <Button size="sm" variant="secondary" onClick={() => void inventoryMode(site, "independent")}>Make independent</Button> : null}
                    <Button size="sm" variant="ghost" onClick={() => void end(site)}>End link</Button>
                  </div>
                ) : null}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {data.events.length ? (
        <Card title="Linking activity">
          <Table head={["When", "Site", "Event", "By"]} caption="Organization link events">
            {data.events.map((event, index) => <tr key={index}><td className="mv-small">{new Date(event.occurredAt).toLocaleString()}</td><td>{event.siteName}</td><td>{event.event.replace(/-/g, " ")}</td><td className="mv-small">{event.actorName ?? "—"}</td></tr>)}
          </Table>
        </Card>
      ) : null}
    </div>
  );
}

function JoinRequests({ data, onChanged }: { data: OrganizationDetail; onChanged: () => void }) {
  const action = useAction();
  const [code, setCode] = useState<{ code: string; notice: string } | null>(null);
  const [codeForm, setCodeForm] = useState({ label: "", maxUses: "1", expiresInDays: "14" });
  const [decision, setDecision] = useState<Record<string, { note: string; resolution: string; host: string }>>({});
  const pending = data.sites.filter((site) => site.status === "pending");
  const hosts = data.sites.filter((site) => site.status === "active" && site.workspaceKind === "facility");

  async function createCode(event: FormEvent) {
    event.preventDefault();
    await action.run("code", async () => {
      const result = await api<{ joinCode: { code: string; notice: string } }>(`/organizations/${data.organization.id}/join-codes`, { method: "POST", body: { label: codeForm.label, maxUses: Number(codeForm.maxUses), expiresInDays: Number(codeForm.expiresInDays) } });
      setCode(result.joinCode);
      setCodeForm({ label: "", maxUses: "1", expiresInDays: "14" });
      onChanged();
    });
  }

  async function decide(site: Site, choice: "approve" | "reject") {
    const input = decision[site.linkId] ?? { note: "", resolution: "", host: "" };
    if (await action.run(`decide-${site.linkId}`, async () => {
      await api(`/organizations/${data.organization.id}/links/${site.linkId}/decision`, { method: "POST", body: {
        decision: choice, note: input.note, ...(input.resolution.trim() ? { duplicateResolution: input.resolution } : {}), ...(choice === "approve" && input.host ? { hostTenantId: input.host } : {}),
      } });
      return choice === "approve" ? `${site.name} is now an active site. Its existing records stay with the site.` : `${site.name}'s request was rejected.`;
    })) onChanged();
  }

  async function revoke(codeId: string) {
    if (await action.run(`revoke-${codeId}`, async () => { await api(`/organizations/${data.organization.id}/join-codes/${codeId}/revoke`, { method: "POST" }); })) onChanged();
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title="Pending join requests" description="Approving links the workspace without moving or copying any record. Possible duplicates must be resolved first.">
        {!pending.length ? <EmptyState title="No pending requests" description="Workspaces that use one of your join codes appear here." /> : (
          <div className="mv-stack">
            {pending.map((site) => {
              const input = decision[site.linkId] ?? { note: "", resolution: "", host: "" };
              const set = (patch: Partial<typeof input>) => setDecision({ ...decision, [site.linkId]: { ...input, ...patch } });
              return (
                <div key={site.linkId} className="mv-stack" style={{ borderBottom: "1px solid var(--mv-border)", paddingBottom: 12 }}>
                  <div className="mv-row"><strong>{site.name}</strong><LevelBadge level={site.level} /><span className="mv-small mv-muted">requested {new Date(site.requestedAt).toLocaleString()} · history: {site.historyVisibility === "full-history" ? "full history offered" : "from approval"}</span></div>
                  {site.duplicateFindings.length ? (
                    <Notice tone="warning" title="Possible duplicate">
                      {site.duplicateFindings.map((finding) => `${finding.name} (${finding.reason})`).join("; ")}. Confirm this is a different place, or reject the request and use the existing site.
                    </Notice>
                  ) : null}
                  <div className="mv-form-grid">
                    <Field label="Decision note" htmlFor={`jr-note-${site.linkId}`}><Input id={`jr-note-${site.linkId}`} value={input.note} onChange={(event) => set({ note: event.target.value })} minLength={3} maxLength={2000} /></Field>
                    {site.duplicateFindings.length ? <Field label="How you confirmed it is not a duplicate" htmlFor={`jr-res-${site.linkId}`}><Input id={`jr-res-${site.linkId}`} value={input.resolution} onChange={(event) => set({ resolution: event.target.value })} maxLength={2000} /></Field> : null}
                    {site.workspaceKind !== "facility" && hosts.length ? (
                      <Field label="Host facility (for roll-ups)" htmlFor={`jr-host-${site.linkId}`}><Select id={`jr-host-${site.linkId}`} value={input.host} onChange={(event) => set({ host: event.target.value })}>
                        <option value="">None</option>{hosts.map((host) => <option key={host.tenantId} value={host.tenantId}>{host.name}</option>)}
                      </Select></Field>
                    ) : null}
                  </div>
                  <div className="mv-row">
                    <Button size="sm" disabled={input.note.trim().length < 3} onClick={() => void decide(site, "approve")}>Approve</Button>
                    <Button size="sm" variant="secondary" disabled={input.note.trim().length < 3} onClick={() => void decide(site, "reject")}>Reject</Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
      <div className="mv-grid mv-grid--2">
        <Card title="Create a join code" description="Give it only to the administrator of the workspace that should join.">
          <form className="mv-stack" onSubmit={createCode}>
            <Field label="Label" htmlFor="jc-label"><Input id="jc-label" value={codeForm.label} onChange={(event) => setCodeForm({ ...codeForm, label: event.target.value })} required minLength={2} maxLength={200} /></Field>
            <div className="mv-form-grid">
              <Field label="Uses" htmlFor="jc-uses"><Input id="jc-uses" type="number" min="1" max="100" value={codeForm.maxUses} onChange={(event) => setCodeForm({ ...codeForm, maxUses: event.target.value })} /></Field>
              <Field label="Valid for (days)" htmlFor="jc-days"><Input id="jc-days" type="number" min="1" max="90" value={codeForm.expiresInDays} onChange={(event) => setCodeForm({ ...codeForm, expiresInDays: event.target.value })} /></Field>
            </div>
            <div><Button type="submit" disabled={action.busy !== null}>Create code</Button></div>
            {code ? <Notice tone="success" title="Join code (shown once)"><span className="mv-id">{code.code}</span><div className="mv-small">{code.notice}</div></Notice> : null}
          </form>
        </Card>
        <Card title="Join codes">
          {!data.joinCodes.length ? <EmptyState title="No codes" description="Codes you create appear here." /> : (
            <Table head={["Label", "Uses", "Expires", ""]} caption="Join codes">
              {data.joinCodes.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.label}</td>
                  <td className="mv-small">{entry.uses} / {entry.maxUses}</td>
                  <td className="mv-small">{entry.revokedAt ? "revoked" : new Date(entry.expiresAt).toLocaleDateString()}</td>
                  <td>{!entry.revokedAt && entry.uses < entry.maxUses && new Date(entry.expiresAt) > new Date() ? <Button size="sm" variant="ghost" onClick={() => void revoke(entry.id)}>Revoke</Button> : null}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}

function AddSite({ data, onChanged }: { data: OrganizationDetail; onChanged: () => void }) {
  const [details, setDetails] = useState({ name: "", workspaceKind: "facility", ownership: data.organization.ownership ?? "private-for-profit", district: "", city: "", hostTenantId: "" });
  const [classification, setClassification] = useState<ClassificationValue>(() => initialClassification("clinic"));
  const [registrations, setRegistrations] = useState<RegistrationValue[]>([]);
  const action = useAction();
  const hosts = data.sites.filter((site) => site.status === "active" && site.workspaceKind === "facility");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await action.run("add", async () => {
      await api(`/organizations/${data.organization.id}/sites`, { method: "POST", body: {
        name: details.name, workspaceKind: details.workspaceKind, ownership: details.ownership, district: details.district, city: details.city, country: "Uganda",
        hostTenantId: details.hostTenantId || null, registrations: registrationsPayload(registrations), ...classificationPayload(classification),
      } });
      setDetails({ ...details, name: "", hostTenantId: "" });
      setRegistrations([]);
      return "Site created. You are its owner; invite its own administrator and staff from its Facility administration page.";
    })) onChanged();
  }
  return (
    <Card title="Add a site, department or unit" description="Each site runs as its own workspace with its own users, inventory and reports.">
      <form className="mv-stack" onSubmit={submit}>
        {action.error ? <ErrorState message={action.error} /> : null}
        {action.message ? <Notice tone="success">{action.message}</Notice> : null}
        <Field label="Name" htmlFor="as-name"><Input id="as-name" value={details.name} onChange={(event) => setDetails({ ...details, name: event.target.value })} required minLength={2} maxLength={200} /></Field>
        <div className="mv-form-grid">
          <Field label="Type" htmlFor="as-kind"><Select id="as-kind" value={details.workspaceKind} onChange={(event) => setDetails({ ...details, workspaceKind: event.target.value })}>
            {WORKSPACE_KINDS.map((kind) => <option key={kind} value={kind}>{WORKSPACE_KIND_LABELS[kind]}</option>)}
          </Select></Field>
          {details.workspaceKind !== "facility" ? (
            <Field label="Inside facility" htmlFor="as-host" hint="Keeps its own category; inherits the host level for roll-ups."><Select id="as-host" value={details.hostTenantId} onChange={(event) => setDetails({ ...details, hostTenantId: event.target.value })}>
              <option value="">Standalone</option>{hosts.map((host) => <option key={host.tenantId} value={host.tenantId}>{host.name}</option>)}
            </Select></Field>
          ) : null}
          <Field label="Ownership" htmlFor="as-ownership"><Select id="as-ownership" value={details.ownership} onChange={(event) => setDetails({ ...details, ownership: event.target.value })}>
            {OWNERSHIP_TYPES.map((type) => <option key={type} value={type}>{OWNERSHIP_LABELS[type]}</option>)}
          </Select></Field>
          <Field label="District" htmlFor="as-district"><Input id="as-district" value={details.district} onChange={(event) => setDetails({ ...details, district: event.target.value })} maxLength={120} /></Field>
          <Field label="Town or city" htmlFor="as-city"><Input id="as-city" value={details.city} onChange={(event) => setDetails({ ...details, city: event.target.value })} maxLength={120} /></Field>
        </div>
        <LevelFields idPrefix="as" value={classification} onChange={setClassification} />
        <RegistrationFields idPrefix="as-reg" category={classification.serviceCategory} value={registrations} onChange={setRegistrations} />
        <div><Button type="submit" disabled={action.busy !== null}>Create site</Button></div>
      </form>
    </Card>
  );
}

function Members({ data, onChanged }: { data: OrganizationDetail; onChanged: () => void }) {
  const [form, setForm] = useState({ email: "", role: "organization_reporting" });
  const action = useAction();
  async function invite(event: FormEvent) {
    event.preventDefault();
    if (await action.run("invite", async () => {
      const result = await api<{ delivery: { delivered: boolean; detail?: string } }>(`/organizations/${data.organization.id}/invitations`, { method: "POST", body: form });
      setForm({ ...form, email: "" });
      return result.delivery.delivered ? "Invitation emailed." : `Invitation created, but the email was not sent: ${result.delivery.detail ?? "delivery failed"}`;
    })) onChanged();
  }
  async function remove(memberId: string) {
    if (!window.confirm("Remove this organization member?")) return;
    if (await action.run(`remove-${memberId}`, async () => { await api(`/organizations/${data.organization.id}/members/${memberId}/remove`, { method: "POST" }); })) onChanged();
  }
  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <div className="mv-grid mv-grid--2">
        <Card title="Invite organization staff" description="Organization roles see aggregate reports across linked sites. Access inside a site is granted separately by that site's administrator.">
          <form className="mv-stack" onSubmit={invite}>
            <Field label="Email" htmlFor="om-email"><Input id="om-email" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required /></Field>
            <Field label="Role" htmlFor="om-role"><Select id="om-role" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>
              <option value="organization_reporting">{ROLE_LABELS.organization_reporting}</option><option value="organization_admin">{ROLE_LABELS.organization_admin}</option>
            </Select></Field>
            <div><Button type="submit" disabled={action.busy !== null}>Send invitation</Button></div>
          </form>
        </Card>
        <Card title="Members">
          <Table head={["Member", "Role", ""]} caption="Organization members">
            {data.members.map((member) => (
              <tr key={member.id}><td><strong>{member.displayName}</strong><div className="mv-small mv-muted">{member.email}</div></td><td className="mv-small">{ROLE_LABELS[member.role] ?? member.role}</td><td><Button size="sm" variant="ghost" onClick={() => void remove(member.id)}>Remove</Button></td></tr>
            ))}
          </Table>
        </Card>
      </div>
      {data.invitations.length ? (
        <Card title="Invitations">
          <Table head={["Email", "Role", "Status"]} caption="Organization invitations">
            {data.invitations.map((entry) => <tr key={entry.id}><td>{entry.email}</td><td className="mv-small">{ROLE_LABELS[entry.role] ?? entry.role}</td><td className="mv-small">{entry.acceptedAt ? "accepted" : entry.revokedAt ? "revoked" : new Date(entry.expiresAt) < new Date() ? "expired" : "pending"}</td></tr>)}
          </Table>
        </Card>
      ) : null}
    </div>
  );
}

interface SummaryReport {
  metadata: { organization: string; from: string; to: string; timeZone: string; generatedAt: string };
  metrics: Array<{ key: string; label: string; definition: string; money?: boolean }>;
  sites: Array<{ tenantId: string; name: string; visibleFrom: string | null; historyVisibility: string; values: Record<string, number>; departments: Array<{ departmentId: string; name: string; values: Record<string, number> }> }>;
  totals: Record<string, number>;
  rollUps: Array<{ tenantId: string; name: string; includes: string[]; values: Record<string, number> }>;
  notes: string[];
}

function isoDate(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function Reports({ data }: { data: OrganizationDetail }) {
  const [range, setRange] = useState({ from: isoDate(-30), to: isoDate(0) });
  const [chosen, setChosen] = useState<string[]>([]);
  const [report, setReport] = useState<SummaryReport | null>(null);
  const action = useAction();
  const active = data.sites.filter((site) => site.status === "active");
  const query = `from=${range.from}&to=${range.to}${chosen.length ? `&sites=${chosen.join(",")}` : ""}`;
  async function run(event: FormEvent) {
    event.preventDefault();
    await action.run("run", async () => { setReport(await api<SummaryReport>(`/organizations/${data.organization.id}/reports/summary?${query}`)); });
  }
  const format = (metric: SummaryReport["metrics"][number], value: number | undefined) => metric.money ? Number(value ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(value ?? 0);
  return (
    <div className="mv-stack">
      <Card title="Consolidated summary" description="Aggregate counts and amounts per site and department. Site activity before its visible-from date is excluded unless the site shared earlier history.">
        <form className="mv-stack" onSubmit={run}>
          {action.error ? <ErrorState message={action.error} /> : null}
          <div className="mv-form-grid">
            <Field label="From" htmlFor="or-from"><Input id="or-from" type="date" value={range.from} onChange={(event) => setRange({ ...range, from: event.target.value })} required /></Field>
            <Field label="To" htmlFor="or-to"><Input id="or-to" type="date" value={range.to} onChange={(event) => setRange({ ...range, to: event.target.value })} required /></Field>
          </div>
          <div className="mv-row mv-small">
            <span className="mv-muted">Sites:</span>
            {active.map((site) => (
              <label key={site.tenantId} className="mv-row"><input type="checkbox" checked={chosen.includes(site.tenantId)} onChange={(event) => setChosen(event.target.checked ? [...chosen, site.tenantId] : chosen.filter((value) => value !== site.tenantId))} />{site.name}</label>
            ))}
            {!chosen.length ? <span className="mv-muted">(all active sites)</span> : null}
          </div>
          <div className="mv-row">
            <Button type="submit" disabled={action.busy !== null}>Run report</Button>
            <a className="mv-small" href={`/api/v1/organizations/${data.organization.id}/reports/summary?${query}&format=csv`}>Download CSV</a>
          </div>
        </form>
      </Card>
      {report ? (
        <>
          <Card title="By site">
            <Table head={["Site", "Visible from", ...report.metrics.map((metric) => metric.label)]} caption={`${report.metadata.from} to ${report.metadata.to}`}>
              {report.sites.map((site) => (
                <tr key={site.tenantId}>
                  <td><strong>{site.name}</strong></td>
                  <td className="mv-small">{site.historyVisibility === "full-history" ? "full history" : site.visibleFrom ? new Date(site.visibleFrom).toLocaleDateString() : "—"}</td>
                  {report.metrics.map((metric) => <td key={metric.key}>{format(metric, site.values[metric.key])}</td>)}
                </tr>
              ))}
              <tr><td><strong>All selected sites</strong></td><td />{report.metrics.map((metric) => <td key={metric.key}><strong>{format(metric, report.totals[metric.key])}</strong></td>)}</tr>
            </Table>
          </Card>
          {report.rollUps.some((rollUp) => rollUp.includes.length > 1) ? (
            <Card title="Facility roll-ups" description="Departments and service units hosted inside a facility counted with it.">
              <Table head={["Facility", "Includes", ...report.metrics.map((metric) => metric.label)]} caption="Facility roll-ups">
                {report.rollUps.map((rollUp) => <tr key={rollUp.tenantId}><td>{rollUp.name}</td><td className="mv-small">{rollUp.includes.join(", ")}</td>{report.metrics.map((metric) => <td key={metric.key}>{format(metric, rollUp.values[metric.key])}</td>)}</tr>)}
              </Table>
            </Card>
          ) : null}
          <Card title="By department">
            <Table head={["Site", "Department", ...report.metrics.map((metric) => metric.label)]} caption="Department-attributed activity">
              {report.sites.flatMap((site) => site.departments.map((department) => (
                <tr key={`${site.tenantId}-${department.departmentId}`}><td>{site.name}</td><td>{department.name}</td>{report.metrics.map((metric) => <td key={metric.key}>{format(metric, department.values[metric.key])}</td>)}</tr>
              )))}
            </Table>
          </Card>
          <Notice tone="info" title="Definitions">
            <ul className="mv-small" style={{ margin: 0, paddingLeft: 18 }}>
              {report.metrics.map((metric) => <li key={metric.key}><strong>{metric.label}:</strong> {metric.definition}</li>)}
              {report.notes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          </Notice>
        </>
      ) : null}
    </div>
  );
}
