import { Link } from "react-router-dom";
import { Badge, Card, DataList, EmptyState, ErrorState, LoadingState, PageHeader, Table } from "@medveris/ui";
import { PriorityBadge, RequestStatusBadge, VisitStateBadge } from "../components/WorkflowBadges";
import { useAuth } from "../lib/auth";
import { useAppEnvironment } from "../lib/environment";
import { CASHIER_ROLES, DEPARTMENT_QUEUE_ROLES, VISIT_ROLES } from "../lib/roles";
import { useQuery } from "../lib/useQuery";
import { departmentLabel, workspaceProfile } from "../lib/workspace";
import type { Queue, QueueItem, QueueSummary, VisitBoardEntry, WorkflowDepartment, WorklistEncounter } from "../lib/types";

interface FeedItem { id: string; title: string; summary: string; contentType: string; publicationDate: string | null; sourceOrganization: string | null }

interface PatientDashboard {
  content: FeedItem[];
  contentTotal: number;
  appointments: Array<{ id: string; startAt: string; durationMinutes: number; reason: string; status: string; facilityName: string }>;
  followUps: Array<{ id: string; dueDate: string; instructions: string | null; status: string }>;
  releases: { facilities: number };
  activeConsents: number;
}

interface ClinicianDashboard {
  content: FeedItem[];
  contentTotal: number;
  appointments: Array<{ id: string; startAt: string; durationMinutes: number; reason: string; status: string; publicId: string; givenName: string; familyName: string }>;
  worklist: Array<{ id: string; state: string; type: string; openedAt: string; publicId: string; givenName: string; familyName: string }>;
  counts: { resultsAwaitingReview: number; pendingFollowUps: number; outstandingReferrals: number };
}

interface SpecialistDashboard {
  content: FeedItem[];
  contentTotal: number;
  diagnosticWorklist: Array<{ id: string; name: string; status: string; priority: string; orderType: string; publicId: string; givenName: string; familyName: string }>;
  specialtyReferrals: Array<{ id: string; reason: string; priority: string; status: string; toFacility: string | null; publicId: string; givenName: string; familyName: string }>;
  specialties: string[];
}

function human(value: string | null | undefined): string {
  if (!value) return "Content";
  return value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function ContentPreview({ items, total }: { items: FeedItem[]; total: number }) {
  if (!items.length) return <EmptyState title="No published content" description="Reviewed content for your role appears here once published." />;
  return (
    <div className="mv-stack">
      {items.map((item) => (
        <div key={item.id}>
          <strong>{item.title}</strong>
          <div className="mv-small mv-muted">{human(item.contentType)} · {item.sourceOrganization ?? "Medveris"} · {item.publicationDate ?? "—"}</div>
          <div className="mv-small">{item.summary}</div>
        </div>
      ))}
      <div className="mv-small"><Link to="/content">Open the health library ({total} items)</Link></div>
    </div>
  );
}

function PatientHome() {
  const { me } = useAuth();
  const dashboard = useQuery<PatientDashboard>("/dashboards/patient");
  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Patient portal" title={`Welcome, ${me?.user.givenName ?? ""}`} description="Your identity locator is not a record-access credential. Only records released by their source facility appear here." />
      <div className="mv-grid mv-grid--3">
        <div className="mv-stat"><span>Upcoming appointments</span><strong>{dashboard.loading ? "…" : dashboard.data?.appointments.length ?? "—"}</strong><span>Next scheduled visits</span></div>
        <div className="mv-stat"><span>Pending follow-ups</span><strong>{dashboard.loading ? "…" : dashboard.data?.followUps.length ?? "—"}</strong><span>Instructions from your care team</span></div>
        <div className="mv-stat"><span>Facilities releasing records</span><strong>{dashboard.loading ? "…" : dashboard.data?.releases.facilities ?? "—"}</strong><span>Active sharing consents: {dashboard.data?.activeConsents ?? "—"}</span></div>
      </div>
      {dashboard.error ? <ErrorState message={dashboard.error} onRetry={dashboard.reload} /> : null}
      <div className="mv-grid mv-grid--2">
        <Card title="Your health record" description="Review released notes, observations, consent and access history.">
          <div className="mv-row"><Link className="mv-button mv-button--primary mv-button--md" to="/portal">Open my record</Link><Link className="mv-button mv-button--secondary mv-button--md" to="/portal/consents">Manage sharing</Link></div>
        </Card>
        <Card title="Upcoming appointments">
          {dashboard.loading ? <LoadingState /> : !dashboard.data?.appointments.length ? <EmptyState title="No upcoming appointment" description="Contact your facility front desk to schedule a visit." /> : (
            <DataList items={dashboard.data.appointments.map((appointment) => ({ label: new Date(appointment.startAt).toLocaleString(), value: <>{appointment.reason} <Badge tone="info">{appointment.facilityName}</Badge></> }))} />
          )}
        </Card>
      </div>
      <div className="mv-grid mv-grid--2">
        <Card title="Follow-up instructions">
          {dashboard.loading ? <LoadingState /> : !dashboard.data?.followUps.length ? <EmptyState title="No pending follow-up" description="Your care team has not recorded a pending follow-up." /> : (
            <DataList items={dashboard.data.followUps.map((followUp) => ({ label: followUp.dueDate, value: followUp.instructions ?? "Follow-up due" }))} />
          )}
        </Card>
        <Card title="Health library" description="Patient education and advisories published for patients.">
          {dashboard.loading ? <LoadingState /> : <ContentPreview items={dashboard.data?.content ?? []} total={dashboard.data?.contentTotal ?? 0} />}
        </Card>
      </div>
    </div>
  );
}

