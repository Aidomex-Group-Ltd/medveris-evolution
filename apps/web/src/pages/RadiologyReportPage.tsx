import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge, Button, Card, DataList, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Textarea } from "@medveris/ui";
import { ApiError, api, errorMessage } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";

interface TemplateField { key: string; label: string; section: "request" | "technique" | "findings" | "conclusion"; kind: "text" | "longtext" | "select"; required: boolean; options?: string[]; hint?: string }
interface Definition { code: string; name: string; fields: TemplateField[]; measurementUnits: string[] }
interface Measurement { label: string; value: number; unit: string }
interface Content { fields: Record<string, string>; measurements: Measurement[] }

interface ReportResponse {
  report: {
    id: string; status: string; urgency: string; content: Content; draftVersion: number; signedVersion: number;
    definition: Definition; templateName: string; templateVersion: number; accession: string; modality: string; bodySite: string;
    acquisitionStatus: string; acquiredAt: string | null; protocol: string | null; priority: string; clinicalNote: string; orderedAt: string;
    examination: string; publicId: string; givenName: string; familyName: string; dateOfBirth: string; sex: string;
    radiologistName: string | null; createdByName: string; signedAt: string | null; releasedAt: string | null;
  };
  versions: Array<{ version: number; kind: string; content: Content; contentHash: string; urgency: string; changeReason: string | null; signedAt: string; signedByName: string }>;
  addenda: Array<{ id: string; appliesToVersion: number; text: string; reason: string; signedAt: string; signedByName: string }>;
  critical: Array<{ id: string; recipientName: string; method: string; findingSummary: string; communicatedAt: string; acknowledgedAt: string | null; acknowledgedByName: string | null; escalatedToName: string | null }>;
  priors: Array<{ id: string; signedAt: string; templateName: string; modality: string; accession: string; impression: string | null }>;
  images: { state: string; reason: string; available: boolean };
  permissions: { draft: boolean; sign: boolean; addend: boolean };
}

const SECTIONS: Array<{ key: TemplateField["section"]; title: string }> = [
  { key: "request", title: "Request" },
  { key: "technique", title: "Technique, comparison and quality" },
  { key: "findings", title: "Findings" },
  { key: "conclusion", title: "Conclusion" },
];

export function RadiologyReportPage() {
  const { id = "" } = useParams();
  const query = useQuery<ReportResponse>(`/radiology/reports/${id}`);
  if (query.loading && !query.data) return <LoadingState label="Loading report" />;
  if (query.error || !query.data) return <ErrorState message={query.error ?? "Report not available"} onRetry={query.reload} />;
  return <ReportWorkspace data={query.data} reload={query.reload} />;
}

function ReportWorkspace({ data, reload }: { data: ReportResponse; reload: () => void }) {
  const { report } = data;
  const editable = ["draft", "preliminary"].includes(report.status) && data.permissions.draft;
  const signed = ["final", "corrected"].includes(report.status);
  const latest = data.versions[data.versions.length - 1];
  const shown: Content = signed && latest ? latest.content : report.content;

  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Radiology report" title={`${report.examination} — ${report.givenName} ${report.familyName}`}
        description={`${report.templateName} template v${report.templateVersion} · accession ${report.accession}`}
        actions={<div className="mv-row"><Link to="/radiology">Back to worklist</Link><Button variant="secondary" onClick={() => window.print()}>Print</Button></div>} />
      <Notice tone="warning" title={`Images: DICOMweb ${data.images.state.replace("_", " ")}`}>{data.images.reason}. No images are shown or attached to this report.</Notice>
      <Card title="Examination">
        <DataList items={[
          { label: "Patient", value: <span>{report.givenName} {report.familyName} · <span className="mv-id">{report.publicId}</span> · DOB {report.dateOfBirth} · {report.sex}</span> },
          { label: "Status", value: <span><Badge tone={signed ? "success" : "warning"}>{report.status}</Badge> {report.urgency !== "routine" ? <Badge tone="danger">{report.urgency}</Badge> : null} {report.releasedAt ? <Badge tone="success">released</Badge> : null}</span> },
          { label: "Modality / region", value: `${report.modality} · ${report.bodySite}` },
          { label: "Acquisition", value: `${report.acquisitionStatus}${report.acquiredAt ? ` at ${formatDateTime(report.acquiredAt)}` : ""}` },
          { label: "Ordered", value: `${formatDateTime(report.orderedAt)} · ${report.priority}` },
          { label: "Order note", value: report.clinicalNote },
          { label: "Reporting radiologist", value: report.radiologistName ?? "Not yet signed" },
          { label: "Signed", value: report.signedAt ? formatDateTime(report.signedAt) : "—" },
        ]} />
      </Card>
      {editable ? <DraftEditor data={data} onSaved={reload} /> : <ReadOnlyContent definition={report.definition} content={shown} />}
      {signed ? <SignedActions data={data} onDone={reload} /> : null}
      <History data={data} />
    </div>
  );
}

