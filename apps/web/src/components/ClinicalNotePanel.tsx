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

const SECTION_LABELS: Record<"subjective" | "objective" | "assessment" | "plan", string> = {
  subjective: "Subjective — what the patient reports",
  objective: "Objective — findings on examination",
  assessment: "Assessment — clinical impression",
  plan: "Plan — treatment and follow-up",
};

const STATUS_ACTION_LABELS: Record<string, string> = {
  draft: "Draft note",
  signed: "Signed",
  amended: "Amendment",
  "entered-in-error": "Entered in error",
};

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

  /** The signed record is never deleted; it is superseded by an entered-in-error version that keeps the original. */
  async function markEnteredInError() {
    if (!entry) return;
    const reason = window.prompt("Why was this note entered in error? (at least 10 characters; the original stays in the history)");
    if (reason === null) return;
    if (reason.trim().length < 10) {
      setError("Give a reason of at least 10 characters.");
      return;
    }
    setBusy("error");
    setError(null);
    try {
      await api(`/entries/${entry.id}/entered-in-error`, { method: "POST", body: { expectedVersion: entry.currentVersion, reason: reason.trim() } });
      setMessage("Note marked entered in error. The original signed version is preserved in its history.");
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
                <div className="mv-small mv-muted" style={{ textTransform: "uppercase", letterSpacing: "0.06em" }}>{SECTION_LABELS[key]}</div>
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
          {entry.status !== "entered-in-error" && canSign ? <Button variant="ghost" disabled={busy !== null} onClick={() => void markEnteredInError()}>{busy === "error" ? "Saving…" : "Mark entered in error"}</Button> : null}
        </div>
      ) : null}
      {entry && signed ? <NoteIntegrity entryId={entry.id} version={entry.currentVersion} /> : null}

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
              <div className="mv-spread"><strong>{STATUS_ACTION_LABELS[version.status] ?? `Version ${version.version}`}</strong><Badge tone={version.status === "signed" || version.status === "amended" ? "success" : version.status === "draft" ? "warning" : "danger"}>{version.status}</Badge></div>
              <div className="mv-small mv-muted">Version {version.version} · {version.authorName} · clinical time {new Date(version.occurredAt).toLocaleString()} · {version.changeNote}</div>
              <div className="mv-small mv-mono" style={{ marginTop: 4 }}>{version.contentDigest}</div>
            </div>
          ))}
        </div>
      ) : null}
      {!entry ? <EmptyState title="No note selected" description="Create the first draft for this encounter. Drafts remain visibly un-signed." /> : null}
    </Card>
  );
}

interface IntegrityReport {
  versions: Array<{ version: number; status: string; storedDigest: string; contentMatches: boolean; signed: boolean }>;
  events: Array<{ eventId: string; action: string; occurredAt: string; eventHash: string; previousHash: string | null; checkpointBatch: number | null }>;
  checkpoints: Array<{ batchNumber: number; eventCount: number; createdAt: string; merkleRoot: string; rootMatches: boolean | null; signatureValid: boolean | null; ledgerState: string; anchor: { network: string | null; state: string; transactionRef: string | null } | null }>;
  summary: { contentIntact: boolean; eventsCheckpointed: number; eventsAwaitingCheckpoint: number; checkpointsVerified: boolean; externallyAnchored: boolean };
}

/**
 * Tamper evidence for a signed note, checked on request: content digests, the hash-chained audit events
 * about the note, and the signed Merkle checkpoint covering them. External anchoring is shown only as recorded.
 */
function NoteIntegrity({ entryId, version }: { entryId: string; version: number }) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReport(null);
    setOpen(false);
  }, [entryId, version]);

  async function check() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setLoading(true);
    setError(null);
    try {
      setReport(await api<IntegrityReport>(`/entries/${entryId}/integrity`));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mv-stack" style={{ marginTop: 12 }}>
      <div><Button size="sm" variant="secondary" onClick={() => void check()}>{open ? "Hide integrity check" : "Verify integrity"}</Button></div>
      {open && loading ? <LoadingState label="Verifying the note's ledger evidence" /> : null}
      {open && error ? <ErrorState message={error} /> : null}
      {open && report ? (
        <div className="mv-note">
          <div className="mv-row" style={{ marginBottom: 8 }}>
            <Badge tone={report.summary.contentIntact ? "success" : "danger"}>{report.summary.contentIntact ? "Content matches its digests" : "Content digest mismatch"}</Badge>
            <Badge tone={report.summary.checkpointsVerified ? "success" : "danger"}>{report.summary.checkpointsVerified ? "Checkpoints verified" : "Checkpoint mismatch"}</Badge>
            {report.summary.eventsAwaitingCheckpoint ? <Badge tone="warning">{report.summary.eventsAwaitingCheckpoint} event(s) awaiting the next checkpoint</Badge> : null}
            <Badge tone={report.summary.externallyAnchored ? "success" : "neutral"}>{report.summary.externallyAnchored ? "Anchored externally" : "Not externally anchored"}</Badge>
          </div>
          <p className="mv-small mv-muted" style={{ margin: "0 0 8px" }}>
            Each change to this note is an append-only audit event chained to the previous event by its hash, then sealed in a signed Merkle checkpoint. Any edit to stored content or events makes these checks fail.
          </p>
          <ul className="mv-small" style={{ margin: 0, paddingLeft: 18 }}>
            {report.events.map((event) => (
              <li key={event.eventId}>
                {new Date(event.occurredAt).toLocaleString()} · {event.action} · <span className="mv-hash">{event.eventHash.slice(0, 16)}…</span>
                {event.checkpointBatch != null ? ` · checkpoint #${event.checkpointBatch}` : " · not yet checkpointed"}
              </li>
            ))}
          </ul>
          {report.checkpoints.map((checkpoint) => (
            <div key={checkpoint.batchNumber} className="mv-small" style={{ marginTop: 6 }}>
              Checkpoint #{checkpoint.batchNumber}: {checkpoint.eventCount} events, root <span className="mv-hash">{checkpoint.merkleRoot.slice(0, 16)}…</span> {checkpoint.rootMatches === null ? "not comparable (events were committed while it was taken)" : checkpoint.rootMatches ? "recomputed ✓" : "does not match ✗"},
              signature {checkpoint.signatureValid === null ? "made with a retired key" : checkpoint.signatureValid ? "valid ✓" : "invalid ✗"} · ledger {checkpoint.anchor ? `${checkpoint.anchor.state}${checkpoint.anchor.network ? ` on ${checkpoint.anchor.network}` : ""}` : checkpoint.ledgerState}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
