import { useMemo, useState, type FormEvent } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDateTime } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";

interface OnboardingStep { key: string; label: string; done: boolean; optional?: boolean }
interface OnboardingMe {
  path: string;
  identity: { userId: string; displayName: string; email: string };
  patient?: { publicId: string; activeProxies: number; requestedProxies: number };
  staff?: {
    staffRef: string; caseId: string | null; caseStatus: string | null; path: string | null;
    catalogueTitleCode: string | null; catalogueCadreCode: string | null; regulatorCodes: string[];
    credentialRequired: boolean; requestedSystemRoles: string[]; approvedSystemRoles: string[];
  } | null;
  credential?: { total: number; verified: number };
  facility?: { name: string; enabledDepartments: number; activeMembers: number; openOnboarding: number } | null;
  steps: OnboardingStep[];
  notice: string;
}

interface CatalogueTitle {
  code: string; name: string; cadreCode: string; seniority: string;
  departmentCodes: string[]; requiresCredential: boolean;
  privilegeCodes: string[]; suggestedSystemRoles: string[];
}
interface CatalogueDepartment { code: string; name: string }
interface Catalogue {
  source: string; countryCode: string; version: number; notice: string; publishedAt: string | null;
  catalogue: { regulators: { code: string; name: string }[]; departments: CatalogueDepartment[] };
  titles: CatalogueTitle[];
  cadres: { code: string; name: string }[];
}
interface CatalogueVersion { id: string; countryCode: string; version: number; status: string; contentDigest: string; publishedAt: string | null }
interface Affiliation {
  engagementId: string; tenantId: string; facilityName: string; engagementType: string; status: string;
  startDate: string; endDate: string | null; jobTitle: string | null; departments: string | null;
  onboardingStatus: string | null; onboardingPath: string | null;
}
interface CustomTitleRequest {
  id: string; proposedName: string; cadreCode: string | null; departmentCodes: string[];
  specialtyCodes: string[]; explanation: string; status: string; createdAt: string;
  requestedByName?: string; requestedByEmail?: string;
}

