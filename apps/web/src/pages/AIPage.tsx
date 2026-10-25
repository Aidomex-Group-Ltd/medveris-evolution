import { Badge, Card, EmptyState, ErrorState, LoadingState, Notice, PageHeader, Table } from "@medveris/ui";
import { formatDateTime } from "../lib/format";
import { useQuery } from "../lib/useQuery";

interface Job { id: string; patientId: string; taskType: string; provider: string; model: string | null; status: string; requestDigest: string; disclaimer: string; createdAt: string; publicId: string; givenName: string; familyName: string; createdByName: string }

export function AIPage() {
  const jobs = useQuery<{ jobs: Job[]; configured: boolean }>("/ai/jobs");
  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Assistive AI" title="AI job records" description="AI output is decision support only, never a diagnosis. No provider is configured in this environment." />
      {!jobs.data?.configured ? <Notice tone="warning">No reviewed AI provider is configured. New AI jobs cannot be submitted, and no clinical inference has been produced.</Notice> : null}
      <Card title="AI job history" description="Each job records its task type, request digest, provider state and disclaimer.">
        {jobs.loading ? <LoadingState /> : jobs.error ? <ErrorState message={jobs.error} onRetry={jobs.reload} /> : !jobs.data?.jobs.length ? <EmptyState title="No AI jobs" description="No AI requests have been recorded for this facility." /> : (
          <Table head={["Patient", "Task", "Provider / model", "Status", "Created", "Disclaimer"]} caption="AI job history">
            {jobs.data.jobs.map((job) => (
              <tr key={job.id}>
                <td>{job.givenName} {job.familyName}<div className="mv-small mv-muted mv-id">{job.publicId}</div></td>
                <td>{job.taskType}<div className="mv-small mv-muted mv-id">{job.requestDigest.slice(0, 16)}…</div></td>
                <td>{job.provider}{job.model ? ` / ${job.model}` : ""}</td>
                <td><Badge tone={job.status === "failed" ? "danger" : job.status === "completed" ? "success" : "neutral"}>{job.status}</Badge></td>
                <td className="mv-small">{formatDateTime(job.createdAt)}<div className="mv-muted">{job.createdByName}</div></td>
                <td className="mv-small">{job.disclaimer}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
