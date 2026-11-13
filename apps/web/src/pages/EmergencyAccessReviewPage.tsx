import { useEffect, useState, type FormEvent } from "react";
import { Badge, Button, Card, Dialog, EmptyState, ErrorState, Field, LoadingState, Notice, PageHeader, Select, Table, Tabs, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";
import type { EmergencyOverrideRow } from "../lib/types";

type ReviewStatus = "reviewed-acceptable" | "reviewed-escalated";
type Filter = "all" | "pending" | "reviewed";

const REVIEW_STATUS_LABEL: Record<string, string> = {
  pending: "Pending review",
  "reviewed-acceptable": "Reviewed — acceptable",
  "reviewed-escalated": "Reviewed — escalated",
};

function statusTone(status: string): "warning" | "success" | "danger" | "neutral" {
  if (status === "pending") return "warning";
  if (status === "reviewed-acceptable") return "success";
  if (status === "reviewed-escalated") return "danger";
  return "neutral";
}

export function EmergencyAccessReviewPage() {
  const overrides = useQuery<{ overrides: EmergencyOverrideRow[] }>("/emergency-overrides");
  const [filter, setFilter] = useState<Filter>("all");
  const [reviewTarget, setReviewTarget] = useState<EmergencyOverrideRow | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<EmergencyOverrideRow | null>(null);
  const action = useAction();

  const rows = (overrides.data?.overrides ?? []).filter((row) => {
    if (filter === "pending") return row.reviewStatus === "pending";
    if (filter === "reviewed") return row.reviewStatus !== "pending";
    return true;
  });

  async function review(target: EmergencyOverrideRow, status: ReviewStatus, note: string) {
    const ok = await action.run("review", async () => {
      await api(`/emergency-overrides/${target.id}/review`, { method: "POST", body: { status, note } });
      setReviewTarget(null);
      overrides.reload();
      return "Emergency access review recorded.";
    });
    if (!ok) setReviewTarget(null);
  }

  async function revoke(target: EmergencyOverrideRow, reason: string) {
    const ok = await action.run("revoke", async () => {
      await api(`/emergency-overrides/${target.id}/revoke`, { method: "POST", body: { reason } });
      setRevokeTarget(null);
      overrides.reload();
      return "Emergency access revoked.";
    });
    if (!ok) setRevokeTarget(null);
  }

  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow="Governance"
        title="Emergency access review"
        description="Break-the-glass access is time-limited, audited and shown to the patient. Review every pending use, escalate unjustified access and close access early when needed."
      />
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Notice tone="info" title="Access is never silent">
        The requesting clinician reauthenticated with a password and authenticator code, the patient sees the access in their
        access history, and review is due within the facility's review window. Revocation takes effect immediately.
      </Notice>

      <Tabs
        label="Review filter"
        value={filter}
        onChange={setFilter}
        options={[
          { value: "all", label: "All uses" },
          { value: "pending", label: "Pending review" },
          { value: "reviewed", label: "Reviewed" },
        ]}
      />

      <Card title="Emergency overrides" description="Newest first. Expired access is retained for the audit record.">
        {overrides.loading ? <LoadingState label="Loading emergency access" /> : overrides.error ? <ErrorState message={overrides.error} onRetry={overrides.reload} /> : !rows.length ? (
          <EmptyState
            title={filter === "pending" ? "No pending reviews" : "No emergency overrides"}
            description={filter === "pending" ? "Every break-the-glass use has been reviewed." : "No clinician has used emergency access in this facility."}
          />
        ) : (
          <Table head={["Patient", "Clinician", "Reason", "Access window", "Review", ""]} caption="Emergency overrides">
            {rows.map((row) => {
              const activeNow = new Date(row.expiresAt) > new Date();
              const overdue = row.reviewStatus === "pending" && new Date(row.reviewDueAt) < new Date();
              return (
                <tr key={row.id}>
                  <td>
                    <strong>{row.givenName} {row.familyName}</strong>
                    <div className="mv-small mv-muted mv-id">{row.publicId}</div>
                  </td>
                  <td>{row.clinicianName}</td>
                  <td className="mv-small">
                    {row.reason}
                    {row.reviewNote ? <div className="mv-muted">Review note: {row.reviewNote}</div> : null}
                  </td>
                  <td className="mv-small">
                    {formatDateTime(row.startedAt)} → {formatDateTime(row.expiresAt)}
                    <div className="mv-muted">{activeNow ? "Access window open" : "Access window closed"}</div>
                  </td>
                  <td>
                    <Badge tone={statusTone(row.reviewStatus)}>{REVIEW_STATUS_LABEL[row.reviewStatus] ?? row.reviewStatus}</Badge>
                    <div className="mv-small mv-muted">
                      {row.reviewedAt ? `Reviewed ${formatDateTime(row.reviewedAt)}` : `Due ${formatDateTime(row.reviewDueAt)}`}
                    </div>
                    {overdue ? <Badge tone="danger">Overdue</Badge> : null}
                  </td>
                  <td>
                    <div className="mv-row">
                      {row.reviewStatus === "pending" ? (
                        <Button size="sm" variant="secondary" onClick={() => setReviewTarget(row)}>Review</Button>
                      ) : null}
                      {activeNow ? (
                        <Button size="sm" variant="danger" onClick={() => setRevokeTarget(row)}>Revoke</Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <ReviewDialog
        target={reviewTarget}
        busy={action.busy === "review"}
        onClose={() => setReviewTarget(null)}
        onSubmit={(status, note) => reviewTarget && void review(reviewTarget, status, note)}
      />
      <RevokeDialog
        target={revokeTarget}
        busy={action.busy === "revoke"}
        onClose={() => setRevokeTarget(null)}
        onSubmit={(reason) => revokeTarget && void revoke(revokeTarget, reason)}
      />
    </div>
  );
}

function ReviewDialog({ target, busy, onClose, onSubmit }: {
  target: EmergencyOverrideRow | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (status: ReviewStatus, note: string) => void;
}) {
  const [status, setStatus] = useState<ReviewStatus>("reviewed-acceptable");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!target) {
      setStatus("reviewed-acceptable");
      setNote("");
    }
  }, [target]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (note.trim().length < 5) return;
    onSubmit(status, note.trim());
  }

  return (
    <Dialog
      open={Boolean(target)}
      onClose={busy ? undefined : onClose}
      title="Review emergency access"
      description={target ? `${target.clinicianName} · ${target.givenName} ${target.familyName}` : undefined}
    >
      <form className="mv-stack" onSubmit={submit}>
        <Field label="Outcome">
          <Select value={status} onChange={(event) => setStatus(event.target.value as ReviewStatus)}>
            <option value="reviewed-acceptable">Justified — acceptable</option>
            <option value="reviewed-escalated">Unjustified — escalate</option>
          </Select>
        </Field>
        <Field label="Review note" htmlFor="override-review-note" hint="At least 5 characters. Record the evidence you checked.">
          <Textarea
            id="override-review-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            required
            minLength={5}
            maxLength={2000}
            autoFocus
          />
        </Field>
        {status === "reviewed-escalated" ? <Notice tone="danger">Escalation is recorded in the audit trail for privacy and clinical governance follow-up.</Notice> : null}
        <Button type="submit" disabled={busy || note.trim().length < 5} busy={busy}>{busy ? "Recording…" : "Record review"}</Button>
      </form>
    </Dialog>
  );
}

function RevokeDialog({ target, busy, onClose, onSubmit }: {
  target: EmergencyOverrideRow | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!target) setReason("");
  }, [target]);

  return (
    <Dialog
      open={Boolean(target)}
      onClose={busy ? undefined : onClose}
      title="Revoke emergency access"
      description={target ? `${target.clinicianName} · ${target.givenName} ${target.familyName}` : undefined}
    >
      <form
        className="mv-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (reason.trim().length >= 5) onSubmit(reason.trim());
        }}
      >
        <Field label="Reason for revoking access" htmlFor="override-revoke-reason" hint="At least 5 characters. This is audited.">
          <Textarea
            id="override-revoke-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
            minLength={5}
            maxLength={2000}
            autoFocus placeholder="Enter the reason" />
        </Field>
        <Button type="submit" variant="danger" disabled={busy || reason.trim().length < 5} busy={busy}>{busy ? "Revoking…" : "Revoke access"}</Button>
      </form>
    </Dialog>
  );
}
