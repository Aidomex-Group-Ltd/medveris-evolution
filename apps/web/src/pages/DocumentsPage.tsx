import { useEffect, useState, type FormEvent } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Tabs, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";
import { PatientPicker } from "../components/Pickers";

interface FieldDef { key: string; label: string; type: string; required?: boolean; section?: string; options?: string[] }
interface Template { id: string; templateKey: string; name: string; context: string; status: string; currentVersion: number; fields: FieldDef[]; documentCount: number }
interface DocumentRow { id: string; title: string; status: string; templateName: string; context: string; patientId: string | null; givenName: string | null; familyName: string | null; publicId: string | null; occurredAt: string; recordedAt: string; currentVersion: number; authorName: string }
interface Version { id: string; version: number; status: string; content: Record<string, unknown>; contentDigest: string; changeNote: string; signedAt: string | null; createdAt: string }
interface DocumentDetail { document: DocumentRow & { templateId: string }; versions: Version[] }

const CONTEXTS = ["clinical", "nursing", "maternity", "theatre", "diagnostic", "pharmacy", "administrative", "operational", "hr", "mortuary", "housekeeping", "portering", "technical"];
const DEFAULT_FIELDS = `[
  { "key": "presenting_complaint", "label": "Presenting complaint", "type": "textarea", "required": true, "section": "History" },
  { "key": "assessment", "label": "Assessment", "type": "textarea", "required": true, "section": "Clinical" },
  { "key": "plan", "label": "Plan", "type": "textarea", "required": true, "section": "Plan" }
]`;

export function DocumentsPage() {
  const [tab, setTab] = useState<"documents" | "templates">("documents");
  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Records" title="Documentation registry" description="Versioned, department-aware templates and forms. Signed versions are immutable; every revision keeps its own digest and reason." />
      <Tabs label="Documentation sections" value={tab} onChange={setTab} options={[
        { value: "documents", label: "Documents" },
        { value: "templates", label: "Templates" },
      ]} />
      {tab === "documents" ? <Documents /> : <Templates />}
    </div>
  );
}

