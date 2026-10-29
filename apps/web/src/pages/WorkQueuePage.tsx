import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { WORKFLOW_DEPARTMENTS } from "@medveris/domain";
import { Button, EmptyState, ErrorState, LoadingState, Notice, PageHeader, Tabs } from "@medveris/ui";
import { BillingBadge, PriorityBadge, RequestStatusBadge, VisitStateBadge } from "../components/WorkflowBadges";
import { api, errorMessage } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";
import { departmentLabel } from "../lib/workspace";
import type { QueueItem, RecommendationStatus, WorkflowDepartment } from "../lib/types";

type Filter = "open" | "completed" | "closed";

const NEXT: Partial<Record<RecommendationStatus, Array<{ status: RecommendationStatus; label: string; note?: "required" | "optional" }>>> = {
  requested: [{ status: "accepted", label: "Accept" }, { status: "in-progress", label: "Start" }, { status: "declined", label: "Decline", note: "required" }],
  accepted: [{ status: "in-progress", label: "Start" }, { status: "completed", label: "Complete", note: "optional" }, { status: "declined", label: "Decline", note: "required" }],
  "in-progress": [{ status: "completed", label: "Complete", note: "optional" }, { status: "declined", label: "Decline", note: "required" }],
};

function age(dateOfBirth: string): string {
  const born = new Date(dateOfBirth);
  if (Number.isNaN(born.getTime())) return "";
  const years = Math.floor((Date.now() - born.getTime()) / (365.25 * 86_400_000));
  return years >= 1 ? `${years} y` : `${Math.max(0, Math.floor((Date.now() - born.getTime()) / (30.44 * 86_400_000)))} m`;
}

/** One department's work: patient, visit, requested service, priority, status and instructions, worked in order. */
export function WorkQueuePage() {
  const { department = "" } = useParams();
  const valid = (WORKFLOW_DEPARTMENTS as readonly string[]).includes(department);
  const [filter, setFilter] = useState<Filter>("open");
  const queue = useQuery<{ department: WorkflowDepartment; canWork: boolean; items: QueueItem[] }>(valid ? `/work-queues/${department}?status=${filter}` : null);
  const action = useAction();

  useEffect(() => {
    if (filter !== "open") return;
    const timer = window.setInterval(() => queue.reload(), 30_000);
    return () => window.clearInterval(timer);
  }, [filter, queue.reload]);

  if (!valid) return <EmptyState title="Unknown department" description="Choose a department queue from the navigation." />;
  const label = departmentLabel(department);

  async function move(item: QueueItem, status: RecommendationStatus, verb: string, note?: "required" | "optional") {
    let text = "";
    if (note) {
      const answer = window.prompt(note === "required" ? `Why can ${label.toLowerCase()} not do “${item.description}”?` : `Completion note for “${item.description}” (optional)`);
      if (answer === null) return;
      text = answer.trim();
      if (note === "required" && text.length < 3) {
        action.setError("A reason of at least 3 characters is needed so the requester and reception know why.");
        return;
      }
    }
    await action.run(item.id, async () => {
      await api(`/recommendations/${item.id}/transitions`, { method: "POST", body: { status, expectedVersion: item.version, note: text } });
      queue.reload();
      return `${item.description} for ${item.patient.givenName} ${item.patient.familyName}: ${verb.toLowerCase()}.`;
    });
  }

  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow="Department work queue"
        title={`${label} queue`}
        description="Requests from consultations and walk-in requests. Emergency and urgent work is listed first; the list refreshes every 30 seconds."
        actions={<Button variant="secondary" onClick={() => queue.reload()} disabled={queue.loading}>{queue.loading ? "Refreshing…" : "Refresh"}</Button>}
      />
      <Tabs label="Queue filter" value={filter} onChange={setFilter} options={[{ value: "open", label: "Open" }, { value: "completed", label: "Completed" }, { value: "closed", label: "All closed" }]} />
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      {queue.data && !queue.data.canWork ? <Notice tone="info">You can see this queue but only {label.toLowerCase()} staff can update it.</Notice> : null}
      {queue.loading && !queue.data ? <LoadingState label={`Loading the ${label.toLowerCase()} queue`} /> : queue.error ? <ErrorState message={queue.error} onRetry={queue.reload} /> : !queue.data?.items.length ? (
        <EmptyState
          title={filter === "open" ? "Nothing waiting" : "Nothing here yet"}
          description={filter === "open" ? "New requests appear as soon as a clinician recommends them or reception logs a walk-in request." : "Completed and closed requests appear here."}
          action={<Link to="/visits">Go to visits</Link>}
        />
      ) : (
        <div className="mv-stack">
          {queue.data.items.map((item) => (
            <article key={item.id} className={`mv-queue-item${item.priority === "emergency" ? " mv-queue-item--emergency" : item.priority === "urgent" ? " mv-queue-item--urgent" : ""}`} aria-label={`${item.description} for ${item.patient.givenName} ${item.patient.familyName}`}>
              <div className="mv-spread">
                <div>
                  <strong>{item.patient.givenName} {item.patient.familyName}</strong>
                  <div className="mv-small mv-muted"><span className="mv-id">{item.patient.publicId}</span> · {item.patient.sex} · {age(item.patient.dateOfBirth)}</div>
                </div>
                <div className="mv-row"><PriorityBadge priority={item.priority} /><RequestStatusBadge status={item.status} /></div>
              </div>
              <div>
                <strong>{item.description}</strong>{item.quantity !== 1 ? ` × ${item.quantity}` : ""}{item.itemCode ? <span className="mv-small mv-muted"> · {item.itemCode}</span> : null}
                <div className="mv-small mv-muted">
                  {item.source === "direct-request" ? `Logged by ${item.createdByName ?? "staff"}${item.externalReferrer ? ` for ${item.externalReferrer}` : ""}` : `Recommended by ${item.createdByName ?? "clinician"}`} · {formatDateTime(item.createdAt)}
                </div>
              </div>
              {item.instructions ? <p className="mv-small" style={{ margin: 0, whiteSpace: "pre-wrap" }}><strong>Instructions:</strong> {item.instructions}</p> : null}
              {item.statusNote && item.status !== "requested" ? <p className="mv-small" style={{ margin: 0 }}><strong>{item.status === "completed" ? "Note" : "Reason"}:</strong> {item.statusNote}</p> : null}
              <div className="mv-spread mv-small">
                <span className="mv-row">Visit: <VisitStateBadge state={item.visit.state} />{item.visit.reason ? <span className="mv-muted">{item.visit.reason}</span> : null}</span>
                <span className="mv-row">Bill: <BillingBadge status={item.billingStatus} /></span>
              </div>
              <div className="mv-row">
                {queue.data!.canWork ? (NEXT[item.status] ?? []).map((next) => (
                  <Button key={next.status} size="sm" variant={next.status === "declined" ? "ghost" : next.status === "completed" ? "primary" : "secondary"} disabled={action.busy !== null}
                    onClick={() => void move(item, next.status, next.label, next.note).catch((cause: unknown) => action.setError(errorMessage(cause)))}>
                    {action.busy === item.id ? "Saving…" : next.label}
                  </Button>
                )) : null}
                <Link className="mv-button mv-button--ghost mv-button--sm" to={`/visits?encounter=${item.visit.id}`}>Visit and supplies</Link>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
