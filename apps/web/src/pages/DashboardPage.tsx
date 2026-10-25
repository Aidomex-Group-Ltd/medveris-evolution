import { Link } from "react-router-dom";
import { Badge, Card, DataList, EmptyState, ErrorState, LoadingState, PageHeader } from "@medveris/ui";
import { useAuth } from "../lib/auth";
import { useQuery } from "../lib/useQuery";
import type { Queue, WorklistEncounter } from "../lib/types";

export function DashboardPage() {
  const { me } = useAuth();
  if (!me) return null;
  if (me.patientId) {
    return (
      <div className="mv-stack">
        <PageHeader eyebrow="Patient portal" title={`Welcome, ${me.user.givenName}`} description="Your identity locator is not a record-access credential. Only records released by their source facility appear here." />
        <Card title="Your health record" description="Review released notes, observations, consent and access history.">
          <div className="mv-row"><Link className="mv-button mv-button--primary mv-button--md" to="/portal">Open my record</Link><Link className="mv-button mv-button--secondary mv-button--md" to="/portal/consents">Manage sharing</Link></div>
        </Card>
      </div>
    );
  }
  return <StaffOverview />;
}

function StaffOverview() {
  const { me } = useAuth();
  const roles = me?.activeTenant?.roles ?? [];
  const frontDesk = roles.some((role) => ["receptionist", "nurse", "clinician", "facility_admin"].includes(role));
  const clinical = roles.some((role) => ["nurse", "clinician"].includes(role));
  const admin = roles.includes("facility_admin");
  const queues = useQuery<{ queues: Queue[] }>("/queues", { enabled: frontDesk });
  const worklist = useQuery<{ encounters: WorklistEncounter[] }>("/encounters/worklist", { enabled: clinical });
  const facility = useQuery<{ facility: { name: string; facilityType: string; city: string | null; country: string } }>("/admin/facility", { enabled: admin });

  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow={me?.activeTenant?.name ?? "Facility workspace"}
        title={`Good day, ${me?.user.givenName ?? ""}`}
        description="Outpatient reception, triage, signed documentation and patient-controlled exchange. Later departmental modules remain unavailable."
        actions={clinical ? <Link className="mv-button mv-button--primary mv-button--md" to="/worklist">Open clinical worklist</Link> : frontDesk ? <Link className="mv-button mv-button--primary mv-button--md" to="/patients">Register or find a patient</Link> : null}
      />

      <section className="mv-grid mv-grid--3" aria-label="Facility status">
        <div className="mv-stat"><span>Active role</span><strong style={{ fontSize: "1.05rem" }}>{roles.join(", ") || "None"}</strong><span>Facility administrator does not imply clinical access</span></div>
        <div className="mv-stat"><span>Waiting in queue</span><strong>{queues.loading ? "…" : queues.data?.queues.reduce((sum, q) => sum + q.waiting, 0) ?? "—"}</strong><span>{frontDesk ? "Across active queues" : "Front-desk role required"}</span></div>
        <div className="mv-stat"><span>Active encounters</span><strong>{worklist.loading ? "…" : worklist.data?.encounters.length ?? "—"}</strong><span>{clinical ? "Arrived, triaged or in progress" : "Clinical role required"}</span></div>
      </section>

      <div className="mv-grid mv-grid--2">
        <Card title="Queue snapshot" description="Counts only; clinical detail requires an authorized chart read.">
          {!frontDesk ? <EmptyState title="Front desk not enabled" description="Your role does not include queue access." /> : queues.loading ? <LoadingState /> : queues.error ? <ErrorState message={queues.error} onRetry={queues.reload} /> : !queues.data?.queues.length ? <EmptyState title="No queues yet" description="Create an outpatient queue or register a walk-in encounter from the Patients workspace." /> : (
            <DataList items={queues.data.queues.map((queue) => ({ label: queue.name, value: <>{queue.waiting} waiting <Badge tone={queue.waiting ? "warning" : "neutral"}>{queue.waiting ? "active" : "clear"}</Badge></> }))} />
          )}
          {frontDesk ? <div style={{ marginTop: 14 }}><Link to="/queues">Open queues</Link></div> : null}
        </Card>
        <Card title="Clinical worklist" description="Only assigned role-filtered encounters. Records are no-store.">
          {!clinical ? <EmptyState title="Clinical workspace not enabled" description="Reception and finance roles cannot read clinical narratives." /> : worklist.loading ? <LoadingState /> : worklist.error ? <ErrorState message={worklist.error} onRetry={worklist.reload} /> : !worklist.data?.encounters.length ? <EmptyState title="Worklist is clear" description="No arrived, triaged or in-progress encounters." /> : (
            <ul className="mv-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {worklist.data.encounters.slice(0, 4).map((encounter) => (
                <li key={encounter.id} className="mv-spread">
                  <div><strong>{encounter.givenName} {encounter.familyName}</strong><div className="mv-small mv-muted"><span className="mv-id">{encounter.publicId}</span> · {encounter.state}</div></div>
                  <Link className="mv-button mv-button--secondary mv-button--sm" to={`/encounters/${encounter.id}`}>Open chart</Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {admin ? (
        <Card title="Facility profile" description="Administrative scope only. This does not grant chart access.">
          {facility.loading ? <LoadingState /> : facility.error ? <ErrorState message={facility.error} onRetry={facility.reload} /> : facility.data ? (
            <DataList items={[
              { label: "Facility", value: facility.data.facility.name },
              { label: "Type", value: facility.data.facility.facilityType },
              { label: "Location", value: [facility.data.facility.city, facility.data.facility.country].filter(Boolean).join(", ") },
              { label: "Credential claim", value: <Badge tone="warning">No automatic verification</Badge> },
            ]} />
          ) : null}
          <div className="mv-row" style={{ marginTop: 14 }}><Link to="/admin">Manage facility</Link><Link to="/credentials">View credentials</Link></div>
        </Card>
      ) : null}

      <Card title="Environment limits" description="Genuine unavailable states are shown rather than simulated success.">
        <ul className="mv-small mv-muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
          <li>Terminology mode is synthetic and must be replaced by a licensed production adapter before standardized coding.</li>
          <li>PACS, laboratory, pharmacy, devices, telehealth, AI, payments and ledger anchoring are disabled.</li>
          <li>Local upload checks verify signatures only; no production malware scanner is configured.</li>
        </ul>
      </Card>
    </div>
  );
}