function Templates() {
  const templates = useQuery<{ templates: Template[] }>("/document-templates");
  const action = useAction();
  const [templateKey, setTemplateKey] = useState("");
  const [name, setName] = useState("");
  const [context, setContext] = useState("clinical");
  const [fields, setFields] = useState(DEFAULT_FIELDS);

  async function create(event: FormEvent) {
    event.preventDefault();
    let parsed: unknown;
    try {
      parsed = JSON.parse(fields);
    } catch {
      action.setError("Fields must be valid JSON.");
      return;
    }
    await action.run("template", async () => {
      await api("/document-templates", {
        method: "POST",
        body: { templateKey, name, context, fields: parsed, authorRoles: ["clinician", "nurse"], reviewerRoles: ["clinician"] },
      });
      setTemplateKey("");
      setName("");
      templates.reload();
      return "Template draft created. Publish it before use.";
    });
  }

  async function publish(template: Template) {
    await action.run(template.id, async () => {
      await api(`/document-templates/${template.id}/publish`, { method: "POST", body: { expectedVersion: template.currentVersion, approvalNote: "Published from documentation registry" } });
      templates.reload();
      return `${template.name} published.`;
    });
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <div className="mv-grid mv-grid--2">
        <Card title="Create a template" description="Fields define required content. A template cannot be used until published.">
          <form className="mv-stack" onSubmit={create}>
            <div className="mv-form-grid">
              <Field label="Template key" htmlFor="tpl-key" hint="Lower-case letters, digits, dots and dashes."><Input id="tpl-key" value={templateKey} onChange={(event) => setTemplateKey(event.target.value)} required pattern="[a-z0-9][a-z0-9.-]+" /></Field>
              <Field label="Name" htmlFor="tpl-name"><Input id="tpl-name" value={name} onChange={(event) => setName(event.target.value)} required /></Field>
            </div>
            <Field label="Context"><Select value={context} onChange={(event) => setContext(event.target.value)}>{CONTEXTS.map((value) => <option key={value} value={value}>{value}</option>)}</Select></Field>
            <Field label="Fields (JSON)" htmlFor="tpl-fields" hint="Each field needs a key, label and supported type."><Textarea id="tpl-fields" value={fields} onChange={(event) => setFields(event.target.value)} rows={10} /></Field>
            <Button type="submit" disabled={action.busy !== null || !templateKey.trim() || !name.trim()}>{action.busy === "template" ? "Creating…" : "Create template"}</Button>
          </form>
        </Card>
        <Card title="Templates" description={`${templates.data?.templates.length ?? 0} templates in this facility.`}>
          {templates.loading ? <LoadingState /> : templates.error ? <ErrorState message={templates.error} onRetry={templates.reload} /> : !templates.data?.templates.length ? <EmptyState title="No templates" description="Create a template to begin." /> : (
            <Table head={["Template", "Context", "Version", "Status", ""]} caption="Document templates">
              {templates.data.templates.map((row) => (
                <tr key={row.id}>
                  <td><strong>{row.name}</strong><div className="mv-small mv-muted mv-id">{row.templateKey}</div></td>
                  <td>{row.context}</td>
                  <td>{row.currentVersion}</td>
                  <td><Badge tone={row.status === "published" ? "success" : row.status === "retired" ? "danger" : "warning"}>{row.status}</Badge></td>
                  <td>{row.status === "draft" ? <Button size="sm" variant="secondary" onClick={() => void publish(row)} disabled={action.busy !== null}>{action.busy === row.id ? "Publishing…" : "Publish"}</Button> : null}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}

function Documents() {
  const templates = useQuery<{ templates: Template[] }>("/document-templates");
  const documents = useQuery<{ documents: DocumentRow[] }>("/documents");
  const action = useAction();
  const [templateId, setTemplateId] = useState("");
  const [patientId, setPatientId] = useState("");
  const [title, setTitle] = useState("");
  const [occurredAt, setOccurredAt] = useState(new Date().toISOString().slice(0, 16));
  const [content, setContent] = useState("{}");
  const [selectedId, setSelectedId] = useState("");
  const selected = useQuery<DocumentDetail>(selectedId ? `/documents/${selectedId}` : null);

  const published = templates.data?.templates.filter((row) => row.status === "published") ?? [];
  const activeTemplate = published.find((row) => row.id === templateId);

  useEffect(() => {
    if (!activeTemplate) return;
    const skeleton = Object.fromEntries(activeTemplate.fields.map((field) => [field.key, ""]));
    setContent(JSON.stringify(skeleton, null, 2));
  }, [templateId]);

  async function create(event: FormEvent) {
    event.preventDefault();
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      action.setError("Content must be valid JSON.");
      return;
    }
    await action.run("document", async () => {
      await api("/documents", {
        method: "POST",
        body: {
          templateId,
          subjectType: "patient",
          patientId,
          title,
          occurredAt: new Date(occurredAt).toISOString(),
          content: parsed,
          changeNote: "Initial draft",
        },
      });
      setTitle("");
      documents.reload();
      return "Draft document created.";
    });
  }

  async function sign(row: DocumentRow) {
    await action.run(`sign-${row.id}`, async () => {
      await api(`/documents/${row.id}/sign`, { method: "POST", body: { expectedVersion: row.currentVersion, note: "Signed from documentation registry" } });
      documents.reload();
      selected.reload();
      return "Document signed. The signed version is now immutable.";
    });
  }

  async function enterInError(row: DocumentRow) {
    const reason = window.prompt("Reason for marking this document entered in error (at least 10 characters):") ?? "";
    if (reason.trim().length < 10) return;
    await action.run(`error-${row.id}`, async () => {
      await api(`/documents/${row.id}/error`, { method: "POST", body: { expectedVersion: row.currentVersion, reason } });
      documents.reload();
      selected.reload();
      return "Document marked entered in error. The previous version remains in history.";
    });
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title="Create a document" description="Only published templates are available. Required fields are validated on the server.">
        <form className="mv-stack" onSubmit={create}>
          <div className="mv-form-grid">
            <Field label="Template"><Select value={templateId} onChange={(event) => setTemplateId(event.target.value)} required><option value="">Select a published template…</option>{published.map((row) => <option key={row.id} value={row.id}>{row.name} · {row.context}</option>)}</Select></Field>
            <PatientPicker value={patientId} onChange={setPatientId} />
            <Field label="Title" htmlFor="doc-title"><Input id="doc-title" value={title} onChange={(event) => setTitle(event.target.value)} required /></Field>
            <Field label="Clinical occurrence" htmlFor="doc-occurred"><Input id="doc-occurred" type="datetime-local" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} required /></Field>
          </div>
          <Field label="Content (JSON)" htmlFor="doc-content" hint="Keys must match the selected template fields."><Textarea id="doc-content" value={content} onChange={(event) => setContent(event.target.value)} rows={8} /></Field>
          <Button type="submit" disabled={action.busy !== null || !templateId || !patientId || !title.trim()}>{action.busy === "document" ? "Creating…" : "Save draft"}</Button>
        </form>
      </Card>
      <Card title="Documents" description="Signed records are never edited in place. Amendments and entered-in-error actions create new versions.">
        {documents.loading ? <LoadingState /> : documents.error ? <ErrorState message={documents.error} onRetry={documents.reload} /> : !documents.data?.documents.length ? <EmptyState title="No documents" description="Create a draft from a published template." /> : (
          <Table head={["Document", "Patient", "Template", "Version", "Status", ""]} caption="Documents">
            {documents.data.documents.map((row) => (
              <tr key={row.id}>
                <td><strong>{row.title}</strong><div className="mv-small mv-muted">{formatDateTime(row.recordedAt)}</div></td>
                <td>{row.givenName ? `${row.familyName}, ${row.givenName}` : "—"}<div className="mv-small mv-muted mv-id">{row.publicId ?? ""}</div></td>
                <td>{row.templateName}<div className="mv-small mv-muted">{row.context}</div></td>
                <td>{row.currentVersion}</td>
                <td><Badge tone={row.status === "signed" ? "success" : row.status === "entered-in-error" ? "danger" : row.status === "amended" ? "warning" : "info"}>{row.status}</Badge></td>
                <td>
                  <div className="mv-row">
                    <Button size="sm" variant="secondary" onClick={() => setSelectedId(row.id)}>View</Button>
                    {row.status === "draft" ? <Button size="sm" onClick={() => void sign(row)} disabled={action.busy !== null}>{action.busy === `sign-${row.id}` ? "Signing…" : "Sign"}</Button> : null}
                    {row.status === "signed" || row.status === "amended" ? <Button size="sm" variant="ghost" onClick={() => void enterInError(row)} disabled={action.busy !== null}>Entered in error</Button> : null}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {selectedId ? (
        <Card title="Version history" description="Each version stores its own digest and change reason.">
          {selected.loading ? <LoadingState /> : selected.error ? <ErrorState message={selected.error} onRetry={selected.reload} /> : selected.data ? (
            <div className="mv-stack">
              <div className="mv-spread"><strong>{selected.data.document.title}</strong><Button size="sm" variant="ghost" onClick={() => setSelectedId("")}>Close</Button></div>
              <Table head={["Version", "Status", "Change note", "Signed", "Digest"]} caption="Document versions">
                {selected.data.versions.map((version) => (
                  <tr key={version.id}>
                    <td>{version.version}</td>
                    <td><Badge tone={version.status === "signed" ? "success" : version.status === "entered-in-error" ? "danger" : "neutral"}>{version.status}</Badge></td>
                    <td>{version.changeNote}<div className="mv-small mv-muted">{JSON.stringify(version.content)}</div></td>
                    <td className="mv-small">{version.signedAt ? formatDateTime(version.signedAt) : "—"}</td>
                    <td className="mv-small mv-id">{version.contentDigest.slice(0, 26)}…</td>
                  </tr>
                ))}
              </Table>
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
