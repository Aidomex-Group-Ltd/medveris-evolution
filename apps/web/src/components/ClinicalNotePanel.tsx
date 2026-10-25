import { useEffect, useState, type FormEvent } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, Textarea } from "@medveris/ui";
import { api, errorMessage } from "../lib/api";
import type { EncounterDetail } from "../lib/types";

type Entry = EncounterDetail["entries"][number];

interface VersionRow {
  id: string;
  version: number;
  status: string;
  changeNote: string;
  authorName: string;
  occurredAt: string;
  signedAt: string | null;
  contentDigest: string;
  content: Entry["content"];
}

const empty = { title: "Outpatient consultation note", subjective: "", objective: "", assessment: "", plan: "", changeNote: "" };

export function ClinicalNotePanel({ encounterId, entry, canSign, onChanged }: { encounterId: string; entry: Entry | null; canSign: boolean; onChanged: () => void }) {
  const [form, setForm] = useState(empty);
  const [amending, setAmending] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [history, setHistory] = useState<VersionRow[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    setAmending(false);
    setError(null);
    setMessage(null);
    setHistory(null);
    if (entry) {
      setForm({
        title: entry.content.title ?? entry.title,
        subjective: entry.content.subjective ?? "",
        objective: entry.content.objective ?? "",
        assessment: entry.content.assessment ?? "",
        plan: entry.content.plan ?? "",
        changeNote: "",
      });
    } else {
      setForm(empty);
    }
  }, [entry?.id, entry?.currentVersion]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy("save");
    setError(null);
    setMessage(null);
    try {
      await api(`/encounters/${encounterId}/entries`, {
        method: "POST",
        body: { ...form, clinicalOccurredAt: new Date().toISOString() },
      });
      setMessage("Draft saved. Signing is required before it becomes part of the record.");
      setForm(empty);
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function updateDraft(event: FormEvent) {
    event.preventDefault();
    if (!entry) return;
    setBusy("save");
    setError(null);
    try {
      await api(`/entries/${entry.id}/draft`, {
        method: "PUT",
        body: { ...form, expectedVersion: entry.currentVersion, clinicalOccurredAt: new Date().toISOString() },
      });
      setMessage("Draft revision recorded with an audit note.");
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function sign() {
    if (!entry) return;
    if (!window.confirm("Sign this note? Signed content becomes immutable and later changes require a reasoned amendment.")) return;
    setBusy("sign");
    setError(null);
    try {
      await api(`/entries/${entry.id}/sign`, { method: "POST", body: { expectedVersion: entry.currentVersion } });
      setMessage("Note signed successfully.");
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function amend(event: FormEvent) {
    event.preventDefault();
    if (!entry) return;
    setBusy("amend");
    setError(null);
    try {
      await api(`/entries/${entry.id}/amendments`, {
        method: "POST",
        body: { ...form, expectedVersion: entry.currentVersion, clinicalOccurredAt: new Date().toISOString() },
      });
      setMessage("Amendment appended. Prior signed versions remain preserved.");
      setAmending(false);
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function loadHistory() {
    if (!entry) return;
    if (history) {
      setHistory(null);
      return;
    }
    setHistoryLoading(true);
    setError(null);
    try {
      const response = await api<{ versions: VersionRow[] }>(`/entries/${entry.id}/versions`);
      setHistory(response.versions);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setHistoryLoading(false);
    }
  }

  const signed = entry?.status === "signed" || entry?.status === "amended" || entry?.status === "entered-in-error";
  const editing = entry ? entry.status === "draft" || amending : true;
  const submitHandler = entry ? (entry.status === "draft" && !amending ? updateDraft : amend) : create;
  const showForm = !entry || editing;

  return (
    <Card
      title={entry ? entry.title : "New clinical note"}
      description={entry ? `Version ${entry.currentVersion} · ${entry.status} · author ${entry.authorName}` : "Create a draft. Only a clinician may sign."}
      actions={entry ? <div className="mv-row"><Badge tone={entry.status === "signed" || entry.status === "amended" ? "success" : entry.status === "draft" ? "warning" : "danger"}>{entry.status}</Badge><Button variant="secondary" size="sm" onClick={() => void loadHistory()}>{history ? "Hide history" : "Version history"}</Button></div> : null}
    >
      {error ? <ErrorState message={error} /> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      {entry ? (
        <div className={`mv-note mv-note--${entry.status}`} style={{ marginBottom: 14 }}>
          <div className="mv-client-fields">
            {(["subjective", "objective", "assessment", "plan"] as const).map((key) => (
              <div key={key} style={{ marginBottom: 8 }}>
                <div className="mv-small mv-muted" style={{ textTransform: "uppercase", letterSpacing: "0.06em" }}>{key}</div>
                <p className="mv-pre">{entry.content[key] || "Not documented"}</p>
              </div>
            ))}
          </div>
          <div className="mv-small mv-muted">Clinical time {new Date(entry.occurredAt).toLocaleString()} · {entry.signedAt ? `Signed ${new Date(entry.signedAt).toLocaleString()}` : "Not signed"} · Creation note: {entry.changeNote}</div>
        </div>
      ) : null}

      {signed && !amending ? (
        <div className="mv-row">
          {entry.status !== "entered-in-error" ? (canSign ? <Button onClick={() => setAmending(true)}>Amend signed note</Button> : <span className="mv-small mv-muted">Only a clinician may amend a signed note.</span>) : <span className="mv-small mv-muted">Entered-in-error versions cannot be amended.</span>}
        </div>
      ) : null}

      {showForm && canSign ? (
        <form className="mv-stack" onSubmit={submitHandler}>
          {amending ? <Notice tone="warning" title="Reasoned amendment">The original signed version is never overwritten. Provide a clear reason for this correction.</Notice> : null}
          <Field label="Title" htmlFor="note-title"><Input id="note-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required maxLength={300} /></Field>
          <div className="mv-grid mv-grid--2">
            <Field label="Subjective" htmlFor="note-s"><Textarea id="note-s" value={form.subjective} onChange={(e) => setForm({ ...form, subjective: e.target.value })} /></Field>
            <Field label="Objective" htmlFor="note-o"><Textarea id="note-o" value={form.objective} onChange={(e) => setForm({ ...form, objective: e.target.value })} /></Field>
            <Field label="Assessment" htmlFor="note-a"><Textarea id="note-a" value={form.assessment} onChange={(e) => setForm({ ...form, assessment: e.target.value })} /></Field>
            <Field label="Plan" htmlFor="note-p"><Textarea id="note-p" value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })} /></Field>
          </div>
          <Field label={amending ? "Amendment reason (required)" : "Creation note (required)"} htmlFor="note-reason" hint={amending ? "Minimum 10 characters. Stored with this version and audit event." : "Minimum 5 characters. Draft edits also record audit notes."}>
            <Input id="note-reason" value={form.changeNote} onChange={(e) => setForm({ ...form, changeNote: e.target.value })} required minLength={amending ? 10 : 5} maxLength={2000} />
          </Field>
          <div className="mv-row">
            <Button type="submit" disabled={busy !== null}>{busy === "save" || busy === "amend" ? "Saving…" : amending ? "Append amendment" : entry ? "Save draft revision" : "Create draft"}</Button>
            {amending ? <Button variant="ghost" onClick={() => setAmending(false)}>Cancel amendment</Button> : null}
            {entry && entry.status === "draft" ? <Button variant="secondary" type="button" onClick={() => void sign()} disabled={busy !== null}>{busy === "sign" ? "Signing…" : "Sign draft"}</Button> : null}
          </div>
        </form>
      ) : !showForm && !canSign ? <Notice tone="info">You can read this record but only clinicians may create, sign or amend notes.</Notice> : null}

      {historyLoading ? <LoadingState label="Loading version history" /> : null}
      {history ? (
        <div className="mv-stack" style={{ marginTop: 16 }}>
          <h3>Version history</h3>
          {history.map((version) => (
            <div key={version.id} className={`mv-note mv-note--${version.status}`}>
              <div className="mv-spread"><strong>Version {version.version}</strong><Badge tone={version.status === "signed" || version.status === "amended" ? "success" : version.status === "draft" ? "warning" : "danger"}>{version.status}</Badge></div>
              <div className="mv-small mv-muted">{version.authorName} · {new Date(version.occurredAt).toLocaleString()} · {version.changeNote}</div>
              <div className="mv-small mv-mono" style={{ marginTop: 4 }}>{version.contentDigest}</div>
            </div>
          ))}
        </div>
      ) : null}
      {!entry ? <EmptyState title="No note selected" description="Create the first draft for this encounter. Drafts remain visibly un-signed." /> : null}
    </Card>
  );
}