function missingRequired(definition: Definition, content: Content): string[] {
  return definition.fields.filter((field) => field.required && !(content.fields[field.key] ?? "").trim()).map((field) => field.label);
}

function DraftEditor({ data, onSaved }: { data: ReportResponse; onSaved: () => void }) {
  const { report } = data;
  const definition = report.definition;
  const [content, setContent] = useState<Content>(report.content.fields ? report.content : { fields: {}, measurements: [] });
  const [urgency, setUrgency] = useState(report.urgency);
  const version = useRef(report.draftVersion);
  const [saveState, setSaveState] = useState<"saved" | "pending" | "saving" | "conflict" | "error">("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const dirty = useRef(false);
  const action = useAction();

  const save = useCallback(async (): Promise<boolean> => {
    if (!dirty.current) return true;
    setSaveState("saving");
    try {
      const result = await api<{ draftVersion: number }>(`/radiology/reports/${report.id}/draft`, {
        method: "PUT", body: { content, urgency, expectedVersion: version.current },
      });
      version.current = result.draftVersion;
      dirty.current = false;
      setSaveState("saved");
      setSaveError(null);
      setSavedAt(new Date());
      return true;
    } catch (cause) {
      setSaveState(cause instanceof ApiError && cause.status === 409 ? "conflict" : "error");
      setSaveError(errorMessage(cause));
      return false;
    }
  }, [content, urgency, report.id]);

  useEffect(() => {
    if (!dirty.current || saveState === "conflict") return;
    const timer = window.setTimeout(() => void save(), 1500);
    return () => window.clearTimeout(timer);
  }, [content, urgency, save, saveState]);

  const update = (key: string, value: string) => {
    dirty.current = true;
    setSaveState("pending");
    setContent((current) => ({ ...current, fields: { ...current.fields, [key]: value } }));
  };
  const updateMeasurements = (measurements: Measurement[]) => {
    dirty.current = true;
    setSaveState("pending");
    setContent((current) => ({ ...current, measurements }));
  };
  const missing = useMemo(() => missingRequired(definition, content), [definition, content]);

  async function sign(kind: "preliminary" | "final") {
    const confirmText = kind === "final"
      ? "Sign this report as FINAL? The signed version cannot be edited; later changes need an addendum or a correction."
      : "Sign this report as PRELIMINARY?";
    if (!window.confirm(confirmText)) return;
    await action.run(`sign-${kind}`, async () => {
      if (!(await save())) throw new Error("The draft could not be saved; resolve the save problem before signing");
      await api(`/radiology/reports/${report.id}/sign`, { method: "POST", body: { kind, expectedVersion: version.current, attest: true } });
      onSaved();
      return kind === "final" ? "Report signed as final." : "Report signed as preliminary.";
    });
  }

  return (
    <Card title="Structured report" description="Drafts save automatically. Empty sections stay empty; nothing is pre-filled.">
      <div className="mv-row mv-small" role="status" aria-live="polite">
        {saveState === "saved" ? <Badge tone="success">{savedAt ? `Saved ${savedAt.toLocaleTimeString()}` : "No unsaved changes"}</Badge> : null}
        {saveState === "pending" ? <Badge tone="neutral">Unsaved changes</Badge> : null}
        {saveState === "saving" ? <Badge tone="neutral">Saving…</Badge> : null}
        {saveState === "conflict" ? <Badge tone="danger">Someone else changed this draft</Badge> : null}
        {saveState === "error" ? <Badge tone="danger">Not saved</Badge> : null}
      </div>
      {saveState === "conflict" ? (
        <Notice tone="danger" title="Edit conflict">This draft changed since you opened it. Copy any text you need, then reload to see the latest version. Your edits are kept on screen until you reload.
          <div style={{ marginTop: 8 }}><Button size="sm" variant="secondary" onClick={() => window.location.reload()}>Reload latest draft</Button></div>
        </Notice>
      ) : null}
      {saveError && saveState === "error" ? <ErrorState message={saveError} onRetry={() => void save()} /> : null}
      {SECTIONS.map((section) => {
        const fields = definition.fields.filter((field) => field.section === section.key);
        if (!fields.length) return null;
        return (
          <fieldset key={section.key} className="mv-stack" style={{ border: 0, padding: 0, marginTop: 16 }}>
            <legend><strong>{section.title}</strong></legend>
            {fields.map((field) => {
              const empty = !(content.fields[field.key] ?? "").trim();
              const label = `${field.label}${field.required ? " (required)" : ""}`;
              const error = field.required && empty ? "Incomplete" : undefined;
              const id = `field-${field.key}`;
              return (
                <Field key={field.key} label={label} htmlFor={id} hint={field.hint} error={error}>
                  {field.kind === "select" ? (
                    <Select id={id} value={content.fields[field.key] ?? ""} onChange={(event) => update(field.key, event.target.value)}>
                      <option value="">Not recorded</option>
                      {field.options?.map((option) => <option key={option} value={option}>{option}</option>)}
                    </Select>
                  ) : field.kind === "text" ? (
                    <Input id={id} value={content.fields[field.key] ?? ""} onChange={(event) => update(field.key, event.target.value)} />
                  ) : (
                    <Textarea id={id} value={content.fields[field.key] ?? ""} onChange={(event) => update(field.key, event.target.value)} />
                  )}
                </Field>
              );
            })}
          </fieldset>
        );
      })}
      <Measurements units={definition.measurementUnits} value={content.measurements} onChange={updateMeasurements} />
      <Field label="Urgency"><Select value={urgency} onChange={(event) => { dirty.current = true; setSaveState("pending"); setUrgency(event.target.value); }}>
        <option value="routine">Routine</option><option value="urgent">Urgent</option><option value="critical">Critical finding</option>
      </Select></Field>
      {missing.length ? <Notice tone="warning" title={`${missing.length} required section(s) incomplete`}>{missing.join(", ")}</Notice> : <Notice tone="success">All required sections are complete.</Notice>}
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      {data.permissions.sign ? (
        <div className="mv-row" style={{ marginTop: 8 }}>
          {report.status === "draft" ? <Button variant="secondary" disabled={action.busy !== null || missing.length > 0} onClick={() => void sign("preliminary")}>Sign preliminary</Button> : null}
          <Button disabled={action.busy !== null || missing.length > 0 || report.acquisitionStatus !== "acquired"} onClick={() => void sign("final")}>Sign final report</Button>
          {report.acquisitionStatus !== "acquired" ? <span className="mv-small mv-muted">The study must be marked acquired before final sign-off.</span> : null}
        </div>
      ) : <p className="mv-small mv-muted">Only a radiologist can sign. Your draft is saved for review.</p>}
    </Card>
  );
}

function Measurements({ units, value, onChange }: { units: string[]; value: Measurement[]; onChange: (next: Measurement[]) => void }) {
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [unit, setUnit] = useState(units[0] ?? "mm");
  return (
    <div className="mv-stack" style={{ marginTop: 16 }}>
      <strong>Measurements</strong>
      {value.length ? (
        <Table head={["Measurement", "Value", ""]} caption="Report measurements">
          {value.map((item, index) => (
            <tr key={`${item.label}-${index}`}><td>{item.label}</td><td>{item.value} {item.unit}</td>
              <td><Button size="sm" variant="ghost" onClick={() => onChange(value.filter((_, position) => position !== index))}>Remove</Button></td></tr>
          ))}
        </Table>
      ) : <p className="mv-small mv-muted">No measurements recorded.</p>}
      <div className="mv-form-grid">
        <Field label="Measurement" htmlFor="m-label"><Input id="m-label" value={label} onChange={(event) => setLabel(event.target.value)} /></Field>
        <Field label="Value" htmlFor="m-value"><Input id="m-value" type="number" min={0} step="any" value={amount} onChange={(event) => setAmount(event.target.value)} /></Field>
        <Field label="Unit"><Select value={unit} onChange={(event) => setUnit(event.target.value)}>{units.map((option) => <option key={option}>{option}</option>)}</Select></Field>
      </div>
      <div><Button size="sm" variant="secondary" disabled={!label.trim() || amount === "" || Number(amount) < 0} onClick={() => {
        onChange([...value, { label: label.trim(), value: Number(amount), unit }]);
        setLabel("");
        setAmount("");
      }}>Add measurement</Button></div>
    </div>
  );
}

function ReadOnlyContent({ definition, content }: { definition: Definition; content: Content }) {
  return (
    <Card title="Report">
      {SECTIONS.map((section) => {
        const fields = definition.fields.filter((field) => field.section === section.key && (content.fields[field.key] ?? "").trim());
        if (!fields.length) return null;
        return (
          <div key={section.key} style={{ marginTop: 12 }}>
            <h3 className="mv-small" style={{ textTransform: "uppercase" }}>{section.title}</h3>
            <DataList items={fields.map((field) => ({ label: field.label, value: <span style={{ whiteSpace: "pre-wrap" }}>{content.fields[field.key]}</span> }))} />
          </div>
        );
      })}
      {content.measurements.length ? <DataList items={content.measurements.map((item, index) => ({ label: item.label || `Measurement ${index + 1}`, value: `${item.value} ${item.unit}` }))} /> : null}
    </Card>
  );
}

function SignedActions({ data, onDone }: { data: ReportResponse; onDone: () => void }) {
  const { report } = data;
  const action = useAction();
  const [mode, setMode] = useState<"none" | "addendum" | "correction" | "critical">("none");
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  const [recipient, setRecipient] = useState("");
  const [method, setMethod] = useState("phone");
  const clinicians = useQuery<{ members: Array<{ id: string; displayName: string; roles: string[] }> }>(mode === "critical" ? "/radiology/clinical-recipients" : null);
  const latest = data.versions[data.versions.length - 1];
  const [correction, setCorrection] = useState<Content | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run(mode, async () => {
      if (mode === "addendum") await api(`/radiology/reports/${report.id}/addenda`, { method: "POST", body: { text, reason, attest: true } });
      if (mode === "critical") await api(`/radiology/reports/${report.id}/critical-communications`, { method: "POST", body: { recipientUserId: recipient, method, findingSummary: text } });
      if (mode === "correction" && correction) {
        if (!window.confirm("Sign this correction? It becomes a new signed version; the earlier version stays in the history.")) return;
        await api(`/radiology/reports/${report.id}/corrections`, {
          method: "POST", body: { content: correction, urgency: report.urgency, reason, expectedSignedVersion: report.signedVersion, attest: true },
        });
      }
      setMode("none");
      setText("");
      setReason("");
      onDone();
      return "Recorded.";
    });
  }

  async function release() {
    const note = window.prompt("Release note (who the report is released to and why):");
    if (!note || note.trim().length < 2) return;
    await action.run("release", async () => {
      await api(`/radiology/reports/${report.id}/release`, { method: "POST", body: { releaseNote: note } });
      onDone();
      return "Report released to the requesting team.";
    });
  }

  return (
    <Card title="Signed report actions" description="Signed versions are never edited. Addenda and corrections are added alongside them.">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <div className="mv-row">
        {!report.releasedAt ? <Button onClick={() => void release()} disabled={action.busy !== null}>Release report</Button> : <Badge tone="success">{`Released ${formatDateTime(report.releasedAt)}`}</Badge>}
        {data.permissions.addend ? <Button variant="secondary" onClick={() => setMode("addendum")}>Add addendum</Button> : null}
        {data.permissions.sign ? <Button variant="secondary" onClick={() => { setMode("correction"); setCorrection(latest?.content ?? report.content); }}>Correct report</Button> : null}
        {data.permissions.sign ? <Button variant="danger" onClick={() => setMode("critical")}>Record critical communication</Button> : null}
      </div>
      {report.urgency === "critical" && !data.critical.length ? <Notice tone="danger" title="Critical finding not yet communicated">Release is blocked until a critical-finding communication is recorded.</Notice> : null}
      {mode !== "none" ? (
        <form className="mv-stack mv-note" style={{ marginTop: 12 }} onSubmit={submit}>
          {mode === "critical" ? (
            <>
              <Field label="Recipient clinician"><Select value={recipient} onChange={(event) => setRecipient(event.target.value)} required>
                <option value="">Select…</option>
                {clinicians.data?.members.map((member) => <option key={member.id} value={member.id}>{member.displayName} ({member.roles.join(", ")})</option>)}
              </Select></Field>
              <Field label="Method"><Select value={method} onChange={(event) => setMethod(event.target.value)}><option value="phone">Phone (read back)</option><option value="in-person">In person</option><option value="secure-message">Secure message</option></Select></Field>
              <Field label="Finding communicated" htmlFor="critical-text"><Textarea id="critical-text" value={text} onChange={(event) => setText(event.target.value)} minLength={5} required /></Field>
            </>
          ) : null}
          {mode === "addendum" ? <Field label="Addendum" htmlFor="addendum-text"><Textarea id="addendum-text" value={text} onChange={(event) => setText(event.target.value)} minLength={2} required /></Field> : null}
          {mode === "correction" && correction ? (
            <>
              {report.definition.fields.map((field) => (
                <Field key={field.key} label={`${field.label}${field.required ? " (required)" : ""}`} htmlFor={`corr-${field.key}`}>
                  <Textarea id={`corr-${field.key}`} value={correction.fields[field.key] ?? ""} onChange={(event) => setCorrection({ ...correction, fields: { ...correction.fields, [field.key]: event.target.value } })} />
                </Field>
              ))}
            </>
          ) : null}
          {mode !== "critical" ? <Field label="Reason" htmlFor="change-reason" hint={mode === "correction" ? "At least 10 characters." : "At least 5 characters."}><Input id="change-reason" value={reason} onChange={(event) => setReason(event.target.value)} required /></Field> : null}
          <div className="mv-row">
            <Button type="submit" disabled={action.busy !== null}>{mode === "critical" ? "Record communication" : mode === "addendum" ? "Sign addendum" : "Sign correction"}</Button>
            <Button type="button" variant="ghost" onClick={() => setMode("none")}>Cancel</Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}

function History({ data }: { data: ReportResponse }) {
  return (
    <div className="mv-grid mv-grid--2">
      <Card title="Signed versions and addenda">
        {!data.versions.length ? <EmptyState title="Not signed" description="No signed version exists yet." /> : (
          <Table head={["Version", "Signed", "Hash"]} caption="Signed versions">
            {data.versions.map((version) => (
              <tr key={version.version}>
                <td>v{version.version} · {version.kind}{version.changeReason ? <div className="mv-small mv-muted">{version.changeReason}</div> : null}</td>
                <td className="mv-small">{formatDateTime(version.signedAt)} by {version.signedByName}</td>
                <td className="mv-small mv-id">{version.contentHash.slice(7, 19)}…</td>
              </tr>
            ))}
          </Table>
        )}
        {data.addenda.map((addendum) => (
          <Notice key={addendum.id} tone="info" title={`Addendum to v${addendum.appliesToVersion} — ${addendum.signedByName}, ${formatDateTime(addendum.signedAt)}`}>
            <span style={{ whiteSpace: "pre-wrap" }}>{addendum.text}</span><div className="mv-small mv-muted">Reason: {addendum.reason}</div>
          </Notice>
        ))}
      </Card>
      <Card title="Critical communications and prior reports">
        {data.critical.map((item) => (
          <div key={item.id} className="mv-note mv-small">
            <strong>{item.method}</strong> to {item.recipientName} at {formatDateTime(item.communicatedAt)}: {item.findingSummary}
            <div>{item.acknowledgedAt ? `Acknowledged by ${item.acknowledgedByName} at ${formatDateTime(item.acknowledgedAt)}` : "Not yet acknowledged"}{item.escalatedToName ? ` · escalated to ${item.escalatedToName}` : ""}</div>
          </div>
        ))}
        {!data.priors.length ? <p className="mv-small mv-muted">No prior signed imaging reports for this patient at this facility.</p> : (
          <Table head={["Prior study", "Impression"]} caption="Prior reports">
            {data.priors.map((prior) => (
              <tr key={prior.id}><td><Link to={`/radiology/reports/${prior.id}`}>{prior.templateName}</Link><div className="mv-small mv-muted">{formatDateTime(prior.signedAt)} · {prior.accession}</div></td><td className="mv-small">{prior.impression ?? "—"}</td></tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
