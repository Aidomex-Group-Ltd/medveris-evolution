import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Tabs, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDateTime } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";

interface WorklistItem {
  orderItemId: string;
  examination: string;
  priority: string;
  orderedAt: string;
  publicId: string;
  givenName: string;
  familyName: string;
  studyId: string | null;
  accession: string | null;
  modality: string | null;
  acquisitionStatus: string | null;
  studyVersion: number | null;
  reportId: string | null;
  reportStatus: string | null;
  urgency: string | null;
  radiologistName: string | null;
  stage: string;
  openCritical: number;
  minutesOrderToSign: number;
}

interface CatalogueTemplate {
  code: string;
  name: string;
  modality: string;
  bodyRegion: string;
  fields: Array<{ key: string; label: string; required: boolean; section: string }>;
  facilityApproval: { version: number; approvedAt: string } | null;
}

interface ApprovedTemplate { id: string; code: string; name: string; modality: string; version: number }

interface CriticalItem {
  id: string;
  reportId: string;
  findingSummary: string;
  communicatedAt: string;
  acknowledgedAt: string | null;
  escalatedAt: string | null;
  recipientUserId: string;
  escalatedTo: string | null;
  recipientName: string;
  escalatedToName: string | null;
  publicId: string;
  givenName: string;
  familyName: string;
  accession: string;
  minutesOpen: number;
  overdue: boolean;
}

const STAGES = [
  { value: "all", label: "All stages" },
  { value: "awaiting-study", label: "Awaiting study" },
  { value: "awaiting-acquisition", label: "Awaiting acquisition" },
  { value: "awaiting-report", label: "Awaiting report" },
  { value: "draft", label: "Draft" },
  { value: "preliminary", label: "Preliminary" },
  { value: "signed", label: "Signed, not released" },
  { value: "released", label: "Released" },
];

const STAGE_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  "awaiting-study": "warning", "awaiting-acquisition": "warning", "awaiting-report": "warning",
  draft: "neutral", preliminary: "neutral", signed: "success", released: "success",
};

export function RadiologyPage() {
  const [tab, setTab] = useState<"worklist" | "templates" | "critical">("worklist");
  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Radiology" title="Imaging worklist and structured reporting" description="Orders, studies, structured reports, sign-off and critical findings. Turnaround is calculated from recorded timestamps." />
      <Notice tone="warning" title="PACS / DICOMweb unavailable">No images are retrieved, displayed or transferred. Studies hold metadata only, and reports are written from images reviewed outside Medveris.</Notice>
      <Tabs label="Radiology sections" value={tab} onChange={setTab} options={[
        { value: "worklist", label: "Worklist" },
        { value: "templates", label: "Templates" },
        { value: "critical", label: "Critical findings" },
      ]} />
      {tab === "worklist" ? <Worklist /> : tab === "templates" ? <Templates /> : <CriticalFindings />}
    </div>
  );
}

