import { Link } from "react-router-dom";
import { Badge, Card, EmptyState, ErrorState, LoadingState, PageHeader, Table } from "@medveris/ui";
import { useQuery } from "../lib/useQuery";
import type { WorklistEncounter } from "../lib/types";

const tone = (state: string) => (state === "triaged" ? "warning" : state === "in-progress" ? "info" : "neutral");

export function WorklistPage() {
  const worklist = useQuery<{ encounters: WorklistEncounter[] }>("/encounters/worklist");
  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Clinical" title="Clinical worklist" description="Assigned encounters awaiting triage or documentation. Opening a chart is audited and responses are no-store." />
      <Card title="Active encounters" description="Triaged patients are prioritised ahead of in-progress and arrived patients.">
        {worklist.loading ? <LoadingState /> : worklist.error ? <ErrorState message={worklist.error} onRetry={worklist.reload} /> : !worklist.data?.encounters.length ? <EmptyState title="Worklist is clear" description="No arrived, triaged or in-progress encounters for this facility." /> : (
          <Table head={["Patient", "State", "Reason", "Draft notes", "Signed notes", "Opened", ""]} caption="Active clinical encounters">
            {worklist.data.encounters.map((encounter) => (
              <tr key={encounter.id}>
                <td><strong>{encounter.givenName} {encounter.familyName}</strong><div className="mv-small mv-muted"><span className="mv-id">{encounter.publicId}</span> · DOB {encounter.dateOfBirth}</div></td>
                <td><Badge tone={tone(encounter.state)}>{encounter.state}</Badge></td>
                <td>{encounter.reason}</td>
                <td>{encounter.draftNotes}</td>
                <td>{encounter.signedNotes}</td>
                <td>{new Date(encounter.openedAt).toLocaleString()}</td>
                <td><Link className="mv-button mv-button--secondary mv-button--sm" to={`/encounters/${encounter.id}`}>Open</Link></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
