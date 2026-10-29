import { useState, type FormEvent } from "react";
import { previousPeriod } from "@medveris/domain";
import { Badge, Button, Card, DataList, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Tabs, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";

type PeriodType = "Monthly" | "Weekly" | "Quarterly";

interface Issue { severity: "error" | "warning"; message: string }
interface PeriodRow {
  id: string; mappingId: string; period: string; periodStart: string; periodEnd: string; revision: number; status: string;
  dataValues: Array<{ dataElement: string; categoryOptionCombo: string; value: number; metric: string; sex: string; ageBand: string; label: string | null }>;
  validation: Issue[]; idempotencyKey: string; generatedAt: string; approvedAt: string | null; submittedAt: string | null;
  importSummary: Record<string, unknown> | null; lastError: string | null; attemptCount: number; manualReference: string | null; version: number;
  datasetCode: string; periodType: PeriodType; generatedByName: string; approvedByName: string | null;
  schedule: { submissionDue: string; validationStart: string; validationEnd: string; lockedAfter: string; phase: string } | null;
}
interface Mapping {
  id: string; datasetCode: string; datasetName: string; dhis2DataSetUid: string; periodType: PeriodType; attributeOptionComboUid: string | null;
  elements: Array<{ metric: string; sex: string; ageBand: string; dataElementUid: string; categoryOptionComboUid: string; label?: string }>;
  status: string; approvalReference: string | null; approvedAt: string | null; approvedByName: string | null; version: number;
}
interface Rule { scope: "facility" | "platform"; submissionDueDay: number; validationStartDay: number; validationEndDay: number; lockAfterDay: number; source: string; verifiedOn: string }
interface Overview {
  integration: {
    nhfrId: string | null; dhis2BaseUrl: string | null; dhis2OrgUnitUid: string | null; dhis2OrgUnitName: string | null; eligibilityStatus: string;
    authorizationReference: string | null; authorizationIssuer: string | null; authorizationValidUntil: string | null; eligibilityDecisionNote: string | null;
    credentialKind: string | null; credentialHint: string | null; credentialsStored: boolean; connectionStatus: string; connectionCheckedAt: string | null;
    connectionDetail: string | null; liveSubmissionEnabled: boolean;
  };
  deployment: { state: string; reason: string };
  readiness: { ready: boolean; problems: string[] };
  baseUrlProblems: string[];
  credentialStorageAvailable: boolean;
  mappings: Mapping[];
  periods: PeriodRow[];
  ledger: Array<{ kind: string; outcome: string; httpStatus: number | null; summary: Record<string, unknown>; error: string | null; idempotencyKey: string | null; startedAt: string; finishedAt: string; actorName: string | null; period: string | null }>;
  rules: Record<PeriodType, Rule | null>;
  metrics: Array<{ code: string; label: string; definition: string; disaggregations: string[] }>;
  ageBands: string[];
  notices: string[];
  permissions: { manage: boolean; prepare: boolean; submit: boolean };
}

type Section = "setup" | "mappings" | "periods" | "ledger" | "rules";

const PERIOD_TONE: Record<string, "success" | "warning" | "info" | "neutral" | "danger"> = {
  generated: "info", "validation-failed": "danger", approved: "warning", exported: "warning", submitting: "info",
  submitted: "success", "submitted-manually": "success", failed: "danger", superseded: "neutral",
};

export function EhmisPage() {
  const overview = useQuery<Overview>("/ehmis");
  const [section, setSection] = useState<Section>("periods");
  if (overview.loading && !overview.data) return <LoadingState variant="page" />;
  if (overview.error || !overview.data) return <ErrorState message={overview.error ?? "Unavailable"} onRetry={overview.reload} />;
  const data = overview.data;
  return (
    <div className="mv-stack">
      <PageHeader eyebrow="National reporting" title="eHMIS / DHIS2 reporting" description="Prepare, validate and approve aggregate HMIS reports from this facility's own records. Export for manual entry at any time; submit live only when the facility is verified and connected."
        actions={<Badge tone={data.readiness.ready ? "success" : "neutral"}>{data.readiness.ready ? "Live submission ready" : "Export / manual entry"}</Badge>} />
      <Notice tone="warning" title="Eligibility and authorization">
        <ul className="mv-small" style={{ margin: 0, paddingLeft: 18 }}>{data.notices.map((notice) => <li key={notice}>{notice}</li>)}</ul>
      </Notice>
      <Tabs label="eHMIS sections" value={section} onChange={setSection} options={[
        { value: "periods", label: "Reporting periods" }, { value: "mappings", label: "Dataset mappings" }, { value: "setup", label: "Connection and eligibility" },
        { value: "ledger", label: "Submission ledger" }, { value: "rules", label: "Schedule" },
      ]} />
      {section === "setup" ? <Setup data={data} onChanged={overview.reload} /> : null}
      {section === "mappings" ? <Mappings data={data} onChanged={overview.reload} /> : null}
      {section === "periods" ? <Periods data={data} onChanged={overview.reload} /> : null}
      {section === "ledger" ? <Ledger data={data} /> : null}
      {section === "rules" ? <Rules data={data} onChanged={overview.reload} /> : null}
    </div>
  );
}

function Setup({ data, onChanged }: { data: Overview; onChanged: () => void }) {
  const integration = data.integration;
  const action = useAction();
  const [settings, setSettings] = useState({ nhfrId: integration.nhfrId ?? "", dhis2BaseUrl: integration.dhis2BaseUrl ?? "", dhis2OrgUnitUid: integration.dhis2OrgUnitUid ?? "" });
  const [authorization, setAuthorization] = useState({ authorizationReference: integration.authorizationReference ?? "", authorizationIssuer: integration.authorizationIssuer ?? "", authorizationValidUntil: integration.authorizationValidUntil?.slice(0, 10) ?? "" });
  const [credentials, setCredentials] = useState({ kind: "personal-access-token", username: "", password: "", token: "" });
  const manage = data.permissions.manage;

  async function run(key: string, fn: () => Promise<string | void>) {
    if (await action.run(key, fn)) onChanged();
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <div className="mv-grid mv-grid--2">
        <Card title="Live submission readiness">
          <DataList items={[
            { label: "Deployment", value: <><Badge tone={data.deployment.state === "available" ? "success" : "neutral"}>{data.deployment.state.replace(/_/g, " ")}</Badge><div className="mv-small mv-muted">{data.deployment.reason}</div></> },
            { label: "Facility eligibility", value: <><Badge tone={integration.eligibilityStatus === "verified" ? "success" : integration.eligibilityStatus === "pending-verification" ? "info" : "neutral"}>{integration.eligibilityStatus.replace(/-/g, " ")}</Badge>{integration.eligibilityDecisionNote ? <div className="mv-small mv-muted">{integration.eligibilityDecisionNote}</div> : null}</> },
            { label: "Connection", value: <><Badge tone={integration.connectionStatus === "verified" ? "success" : integration.connectionStatus === "failed" ? "danger" : "neutral"}>{integration.connectionStatus.replace(/-/g, " ")}</Badge>{integration.connectionDetail ? <div className="mv-small mv-muted">{integration.connectionDetail}</div> : null}</> },
            { label: "Live submission", value: integration.liveSubmissionEnabled ? "On" : "Off" },
          ]} />
          {data.readiness.problems.length ? <ul className="mv-small mv-muted" style={{ paddingLeft: 18 }}>{data.readiness.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul> : null}
          {manage ? (
            <div className="mv-row" style={{ marginTop: 8 }}>
              <Button size="sm" variant="secondary" disabled={action.busy !== null} onClick={() => void run("test", async () => {
                const result = await api<{ ok: boolean; detail: string }>("/ehmis/connection-test", { method: "POST", body: {} });
                return result.ok ? `Connection verified: ${result.detail}` : `Connection test failed: ${result.detail}`;
              })}>Test connection</Button>
              <Button size="sm" variant={integration.liveSubmissionEnabled ? "ghost" : "primary"} disabled={action.busy !== null} onClick={() => void run("live", async () => {
                await api("/ehmis/live-submission", { method: "POST", body: { enabled: !integration.liveSubmissionEnabled } });
                return integration.liveSubmissionEnabled ? "Live submission switched off." : "Live submission switched on.";
              })}>{integration.liveSubmissionEnabled ? "Switch live submission off" : "Switch live submission on"}</Button>
            </div>
          ) : null}
        </Card>
        <Card title="Facility identity" description="Map the official NHFR identity to the facility's DHIS2 organisation unit.">
          <form className="mv-stack" onSubmit={(event: FormEvent) => { event.preventDefault(); void run("settings", async () => {
            await api("/ehmis/settings", { method: "PUT", body: { nhfrId: settings.nhfrId.trim() || null, dhis2BaseUrl: settings.dhis2BaseUrl.trim() || null, dhis2OrgUnitUid: settings.dhis2OrgUnitUid.trim() || null } });
            return "Settings saved. A change to the URL or organisation unit needs a new connection test.";
          }); }}>
            <Field label="NHFR facility ID" htmlFor="eh-nhfr"><Input id="eh-nhfr" value={settings.nhfrId} onChange={(event) => setSettings({ ...settings, nhfrId: event.target.value })} disabled={!manage} maxLength={64} /></Field>
            <Field label="DHIS2 organisation unit UID" htmlFor="eh-ou" hint={integration.dhis2OrgUnitName ? `DHIS2 name: ${integration.dhis2OrgUnitName}` : "11 characters, from the district biostatistician."}><Input id="eh-ou" value={settings.dhis2OrgUnitUid} onChange={(event) => setSettings({ ...settings, dhis2OrgUnitUid: event.target.value })} disabled={!manage} pattern="[A-Za-z][A-Za-z0-9]{10}" /></Field>
            <Field label="DHIS2 base URL" htmlFor="eh-url" hint="The eHMIS instance address approved for this facility."><Input id="eh-url" type="url" value={settings.dhis2BaseUrl} onChange={(event) => setSettings({ ...settings, dhis2BaseUrl: event.target.value })} disabled={!manage} /></Field>
            {data.baseUrlProblems.length && settings.dhis2BaseUrl ? <div className="mv-small mv-muted">{data.baseUrlProblems.join("; ")}</div> : null}
            {manage ? <div><Button type="submit" size="sm" disabled={action.busy !== null}>Save identity</Button></div> : null}
          </form>
        </Card>
      </div>
      {manage ? (
        <div className="mv-grid mv-grid--2">
          <Card title="Ministry authorization" description="Record the authorization that makes this facility eligible. A platform operator other than you verifies it before live submission is possible.">
            <form className="mv-stack" onSubmit={(event: FormEvent) => { event.preventDefault(); void run("eligibility", async () => {
              await api("/ehmis/eligibility-request", { method: "POST", body: { ...authorization, scope: "aggregate" } });
              return "Authorization recorded and sent for verification. Live submission stays off until it is verified.";
            }); }}>
              <Field label="Authorization or certificate reference" htmlFor="eh-ref"><Input id="eh-ref" value={authorization.authorizationReference} onChange={(event) => setAuthorization({ ...authorization, authorizationReference: event.target.value })} required minLength={3} maxLength={200} /></Field>
              <Field label="Issued by" htmlFor="eh-issuer"><Input id="eh-issuer" value={authorization.authorizationIssuer} onChange={(event) => setAuthorization({ ...authorization, authorizationIssuer: event.target.value })} required minLength={3} maxLength={200} /></Field>
              <Field label="Valid until" htmlFor="eh-until"><Input id="eh-until" type="date" value={authorization.authorizationValidUntil} onChange={(event) => setAuthorization({ ...authorization, authorizationValidUntil: event.target.value })} /></Field>
              <div className="mv-small mv-muted">Scope: routine aggregate HMIS reporting only. Client-level reporting needs a separate, exceptional authorization and is not available.</div>
              <div><Button type="submit" size="sm" disabled={action.busy !== null}>Submit for verification</Button></div>
            </form>
          </Card>
          <Card title="DHIS2 credentials" description={integration.credentialsStored ? `Stored server-side (${integration.credentialHint}). They are never shown again or sent to the browser.` : "Stored encrypted on the server and bound to this facility."}>
            {!data.credentialStorageAvailable ? <Notice tone="neutral">Credential storage is not configured for this deployment, so credentials cannot be stored. Use export and manual entry.</Notice> : (
              <form className="mv-stack" onSubmit={(event: FormEvent) => { event.preventDefault(); void run("credentials", async () => {
                const body = credentials.kind === "basic" ? { kind: "basic", username: credentials.username, password: credentials.password } : { kind: "personal-access-token", token: credentials.token };
                await api("/ehmis/credentials", { method: "POST", body });
                setCredentials({ kind: credentials.kind, username: "", password: "", token: "" });
                return "Credentials stored. Test the connection next.";
              }); }}>
                <Field label="Kind" htmlFor="eh-kind"><Select id="eh-kind" value={credentials.kind} onChange={(event) => setCredentials({ ...credentials, kind: event.target.value })}>
                  <option value="personal-access-token">Personal access token</option><option value="basic">Username and password</option>
                </Select></Field>
                {credentials.kind === "basic" ? (
                  <div className="mv-form-grid">
                    <Field label="Username" htmlFor="eh-user"><Input id="eh-user" autoComplete="off" value={credentials.username} onChange={(event) => setCredentials({ ...credentials, username: event.target.value })} required /></Field>
                    <Field label="Password" htmlFor="eh-pass"><Input id="eh-pass" type="password" autoComplete="new-password" value={credentials.password} onChange={(event) => setCredentials({ ...credentials, password: event.target.value })} required /></Field>
                  </div>
                ) : <Field label="Token" htmlFor="eh-token"><Input id="eh-token" type="password" autoComplete="off" value={credentials.token} onChange={(event) => setCredentials({ ...credentials, token: event.target.value })} required minLength={10} /></Field>}
                <div className="mv-row">
                  <Button type="submit" size="sm" disabled={action.busy !== null}>Store credentials</Button>
                  {integration.credentialsStored ? <Button type="button" size="sm" variant="ghost" onClick={() => void run("remove", async () => { await api("/ehmis/credentials", { method: "DELETE" }); return "Credentials removed."; })}>Remove stored credentials</Button> : null}
                </div>
              </form>
            )}
          </Card>
        </div>
      ) : null}
    </div>
  );
}

interface ElementInput { metric: string; sex: string; ageBand: string; dataElementUid: string; categoryOptionComboUid: string; label: string }

function Mappings({ data, onChanged }: { data: Overview; onChanged: () => void }) {
  const action = useAction();
  const blank: ElementInput = { metric: data.metrics[0]?.code ?? "", sex: "all", ageBand: "all", dataElementUid: "", categoryOptionComboUid: "", label: "" };
  const [form, setForm] = useState({ datasetCode: "", datasetName: "", dhis2DataSetUid: "", periodType: "Monthly", attributeOptionComboUid: "" });
  const [elements, setElements] = useState<ElementInput[]>([blank]);
  const setElement = (index: number, patch: Partial<ElementInput>) => setElements(elements.map((element, position) => position === index ? { ...element, ...patch } : element));

  async function create(event: FormEvent) {
    event.preventDefault();
    if (await action.run("create", async () => {
      await api("/ehmis/mappings", { method: "POST", body: { ...form, attributeOptionComboUid: form.attributeOptionComboUid || null, elements } });
      setElements([blank]);
      return "Mapping saved as a draft. Approve it once the district biostatistician has confirmed the UIDs.";
    })) onChanged();
  }
  async function approve(mapping: Mapping) {
    const reference = window.prompt("Who confirmed this mapping, and how? (e.g. district biostatistician email of 2026-10-20)");
    if (!reference || reference.trim().length < 3) return;
    if (await action.run(`approve-${mapping.id}`, async () => { await api(`/ehmis/mappings/${mapping.id}/approve`, { method: "POST", body: { approvalReference: reference, expectedVersion: mapping.version } }); })) onChanged();
  }
  async function retire(mapping: Mapping) {
    if (!window.confirm(`Retire the ${mapping.datasetCode} mapping?`)) return;
    if (await action.run(`retire-${mapping.id}`, async () => { await api(`/ehmis/mappings/${mapping.id}/retire`, { method: "POST" }); })) onChanged();
  }
  const metricLabel = (code: string) => data.metrics.find((metric) => metric.code === code)?.label ?? code;

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title="Dataset mappings" description="Map only the datasets, data elements and category option combinations approved for this facility. Not every category reports every form.">
        {!data.mappings.length ? <EmptyState title="No mappings" description="Add the HMIS datasets this facility is required to report." /> : (
          <Table head={["Dataset", "Period", "Elements", "Status", ""]} caption="HMIS dataset mappings">
            {data.mappings.map((mapping) => (
              <tr key={mapping.id}>
                <td><strong>{mapping.datasetName}</strong><div className="mv-small mv-muted mv-id">{mapping.datasetCode} · {mapping.dhis2DataSetUid}</div></td>
                <td>{mapping.periodType}</td>
                <td className="mv-small">{mapping.elements.map((element) => `${element.label || metricLabel(element.metric)}${element.sex !== "all" ? ` · ${element.sex}` : ""}${element.ageBand !== "all" ? ` · ${element.ageBand}` : ""}`).join("; ")}</td>
                <td><Badge tone={mapping.status === "approved" ? "success" : "neutral"}>{mapping.status}</Badge>{mapping.approvalReference ? <div className="mv-small mv-muted">{mapping.approvalReference}</div> : null}</td>
                <td>{data.permissions.manage ? <div className="mv-row">{mapping.status === "draft" ? <Button size="sm" onClick={() => void approve(mapping)}>Approve</Button> : null}<Button size="sm" variant="ghost" onClick={() => void retire(mapping)}>Retire</Button></div> : null}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {data.permissions.manage ? (
        <Card title="Add a dataset mapping">
          <form className="mv-stack" onSubmit={create}>
            <div className="mv-form-grid">
              <Field label="Form code" htmlFor="mp-code" hint="e.g. HMIS 105"><Input id="mp-code" value={form.datasetCode} onChange={(event) => setForm({ ...form, datasetCode: event.target.value })} required minLength={2} maxLength={60} /></Field>
              <Field label="Form name" htmlFor="mp-name"><Input id="mp-name" value={form.datasetName} onChange={(event) => setForm({ ...form, datasetName: event.target.value })} required minLength={2} maxLength={200} /></Field>
              <Field label="DHIS2 dataset UID" htmlFor="mp-uid"><Input id="mp-uid" value={form.dhis2DataSetUid} onChange={(event) => setForm({ ...form, dhis2DataSetUid: event.target.value })} required pattern="[A-Za-z][A-Za-z0-9]{10}" /></Field>
              <Field label="Period type" htmlFor="mp-period"><Select id="mp-period" value={form.periodType} onChange={(event) => setForm({ ...form, periodType: event.target.value })}><option>Monthly</option><option>Weekly</option><option>Quarterly</option></Select></Field>
              <Field label="Attribute option combo UID (optional)" htmlFor="mp-aoc"><Input id="mp-aoc" value={form.attributeOptionComboUid} onChange={(event) => setForm({ ...form, attributeOptionComboUid: event.target.value })} pattern="[A-Za-z][A-Za-z0-9]{10}" /></Field>
            </div>
            {elements.map((element, index) => {
              const metric = data.metrics.find((entry) => entry.code === element.metric);
              return (
                <div className="mv-form-grid" key={index}>
                  <Field label="Medveris source metric" htmlFor={`mp-metric-${index}`} hint={metric?.definition}><Select id={`mp-metric-${index}`} value={element.metric} onChange={(event) => setElement(index, { metric: event.target.value, sex: "all", ageBand: "all" })}>
                    {data.metrics.map((entry) => <option key={entry.code} value={entry.code}>{entry.label}</option>)}
                  </Select></Field>
                  {metric?.disaggregations.includes("sex") ? <Field label="Sex" htmlFor={`mp-sex-${index}`}><Select id={`mp-sex-${index}`} value={element.sex} onChange={(event) => setElement(index, { sex: event.target.value })}>{["all", "female", "male", "other", "unknown"].map((value) => <option key={value}>{value}</option>)}</Select></Field> : null}
                  {metric?.disaggregations.includes("age") ? <Field label="Age band" htmlFor={`mp-age-${index}`}><Select id={`mp-age-${index}`} value={element.ageBand} onChange={(event) => setElement(index, { ageBand: event.target.value })}>{["all", ...data.ageBands].map((value) => <option key={value}>{value}</option>)}</Select></Field> : null}
                  <Field label="Data element UID" htmlFor={`mp-de-${index}`}><Input id={`mp-de-${index}`} value={element.dataElementUid} onChange={(event) => setElement(index, { dataElementUid: event.target.value })} required pattern="[A-Za-z][A-Za-z0-9]{10}" /></Field>
                  <Field label="Category option combo UID" htmlFor={`mp-coc-${index}`}><Input id={`mp-coc-${index}`} value={element.categoryOptionComboUid} onChange={(event) => setElement(index, { categoryOptionComboUid: event.target.value })} required pattern="[A-Za-z][A-Za-z0-9]{10}" /></Field>
                  <Field label="Label" htmlFor={`mp-label-${index}`}><Input id={`mp-label-${index}`} value={element.label} onChange={(event) => setElement(index, { label: event.target.value })} maxLength={200} /></Field>
                  <div>{elements.length > 1 ? <Button type="button" size="sm" variant="ghost" onClick={() => setElements(elements.filter((_, position) => position !== index))}>Remove</Button> : null}</div>
                </div>
              );
            })}
            <div className="mv-row">
              <Button type="button" size="sm" variant="secondary" onClick={() => setElements([...elements, blank])}>Add element</Button>
              <Button type="submit" disabled={action.busy !== null}>Save draft mapping</Button>
            </div>
          </form>
        </Card>
      ) : null}
    </div>
  );
}

function Periods({ data, onChanged }: { data: Overview; onChanged: () => void }) {
  const action = useAction();
  const approved = data.mappings.filter((mapping) => mapping.status !== "retired");
  const [mappingId, setMappingId] = useState(approved[0]?.id ?? "");
  const mapping = approved.find((entry) => entry.id === mappingId);
  const [period, setPeriod] = useState(() => previousPeriod((mapping?.periodType ?? "Monthly") as PeriodType, new Date().toISOString().slice(0, 10)));
  const [open, setOpen] = useState<string | null>(null);

  async function generate(event: FormEvent) {
    event.preventDefault();
    if (await action.run("generate", async () => {
      const result = await api<{ period: { id: string; status: string } }>("/ehmis/periods", { method: "POST", body: { mappingId, period } });
      setOpen(result.period.id);
      return result.period.status === "generated" ? "Values prepared and validated. Review and approve them." : "Values prepared, but validation found errors.";
    })) onChanged();
  }

  async function post(key: string, path: string, body: unknown, message: (result: Record<string, unknown>) => string) {
    if (await action.run(key, async () => message(await api<Record<string, unknown>>(path, { method: "POST", body })))) onChanged();
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      {data.permissions.prepare ? (
        <Card title="Prepare a reporting period">
          {!approved.length ? <EmptyState title="No dataset mappings" description="Add and approve a dataset mapping first." /> : (
            <form className="mv-row" onSubmit={generate}>
              <Field label="Dataset" htmlFor="pr-mapping"><Select id="pr-mapping" value={mappingId} onChange={(event) => {
                setMappingId(event.target.value);
                const next = approved.find((entry) => entry.id === event.target.value);
                if (next) setPeriod(previousPeriod(next.periodType, new Date().toISOString().slice(0, 10)));
              }}>{approved.map((entry) => <option key={entry.id} value={entry.id}>{entry.datasetName} ({entry.periodType}{entry.status === "draft" ? ", draft" : ""})</option>)}</Select></Field>
              <Field label="Period" htmlFor="pr-period" hint="DHIS2 period, e.g. 202609, 2026W43 or 2026Q3"><Input id="pr-period" value={period} onChange={(event) => setPeriod(event.target.value)} required /></Field>
              <Button type="submit" disabled={action.busy !== null}>Prepare values</Button>
            </form>
          )}
        </Card>
      ) : null}
      <Card title="Reporting periods" description="Each revision has an idempotency key; a submitted revision is never sent twice. Reopen a period to prepare a corrected revision.">
        {!data.periods.length ? <EmptyState title="No periods" description="Prepared periods appear here." /> : (
          <Table head={["Period", "Dataset", "Status", "Schedule", "Updated", ""]} caption="HMIS reporting periods">
            {data.periods.map((row) => (
              <tr key={row.id}>
                <td><strong>{row.period}</strong><div className="mv-small mv-muted">revision {row.revision}</div></td>
                <td className="mv-small">{row.datasetCode}</td>
                <td><Badge tone={PERIOD_TONE[row.status] ?? "neutral"}>{row.status.replace(/-/g, " ")}</Badge>{row.lastError ? <div className="mv-small mv-muted">{row.lastError}</div> : null}</td>
                <td className="mv-small">{row.schedule ? <>due {row.schedule.submissionDue}<br />validation to {row.schedule.validationEnd}<br /><Badge tone={row.schedule.phase === "locked" ? "warning" : "neutral"}>{row.schedule.phase}</Badge></> : "No rule"}</td>
                <td className="mv-small">{new Date(row.submittedAt ?? row.approvedAt ?? row.generatedAt).toLocaleString()}</td>
                <td><Button size="sm" variant="secondary" onClick={() => setOpen(open === row.id ? null : row.id)}>{open === row.id ? "Hide" : "Review"}</Button></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {open ? (() => {
        const row = data.periods.find((entry) => entry.id === open);
        if (!row) return null;
        return (
          <Card title={`${row.datasetCode} · ${row.period} · revision ${row.revision}`} description={`${row.periodStart} to ${row.periodEnd} · prepared by ${row.generatedByName}${row.approvedByName ? ` · approved by ${row.approvedByName}` : ""}`}>
            <div className="mv-stack">
              {row.validation.length ? (
                <Notice tone={row.validation.some((issue) => issue.severity === "error") ? "danger" : "warning"} title="Validation">
                  <ul className="mv-small" style={{ margin: 0, paddingLeft: 18 }}>{row.validation.map((issue, index) => <li key={index}><strong>{issue.severity}:</strong> {issue.message}</li>)}</ul>
                </Notice>
              ) : <Notice tone="success">No validation issues.</Notice>}
              <Table head={["Element", "Disaggregation", "Data element / COC", "Value"]} caption="Values to report">
                {row.dataValues.map((value, index) => (
                  <tr key={index}><td>{value.label ?? data.metrics.find((metric) => metric.code === value.metric)?.label ?? value.metric}</td><td className="mv-small">{value.sex}{value.ageBand !== "all" ? ` · ${value.ageBand}` : ""}</td><td className="mv-small mv-id">{value.dataElement} / {value.categoryOptionCombo}</td><td><strong>{value.value}</strong></td></tr>
                ))}
              </Table>
              {row.importSummary && Object.keys(row.importSummary).length ? <div className="mv-small mv-muted">DHIS2 import summary: {JSON.stringify(row.importSummary)}</div> : null}
              {row.manualReference ? <div className="mv-small">Entered manually: {row.manualReference}</div> : null}
              <div className="mv-small mv-muted mv-id">Idempotency key {row.idempotencyKey}</div>
              <div className="mv-row">
                {row.status === "generated" && data.permissions.prepare ? <Button size="sm" onClick={() => void post("approve", `/ehmis/periods/${row.id}/approve`, { expectedVersion: row.version }, () => "Period approved. Export it or submit it live.")}>Approve values</Button> : null}
                {["approved", "failed", "exported", "submitted", "submitted-manually"].includes(row.status) ? (
                  <>
                    <a className="mv-small" href={`/api/v1/ehmis/periods/${row.id}/export?format=csv`} onClick={() => window.setTimeout(onChanged, 1500)}>Download CSV (DHIS2 import)</a>
                    <a className="mv-small" href={`/api/v1/ehmis/periods/${row.id}/export?format=json`} onClick={() => window.setTimeout(onChanged, 1500)}>Download JSON (dataValueSet)</a>
                  </>
                ) : null}
                {["approved", "exported", "failed"].includes(row.status) && data.permissions.submit ? (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => {
                      const reference = window.prompt("Reference for the manual entry in eHMIS (who entered it and when):");
                      if (reference && reference.trim().length >= 3) void post("manual", `/ehmis/periods/${row.id}/manual-submission`, { expectedVersion: row.version, reference }, () => "Recorded as entered manually.");
                    }}>Record manual entry</Button>
                    <Button size="sm" disabled={!data.readiness.ready} title={data.readiness.ready ? undefined : data.readiness.problems.join("; ")} onClick={() => void post("submit", `/ehmis/periods/${row.id}/submit`, {}, (result) => result.ok ? "Submitted to eHMIS/DHIS2 after a successful dry run." : `Not imported: ${String(result.error ?? "see the ledger")}`)}>Submit live</Button>
                  </>
                ) : null}
                {row.status !== "superseded" && row.status !== "submitting" && data.permissions.prepare ? <Button size="sm" variant="ghost" onClick={() => {
                  const reason = window.prompt("Why is this period being reopened? (at least 10 characters)");
                  if (reason && reason.trim().length >= 10) void post("reopen", `/ehmis/periods/${row.id}/reopen`, { expectedVersion: row.version, reason }, () => "A new revision was prepared from current data.");
                }}>Reopen</Button> : null}
              </div>
            </div>
          </Card>
        );
      })() : null}
    </div>
  );
}

function Ledger({ data }: { data: Overview }) {
  return (
    <Card title="Submission ledger" description="Every connection test, dry run, import, export, manual entry and refusal, with its outcome. Entries cannot be edited.">
      {!data.ledger.length ? <EmptyState title="No entries" description="Activity appears here." /> : (
        <Table head={["When", "Period", "Kind", "Outcome", "Detail", "By"]} caption="eHMIS submission ledger">
          {data.ledger.map((entry, index) => (
            <tr key={index}>
              <td className="mv-small">{new Date(entry.finishedAt).toLocaleString()}</td>
              <td>{entry.period ?? "—"}</td>
              <td className="mv-small">{entry.kind}</td>
              <td><Badge tone={entry.outcome === "succeeded" ? "success" : entry.outcome === "skipped-duplicate" ? "neutral" : "danger"}>{entry.outcome}</Badge>{entry.httpStatus ? <div className="mv-small mv-muted">HTTP {entry.httpStatus}</div> : null}</td>
              <td className="mv-small">{entry.error ?? (Object.keys(entry.summary ?? {}).length ? JSON.stringify(entry.summary) : "—")}</td>
              <td className="mv-small">{entry.actorName ?? "—"}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

function Rules({ data, onChanged }: { data: Overview; onChanged: () => void }) {
  const action = useAction();
  const monthly = data.rules.Monthly;
  const [form, setForm] = useState({ periodType: "Monthly", submissionDueDay: String(monthly?.submissionDueDay ?? 7), validationStartDay: String(monthly?.validationStartDay ?? 8), validationEndDay: String(monthly?.validationEndDay ?? 15), lockAfterDay: String(monthly?.lockAfterDay ?? 15), source: "" });
  async function save(event: FormEvent) {
    event.preventDefault();
    if (await action.run("rule", async () => {
      await api("/ehmis/rules", { method: "PUT", body: { periodType: form.periodType, submissionDueDay: Number(form.submissionDueDay), validationStartDay: Number(form.validationStartDay), validationEndDay: Number(form.validationEndDay), lockAfterDay: Number(form.lockAfterDay), source: form.source } });
      return "Facility schedule saved.";
    })) onChanged();
  }
  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title="Reporting schedule" description="Deadlines are configuration, not code. Confirm the current schedule with the district before relying on it.">
        <Table head={["Period type", "Submission due", "Validation", "Locked after", "Source", "Applies"]} caption="Effective reporting rules">
          {(["Monthly", "Weekly", "Quarterly"] as const).map((type) => {
            const rule = data.rules[type];
            return <tr key={type}><td>{type}</td>{rule ? <><td>day {rule.submissionDueDay}</td><td>days {rule.validationStartDay}–{rule.validationEndDay}</td><td>day {rule.lockAfterDay}</td><td className="mv-small">{rule.source}<div className="mv-muted">checked {rule.verifiedOn}</div></td><td>{rule.scope === "facility" ? "This facility" : "Platform default"}</td></> : <td colSpan={5} className="mv-small mv-muted">No rule configured</td>}</tr>;
          })}
        </Table>
      </Card>
      {data.permissions.manage ? (
        <Card title="Set this facility's schedule">
          <form className="mv-stack" onSubmit={save}>
            <div className="mv-form-grid">
              <Field label="Period type" htmlFor="rl-type"><Select id="rl-type" value={form.periodType} onChange={(event) => setForm({ ...form, periodType: event.target.value })}><option>Monthly</option><option>Weekly</option><option>Quarterly</option></Select></Field>
              <Field label="Submission due (day of next month)" htmlFor="rl-due"><Input id="rl-due" type="number" min="1" max="28" value={form.submissionDueDay} onChange={(event) => setForm({ ...form, submissionDueDay: event.target.value })} /></Field>
              <Field label="Validation starts" htmlFor="rl-vs"><Input id="rl-vs" type="number" min="1" max="28" value={form.validationStartDay} onChange={(event) => setForm({ ...form, validationStartDay: event.target.value })} /></Field>
              <Field label="Validation ends" htmlFor="rl-ve"><Input id="rl-ve" type="number" min="1" max="28" value={form.validationEndDay} onChange={(event) => setForm({ ...form, validationEndDay: event.target.value })} /></Field>
              <Field label="Locked after" htmlFor="rl-lock"><Input id="rl-lock" type="number" min="1" max="28" value={form.lockAfterDay} onChange={(event) => setForm({ ...form, lockAfterDay: event.target.value })} /></Field>
            </div>
            <Field label="Source of this schedule" htmlFor="rl-source" hint="Circular, guideline section or district instruction, with date."><Textarea id="rl-source" value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value })} required minLength={5} maxLength={500} /></Field>
            <div><Button type="submit" disabled={action.busy !== null}>Save schedule</Button></div>
          </form>
        </Card>
      ) : null}
    </div>
  );
}

interface EligibilityRequest {
  tenantId: string; facilityName: string; serviceCategory: string | null; levelStatus: string; officialLevel: string | null; nhfrId: string | null;
  dhis2OrgUnitUid: string | null; eligibilityStatus: string; authorizationReference: string | null; authorizationIssuer: string | null;
  authorizationValidUntil: string | null; eligibilityRequestedAt: string | null; eligibilityDecisionNote: string | null; requestedByName: string | null; registrations: string | null;
}

/** Platform operators check each facility's Ministry authorization evidence before it may submit live. */
export function EhmisEligibilityReview() {
  const requests = useQuery<{ requests: EligibilityRequest[] }>("/ehmis/eligibility-requests");
  const action = useAction();
  async function decide(request: EligibilityRequest, decision: "verified" | "rejected" | "suspended") {
    const note = window.prompt(`Record how the authorization was checked for ${request.facilityName} (at least 10 characters):`);
    if (!note || note.trim().length < 10) return;
    if (await action.run(`${decision}-${request.tenantId}`, async () => { await api(`/ehmis/eligibility/${request.tenantId}/decision`, { method: "POST", body: { decision, note } }); })) requests.reload();
  }
  return (
    <Card title="eHMIS eligibility verification" description="Verify only against the Ministry authorization evidence. You cannot verify a request you recorded yourself.">
      {action.error ? <ErrorState message={action.error} /> : null}
      {requests.loading && !requests.data ? <LoadingState /> : requests.error ? <ErrorState message={requests.error} onRetry={requests.reload} /> : !requests.data?.requests.length ? <EmptyState title="No requests" description="Facilities that record an eHMIS authorization appear here." /> : (
        <Table head={["Facility", "Identity", "Authorization", "Status", ""]} caption="eHMIS eligibility requests">
          {requests.data.requests.map((request) => (
            <tr key={request.tenantId}>
              <td><strong>{request.facilityName}</strong><div className="mv-small mv-muted">{request.serviceCategory ?? "—"} · {request.levelStatus}{request.officialLevel ? ` (${request.officialLevel})` : ""}</div></td>
              <td className="mv-small">NHFR {request.nhfrId ?? "—"}<br />Org unit {request.dhis2OrgUnitUid ?? "—"}<br />{request.registrations ?? ""}</td>
              <td className="mv-small">{request.authorizationReference ?? "—"}<br />{request.authorizationIssuer ?? ""}{request.authorizationValidUntil ? ` · until ${request.authorizationValidUntil.slice(0, 10)}` : ""}<br />by {request.requestedByName ?? "—"}</td>
              <td><Badge tone={request.eligibilityStatus === "verified" ? "success" : request.eligibilityStatus === "pending-verification" ? "info" : "neutral"}>{request.eligibilityStatus}</Badge>{request.eligibilityDecisionNote ? <div className="mv-small mv-muted">{request.eligibilityDecisionNote}</div> : null}</td>
              <td><div className="mv-row">
                {request.eligibilityStatus === "pending-verification" ? <><Button size="sm" onClick={() => void decide(request, "verified")}>Verify</Button><Button size="sm" variant="secondary" onClick={() => void decide(request, "rejected")}>Reject</Button></> : null}
                {request.eligibilityStatus === "verified" ? <Button size="sm" variant="ghost" onClick={() => void decide(request, "suspended")}>Suspend</Button> : null}
              </div></td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