function Worklist() {
  const [stage, setStage] = useState("all");
  const [modality, setModality] = useState("");
  const [priority, setPriority] = useState("");
  const [offset, setOffset] = useState(0);
  const params = new URLSearchParams({ status: stage, limit: "50", offset: String(offset) });
  if (modality) params.set("modality", modality);
  if (priority) params.set("priority", priority);
  const worklist = useQuery<{ items: WorklistItem[]; hasMore: boolean }>(`/radiology/worklist?${params.toString()}`);
  const templates = useQuery<{ templates: ApprovedTemplate[] }>("/radiology/templates");
  return (
    <Card title="Worklist" description="Sorted by priority, then order time.">
      <div className="mv-form-grid">
        <Field label="Stage"><Select value={stage} onChange={(event) => { setStage(event.target.value); setOffset(0); }}>{STAGES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></Field>
        <Field label="Modality"><Select value={modality} onChange={(event) => { setModality(event.target.value); setOffset(0); }}><option value="">All</option>{["XR", "CT", "MR", "US", "OT"].map((value) => <option key={value}>{value}</option>)}</Select></Field>
        <Field label="Priority"><Select value={priority} onChange={(event) => { setPriority(event.target.value); setOffset(0); }}><option value="">All</option><option value="emergency">Emergency</option><option value="urgent">Urgent</option><option value="routine">Routine</option></Select></Field>
      </div>
      {worklist.loading ? <LoadingState /> : worklist.error ? <ErrorState message={worklist.error} onRetry={worklist.reload} /> : !worklist.data?.items.length ? (
        <EmptyState title="No imaging work" description="No imaging orders match these filters." />
      ) : (
        <div className="mv-stack" style={{ marginTop: 12 }}>
          <Table head={["Patient", "Examination", "Priority", "Accession", "Stage", "Order to sign", "Action"]} caption="Radiology worklist">
            {worklist.data.items.map((item) => (
              <tr key={item.orderItemId}>
                <td><strong>{item.givenName} {item.familyName}</strong><div className="mv-small mv-muted mv-id">{item.publicId}</div></td>
                <td>{item.examination}<div className="mv-small mv-muted">ordered {formatDateTime(item.orderedAt)}</div></td>
                <td><Badge tone={item.priority === "routine" ? "neutral" : "danger"}>{item.priority}</Badge></td>
                <td className="mv-id">{item.accession ?? "—"}</td>
                <td>
                  <Badge tone={STAGE_TONE[item.stage] ?? "neutral"}>{item.stage.replace(/-/g, " ")}</Badge>
                  {item.urgency === "critical" ? <div><Badge tone="danger">critical</Badge></div> : null}
                  {item.openCritical ? <div className="mv-small">{item.openCritical} unacknowledged</div> : null}
                </td>
                <td className="mv-small">{item.minutesOrderToSign} min{item.stage === "released" || item.stage === "signed" ? "" : " so far"}</td>
                <td><WorklistAction item={item} templates={templates.data?.templates ?? []} onDone={worklist.reload} /></td>
              </tr>
            ))}
          </Table>
          <div className="mv-row">
            <Button size="sm" variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</Button>
            <Button size="sm" variant="ghost" disabled={!worklist.data.hasMore} onClick={() => setOffset(offset + 50)}>Next</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function WorklistAction({ item, templates, onDone }: { item: WorklistItem; templates: ApprovedTemplate[]; onDone: () => void }) {
  const navigate = useNavigate();
  const action = useAction();
  const [open, setOpen] = useState(false);
  const [modality, setModality] = useState("XR");
  const [bodySite, setBodySite] = useState("");
  const [protocol, setProtocol] = useState("");
  const [templateId, setTemplateId] = useState("");
  if (item.reportId) return <Link to={`/radiology/reports/${item.reportId}`}>Open report</Link>;
  if (!item.studyId) {
    if (!open) return <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>Register study</Button>;
    return (
      <form className="mv-stack" onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void action.run("study", async () => {
          await api("/radiology/studies", { method: "POST", body: { orderItemId: item.orderItemId, modality, bodySite, protocol } });
          onDone();
        });
      }}>
        {action.error ? <ErrorState message={action.error} /> : null}
        <Field label="Modality"><Select value={modality} onChange={(event) => setModality(event.target.value)}>{["XR", "CT", "MR", "US", "OT"].map((value) => <option key={value}>{value}</option>)}</Select></Field>
        <Field label="Body site" htmlFor={`site-${item.orderItemId}`}><Input id={`site-${item.orderItemId}`} value={bodySite} onChange={(event) => setBodySite(event.target.value)} required /></Field>
        <Field label="Protocol" htmlFor={`protocol-${item.orderItemId}`}><Input id={`protocol-${item.orderItemId}`} value={protocol} onChange={(event) => setProtocol(event.target.value)} /></Field>
        <Button size="sm" type="submit" disabled={action.busy !== null || !bodySite.trim()}>{action.busy ? "Registering…" : "Register"}</Button>
      </form>
    );
  }
  if (item.acquisitionStatus !== "acquired") {
    return (
      <div className="mv-stack">
        {action.error ? <ErrorState message={action.error} /> : null}
        <Button size="sm" variant="secondary" disabled={action.busy !== null} onClick={() => void action.run("acquire", async () => {
          await api(`/radiology/studies/${item.studyId}/acquisition`, { method: "POST", body: { status: "acquired", expectedVersion: item.studyVersion } });
          onDone();
        })}>Mark acquired</Button>
      </div>
    );
  }
  const suggested = templates.filter((template) => template.modality === item.modality);
  return (
    <form className="mv-stack" onSubmit={(event: FormEvent) => {
      event.preventDefault();
      void action.run("report", async () => {
        const created = await api<{ report: { id: string } }>("/radiology/reports", { method: "POST", body: { studyId: item.studyId, templateId } });
        navigate(`/radiology/reports/${created.report.id}`);
      });
    }}>
      {action.error ? <ErrorState message={action.error} /> : null}
      {!templates.length ? <span className="mv-small mv-muted">No approved template yet. A radiologist must approve one under Templates.</span> : (
        <>
          <Field label="Template"><Select value={templateId} onChange={(event) => setTemplateId(event.target.value)} required>
            <option value="">Select…</option>
            {(suggested.length ? suggested : templates).map((template) => <option key={template.id} value={template.id}>{template.name} (v{template.version})</option>)}
          </Select></Field>
          <Button size="sm" type="submit" disabled={action.busy !== null || !templateId}>Start report</Button>
        </>
      )}
    </form>
  );
}

function Templates() {
  const { me } = useAuth();
  const canApprove = Boolean(me?.activeTenant?.roles.includes("radiologist"));
  const catalogue = useQuery<{ templates: CatalogueTemplate[]; notice: string }>("/radiology/catalogue");
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const action = useAction();
  if (catalogue.loading) return <LoadingState />;
  if (catalogue.error) return <ErrorState message={catalogue.error} onRetry={catalogue.reload} />;
  return (
    <Card title="Report templates" description={catalogue.data?.notice}>
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Table head={["Template", "Modality", "Required sections", "Facility approval", ""]} caption="Template catalogue">
        {catalogue.data?.templates.map((template) => (
          <tr key={template.code}>
            <td><strong>{template.name}</strong><div className="mv-small mv-muted">{template.bodyRegion}</div></td>
            <td>{template.modality}</td>
            <td className="mv-small">{template.fields.filter((field) => field.required).map((field) => field.label).join(", ")}</td>
            <td>{template.facilityApproval ? <Badge tone="success">{`approved v${template.facilityApproval.version}`}</Badge> : <Badge tone="warning">not approved</Badge>}</td>
            <td>{canApprove ? <Button size="sm" variant="secondary" onClick={() => { setSelected(template.code); setNote(""); }}>{template.facilityApproval ? "Approve new version" : "Review and approve"}</Button> : null}</td>
          </tr>
        ))}
      </Table>
      {!canApprove ? <p className="mv-small mv-muted">Only a radiologist can approve templates.</p> : null}
      {selected ? (
        <form className="mv-stack mv-note" style={{ marginTop: 12 }} onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void action.run("approve", async () => {
            await api("/radiology/templates", { method: "POST", body: { code: selected, approvalNote: note } });
            setSelected(null);
            catalogue.reload();
            return "Template approved for this facility.";
          });
        }}>
          <strong>Approve {catalogue.data?.templates.find((template) => template.code === selected)?.name}</strong>
          <Field label="Approval note" htmlFor="template-note" hint="Record the clinical review that supports this approval (at least 10 characters).">
            <Textarea id="template-note" value={note} onChange={(event) => setNote(event.target.value)} minLength={10} required />
          </Field>
          <div className="mv-row">
            <Button type="submit" disabled={action.busy !== null || note.trim().length < 10}>Approve</Button>
            <Button type="button" variant="ghost" onClick={() => setSelected(null)}>Cancel</Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}

function CriticalFindings() {
  const { me } = useAuth();
  const [state, setState] = useState<"open" | "all">("open");
  const list = useQuery<{ communications: CriticalItem[]; acknowledgementMinutes: number }>(`/radiology/critical-communications?state=${state}`);
  const action = useAction();
  return (
    <Card title="Critical imaging findings" description={`Findings unacknowledged after ${list.data?.acknowledgementMinutes ?? "—"} minutes are flagged overdue (facility policy setting).`}>
      <Field label="Show"><Select value={state} onChange={(event) => setState(event.target.value as "open" | "all")}><option value="open">Unacknowledged</option><option value="all">All</option></Select></Field>
      {action.error ? <ErrorState message={action.error} /> : null}
      {list.loading ? <LoadingState /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : !list.data?.communications.length ? (
        <EmptyState title="No critical findings" description="No critical imaging findings match this view." />
      ) : (
        <Table head={["Patient", "Finding", "Communicated", "Status", ""]} caption="Critical imaging findings">
          {list.data.communications.map((item) => (
            <tr key={item.id}>
              <td><strong>{item.givenName} {item.familyName}</strong><div className="mv-small mv-muted mv-id">{item.accession}</div></td>
              <td className="mv-small">{item.findingSummary}<div><Link to={`/radiology/reports/${item.reportId}`}>Open report</Link></div></td>
              <td className="mv-small">{formatDateTime(item.communicatedAt)} to {item.recipientName}{item.escalatedToName ? <div>escalated to {item.escalatedToName}</div> : null}</td>
              <td>{item.acknowledgedAt ? <Badge tone="success">acknowledged</Badge> : item.overdue ? <Badge tone="danger">{`overdue (${item.minutesOpen} min)`}</Badge> : <Badge tone="warning">{`open (${item.minutesOpen} min)`}</Badge>}</td>
              <td>{!item.acknowledgedAt && me && [item.recipientUserId, item.escalatedTo].includes(me.user.id) ? (
                <Button size="sm" onClick={() => {
                  const note = window.prompt("Acknowledgement note (what was done):");
                  if (!note || note.trim().length < 2) return;
                  void action.run("ack", async () => {
                    await api(`/radiology/critical-communications/${item.id}/acknowledge`, { method: "POST", body: { note } });
                    list.reload();
                  });
                }}>Acknowledge</Button>
              ) : null}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
