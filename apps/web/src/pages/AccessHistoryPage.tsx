import { Badge, Card, EmptyState, ErrorState, LoadingState, PageHeader, Table } from "@medveris/ui";
import { useQuery } from "../lib/useQuery";
import type { AuditEventRow } from "../lib/types";

export function AccessHistoryPage() {
  const history = useQuery<{ events: AuditEventRow[] }>("/me/access-history");
  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Patient portal" title="Access history" description="A patient-readable account of record access and sharing decisions. Security investigation detail is restricted." />
      <Card title="Events">
        {history.loading ? <LoadingState /> : history.error ? <ErrorState message={history.error} onRetry={history.reload} /> : !history.data?.events.length ? <EmptyState title="No access events" description="No access has been recorded for your record." /> : (
          <Table head={["Event", "When", "Decision"]} caption="Access history">
            {history.data.events.map((event) => (
              <tr key={event.id}>
                <td>{event.summary}<div className="mv-small mv-muted">{event.resourceType}</div></td>
                <td>{new Date(event.occurredAt).toLocaleString()}</td>
                <td><Badge tone={event.decision === "deny" ? "danger" : "success"}>{event.decision}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
