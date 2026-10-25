import { Link } from "react-router-dom";
import { Badge, Card, DataList, EmptyState, ErrorState, LoadingState, PageHeader } from "@medveris/ui";
import { useAuth } from "../lib/auth";
import { useQuery } from "../lib/useQuery";
import type { Queue, WorklistEncounter } from "../lib/types";

interface FeedItem { id: string; title: string; summary: string; content_type: string; publication_date: string | null; source_organization: string | null }

interface PatientDashboard {
  content: FeedItem[];
  contentTotal: number;
  appointments: Array<{ id: string; start_at: string; duration_minutes: number; reason: string; status: string; facility_name: string }>;
  followUps: Array<{ id: string; due_date: string; instructions: string | null; status: string }>;
  releases: { facilities: number };
  activeConsents: number;
}

interface ClinicianDashboard {
  content: FeedItem[];
  contentTotal: number;
  appointments: Array<{ id: string; start_at: string; duration_minutes: number; reason: string; status: string; public_id: string; given_name: string; family_name: string }>;
  worklist: Array<{ id: string; state: string; type: string; opened_at: string; public_id: string; given_name: string; family_name: string }>;
  counts: { resultsAwaitingReview: number; pendingFollowUps: number; outstandingReferrals: number };
}

interface SpecialistDashboard {
  content: FeedItem[];
  contentTotal: number;
  diagnosticWorklist: Array<{ id: string; name: string; status: string; priority: string; order_type: string; public_id: string; given_name: string; family_name: string }>;
  specialtyReferrals: Array<{ id: string; reason: string; priority: string; status: string; to_facility: string | null; public_id: string; given_name: string; family_name: string }>;
  specialties: string[];
}

function human(value: string): string {
  return value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function ContentPreview({ items, total }: { items: FeedItem[]; total: number }) {
  if (!items.length) return <EmptyState title="No published content" description="Reviewed content for your role appears here once published." />;
  return (
    <div className="mv-stack">
      {items.map((item) => (
        <div key={item.id}>
          <strong>{item.title}</strong>
          <div className="mv-small mv-muted">{human(item.content_type)} · {item.source_organization ?? "Medveris"} · {item.publication_date ?? "—"}</div>
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
            <DataList items={dashboard.data.appointments.map((appointment) => ({ label: new Date(appointment.start_at).toLocaleString(), value: <>{appointment.reason} <Badge tone="info">{appointment.facility_name}</Badge></> }))} />
          )}
        </Card>
      </div>
      <div className="mv-grid mv-grid--2">
        <Card title="Follow-up instructions">
          {dashboard.loading ? <LoadingState /> : !dashboard.data?.followUps.length ? <EmptyState title="No pending follow-up" description="Your care team has not recorded a pending follow-up." /> : (
            <DataList items={dashboard.data.followUps.map((followUp) => ({ label: followUp.due_date, value: followUp.instructions ?? "Follow-up due" }))} />
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
  const roles = me?.activeTenant?.roles ?? [];
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

      {clinicianScope ? (
        <div className="mv-grid mv-grid--3">
          <Card title="My clinical day" description="Appointments assigned to you in the next day.">
            {clinicianDashboard.loading ? <LoadingState /> : clinicianDashboard.error ? <ErrorState message={clinicianDashboard.error} onRetry={clinicianDashboard.reload} /> : !clinicianDashboard.data?.appointments.length ? <EmptyState title="No assigned appointments" description="Your schedule is clear for the next day." /> : (
              <ul className="mv-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {clinicianDashboard.data.appointments.slice(0, 5).map((appointment) => (
                  <li key={appointment.id}><strong>{appointment.given_name} {appointment.family_name}</strong><div className="mv-small mv-muted">{new Date(appointment.start_at).toLocaleString()} · {appointment.reason}</div></li>
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
                  <li key={item.id} className="mv-spread"><span>{item.name}<div className="mv-small mv-muted">{item.given_name} {item.family_name} · <span className="mv-id">{item.public_id}</span></div></span><Badge tone={item.priority === "emergency" ? "danger" : item.priority === "urgent" ? "warning" : "neutral"}>{item.priority}</Badge></li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Specialty referrals" description="Pending referrals; diagnose and disposition are separate decisions.">
            {specialistDashboard.loading ? <LoadingState /> : !specialistDashboard.data?.specialtyReferrals.length ? <EmptyState title="No pending referrals" description="No referrals are pending for your specialty." /> : (
              <ul className="mv-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {specialistDashboard.data.specialtyReferrals.slice(0, 6).map((referral) => (
                  <li key={referral.id}><strong>{referral.given_name} {referral.family_name}</strong><div className="mv-small mv-muted">{referral.reason} · {referral.to_facility ?? "internal"} · <Badge tone="warning">{referral.priority}</Badge></div></li>
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
          <li>Terminology mode is synthetic and must be replaced by a licensed production adapter before standardized coding.</li>
          <li>PACS, laboratory, pharmacy, devices, telehealth, AI, payments and ledger anchoring are disabled.</li>
          <li>Local upload checks verify signatures only; no production malware scanner is configured.</li>
        </ul>
      </Card>
    </div>
  );
}
