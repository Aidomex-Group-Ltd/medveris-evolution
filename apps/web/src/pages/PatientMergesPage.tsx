import { useState } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Field, LoadingState, Notice, PageHeader, Select, Table } from "@medveris/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDateTime } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";

interface MergeRow {
  id: string;
  status: "requested" | "completed" | "rejected" | "reversed";
  reason: string;
  evidence: string;
  requestedAt: string;
  requestedBy: string;
  requestedByName: string;
  decidedAt: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  reversedAt: string | null;
  reversedByName: string | null;
  reversalReason: string | null;
  sourcePublicId: string;
  sourceGivenName: string;
  sourceFamilyName: string;
  sourceDateOfBirth: string;
  survivorPublicId: string;
  survivorGivenName: string;
  survivorFamilyName: string;
  survivorDateOfBirth: string;
}

const TONE: Record<MergeRow["status"], "success" | "warning" | "danger" | "neutral"> = {
  requested: "warning", completed: "success", rejected: "neutral", reversed: "danger",
};

export function PatientMergesPage() {
  const { me } = useAuth();
  const [status, setStatus] = useState("requested");
  const merges = useQuery<{ merges: MergeRow[] }>(`/patient-merges?status=${status}`);
  const action = useAction();

  function decide(merge: MergeRow, kind: "approve" | "reject" | "reverse") {
    const prompts = {
      approve: "Approval note: confirm you independently checked both identities (at least 5 characters).",
      reject: "Reason for rejecting this merge (at least 5 characters):",
      reverse: "Reason for reversing this merge (at least 10 characters):",
    };
    const text = window.prompt(prompts[kind]);
    if (!text || text.trim().length < (kind === "reverse" ? 10 : 5)) return;
    if (kind === "approve" && !window.confirm(`Merge ${merge.sourcePublicId} into ${merge.survivorPublicId}? The retired ID will resolve to the surviving record.`)) return;
    void action.run(kind, async () => {
      await api(`/patient-merges/${merge.id}/${kind}`, { method: "POST", body: kind === "reverse" ? { reason: text } : { note: text } });
      merges.reload();
      return kind === "approve" ? "Merge completed." : kind === "reject" ? "Merge request rejected." : "Merge reversed; both identities are active again.";
    });
  }

  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Patient identity" title="Patient merges" description="Merges need a request and an approval by two different authorised people. Signed records are never rewritten; they stay under their original ID and are shown with the surviving record." />
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title="Merge requests">
        <Field label="Status"><Select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="requested">Awaiting approval</option><option value="completed">Completed</option><option value="rejected">Rejected</option><option value="reversed">Reversed</option><option value="all">All</option>
        </Select></Field>
        {merges.loading ? <LoadingState /> : merges.error ? <ErrorState message={merges.error} onRetry={merges.reload} /> : !merges.data?.merges.length ? (
          <EmptyState title="No merges" description="Request a merge from Administration → Duplicates." />
        ) : (
          <Table head={["Retire", "Keep", "Request", "Decision", "Status", ""]} caption="Patient merge requests">
            {merges.data.merges.map((merge) => (
              <tr key={merge.id}>
                <td>{merge.sourceGivenName} {merge.sourceFamilyName}<div className="mv-small mv-muted"><span className="mv-id">{merge.sourcePublicId}</span> · {merge.sourceDateOfBirth}</div></td>
                <td>{merge.survivorGivenName} {merge.survivorFamilyName}<div className="mv-small mv-muted"><span className="mv-id">{merge.survivorPublicId}</span> · {merge.survivorDateOfBirth}</div></td>
                <td className="mv-small">{merge.reason}<div className="mv-muted">Evidence: {merge.evidence}</div><div className="mv-muted">{merge.requestedByName}, {formatDateTime(merge.requestedAt)}</div></td>
                <td className="mv-small">{merge.decidedAt ? <>{merge.decisionNote}<div className="mv-muted">{merge.decidedByName}, {formatDateTime(merge.decidedAt)}</div></> : "—"}
                  {merge.reversedAt ? <div>Reversed: {merge.reversalReason}<div className="mv-muted">{merge.reversedByName}, {formatDateTime(merge.reversedAt)}</div></div> : null}</td>
                <td><Badge tone={TONE[merge.status]}>{merge.status}</Badge></td>
                <td>
                  {merge.status === "requested" && merge.requestedBy !== me?.user.id ? (
                    <div className="mv-row"><Button size="sm" disabled={action.busy !== null} onClick={() => decide(merge, "approve")}>Approve</Button><Button size="sm" variant="secondary" disabled={action.busy !== null} onClick={() => decide(merge, "reject")}>Reject</Button></div>
                  ) : merge.status === "requested" ? <span className="mv-small mv-muted">Awaiting a second reviewer</span> : null}
                  {merge.status === "completed" ? <Button size="sm" variant="danger" disabled={action.busy !== null} onClick={() => decide(merge, "reverse")}>Reverse</Button> : null}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
