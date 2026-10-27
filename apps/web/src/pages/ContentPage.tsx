import { useMemo, useState, type FormEvent } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Tabs, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { formatDate, formatDateTime, futureIso, todayInput } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";
import type { Role } from "../lib/types";

type Tab = "feed" | "saved" | "opportunities" | "editorial" | "governance";

interface AccessSummary { permissions: string[]; roles: string[] }

interface FeedItem {
  id: string;
  contentType: string;
  slug: string;
  title: string;
  summary: string;
  sourceOrganization: string | null;
  publicationDate: string | null;
  audience: string;
  specialtyTags: string[];
  visibilityScope: string;
  attribution: string | null;
  sponsorshipDisclosure: string | null;
  peerReviewStatus: string | null;
  correctionStatus: string | null;
  clinicalReviewed: boolean;
  publishedAt: string | null;
  reviewDueOn: string | null;
  sourceName: string | null;
}

interface ContentDetail { item: FeedItem & { body: string | null; sourceUrl: string | null; reuseTerms: string | null; findingsSummary: string | null; limitations: string | null; population: string | null; studyType: string | null; correctionNote: string | null }; bookmarked: boolean }

interface Bookmark { id: string; title: string; summary: string; contentType: string; publicationDate: string | null; sourceOrganization: string | null }

interface Preferences { language: string; geography: string | null; specialtyTags: string[]; interests: string[]; hidePatientOpportunities: boolean; hideProfessionalOpportunities: boolean }

interface Opportunity {
  id: string;
  opportunityType: string;
  title: string;
  description: string;
  organization: string;
  audience: string;
  specialtyTags: string[];
  eligibility: string | null;
  location: string | null;
  remote: boolean;
  applicationUrl: string | null;
  contactRoute: string | null;
  opensOn: string | null;
  closesOn: string | null;
  compensation: string | null;
  cpdDetails: string | null;
  verificationStatus: string;
  sponsorshipStatus: string;
}

interface EditorialItem { id: string; contentType: string; slug: string; title: string; status: string; version: number; visibilityScope: string; publicationDate: string | null; reviewDueOn: string | null; updatedAt: string; authorName: string }

interface RoleGrant { id: string; userId: string; userName: string; email: string; role: string; departmentName: string | null; status: string; scopeNote: string | null; startsAt: string; expiresAt: string | null; requestedByName: string | null; approvedByName: string | null }

interface CareTeamMember { id: string; patientId: string; publicId: string; givenName: string; familyName: string; userName: string | null; relationship: string; departmentName: string | null; status: string; startsAt: string; endsAt: string | null }

const CONTENT_TYPES = [
  ["public-health-advisory", "Public-health advisory"],
  ["health-education", "Health education"],
  ["research-update", "Research update"],
  ["guideline", "Guideline"],
  ["professional-learning", "Professional learning"],
  ["facility-announcement", "Facility announcement"],
] as const;

const REPORT_REASONS = ["inaccurate", "outdated", "unsafe", "spam", "copyright", "privacy", "other"] as const;

const ASSIGNABLE_ROLES: Role[] = [
  "receptionist", "nurse", "midwife", "clinician", "specialist_clinician", "diagnostic_practitioner", "department_lead",
  "facility_admin", "finance", "auditor", "pharmacist", "laboratory", "radiology", "public_health", "hr", "records",
  "theatre", "housekeeping", "porter", "mortuary", "cssd", "biomedical", "quality", "it_admin", "research",
  "content_editor", "content_reviewer", "opportunity_moderator",
];

