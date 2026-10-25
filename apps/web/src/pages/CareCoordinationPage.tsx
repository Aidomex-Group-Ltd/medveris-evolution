import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card, EmptyState, ErrorState, Field, LoadingState, Notice, PageHeader, Select, Table, Tabs, Textarea } from "@medveris/ui";
import { api, errorMessage } from "../lib/api";
import { formatDate, formatDateTime } from "../lib/format";
import { useQuery } from "../lib/useQuery";

interface FollowUp {
  id: string;
  encounterId: string;
  dueDate: string;
  instructions: string;
  status: string;
  version: number;
  statusNote: string | null;
  statusChangedAt: string | null;
  overdue: boolean;
  publicId: string;
  givenName: string;
  familyName: string;
  authorName: string | null;
}

interface Referral {
  id: string;
  encounterId: string;
  toFacility: string;
  reason: string;
  priority: string;
  status: string;
  version: number;
  statusNote: string | null;
  statusChangedAt: string | null;
  createdAt: string;
  publicId: string;
  givenName: string;
  familyName: string;
  authorName: string | null;
}

interface ActionTarget {
  kind: "follow-up" | "referral";
  id: string;
  status: string;
  version: number;
  patient: string;
  context: string;
}

const statusTone = (status: string) =>
  status === "completed" || status === "accepted" ? "success"
    : status === "cancelled" || status === "declined" ? "neutral"
      : "warning";

export function CareCoordinationPage() {
  const [tab, setTab] = useState<"follow-ups" | "referrals">("follow-ups");
  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow="Clinical coordination"
        title="Follow-ups and referrals"
        description="Record local completion and referral-tracking decisions. Referral status is not a transmission receipt from an external facility."
      />
      <Notice tone="info" title="Local tracking only">
        No referral is sent to another facility by this page. Status changes describe what staff recorded locally; they are audited and versioned.
      </Notice>
      <Tabs label="Care coordination sections" value={tab} onChange={setTab} options={[
        { value: "follow-ups", label: "Follow-ups" },
        { value: "referrals", label: "Referrals" },
      ]} />
      {tab === "follow-ups" ? <FollowUps /> : <Referrals />}
    </div>
  );
}

