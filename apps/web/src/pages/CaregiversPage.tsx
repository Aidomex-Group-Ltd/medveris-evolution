import { useState, type FormEvent } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Table, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDateTime } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";

const SCOPES = [
  { code: "profile", label: "Profile details" },
  { code: "appointments", label: "Appointments" },
  { code: "records", label: "Clinical records" },
  { code: "consent", label: "Consent decisions" },
] as const;

interface PatientProxy {
  id: string; proxyName: string; proxyEmail: string; relationship: string; scopes: string[];
  status: string; startsAt: string | null; expiresAt: string | null; reviewedAt: string | null;
  decisionReason: string | null; createdAt: string;
}
interface QueueProxy {
  id: string; patientId: string; publicId: string; givenName: string; familyName: string;
  proxyName: string; proxyEmail: string; relationship: string; scopes: string[];
  expiresAt: string | null; createdAt: string;
}

const toneFor = (status: string) =>
  status === "active" ? "success" : status === "requested" ? "warning" : status === "rejected" ? "danger" : "neutral";

export function CaregiversPage() {
  const { me } = useAuth();
  const patientView = Boolean(me?.patientId);
  const mine = useQuery<{ proxies: PatientProxy[] }>(patientView ? "/onboarding/proxies" : null);
  const queue = useQuery<{ requests: QueueProxy[] }>(patientView ? null : "/onboarding/proxies/queue");
  const action = useAction();
  const [email, setEmail] = useState("");
  const [relationship, setRelationship] = useState("Next of kin");
  const [scopes, setScopes] = useState<string[]>(["profile", "appointments"]);
  const [expiresAt, setExpiresAt] = useState("");
  const [reasons, setReasons] = useState<Record<string, string>>({});

  function toggleScope(code: string) {
    setScopes((current) => current.includes(code) ? current.filter((item) => item !== code) : [...current, code]);
  }

  async function invite(event: FormEvent) {
    event.preventDefault();
    await action.run("invite", async () => {
      await api("/onboarding/proxies/requests", {
        method: "POST",
        body: { proxyEmail: email.trim(), relationship: relationship.trim(), scopes, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null },
      });
      setEmail("");
      setExpiresAt("");
      mine.reload();
      return "Caregiver request created. It stays inactive until it is approved.";
    });
  }

  async function decide(id: string, decision: "approve" | "reject") {
    await action.run(`${id}-${decision}`, async () => {
      await api(`/onboarding/proxies/${id}/decision`, { method: "POST", body: { decision, reason: reasons[id] ?? "" } });
      queue.reload();
      return decision === "approve" ? "Caregiver access approved." : "Caregiver request rejected.";
    });
  }

  const active = patientView ? mine : queue;
  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow="Caregivers"
        title={patientView ? "Your caregiver access" : "Caregiver request queue"}
        description={patientView
          ? "Invite someone you trust and choose exactly which parts of your record they may see. You can revoke access at any time."
          : "Review caregiver requests for patients linked to this facility. A decision is recorded in the audit trail with your reason."}
      />
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      {active.loading ? <LoadingState /> : active.error ? <ErrorState message={active.error} onRetry={active.reload} /> : null}

      {patientView ? (
        <div className="mv-stack">
          <Card title="Invite a caregiver" description="The person must already have an active Medveris account. Requests never grant access automatically.">
            <form className="mv-stack" onSubmit={invite}>
              <div className="mv-grid mv-grid--2">
                <Field label="Caregiver email" htmlFor="proxy-email" hint="We match the address to an existing account.">
                  <Input id="proxy-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
                </Field>
                <Field label="Relationship" htmlFor="proxy-relationship">
                  <Input id="proxy-relationship" value={relationship} onChange={(event) => setRelationship(event.target.value)} required />
                </Field>
                <Field label="Expires on (optional)" htmlFor="proxy-expiry">
                  <Input id="proxy-expiry" type="date" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
                </Field>
              </div>
              <fieldset className="mv-field">
                <legend className="mv-field__label">Scopes</legend>
                <div className="mv-row" style={{ flexWrap: "wrap", gap: 12 }}>
                  {SCOPES.map((scope) => (
                    <label key={scope.code} className="mv-row" style={{ gap: 6 }}>
                      <input type="checkbox" checked={scopes.includes(scope.code)} onChange={() => toggleScope(scope.code)} />
                      <span>{scope.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <Button type="submit" disabled={action.busy !== null || !email.trim() || scopes.length === 0}>
                {action.busy === "invite" ? "Sending…" : "Send caregiver request"}
              </Button>
            </form>
          </Card>
          <Card title="Caregivers">
            {!mine.data?.proxies.length ? <EmptyState title="No caregivers yet" description="Invite a trusted person to help manage your appointments or records." /> : (
              <Table head={["Caregiver", "Relationship", "Scopes", "Status", "Expires", "Created"]} caption="Your caregiver links">
                {mine.data.proxies.map((row) => (
                  <tr key={row.id}>
                    <td><strong>{row.proxyName}</strong><div className="mv-small mv-muted">{row.proxyEmail}</div></td>
                    <td>{row.relationship}</td>
                    <td className="mv-small">{row.scopes.join(", ")}</td>
                    <td><Badge tone={toneFor(row.status)}>{row.status}</Badge></td>
                    <td className="mv-small">{row.expiresAt ? formatDateTime(row.expiresAt) : "No expiry"}</td>
                    <td className="mv-small">{formatDateTime(row.createdAt)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>
      ) : (
        <Card title="Pending requests" description="Approve only when you can confirm the patient's intent and the caregiver's identity.">
          {!queue.data?.requests.length ? <EmptyState title="No pending requests" description="Caregiver requests linked to your facility will appear here." /> : (
            <div className="mv-stack">
              {queue.data.requests.map((row) => {
                const reason = reasons[row.id] ?? "";
                return (
                  <Card key={row.id} title={`${row.givenName} ${row.familyName}`} description={`${row.publicId} · ${row.relationship}`}>
                    <div className="mv-grid mv-grid--3">
                      <div><div className="mv-small mv-muted">Caregiver</div><div>{row.proxyName}</div><div className="mv-small mv-muted">{row.proxyEmail}</div></div>
                      <div><div className="mv-small mv-muted">Requested scopes</div><div className="mv-small">{row.scopes.join(", ")}</div></div>
                      <div><div className="mv-small mv-muted">Requested</div><div className="mv-small">{formatDateTime(row.createdAt)}</div></div>
                    </div>
                    <Field label="Decision reason" htmlFor={`reason-${row.id}`} hint="At least 10 characters; stored with the audit event.">
                      <Textarea id={`reason-${row.id}`} value={reason} onChange={(event) => setReasons((current) => ({ ...current, [row.id]: event.target.value }))} rows={2} />
                    </Field>
                    <div className="mv-row" style={{ gap: 8 }}>
                      <Button disabled={action.busy !== null || reason.trim().length < 10} onClick={() => void decide(row.id, "approve")}>
                        {action.busy === `${row.id}-approve` ? "Approving…" : "Approve access"}
                      </Button>
                      <Button variant="danger" disabled={action.busy !== null || reason.trim().length < 10} onClick={() => void decide(row.id, "reject")}>
                        {action.busy === `${row.id}-reject` ? "Rejecting…" : "Reject request"}
                      </Button>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