function human(value: string): string {
  return value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function typeLabel(value: string): string {
  return CONTENT_TYPES.find(([code]) => code === value)?.[1] ?? human(value);
}

export function ContentPage() {
  const access = useQuery<AccessSummary>("/access/summary");
  const [tab, setTab] = useState<Tab>("feed");
  const permissions = useMemo(() => new Set(access.data?.permissions ?? []), [access.data]);
  const can = (permission: string) => permissions.has(permission);

  const tabs: { value: Tab; label: string }[] = [{ value: "feed", label: "Health library" }, { value: "saved", label: "Saved and preferences" }, { value: "opportunities", label: "Opportunities" }];
  if (can("content.draft") || can("content.review")) tabs.push({ value: "editorial", label: "Editorial" });
  if (can("role_grant.request") || can("audit.read")) tabs.push({ value: "governance", label: "Access governance" });

  if (access.loading) return <LoadingState label="Loading library access" />;
  if (access.error) return <ErrorState message={access.error} onRetry={access.reload} />;

  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow="Knowledge and opportunities"
        title="Library and professional opportunities"
        description="Non-clinical content carries its source, attribution, review status and corrections. Patient audiences only receive content published for them."
      />
      <Tabs label="Library sections" value={tab} onChange={setTab} options={tabs} />
      {tab === "feed" ? <FeedWorkspace /> : null}
      {tab === "saved" ? <SavedWorkspace /> : null}
      {tab === "opportunities" ? <OpportunitiesWorkspace /> : null}
      {tab === "editorial" ? <EditorialWorkspace can={can} /> : null}
      {tab === "governance" ? <GovernanceWorkspace can={can} roles={access.data?.roles ?? []} /> : null}
    </div>
  );
}

