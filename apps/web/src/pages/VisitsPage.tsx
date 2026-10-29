import { Link, useSearchParams } from "react-router-dom";
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, PageHeader, Table } from "@medveris/ui";
import { VisitWorkflowPanel } from "../components/VisitWorkflowPanel";
import { VisitStateBadge } from "../components/WorkflowBadges";
import { useAuth } from "../lib/auth";
import { formatDateTime, formatMoney } from "../lib/format";
import { useQuery } from "../lib/useQuery";
import { departmentLabel } from "../lib/workspace";
import type { VisitBoardEntry } from "../lib/types";

/**
 * Reception's view of today's visits: where each patient is, what was requested of which department, and
 * whether it is billed and paid. Selecting a visit opens its requests and supplied items.
 */
export function VisitsPage() {
  const { me } = useAuth();
  const [params, setParams] = useSearchParams();
  const selected = params.get("encounter");
  const board = useQuery<{ visits: VisitBoardEntry[]; canBill: boolean }>("/visits/board");
  const roles = me?.activeTenant?.roles ?? [];
  const clinical = roles.some((role) => ["clinician", "nurse"].includes(role));
  const frontDesk = roles.some((role) => ["receptionist", "facility_admin", "nurse", "clinician"].includes(role));
  const current = board.data?.visits.find((visit) => visit.id === selected) ?? null;

  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow="Patient flow"
        title="Visits"
        description="Open visits and today's completed visits, with each request's progress and billing."
        actions={<div className="mv-row">
          <Button variant="secondary" onClick={() => board.reload()} disabled={board.loading}>{board.loading ? "Refreshing…" : "Refresh"}</Button>
          {frontDesk ? <Link className="mv-button mv-button--primary mv-button--md" to="/patients">Register or find a patient</Link> : null}
        </div>}
      />
      {selected ? (
        <Card
          title={current ? `${current.patient.givenName} ${current.patient.familyName}` : "Selected visit"}
          description={current ? `${current.patient.publicId} · opened ${formatDateTime(current.openedAt)}` : undefined}
          actions={<div className="mv-row">
            {clinical ? <Link className="mv-button mv-button--secondary mv-button--sm" to={`/encounters/${selected}`}>Open consultation</Link> : null}
            <Button size="sm" variant="ghost" onClick={() => setParams({})}>Close</Button>
          </div>}
        >
          <VisitWorkflowPanel key={selected} encounterId={selected} />
        </Card>
      ) : null}
      <Card title="Visit board" description="Status for reception; clinical notes stay in the consultation.">
        {board.loading && !board.data ? <LoadingState /> : board.error ? <ErrorState message={board.error} onRetry={board.reload} /> : !board.data?.visits.length ? (
          <EmptyState title="No visits today" description="Register or find a patient, then record their visit to start the workflow." action={frontDesk ? <Link to="/patients">Go to patients</Link> : undefined} />
        ) : (
          <Table head={["Patient", "Visit", "Requests", "Billing", ""]} caption="Today's visits">
            {board.data.visits.map((visit) => {
              const open = visit.requests.requested + visit.requests.active;
              const toBill = visit.billing.unbilledRequests + visit.billing.unbilledSupplies;
              return (
                <tr key={visit.id} aria-selected={visit.id === selected}>
                  <td><strong>{visit.patient.givenName} {visit.patient.familyName}</strong><div className="mv-small mv-muted mv-id">{visit.patient.publicId}</div></td>
                  <td><VisitStateBadge state={visit.state} /><div className="mv-small mv-muted">{formatDateTime(visit.openedAt)}</div></td>
                  <td className="mv-small">
                    {open ? <div><Badge tone="warning">{open} open</Badge> {visit.requests.departments.map(departmentLabel).join(", ")}</div> : null}
                    {visit.requests.completed ? <div><Badge tone="success">{visit.requests.completed} done</Badge></div> : null}
                    {!open && !visit.requests.completed ? <span className="mv-muted">None</span> : null}
                  </td>
                  <td className="mv-small">
                    {board.data!.canBill && visit.billing.balance != null ? <div className="mv-money">Balance {formatMoney(visit.billing.balance)}</div> : null}
                    {toBill ? <div><Badge tone="neutral">{toBill} not billed</Badge></div> : null}
                    {visit.billing.unpaidRequests ? <div><Badge tone="warning">{visit.billing.unpaidRequests} unpaid</Badge></div> : null}
                    {visit.billing.paidRequests && !visit.billing.unpaidRequests && !toBill ? <Badge tone="success">Paid</Badge> : null}
                  </td>
                  <td>
                    <div className="mv-row">
                      <Button size="sm" variant="secondary" onClick={() => { setParams({ encounter: visit.id }); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Open</Button>
                      {board.data!.canBill && (toBill || visit.billing.unpaidRequests || (visit.billing.balance ?? 0) > 0) ? <Link className="mv-button mv-button--ghost mv-button--sm" to={`/pos?encounter=${visit.id}`}>Bill</Link> : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </div>
  );
}