function FollowUps() {
  const [status, setStatus] = useState("pending");
  const [due, setDue] = useState("all");
  const followUps = useQuery<{ followUps: FollowUp[] }>(`/care/follow-ups?status=${status}&due=${due}`);
  const [target, setTarget] = useState<ActionTarget | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="mv-stack">
      {message ? <Notice tone="success">{message}</Notice> : null}
      {target ? (
        <StatusPanel
          target={target}
          onCancel={() => setTarget(null)}
          onSaved={() => {
            setMessage(`Follow-up marked ${target.status}.`);
            setTarget(null);
            followUps.reload();
          }}
        />
      ) : null}
      <Card
        title="Follow-up worklist"
        description="Overdue pending follow-ups are shown first. Completing a follow-up records a local clinical decision; it does not create a new encounter automatically."
        actions={<div className="mv-row">
          <Select aria-label="Filter follow-ups by due date" value={due} onChange={(event) => setDue(event.target.value)}>
            <option value="all">All dates</option>
            <option value="overdue">Overdue</option>
            <option value="upcoming">Upcoming</option>
          </Select>
          <Select aria-label="Filter follow-ups by status" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="pending">Pending</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
            <option value="all">All statuses</option>
          </Select>
        </div>}
      >
        {followUps.loading ? <LoadingState /> : followUps.error ? <ErrorState message={followUps.error} onRetry={followUps.reload} /> : !followUps.data?.followUps.length ? <EmptyState title="No follow-ups" description="No follow-ups match the selected filters." /> : (
          <Table head={["Patient", "Due", "Instructions", "Source encounter", "Status", ""]} caption="Follow-up worklist">
            {followUps.data.followUps.map((row) => (
              <tr key={row.id}>
                <td><strong>{row.givenName} {row.familyName}</strong><div className="mv-small mv-muted mv-id">{row.publicId}</div></td>
                <td>
                  {formatDate(row.dueDate)}
                  {row.overdue ? <div><Badge tone="danger">overdue</Badge></div> : null}
                </td>
                <td>{row.instructions}<div className="mv-small mv-muted">By {row.authorName ?? "unknown author"}</div></td>
                <td><Link to={`/encounters/${row.encounterId}`}>Open encounter</Link></td>
                <td>
                  <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                  {row.statusNote ? <div className="mv-small mv-muted">{row.statusNote}</div> : null}
                  {row.statusChangedAt ? <div className="mv-small mv-muted">{formatDateTime(row.statusChangedAt)}</div> : null}
                </td>
                <td>
                  {row.status === "pending" ? (
                    <div className="mv-row">
                      <Button size="sm" onClick={() => setTarget({ kind: "follow-up", id: row.id, status: "completed", version: row.version, patient: `${row.givenName} ${row.familyName}`, context: row.instructions })}>Complete</Button>
                      <Button size="sm" variant="secondary" onClick={() => setTarget({ kind: "follow-up", id: row.id, status: "cancelled", version: row.version, patient: `${row.givenName} ${row.familyName}`, context: row.instructions })}>Cancel</Button>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function Referrals() {
  const [status, setStatus] = useState("pending");
  const referrals = useQuery<{ referrals: Referral[] }>(`/care/referrals?status=${status}`);
  const [target, setTarget] = useState<ActionTarget | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function targetFor(row: Referral, next: string): ActionTarget {
    return {
      kind: "referral",
      id: row.id,
      status: next,
      version: row.version,
      patient: `${row.givenName} ${row.familyName}`,
      context: `${row.toFacility}: ${row.reason}`,
    };
  }

  return (
    <div className="mv-stack">
      {message ? <Notice tone="success">{message}</Notice> : null}
      {target ? (
        <StatusPanel
          target={target}
          onCancel={() => setTarget(null)}
          onSaved={() => {
            setMessage(`Referral marked ${target.status}. No external transmission was performed.`);
            setTarget(null);
            referrals.reload();
          }}
        />
      ) : null}
      <Card
        title="Referral tracking"
        description="Priority is shown first. Accepting or declining records a local staff decision, not a message from the receiving facility."
        actions={<Select aria-label="Filter referrals by status" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="pending">Pending</option>
          <option value="accepted">Accepted</option>
          <option value="declined">Declined</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
          <option value="all">All statuses</option>
        </Select>}
      >
        {referrals.loading ? <LoadingState /> : referrals.error ? <ErrorState message={referrals.error} onRetry={referrals.reload} /> : !referrals.data?.referrals.length ? <EmptyState title="No referrals" description="No referrals match the selected status." /> : (
          <Table head={["Patient", "Destination", "Reason", "Priority", "Status", ""]} caption="Referral tracking">
            {referrals.data.referrals.map((row) => (
              <tr key={row.id}>
                <td><strong>{row.givenName} {row.familyName}</strong><div className="mv-small mv-muted mv-id">{row.publicId}</div></td>
                <td>{row.toFacility}<div className="mv-small mv-muted"><Link to={`/encounters/${row.encounterId}`}>Open encounter</Link></div></td>
                <td>{row.reason}<div className="mv-small mv-muted">By {row.authorName ?? "unknown author"} · {formatDateTime(row.createdAt)}</div></td>
                <td><Badge tone={row.priority === "emergency" ? "danger" : row.priority === "urgent" ? "warning" : "neutral"}>{row.priority}</Badge></td>
                <td>
                  <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                  {row.statusNote ? <div className="mv-small mv-muted">{row.statusNote}</div> : null}
                  {row.statusChangedAt ? <div className="mv-small mv-muted">{formatDateTime(row.statusChangedAt)}</div> : null}
                </td>
                <td>
                  <div className="mv-row">
                    {row.status === "pending" ? <Button size="sm" onClick={() => setTarget(targetFor(row, "accepted"))}>Accept locally</Button> : null}
                    {row.status === "pending" ? <Button size="sm" variant="secondary" onClick={() => setTarget(targetFor(row, "declined"))}>Decline</Button> : null}
                    {row.status === "pending" || row.status === "accepted" ? <Button size="sm" variant="secondary" onClick={() => setTarget(targetFor(row, "completed"))}>Complete</Button> : null}
                    {row.status === "pending" || row.status === "accepted" ? <Button size="sm" variant="ghost" onClick={() => setTarget(targetFor(row, "cancelled"))}>Cancel</Button> : null}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function StatusPanel({ target, onCancel, onSaved }: { target: ActionTarget; onCancel: () => void; onSaved: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind = target.kind === "follow-up" ? "follow-ups" : "referrals";

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/care/${kind}/${target.id}/status`, {
        method: "POST",
        body: { status: target.status, note, expectedVersion: target.version },
      });
      setNote("");
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={`Record ${target.kind} ${target.status}`} description={`${target.patient} · ${target.context}`}>
      {error ? <ErrorState message={error} /> : null}
      <form className="mv-stack" onSubmit={submit}>
        <Field label="Decision note" htmlFor="care-status-note" hint="Minimum five characters. This note is audited.">
          <Textarea id="care-status-note" value={note} onChange={(event) => setNote(event.target.value)} required minLength={5} maxLength={2000} />
        </Field>
        <div className="mv-row">
          <Button type="submit" disabled={busy || note.trim().length < 5}>{busy ? "Saving…" : "Save status"}</Button>
          <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}