export function OnboardingPage() {
  const { me } = useAuth();
  const onboarding = useQuery<OnboardingMe>("/onboarding/me");
  const action = useAction();
  const [q, setQ] = useState("");
  const [departmentCode, setDepartmentCode] = useState("");
  const [version, setVersion] = useState("");
  const cataloguePath = useMemo(() => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (departmentCode) params.set("departmentCode", departmentCode);
    return `/onboarding/catalogue${params.size ? `?${params.toString()}` : ""}`;
  }, [q, departmentCode]);
  const catalogue = useQuery<Catalogue>(cataloguePath);
  const isOperator = me?.platformRoles.includes("platform_operator") ?? false;
  const roles = me?.activeTenant?.roles ?? [];
  const reviewer = roles.includes("facility_admin") || roles.includes("hr");
  const versions = useQuery<{ versions: CatalogueVersion[] }>("/onboarding/catalogue/versions", { enabled: isOperator });
  const affiliations = useQuery<{ affiliations: Affiliation[]; multipleAffiliations: boolean }>("/onboarding/affiliations/mine");

  const [catalogueStatus, setCatalogueStatus] = useState<"draft" | "published">("published");

  async function publish(event: FormEvent) {
    event.preventDefault();
    await action.run("publish", async () => {
      const result = await api<{ catalogue: { version: number; digest: string; status: string } }>("/onboarding/catalogue/publish", {
        method: "POST",
        body: { countryCode: "UG", version: Number(version), status: catalogueStatus },
      });
      setVersion("");
      versions.reload();
      catalogue.reload();
      return `Saved catalogue v${result.catalogue.version} as ${result.catalogue.status} (${result.catalogue.digest.slice(0, 16)}…).`;
    });
  }

  async function publishDraft(id: string) {
    await action.run(`publish-draft-${id}`, async () => {
      await api(`/onboarding/catalogue/${id}/publish`, { method: "POST", body: { reason: "Published from the onboarding catalogue console" } });
      versions.reload();
      catalogue.reload();
      return "Draft catalogue published and the previous version retired.";
    });
  }

  const progress = onboarding.data ? onboarding.data.steps.filter((step) => step.done).length : 0;
  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow="Onboarding"
        title="Your onboarding path"
        description="Role-specific guidance for patients, clinicians, facility administrators and support staff. Onboarding never grants a clinical privilege or a system role by itself."
      />
      {onboarding.loading ? <LoadingState /> : onboarding.error ? <ErrorState message={onboarding.error} onRetry={onboarding.reload} /> : onboarding.data ? (
        <div className="mv-stack">
          <div className="mv-grid mv-grid--3">
            <Card title="Path"><Badge tone="info">{onboarding.data.path.replaceAll("_", " ")}</Badge><div className="mv-small mv-muted" style={{ marginTop: 8 }}>{onboarding.data.identity.displayName}</div></Card>
            <Card title="Checklist progress"><strong style={{ fontSize: "1.65rem" }}>{progress}/{onboarding.data.steps.length}</strong></Card>
            <Card title="Catalogue version"><strong style={{ fontSize: "1.65rem" }}>v{catalogue.data?.version ?? "—"}</strong><div className="mv-small mv-muted">{catalogue.data?.source === "published" ? "Published register" : "Bundled draft"}</div></Card>
          </div>
          <Notice tone="info">{onboarding.data.notice}</Notice>
          <Card title="Checklist">
            <Table head={["Step", "State", "Notes"]} caption="Onboarding checklist">
              {onboarding.data.steps.map((step) => (
                <tr key={step.key}>
                  <td><strong>{step.label}</strong></td>
                  <td><Badge tone={step.done ? "success" : "neutral"}>{step.done ? "Complete" : "Pending"}</Badge></td>
                  <td className="mv-small mv-muted">{step.optional ? "Optional" : "Required"}</td>
                </tr>
              ))}
            </Table>
          </Card>
          {onboarding.data.staff ? (
            <Card title="Professional snapshot" description="Recorded when this onboarding case started. A later catalogue release does not silently change it.">
              <div className="mv-grid mv-grid--3">
                <div><div className="mv-small mv-muted">Staff reference</div><div className="mv-id">{onboarding.data.staff.staffRef}</div></div>
                <div><div className="mv-small mv-muted">Catalogue title</div><div>{onboarding.data.staff.catalogueTitleCode ?? "Not recorded"}</div></div>
                <div><div className="mv-small mv-muted">Cadre</div><div>{onboarding.data.staff.catalogueCadreCode ?? "Not recorded"}</div></div>
                <div><div className="mv-small mv-muted">Regulators</div><div>{onboarding.data.staff.regulatorCodes.join(", ") || "None recorded"}</div></div>
                <div><div className="mv-small mv-muted">Credential required</div><div>{onboarding.data.staff.credentialRequired ? "Yes" : "No"}</div></div>
                <div><div className="mv-small mv-muted">Suggested roles (not granted)</div><div>{onboarding.data.staff.requestedSystemRoles.join(", ") || "None"}</div></div>
              </div>
            </Card>
          ) : null}
          <Card title="Facility affiliations" description={affiliations.data?.multipleAffiliations ? "You have more than one facility affiliation. Each facility approves its own affiliation independently." : "Each facility approves its own affiliation independently. An affiliation here does not grant access to another facility's records."}>
            {affiliations.loading ? <LoadingState /> : affiliations.error ? <ErrorState message={affiliations.error} onRetry={affiliations.reload} /> : !affiliations.data?.affiliations.length ? <EmptyState title="No affiliations" description="No staff affiliations are linked to this account." /> : (
              <Table head={["Facility", "Role", "Departments", "Onboarding", "Period"]} caption="My facility affiliations">
                {affiliations.data.affiliations.map((row) => (
                  <tr key={row.engagementId}>
                    <td><strong>{row.facilityName}</strong><div className="mv-small mv-muted">{row.engagementType} · {row.status}</div></td>
                    <td>{row.jobTitle ?? "No job title"}</td>
                    <td className="mv-small">{row.departments ?? "Unassigned"}</td>
                    <td><Badge tone={row.onboardingStatus === "active" ? "success" : "info"}>{row.onboardingStatus ?? "—"}</Badge><div className="mv-small mv-muted">{row.onboardingPath ?? ""}</div></td>
                    <td className="mv-small">{row.startDate} → {row.endDate ?? "present"}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>
      ) : null}

      {reviewer ? <CustomTitleQueue /> : null}

      <Card title="Uganda onboarding catalogue" description="Editable, versioned governance metadata. Verify every regulator and licence requirement with the competent authority.">
        <div className="mv-row" style={{ flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
          <Input aria-label="Search catalogue" placeholder="Search title, cadre or department" value={q} onChange={(event) => setQ(event.target.value)} />
          <Select aria-label="Filter by department" value={departmentCode} onChange={(event) => setDepartmentCode(event.target.value)}>
            <option value="">All departments</option>
            {catalogue.data?.catalogue.departments.map((row) => <option key={row.code} value={row.code}>{row.name}</option>)}
          </Select>
          <Badge tone={catalogue.data?.source === "published" ? "success" : "warning"}>{catalogue.data?.source === "published" ? `Published v${catalogue.data.version}` : "Bundled draft"}</Badge>
        </div>
        {catalogue.loading ? <LoadingState /> : catalogue.error ? <ErrorState message={catalogue.error} onRetry={catalogue.reload} /> : !catalogue.data?.titles.length ? <EmptyState title="No catalogue entries" description="Try a broader search or clear the department filter." /> : (
          <Table head={["Title", "Cadre", "Departments", "Credential", "Suggested roles"]} caption="Uganda onboarding catalogue titles">
            {catalogue.data.titles.map((title) => (
              <tr key={title.code}>
                <td><strong>{title.name}</strong><div className="mv-small mv-muted mv-id">{title.code} · {title.seniority}</div></td>
                <td>{catalogue.data!.cadres.find((cadre) => cadre.code === title.cadreCode)?.name ?? title.cadreCode}</td>
                <td className="mv-small">{title.departmentCodes.join(", ")}</td>
                <td><Badge tone={title.requiresCredential ? "warning" : "neutral"}>{title.requiresCredential ? "Required" : "Not required"}</Badge></td>
                <td className="mv-small">{title.suggestedSystemRoles.join(", ") || "—"}</td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mv-small mv-muted" style={{ marginTop: 12 }}>{catalogue.data?.notice}</p>
      </Card>

      {isOperator ? (
        <div className="mv-stack">
          {action.error ? <ErrorState message={action.error} /> : null}
          {action.message ? <Notice tone="success">{action.message}</Notice> : null}
          <div className="mv-grid mv-grid--2">
            <Card title="Publish the bundled catalogue" description="Platform operators publish a new version with a content digest. Publishing retires the previous version.">
              <form className="mv-stack" onSubmit={publish}>
                <Field label="Version" htmlFor="cat-version" hint="Must be greater than the latest recorded version.">
                  <Input id="cat-version" type="number" min={1} value={version} onChange={(event) => setVersion(event.target.value)} required />
                </Field>
                <Field label="Status">
                  <Select value={catalogueStatus} onChange={(event) => setCatalogueStatus(event.target.value as typeof catalogueStatus)}>
                    <option value="published">Published</option>
                    <option value="draft">Draft (review before publishing)</option>
                  </Select>
                </Field>
                <Button type="submit" disabled={action.busy !== null || !version}>{action.busy === "publish" ? "Saving…" : "Save catalogue version"}</Button>
              </form>
            </Card>
            <Card title="Catalogue versions">
              {versions.loading ? <LoadingState /> : versions.error ? <ErrorState message={versions.error} onRetry={versions.reload} /> : !versions.data?.versions.length ? <EmptyState title="No versions" description="Publish the bundled catalogue." /> : (
                <Table head={["Version", "Status", "Published", "Digest", "Action"]} caption="Catalogue versions">
                  {versions.data.versions.map((row) => (
                    <tr key={row.id}>
                      <td>v{row.version}</td>
                      <td><Badge tone={row.status === "published" ? "success" : "neutral"}>{row.status}</Badge></td>
                      <td className="mv-small">{row.publishedAt ? formatDateTime(row.publishedAt) : "—"}</td>
                      <td className="mv-small mv-id">{row.contentDigest.replace("sha256:", "").slice(0, 12)}…</td>
                      <td>{row.status === "draft" ? <Button size="sm" variant="secondary" onClick={() => void publishDraft(row.id)} disabled={action.busy !== null}>{action.busy === `publish-draft-${row.id}` ? "Publishing…" : "Publish draft"}</Button> : "—"}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CustomTitleQueue() {
  const queue = useQuery<{ requests: CustomTitleRequest[] }>("/onboarding/custom-titles/queue");
  const action = useAction();
  const [deciding, setDeciding] = useState("");
  const [decision, setDecision] = useState<"approve" | "reject">("approve");
  const [reason, setReason] = useState("");
  const [approvedName, setApprovedName] = useState("");

  async function decide(event: FormEvent) {
    event.preventDefault();
    await action.run("decide", async () => {
      await api(`/onboarding/custom-titles/${deciding}/decision`, {
        method: "POST",
        body: { decision, reason, approvedName: approvedName || undefined },
      });
      setDeciding("");
      setReason("");
      setApprovedName("");
      queue.reload();
      return decision === "approve"
        ? "Custom title approved as a local label. No system role or clinical privilege was granted."
        : "Custom title request rejected.";
    });
  }

  return (
    <Card title="Custom title requests" description="A custom title stays pending until an authorised reviewer decides. Approval creates a local label only; it never grants a system role or clinical privilege.">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      {queue.loading ? <LoadingState /> : queue.error ? <ErrorState message={queue.error} onRetry={queue.reload} /> : !queue.data?.requests.length ? <EmptyState title="No pending custom titles" description="Requests from onboarding appear here for review." /> : (
        <Table head={["Proposed title", "Requested by", "Cadre", "Departments", "Action"]} caption="Pending custom title requests">
          {queue.data.requests.map((row) => (
            <tr key={row.id}>
              <td><strong>{row.proposedName}</strong><div className="mv-small mv-muted">{row.explanation}</div></td>
              <td className="mv-small">{row.requestedByName ?? "—"}<div className="mv-muted">{row.requestedByEmail ?? ""}</div></td>
              <td>{row.cadreCode ?? "Not specified"}</td>
              <td className="mv-small">{row.departmentCodes.join(", ") || "—"}</td>
              <td><Button size="sm" variant="secondary" onClick={() => { setDeciding(row.id); setApprovedName(row.proposedName); }}>Review</Button></td>
            </tr>
          ))}
        </Table>
      )}
      {deciding ? (
        <form className="mv-stack" onSubmit={decide} style={{ marginTop: 16 }}>
          <Field label="Decision">
            <Select value={decision} onChange={(event) => setDecision(event.target.value as typeof decision)}>
              <option value="approve">Approve local label</option>
              <option value="reject">Reject</option>
            </Select>
          </Field>
          {decision === "approve" ? (
            <Field label="Approved local title" hint="Keep the wording distinct from catalogue titles where possible.">
              <Input value={approvedName} onChange={(event) => setApprovedName(event.target.value)} minLength={2} required />
            </Field>
          ) : null}
          <Field label="Reason" hint="At least 10 characters. Recorded in the audit trail.">
            <Textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={10} required />
          </Field>
          <div className="mv-row">
            <Button type="submit" disabled={action.busy !== null || reason.trim().length < 10}>{action.busy === "decide" ? "Recording…" : "Record decision"}</Button>
            <Button type="button" variant="ghost" onClick={() => setDeciding("")}>Cancel</Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}