export function DashboardPage() {
  const { me } = useAuth();
  if (!me) return null;
  if (me.patientId) return <PatientHome />;
  return <StaffOverview />;
}

function StaffOverview() {
  const { me } = useAuth();
  const profile = workspaceProfile(me?.activeTenant);
  if (profile.unitDepartment) return <UnitDashboard department={profile.unitDepartment} />;
  return <FacilityOverview />;
}

function age(dateOfBirth: string): string {
  const born = new Date(dateOfBirth);
  if (Number.isNaN(born.getTime())) return "";
  const years = Math.floor((Date.now() - born.getTime()) / (365.25 * 86_400_000));
  return years >= 1 ? `${years}y` : `${Math.max(0, Math.floor((Date.now() - born.getTime()) / (30.44 * 86_400_000)))}m`;
}

/** Landing page for a standalone laboratory, imaging centre or pharmacy: its own queue, visits and till first. */
function UnitDashboard({ department }: { department: WorkflowDepartment }) {
  const { me } = useAuth();
  const roles = me?.activeTenant?.roles ?? [];
  const profile = workspaceProfile(me?.activeTenant);
  const canWork = (DEPARTMENT_QUEUE_ROLES[department] as readonly string[]).some((role) => roles.includes(role as never));
  const cashier = CASHIER_ROLES.some((role) => roles.includes(role));
  const frontDesk = roles.some((role) => ["receptionist", "facility_admin"].includes(role));
  const summary = useQuery<{ departments: QueueSummary[] }>("/work-queues");
  const queue = useQuery<{ items: QueueItem[] }>(canWork ? `/work-queues/${department}?limit=6` : null);
  const visits = useQuery<{ visits: VisitBoardEntry[] }>("/visits/board");
  const catalogue = useQuery<{ services: Array<{ id: string }> }>("/service-catalog?active=true", { enabled: cashier });
  const config = useQuery<{ features: Record<string, boolean> }>("/public/config", { enabled: cashier });
  const counts = summary.data?.departments.find((row) => row.department === department);
  const openVisits = visits.data?.visits.filter((visit) => ["planned", "arrived", "triaged", "in-progress"].includes(visit.state)) ?? [];
  const unpaid = visits.data?.visits.filter((visit) => visit.billing.unbilledRequests + visit.billing.unpaidRequests + visit.billing.unbilledSupplies > 0).length;
  const label = departmentLabel(department);

  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow={profile.categoryLabel ? `${profile.categoryLabel} · independent workspace` : "Independent workspace"}
        title={me?.activeTenant?.name ?? `${label} dashboard`}
        description={`Good day, ${me?.user.givenName ?? ""}. Register walk-in patients, work the ${label.toLowerCase()} queue and take payments in one place.`}
        actions={
          <div className="mv-row">
            {frontDesk ? <Link className="mv-button mv-button--secondary mv-button--md" to="/patients">Register or find a patient</Link> : null}
            {canWork ? <Link className="mv-button mv-button--primary mv-button--md" to={`/work-queues/${department}`}>Open {label.toLowerCase()} queue</Link> : null}
          </div>
        }
      />
      <section className="mv-grid mv-grid--3" aria-label={`${label} status`}>
        <div className="mv-stat"><span>Waiting</span><strong>{summary.loading ? "…" : counts ? counts.requested + counts.accepted : 0}</strong><span>{counts?.emergency ? `${counts.emergency} emergency` : counts?.urgent ? `${counts.urgent} urgent` : "Requested or accepted"}</span></div>
        <div className="mv-stat"><span>In progress</span><strong>{summary.loading ? "…" : counts?.inProgress ?? 0}</strong><span>Completed today: {counts?.completedToday ?? 0}</span></div>
        <div className="mv-stat"><span>Open visits</span><strong>{visits.loading ? "…" : openVisits.length}</strong><span>{cashier && unpaid != null ? `${unpaid} with charges to collect` : "Registered today and not closed"}</span></div>
      </section>
      {summary.error ? <ErrorState message={summary.error} onRetry={summary.reload} /> : null}
      <div className="mv-grid mv-grid--2">
        <Card title={`Next in the ${label.toLowerCase()} queue`} description="Emergency and urgent work first.">
          {!canWork ? <EmptyState title="Queue not assigned to you" description={`Ask the workspace owner to add the ${label.toLowerCase()} role to your account.`} /> : queue.loading ? <LoadingState /> : queue.error ? <ErrorState message={queue.error} onRetry={queue.reload} /> : !queue.data?.items.length ? (
            <EmptyState title="Queue is clear" description="New requests appear here as soon as reception or a clinician records them." action={frontDesk ? <Link to="/patients">Register a walk-in patient</Link> : undefined} />
          ) : (
            <ul className="mv-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {queue.data.items.map((item) => (
                <li key={item.id} className="mv-spread">
                  <div>
                    <strong>{item.description}</strong>
                    <div className="mv-small mv-muted">{item.patient.givenName} {item.patient.familyName} · {item.patient.sex} {age(item.patient.dateOfBirth)}</div>
                  </div>
                  <div className="mv-row"><PriorityBadge priority={item.priority} /><RequestStatusBadge status={item.status} /></div>
                </li>
              ))}
            </ul>
          )}
          {canWork ? <div style={{ marginTop: 14 }}><Link to={`/work-queues/${department}`}>Open the full queue</Link></div> : null}
        </Card>
        <Card title="Today's visits" description="Progress and billing at a glance.">
          {visits.loading ? <LoadingState /> : visits.error ? <ErrorState message={visits.error} onRetry={visits.reload} /> : !visits.data?.visits.length ? <EmptyState title="No visits yet today" description="Register a patient and record the visit to start." /> : (
            <ul className="mv-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {visits.data.visits.slice(0, 6).map((visit) => (
                <li key={visit.id} className="mv-spread">
                  <div><strong>{visit.patient.givenName} {visit.patient.familyName}</strong><div className="mv-small mv-muted">{visit.requests.requested + visit.requests.active} open · {visit.requests.completed} done</div></div>
                  <VisitStateBadge state={visit.state} />
                </li>
              ))}
            </ul>
          )}
          <div style={{ marginTop: 14 }}><Link to="/visits">All visits</Link></div>
        </Card>
      </div>
      {cashier ? (
        <Card title="Set up your unit" description="A few things make the till and queue work smoothly.">
          <ul className="mv-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            <li className="mv-spread"><span>Price list: {catalogue.loading ? "…" : `${catalogue.data?.services.length ?? 0} active items`}</span><Link to="/price-list">{catalogue.data?.services.length ? "Review prices" : "Add your services and prices"}</Link></li>
            <li className="mv-spread"><span>Mobile money (Yo!): {config.loading ? "…" : config.data?.features.payments ? <Badge tone="success">available</Badge> : <Badge tone="neutral">not configured; cash only</Badge>}</span><Link to="/pos">Open point of sale</Link></li>
            <li className="mv-spread"><span>Staff accounts</span><Link to="/admin">Invite staff</Link></li>
            <li className="mv-spread"><span>Licences, registry IDs and modules</span><Link to="/workspace">Workspace profile</Link></li>
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

/** Work in every department queue: counts only, linked to the queues the caller works. */
function PatientFlowCard() {
  const summary = useQuery<{ departments: QueueSummary[] }>("/work-queues");
  const rows = summary.data?.departments.filter((row) => row.requested + row.accepted + row.inProgress + row.completedToday > 0 || row.canWork) ?? [];
  if (!summary.loading && !summary.error && !rows.length) return null;
  return (
    <Card title="Patient flow" description="Requests from consultations in each department's queue.">
      {summary.loading ? <LoadingState /> : summary.error ? <ErrorState message={summary.error} onRetry={summary.reload} /> : (
        <Table head={["Department", "Waiting", "In progress", "Done today", ""]} caption="Department work queues">
          {rows.map((row) => (
            <tr key={row.department}>
              <td><strong>{departmentLabel(row.department)}</strong>{row.emergency ? <> <Badge tone="danger">{row.emergency} emergency</Badge></> : row.urgent ? <> <Badge tone="warning">{row.urgent} urgent</Badge></> : null}</td>
              <td>{row.requested + row.accepted}</td>
              <td>{row.inProgress}</td>
              <td>{row.completedToday}</td>
              <td>{row.canWork ? <Link to={`/work-queues/${row.department}`}>Open queue</Link> : null}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

function FacilityOverview() {
  const { me } = useAuth();
  const environment = useAppEnvironment();
  const roles = me?.activeTenant?.roles ?? [];
  const visitRole = VISIT_ROLES.some((role) => roles.includes(role));
  const frontDesk = roles.some((role) => ["receptionist", "nurse", "clinician", "facility_admin"].includes(role));
  const clinical = roles.some((role) => ["nurse", "clinician"].includes(role));
  const admin = roles.includes("facility_admin");
  const specialistScope = roles.some((role) => ["specialist_clinician", "department_lead"].includes(role));
  const clinicianScope = roles.some((role) => ["nurse", "clinician", "diagnostic_practitioner", "laboratory", "radiology"].includes(role));
  const queues = useQuery<{ queues: Queue[] }>("/queues", { enabled: frontDesk });
  const worklist = useQuery<{ encounters: WorklistEncounter[] }>("/encounters/worklist", { enabled: clinical });
  const facility = useQuery<{ facility: { name: string; facilityType: string; city: string | null; country: string } }>("/admin/facility", { enabled: admin });
  const clinicianDashboard = useQuery<ClinicianDashboard>("/dashboards/clinician", { enabled: clinicianScope });
  const specialistDashboard = useQuery<SpecialistDashboard>("/dashboards/specialist", { enabled: specialistScope });
  const knowledge = useQuery<{ items: FeedItem[]; total: number }>("/content?limit=4");

  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow={me?.activeTenant?.name ?? "Facility workspace"}
        title={`Good day, ${me?.user.givenName ?? ""}`}
        description="Reception, consultations with signed notes, department work queues, billing and patient-controlled exchange for this workspace."
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

      {visitRole ? <PatientFlowCard /> : null}

      {clinicianScope ? (
        <div className="mv-grid mv-grid--3">
          <Card title="My clinical day" description="Appointments assigned to you in the next day.">
            {clinicianDashboard.loading ? <LoadingState /> : clinicianDashboard.error ? <ErrorState message={clinicianDashboard.error} onRetry={clinicianDashboard.reload} /> : !clinicianDashboard.data?.appointments.length ? <EmptyState title="No assigned appointments" description="Your schedule is clear for the next day." /> : (
              <ul className="mv-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {clinicianDashboard.data.appointments.slice(0, 5).map((appointment) => (
                  <li key={appointment.id}><strong>{appointment.givenName} {appointment.familyName}</strong><div className="mv-small mv-muted">{new Date(appointment.startAt).toLocaleString()} · {appointment.reason}</div></li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Results and follow-ups" description="Counts only; chart detail requires an authorized read.">
            {clinicianDashboard.loading ? <LoadingState /> : clinicianDashboard.data ? (
              <DataList items={[
                { label: "Results awaiting review", value: clinicianDashboard.data.counts.resultsAwaitingReview },
                { label: "Follow-ups due this week", value: clinicianDashboard.data.counts.pendingFollowUps },
                { label: "Outstanding referrals", value: clinicianDashboard.data.counts.outstandingReferrals },
              ]} />
            ) : null}
          </Card>
          <Card title="Clinical feed" description="Reviewed content for your specialty and department.">
            {clinicianDashboard.loading ? <LoadingState /> : <ContentPreview items={clinicianDashboard.data?.content ?? []} total={clinicianDashboard.data?.contentTotal ?? 0} />}
          </Card>
        </div>
      ) : null}

      {specialistScope ? (
        <div className="mv-grid mv-grid--2">
          <Card title="Specialty worklist" description="Collected or in-progress diagnostic items ordered for patients.">
            {specialistDashboard.loading ? <LoadingState /> : specialistDashboard.error ? <ErrorState message={specialistDashboard.error} onRetry={specialistDashboard.reload} /> : !specialistDashboard.data?.diagnosticWorklist.length ? <EmptyState title="Worklist is clear" description="No diagnostic items are awaiting specialty handling." /> : (
              <ul className="mv-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {specialistDashboard.data.diagnosticWorklist.slice(0, 6).map((item) => (
                  <li key={item.id} className="mv-spread"><span>{item.name}<div className="mv-small mv-muted">{item.givenName} {item.familyName} · <span className="mv-id">{item.publicId}</span></div></span><Badge tone={item.priority === "emergency" ? "danger" : item.priority === "urgent" ? "warning" : "neutral"}>{item.priority}</Badge></li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Specialty referrals" description="Pending referrals; diagnose and disposition are separate decisions.">
            {specialistDashboard.loading ? <LoadingState /> : !specialistDashboard.data?.specialtyReferrals.length ? <EmptyState title="No pending referrals" description="No referrals are pending for your specialty." /> : (
              <ul className="mv-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {specialistDashboard.data.specialtyReferrals.slice(0, 6).map((referral) => (
                  <li key={referral.id}><strong>{referral.givenName} {referral.familyName}</strong><div className="mv-small mv-muted">{referral.reason} · {referral.toFacility ?? "internal"} · <Badge tone="warning">{referral.priority}</Badge></div></li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      ) : null}

      <Card title="Health library" description="Published advisories, guidelines and learning selected for your role and department.">
        {knowledge.loading ? <LoadingState /> : knowledge.error ? <ErrorState message={knowledge.error} onRetry={knowledge.reload} /> : <ContentPreview items={knowledge.data?.items ?? []} total={knowledge.data?.total ?? 0} />}
      </Card>

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
          <li>{environment.synthetic
            ? "Terminology mode is synthetic and must be replaced by a licensed production adapter before standardized coding."
            : "No licensed terminology service is configured; coded entries cannot be validated until one is contracted."}</li>
          <li>PACS, laboratory, pharmacy, devices, telehealth, AI, payments and ledger anchoring are disabled.</li>
          <li>Local upload checks verify signatures only; no production malware scanner is configured.</li>
        </ul>
      </Card>
    </div>
  );
}
