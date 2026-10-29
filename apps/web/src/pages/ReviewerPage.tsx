import { useState } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, Notice, PageHeader, Table } from "@medveris/ui";
import { api, errorMessage } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useQuery } from "../lib/useQuery";
import { EhmisEligibilityReview } from "./EhmisPage";

interface ReviewRow {
  id: string;
  subjectType: string;
  subjectUserName: string | null;
  subjectFacilityName: string | null;
  credentialType: string;
  issuer: string;
  jurisdiction: string;
  credentialNumber: string;
  scope: string | null;
  issuedOn: string;
  expiresOn: string;
  status: string;
  createdAt: string;
  submitterName: string | null;
  submitterEmail: string | null;
  evidenceUploadIds: string[] | null;
}

export function ReviewerPage() {
  const { me } = useAuth();
  const queue = useQuery<{ queue: ReviewRow[]; independenceRule: string }>("/credentials/queue");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function decide(id: string, decision: "verified" | "rejected") {
    const reason = window.prompt("Decision reason (minimum 10 characters):");
    if (!reason || reason.trim().length < 10) return;
    const checks = window.prompt("Checks performed (minimum 5 characters):", "Compared submitted evidence with issuer and expiry");
    if (!checks || checks.trim().length < 5) return;
    setError(null);
    setMessage(null);
    try {
      const result = await api<{ publicClaim: string }>(`/credentials/${id}/decision`, { method: "POST", body: { decision, reason, checksPerformed: checks, expiresOn: null } });
      setMessage(`${decision === "verified" ? "Verified" : "Rejected"}. Public claim: ${result.publicClaim}.`);
      queue.reload();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Platform governance" title="Credential review" description="Independent review queue. Self-verification and verification of one's own submission are blocked by the server." />
      {error ? <ErrorState message={error} /> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      <Notice tone="info" title="Evidence access">{queue.data?.independenceRule ?? "Reviewers may access submitted evidence only for this review."} Evidence links are authenticated and audited.</Notice>
      <Card title="Pending reviews">
        {queue.loading ? <LoadingState /> : queue.error ? <ErrorState message={queue.error} onRetry={queue.reload} /> : !queue.data?.queue.length ? <EmptyState title="Queue is clear" description="No pending credential submissions." /> : (
          <Table head={["Subject", "Credential", "Submitted by", "Evidence", "Actions"]}>
            {queue.data.queue.map((row) => (
              <tr key={row.id}>
                <td><strong>{row.subjectType === "facility" ? row.subjectFacilityName : row.subjectUserName}</strong><div className="mv-small mv-muted">{row.subjectType}</div></td>
                <td><strong>{row.credentialType}</strong><div className="mv-small mv-muted">{row.issuer} · {row.jurisdiction} · expires {row.expiresOn}</div></td>
                <td className="mv-small">{row.submitterName}<div className="mv-muted">{row.submitterEmail}</div></td>
                <td>{row.evidenceUploadIds?.length ? row.evidenceUploadIds.map((id) => <a key={id} href={`/api/v1/uploads/${id}/content`} target="_blank" rel="noreferrer">Open evidence</a>) : <Badge tone="warning">none</Badge>}</td>
                <td><div className="mv-row"><Button size="sm" onClick={() => void decide(row.id, "verified")}>Verify</Button><Button size="sm" variant="danger" onClick={() => void decide(row.id, "rejected")}>Reject</Button></div></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {me?.platformRoles.includes("platform_operator") ? <EhmisEligibilityReview /> : null}
    </div>
  );
}