function FeedWorkspace() {
  const [search, setSearch] = useState("");
  const [contentType, setContentType] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  const [reason, setReason] = useState<string>("inaccurate");
  const [detail, setDetail] = useState("");
  const query = `/content?limit=20${search ? `&q=${encodeURIComponent(search)}` : ""}${contentType ? `&type=${contentType}` : ""}`;
  const feed = useQuery<{ items: FeedItem[]; total: number }>(query);
  const item = useQuery<ContentDetail>(selected ? `/content/${selected}` : null);
  const action = useAction();

  async function bookmark(id: string) {
    await action.run(`bookmark-${id}`, async () => {
      await api(`/content/${id}/bookmark`, { method: "POST" });
      item.reload();
      return "Saved to your bookmarks.";
    });
  }

  async function removeBookmark(id: string) {
    await action.run(`unbookmark-${id}`, async () => {
      await api(`/content/${id}/bookmark`, { method: "DELETE" });
      item.reload();
      return "Removed from your bookmarks.";
    });
  }

  async function submitReport(event: FormEvent) {
    event.preventDefault();
    if (!reporting) return;
    await action.run("report", async () => {
      await api(`/content/${reporting}/report`, { method: "POST", body: { reason, detail } });
      setReporting(null);
      setDetail("");
      return "Report submitted for editorial review.";
    });
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title="Search published content" description="Only content whose visibility and audience match your role and department is returned.">
        <div className="mv-form-grid">
          <Field label="Search"><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Title or summary" /></Field>
          <Field label="Type"><Select value={contentType} onChange={(event) => setContentType(event.target.value)}><option value="">All types</option>{CONTENT_TYPES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</Select></Field>
        </div>
      </Card>
      {reporting ? (
        <Card title="Report content" description="Reports are triaged by an independent reviewer.">
          <form className="mv-stack" onSubmit={submitReport}>
            <Field label="Reason"><Select value={reason} onChange={(event) => setReason(event.target.value)}>{REPORT_REASONS.map((value) => <option key={value} value={value}>{human(value)}</option>)}</Select></Field>
            <Field label="Detail"><Textarea value={detail} onChange={(event) => setDetail(event.target.value)} rows={3} maxLength={2000} /></Field>
            <div className="mv-row"><Button type="submit" disabled={action.busy !== null}>Submit report</Button><Button type="button" variant="ghost" onClick={() => setReporting(null)}>Cancel</Button></div>
          </form>
        </Card>
      ) : null}
      {feed.loading ? <LoadingState /> : feed.error ? <ErrorState message={feed.error} onRetry={feed.reload} /> : !feed.data?.items.length ? <EmptyState title="No published content" description="Content appears here once it has been independently reviewed and published for your audience." /> : (
        <Card title={`Published content (${feed.data.total})`}>
          <ul className="mv-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {feed.data.items.map((row) => (
              <li key={row.id} className="mv-spread">
                <div>
                  <strong>{row.title}</strong>
                  <div className="mv-small mv-muted">{typeLabel(row.contentType)} · {row.sourceName ?? row.sourceOrganization ?? "Medveris"} · {formatDate(row.publicationDate)}</div>
                  <div className="mv-small">{row.summary}</div>
                  <div className="mv-row" style={{ marginTop: 6 }}>
                    <Badge tone="neutral">{human(row.audience)}</Badge>
                    {row.clinicalReviewed ? <Badge tone="success">Clinically reviewed</Badge> : <Badge tone="warning">Not clinically reviewed</Badge>}
                    {row.correctionStatus && row.correctionStatus !== "none" ? <Badge tone="danger">{human(row.correctionStatus)}</Badge> : null}
                  </div>
                </div>
                <div className="mv-row">
                  <Button variant="secondary" size="sm" onClick={() => setSelected(selected === row.id ? null : row.id)}>{selected === row.id ? "Close" : "Read"}</Button>
                  <Button variant="ghost" size="sm" onClick={() => setReporting(row.id)}>Report</Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {selected ? (
        <Card title="Content detail" description="Source and attribution are retained. Corrections remain visible.">
          {item.loading ? <LoadingState /> : item.error ? <ErrorState message={item.error} onRetry={item.reload} /> : item.data ? (
            <div className="mv-stack">
              <h3 style={{ margin: 0 }}>{item.data.item.title}</h3>
              <div className="mv-small mv-muted">{typeLabel(item.data.item.contentType)} · {item.data.item.sourceName ?? item.data.item.sourceOrganization ?? "Medveris"} · {formatDate(item.data.item.publicationDate)} · reviewed {formatDate(item.data.item.reviewDueOn)}</div>
              <p className="mv-pre">{item.data.item.summary}</p>
              {item.data.item.body ? <div className="mv-pre">{item.data.item.body}</div> : null}
              {item.data.item.findingsSummary ? <p><strong>Findings:</strong> {item.data.item.findingsSummary}</p> : null}
              {item.data.item.limitations ? <p><strong>Limitations:</strong> {item.data.item.limitations}</p> : null}
              {item.data.item.correctionNote ? <Notice tone="warning" title="Correction">{item.data.item.correctionNote}</Notice> : null}
              {item.data.item.attribution ? <p className="mv-small mv-muted">Attribution: {item.data.item.attribution}</p> : null}
              {item.data.item.sponsorshipDisclosure ? <p className="mv-small mv-muted">Sponsorship: {item.data.item.sponsorshipDisclosure}</p> : null}
              {item.data.item.sourceUrl ? <p className="mv-small"><a href={item.data.item.sourceUrl} target="_blank" rel="noreferrer">Open source</a></p> : null}
              <div className="mv-row">
                {item.data.bookmarked ? <Button variant="secondary" onClick={() => void removeBookmark(item.data!.item.id)} disabled={action.busy !== null}>Remove bookmark</Button> : <Button onClick={() => void bookmark(item.data!.item.id)} disabled={action.busy !== null}>Save bookmark</Button>}
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}

function SavedWorkspace() {
  const bookmarks = useQuery<{ items: Bookmark[] }>("/content/bookmarks/mine");
  const preferences = useQuery<{ preferences: Preferences }>("/content/preferences/mine");
  const action = useAction();
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const current = prefs ?? preferences.data?.preferences ?? null;

  function update<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    setPrefs((previous) => ({ ...(previous ?? preferences.data!.preferences), [key]: value }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!current) return;
    await action.run("preferences", async () => {
      await api("/content/preferences/mine", { method: "PUT", body: current });
      preferences.reload();
      setPrefs(null);
      return "Preferences saved.";
    });
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title="Your bookmarks" description="Bookmarks are private to your account.">
        {bookmarks.loading ? <LoadingState /> : bookmarks.error ? <ErrorState message={bookmarks.error} onRetry={bookmarks.reload} /> : !bookmarks.data?.items.length ? <EmptyState title="No bookmarks" description="Save content from the health library to find it here." /> : (
          <Table head={["Title", "Type", "Published"]}>
            {bookmarks.data.items.map((row) => (
              <tr key={row.id}><td><strong>{row.title}</strong><div className="mv-small mv-muted">{row.summary}</div></td><td>{typeLabel(row.contentType)}</td><td>{formatDate(row.publicationDate)}</td></tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="Content preferences" description="Language, geography and interests tune the feed but never widen visibility.">
        {preferences.loading ? <LoadingState /> : preferences.error ? <ErrorState message={preferences.error} onRetry={preferences.reload} /> : current ? (
          <form className="mv-stack" onSubmit={save}>
            <div className="mv-form-grid">
              <Field label="Language"><Input value={current.language} onChange={(event) => update("language", event.target.value)} minLength={2} maxLength={20} /></Field>
              <Field label="Geography"><Input value={current.geography ?? ""} onChange={(event) => update("geography", event.target.value)} /></Field>
              <Field label="Specialty tags" hint="Comma separated"><Input value={current.specialtyTags.join(", ")} onChange={(event) => update("specialtyTags", event.target.value.split(",").map((value) => value.trim()).filter(Boolean))} /></Field>
              <Field label="Interests" hint="Comma separated"><Input value={current.interests.join(", ")} onChange={(event) => update("interests", event.target.value.split(",").map((value) => value.trim()).filter(Boolean))} /></Field>
            </div>
            <label className="mv-small"><input type="checkbox" checked={current.hidePatientOpportunities} onChange={(event) => update("hidePatientOpportunities", event.target.checked)} /> Hide patient opportunities</label>
            <label className="mv-small"><input type="checkbox" checked={current.hideProfessionalOpportunities} onChange={(event) => update("hideProfessionalOpportunities", event.target.checked)} /> Hide professional opportunities</label>
            <Button type="submit" disabled={action.busy !== null}>{action.busy === "preferences" ? "Saving…" : "Save preferences"}</Button>
          </form>
        ) : null}
      </Card>
    </div>
  );
}

function OpportunitiesWorkspace() {
  const [type, setType] = useState("");
  const opportunities = useQuery<{ opportunities: Opportunity[]; total: number }>(`/opportunities?limit=30${type ? `&type=${type}` : ""}`);
  const action = useAction();
  const [reporting, setReporting] = useState<string | null>(null);
  const [detail, setDetail] = useState("");

  async function bookmark(id: string) {
    await action.run(`bookmark-${id}`, async () => {
      await api(`/opportunities/${id}/bookmark`, { method: "POST" });
      return "Opportunity bookmarked.";
    });
  }

  async function report(event: FormEvent) {
    event.preventDefault();
    if (!reporting) return;
    await action.run("report", async () => {
      await api(`/opportunities/${reporting}/report`, { method: "POST", body: { reason: "inaccurate", detail } });
      setReporting(null);
      setDetail("");
      return "Opportunity reported.";
    });
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title="Filter opportunities" description="Only published opportunities matching your audience are shown.">
        <Field label="Type">
          <Select value={type} onChange={(event) => setType(event.target.value)}>
            <option value="">All types</option>
            {["employment", "locum", "cpd", "conference", "fellowship", "training", "research-collaboration", "community-screening", "health-education", "patient-support", "study-participation"].map((value) => <option key={value} value={value}>{human(value)}</option>)}
          </Select>
        </Field>
      </Card>
      {reporting ? (
        <Card title="Report opportunity">
          <form className="mv-stack" onSubmit={report}>
            <Field label="Detail"><Textarea value={detail} onChange={(event) => setDetail(event.target.value)} rows={3} maxLength={2000} /></Field>
            <div className="mv-row"><Button type="submit" disabled={action.busy !== null}>Submit report</Button><Button type="button" variant="ghost" onClick={() => setReporting(null)}>Cancel</Button></div>
          </form>
        </Card>
      ) : null}
      {opportunities.loading ? <LoadingState /> : opportunities.error ? <ErrorState message={opportunities.error} onRetry={opportunities.reload} /> : !opportunities.data?.opportunities.length ? <EmptyState title="No opportunities" description="Verified opportunities appear here once independent moderation publishes them." /> : (
        <Card title={`Opportunities (${opportunities.data.total})`}>
          <ul className="mv-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {opportunities.data.opportunities.map((row) => (
              <li key={row.id}>
                <div className="mv-spread">
                  <strong>{row.title}</strong>
                  <div className="mv-row"><Badge tone={row.verificationStatus === "source-verified" ? "success" : row.verificationStatus === "details-checked" ? "info" : "warning"}>{human(row.verificationStatus)}</Badge><Button variant="ghost" size="sm" onClick={() => void bookmark(row.id)} disabled={action.busy !== null}>Bookmark</Button><Button variant="ghost" size="sm" onClick={() => setReporting(row.id)}>Report</Button></div>
                </div>
                <div className="mv-small mv-muted">{human(row.opportunityType)} · {row.organization} · {row.location ?? (row.remote ? "Remote" : "Location not stated")} · closes {formatDate(row.closesOn)}</div>
                <p className="mv-small">{row.description}</p>
                {row.eligibility ? <p className="mv-small"><strong>Eligibility:</strong> {row.eligibility}</p> : null}
                {row.sponsorshipStatus !== "none" ? <Badge tone="warning">{human(row.sponsorshipStatus)}</Badge> : null}
                {row.applicationUrl ? <p className="mv-small"><a href={row.applicationUrl} target="_blank" rel="noreferrer">Application details</a></p> : null}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function EditorialWorkspace({ can }: { can: (permission: string) => boolean }) {
  const items = useQuery<{ items: EditorialItem[] }>("/content/editorial/items");
  const action = useAction();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ title: "", slug: "", summary: "", contentType: "health-education", audience: "general", visibilityScope: "public", body: "", reviewDueOn: "" });
  const [target, setTarget] = useState<{ id: string; action: "review" | "publish" | "archive"; version: number; title: string } | null>(null);
  const [note, setNote] = useState("");

  async function create(event: FormEvent) {
    event.preventDefault();
    await action.run("create", async () => {
      await api("/content/editorial/items", {
        method: "POST",
        body: {
          title: form.title,
          slug: form.slug,
          summary: form.summary,
          contentType: form.contentType,
          audience: form.audience,
          visibilityScope: form.visibilityScope,
          body: form.body || undefined,
          language: "en",
          specialtyTags: [],
          visibilityValues: [],
          editorialPriority: 50,
          reviewDueOn: form.reviewDueOn || undefined,
          publicationDate: todayInput(),
        },
      });
      setForm({ title: "", slug: "", summary: "", contentType: "health-education", audience: "general", visibilityScope: "public", body: "", reviewDueOn: "" });
      setCreating(false);
      items.reload();
      return "Draft created. A different reviewer must approve publication.";
    });
  }

  async function decide(event: FormEvent) {
    event.preventDefault();
    if (!target) return;
    await action.run("decision", async () => {
      await api(`/content/editorial/items/${target.id}/${target.action}`, { method: "POST", body: { expectedVersion: target.version, note, reviewDueOn: target.action === "publish" ? futureIso(180) : undefined } });
      setTarget(null);
      setNote("");
      items.reload();
      return `Content ${target.action === "review" ? "submitted for review" : target.action === "publish" ? "published" : "archived"}.`;
    });
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title="Editorial workflow" description="Draft, independent review, then publication. Authors cannot review or publish their own content." actions={can("content.draft") ? <Button onClick={() => setCreating((value) => !value)}>{creating ? "Close" : "New draft"}</Button> : undefined}>
        {creating ? (
          <form className="mv-stack" onSubmit={create}>
            <div className="mv-form-grid">
              <Field label="Title"><Input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} required minLength={2} maxLength={300} /></Field>
              <Field label="Slug" hint="lowercase-with-hyphens"><Input value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value })} required pattern="[a-z0-9][a-z0-9-]+" /></Field>
              <Field label="Type"><Select value={form.contentType} onChange={(event) => setForm({ ...form, contentType: event.target.value })}>{CONTENT_TYPES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</Select></Field>
              <Field label="Audience"><Select value={form.audience} onChange={(event) => setForm({ ...form, audience: event.target.value })}>{["general", "patient", "professional", "specialty", "organization", "department"].map((value) => <option key={value} value={value}>{human(value)}</option>)}</Select></Field>
              <Field label="Visibility"><Select value={form.visibilityScope} onChange={(event) => setForm({ ...form, visibilityScope: event.target.value })}>{["public", "authenticated", "patient", "professional", "specialty", "organization", "department"].map((value) => <option key={value} value={value}>{human(value)}</option>)}</Select></Field>
              <Field label="Review due"><Input type="date" value={form.reviewDueOn} onChange={(event) => setForm({ ...form, reviewDueOn: event.target.value })} /></Field>
            </div>
            <Field label="Summary"><Textarea value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} rows={3} required minLength={10} maxLength={4000} /></Field>
            <Field label="Body"><Textarea value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} rows={6} maxLength={60000} /></Field>
            <Button type="submit" disabled={action.busy !== null}>{action.busy === "create" ? "Creating…" : "Create draft"}</Button>
          </form>
        ) : null}
      </Card>
      {target ? (
        <Card title={`${target.action === "review" ? "Submit for review" : target.action === "publish" ? "Publish" : "Archive"}: ${target.title}`} description={target.action === "publish" ? "Publication requires a reviewer other than the author." : undefined}>
          <form className="mv-stack" onSubmit={decide}>
            <Field label="Decision note" hint="At least 5 characters"><Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} required minLength={5} maxLength={4000} /></Field>
            <div className="mv-row"><Button type="submit" disabled={action.busy !== null || note.trim().length < 5}>{action.busy === "decision" ? "Saving…" : "Confirm"}</Button><Button type="button" variant="ghost" onClick={() => setTarget(null)}>Cancel</Button></div>
          </form>
        </Card>
      ) : null}
      <Card title="Content items" description="Version increments on each draft edit.">
        {items.loading ? <LoadingState /> : items.error ? <ErrorState message={items.error} onRetry={items.reload} /> : !items.data?.items.length ? <EmptyState title="No content items" description="Create the first draft to begin the editorial workflow." /> : (
          <Table head={["Title", "Status", "Version", "Updated", "Actions"]}>
            {items.data.items.map((row) => (
              <tr key={row.id}>
                <td><strong>{row.title}</strong><div className="mv-small mv-muted">{typeLabel(row.contentType)} · {row.authorName} · {human(row.visibilityScope)}</div></td>
                <td><Badge tone={row.status === "published" ? "success" : row.status === "in-review" ? "info" : row.status === "archived" ? "neutral" : "warning"}>{human(row.status)}</Badge></td>
                <td>{row.version}</td>
                <td>{formatDateTime(row.updatedAt)}</td>
                <td>
                  <div className="mv-row">
                    {can("content.review") && ["draft", "in-review"].includes(row.status) ? <Button variant="secondary" size="sm" onClick={() => setTarget({ id: row.id, action: "review", version: row.version, title: row.title })}>Review</Button> : null}
                    {can("content.publish") && row.status === "in-review" ? <Button size="sm" onClick={() => setTarget({ id: row.id, action: "publish", version: row.version, title: row.title })}>Publish</Button> : null}
                    {can("content.archive") && row.status !== "archived" ? <Button variant="ghost" size="sm" onClick={() => setTarget({ id: row.id, action: "archive", version: row.version, title: row.title })}>Archive</Button> : null}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function GovernanceWorkspace({ can, roles }: { can: (permission: string) => boolean; roles: string[] }) {
  const grants = useQuery<{ grants: RoleGrant[] }>(can("role_grant.request") ? "/admin/role-grants" : null);
  const careTeam = useQuery<{ assignments: CareTeamMember[] }>(can("care_team.read") ? "/admin/care-team" : null);
  const review = useQuery<{ grants: RoleGrant[]; careTeam: CareTeamMember[]; credentials: Array<{ credentialType: string; status: string; expiresOn: string | null; total: number }> }>(can("audit.read") ? "/admin/access-review" : null);
  const action = useAction();
  const [grantForm, setGrantForm] = useState({ userId: "", role: "nurse", scopeNote: "", expiresAt: "" });
  const [decision, setDecision] = useState<{ id: string; decision: "approved" | "rejected" | "revoked" } | null>(null);
  const [reason, setReason] = useState("");
  const [teamForm, setTeamForm] = useState({ patientId: "", userId: "", relationship: "primary", purpose: "" });
  const canApprove = can("role_grant.approve");
  const canManageTeam = can("clinical.care_team.manage");

  async function requestGrant(event: FormEvent) {
    event.preventDefault();
    await action.run("grant", async () => {
      await api("/admin/role-grants", { method: "POST", body: { userId: grantForm.userId, role: grantForm.role, scopeNote: grantForm.scopeNote || undefined, expiresAt: grantForm.expiresAt ? new Date(grantForm.expiresAt).toISOString() : undefined } });
      setGrantForm({ userId: "", role: "nurse", scopeNote: "", expiresAt: "" });
      grants.reload();
      review.reload();
      return "Role grant requested. A separate approver must decide it.";
    });
  }

  async function decide(event: FormEvent) {
    event.preventDefault();
    if (!decision) return;
    await action.run("decision", async () => {
      await api(`/admin/role-grants/${decision.id}/decision`, { method: "POST", body: { decision: decision.decision, reason } });
      setDecision(null);
      setReason("");
      grants.reload();
      review.reload();
      return "Role grant decision recorded.";
    });
  }

  async function assignTeam(event: FormEvent) {
    event.preventDefault();
    await action.run("team", async () => {
      await api("/admin/care-team", { method: "POST", body: { patientId: teamForm.patientId, userId: teamForm.userId || undefined, relationship: teamForm.relationship, purpose: teamForm.purpose || undefined } });
      setTeamForm({ patientId: "", userId: "", relationship: "primary", purpose: "" });
      careTeam.reload();
      review.reload();
      return "Care-team assignment recorded.";
    });
  }

  async function revokeTeam(id: string) {
    await action.run(`revoke-${id}`, async () => {
      await api(`/admin/care-team/${id}/revoke`, { method: "POST" });
      careTeam.reload();
      review.reload();
      return "Care-team assignment revoked.";
    });
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      {can("role_grant.request") ? (
        <div className="mv-grid mv-grid--2">
          <Card title="Request a role grant" description="Requests expire and require an independent approver. Your own facility role is unchanged until approval.">
            <form className="mv-stack" onSubmit={requestGrant}>
              <Field label="User ID" hint="Directory UUID of an active member"><Input value={grantForm.userId} onChange={(event) => setGrantForm({ ...grantForm, userId: event.target.value })} required /></Field>
              <Field label="Role"><Select value={grantForm.role} onChange={(event) => setGrantForm({ ...grantForm, role: event.target.value })}>{ASSIGNABLE_ROLES.map((role) => <option key={role} value={role}>{human(role)}</option>)}</Select></Field>
              <Field label="Scope note"><Input value={grantForm.scopeNote} onChange={(event) => setGrantForm({ ...grantForm, scopeNote: event.target.value })} maxLength={1000} /></Field>
              <Field label="Expires"><Input type="datetime-local" value={grantForm.expiresAt} onChange={(event) => setGrantForm({ ...grantForm, expiresAt: event.target.value })} /></Field>
              <Button type="submit" disabled={action.busy !== null}>Request grant</Button>
            </form>
          </Card>
          <Card title="Role grants" description="Approved grants are time-bound and independently approved.">
            {grants.loading ? <LoadingState /> : grants.error ? <ErrorState message={grants.error} onRetry={grants.reload} /> : !grants.data?.grants.length ? <EmptyState title="No role grants" description="Request a scoped grant for a member who needs temporary access." /> : (
              <Table head={["Member", "Role", "Status", "Expires", "Actions"]}>
                {grants.data.grants.map((grant) => (
                  <tr key={grant.id}>
                    <td><strong>{grant.userName}</strong><div className="mv-small mv-muted">{grant.email}</div></td>
                    <td>{human(grant.role)}{grant.departmentName ? <div className="mv-small mv-muted">{grant.departmentName}</div> : null}</td>
                    <td><Badge tone={grant.status === "approved" ? "success" : grant.status === "rejected" || grant.status === "revoked" ? "danger" : "warning"}>{human(grant.status)}</Badge></td>
                    <td>{formatDateTime(grant.expiresAt)}</td>
                    <td>
                      {canApprove && grant.status === "requested" ? <div className="mv-row"><Button size="sm" onClick={() => setDecision({ id: grant.id, decision: "approved" })}>Approve</Button><Button size="sm" variant="secondary" onClick={() => setDecision({ id: grant.id, decision: "rejected" })}>Reject</Button></div> : canApprove && grant.status === "approved" ? <Button size="sm" variant="ghost" onClick={() => setDecision({ id: grant.id, decision: "revoked" })}>Revoke</Button> : <span className="mv-small mv-muted">—</span>}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>
      ) : null}
      {decision ? (
        <Card title={`${human(decision.decision)} role grant`} description="Separation of duties is enforced: requesters cannot approve their own grant.">
          <form className="mv-stack" onSubmit={decide}>
            <Field label="Reason" hint="At least 10 characters"><Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} required minLength={10} maxLength={2000} /></Field>
            <div className="mv-row"><Button type="submit" disabled={action.busy !== null || reason.trim().length < 10}>Confirm {human(decision.decision)}</Button><Button type="button" variant="ghost" onClick={() => setDecision(null)}>Cancel</Button></div>
          </form>
        </Card>
      ) : null}
      {can("care_team.read") ? (
        <div className="mv-grid mv-grid--2">
          {canManageTeam ? (
            <Card title="Assign a care team" description="Care-team membership authorizes chart participation for a defined patient only.">
              <form className="mv-stack" onSubmit={assignTeam}>
                <Field label="Patient ID"><Input value={teamForm.patientId} onChange={(event) => setTeamForm({ ...teamForm, patientId: event.target.value })} required /></Field>
                <Field label="Member user ID" hint="Defaults to you"><Input value={teamForm.userId} onChange={(event) => setTeamForm({ ...teamForm, userId: event.target.value })} /></Field>
                <Field label="Relationship"><Select value={teamForm.relationship} onChange={(event) => setTeamForm({ ...teamForm, relationship: event.target.value })}>{["primary", "covering", "consulting", "multidisciplinary", "nursing", "diagnostic"].map((value) => <option key={value} value={value}>{human(value)}</option>)}</Select></Field>
                <Field label="Purpose"><Input value={teamForm.purpose} onChange={(event) => setTeamForm({ ...teamForm, purpose: event.target.value })} maxLength={1000} /></Field>
                <Button type="submit" disabled={action.busy !== null}>Assign</Button>
              </form>
            </Card>
          ) : null}
          <Card title="Care-team assignments">
            {careTeam.loading ? <LoadingState /> : careTeam.error ? <ErrorState message={careTeam.error} onRetry={careTeam.reload} /> : !careTeam.data?.assignments.length ? <EmptyState title="No care-team assignments" description="Assign a member to a linked patient to enable chart participation." /> : (
              <Table head={["Patient", "Member", "Status", "Actions"]}>
                {careTeam.data.assignments.map((row) => (
                  <tr key={row.id}>
                    <td><strong>{row.givenName} {row.familyName}</strong><div className="mv-small mv-muted"><span className="mv-id">{row.publicId}</span> · {human(row.relationship)}</div></td>
                    <td>{row.userName ?? "—"}{row.departmentName ? <div className="mv-small mv-muted">{row.departmentName}</div> : null}</td>
                    <td><Badge tone={row.status === "active" ? "success" : "neutral"}>{human(row.status)}</Badge></td>
                    <td>{canManageTeam && row.status === "active" ? <Button size="sm" variant="ghost" onClick={() => void revokeTeam(row.id)} disabled={action.busy !== null}>Revoke</Button> : <span className="mv-small mv-muted">—</span>}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>
      ) : null}
      {can("audit.read") ? (
        <Card title="Access review" description="Read-only evidence for periodic access recertification.">
          {review.loading ? <LoadingState /> : review.error ? <ErrorState message={review.error} onRetry={review.reload} /> : review.data ? (
            <div className="mv-stack">
              <div className="mv-grid mv-grid--3">
                <div className="mv-stat"><span>Role grants</span><strong>{review.data.grants.length}</strong><span>Lifetime records</span></div>
                <div className="mv-stat"><span>Care-team assignments</span><strong>{review.data.careTeam.length}</strong><span>Lifetime records</span></div>
                <div className="mv-stat"><span>Credential records</span><strong>{review.data.credentials.reduce((sum, row) => sum + row.total, 0)}</strong><span>Grouped by type and status</span></div>
              </div>
              <Table head={["Credential type", "Status", "Expires", "Count"]}>
                {review.data.credentials.map((row) => (
                  <tr key={`${row.credentialType}-${row.status}-${row.expiresOn ?? "none"}`}><td>{human(row.credentialType)}</td><td>{human(row.status)}</td><td>{formatDate(row.expiresOn)}</td><td>{row.total}</td></tr>
                ))}
              </Table>
            </div>
          ) : null}
          <p className="mv-small mv-muted" style={{ marginTop: 12 }}>Active facility roles: {roles.join(", ") || "none"}.</p>
        </Card>
      ) : null}
    </div>
  );
}
