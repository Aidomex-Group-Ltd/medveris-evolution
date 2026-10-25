import { useState } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Table } from "@medveris/ui";
import { api, errorMessage } from "../lib/api";
import { useQuery } from "../lib/useQuery";
import type { ExchangeGrant } from "../lib/types";

interface ExchangeRecord {
  category: string;
  sourceFacility: string;
  resourceId: string;
  authorName: string;
  occurredAt: string;
  recordedAt: string;
  status: string;
  title: string;
  summary: string;
  payload: unknown;
}

export function ExchangePage() {
  const grants = useQuery<{ grants: ExchangeGrant[] }>("/exchange/grants");
  const [publicId, setPublicId] = useState("");
  const [grantId, setGrantId] = useState("");
  const [records, setRecords] = useState<ExchangeRecord[] | null>(null);
  const [patient, setPatient] = useState<{ publicId: string; givenName: string; familyName: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    setError(null);
    setRecords(null);
    try {
      const response = await api<{ patient: { publicId: string; givenName: string; familyName: string }; records: ExchangeRecord[] }>(`/exchange/patients/${encodeURIComponent(publicId.trim().toUpperCase())}/records?grantId=${grantId}`);
      setPatient(response.patient);
      setRecords(response.records);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const active = grants.data?.grants.filter((grant) => !grant.revokedAt && new Date(grant.expiresAt) > new Date()) ?? [];

  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Controlled exchange" title="Cross-facility records" description="Only a current patient consent grant permits a filtered, source-labelled projection. Ordinary facility queries cannot see other tenants." />
      {error ? <ErrorState message={error} /> : null}
      <div className="mv-grid mv-grid--2">
        <Card title="Open permitted records" description="Provide the exact public ID and select an active grant.">
          <div className="mv-stack">
            <Field label="Public patient ID" htmlFor="exchange-id"><Input id="exchange-id" value={publicId} onChange={(e) => setPublicId(e.target.value)} placeholder="MV-…" /></Field>
            <Field label="Consent grant">
              <select className="mv-input mv-select" value={grantId} onChange={(e) => setGrantId(e.target.value)}>
                <option value="">Select an active grant…</option>
                {active.map((grant) => <option key={grant.id} value={grant.id}>{grant.givenName} {grant.familyName} — {grant.publicId}</option>)}
              </select>
            </Field>
            <Button onClick={() => void load()} disabled={busy || !publicId.trim() || !grantId}>{busy ? "Checking grant…" : "Open permitted records"}</Button>
            {!active.length ? <Notice tone="warning">No active grants are addressed to this facility. The patient must authorize a scoped grant.</Notice> : null}
          </div>
        </Card>
        <Card title="Grant inventory" description="Grants are rechecked on every query; revocation blocks subsequent access.">
          {grants.loading ? <LoadingState /> : grants.error ? <ErrorState message={grants.error} onRetry={grants.reload} /> : !grants.data?.grants.length ? <EmptyState title="No grants" description="No patient has authorized this facility." /> : (
            <Table head={["Patient", "Scope", "Expires", "Status"]}>
              {grants.data.grants.map((grant) => (
                <tr key={grant.id}>
                  <td><strong>{grant.givenName} {grant.familyName}</strong><div className="mv-small mv-muted mv-id">{grant.publicId}</div></td>
                  <td className="mv-small">{grant.categories.join(", ")}<div className="mv-muted">{grant.purpose}</div></td>
                  <td className="mv-small">{new Date(grant.expiresAt).toLocaleDateString()}</td>
                  <td><Badge tone={grant.revokedAt ? "danger" : new Date(grant.expiresAt) < new Date() ? "warning" : "success"}>{grant.revokedAt ? "revoked" : new Date(grant.expiresAt) < new Date() ? "expired" : "active"}</Badge></td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
      {patient ? <Notice tone="success" title={`Exchange projection for ${patient.givenName} ${patient.familyName}`}>{records?.length ?? 0} permitted record(s). Source facilities retain ownership; edits remain impossible.</Notice> : null}
      {records ? (
        <Card title="Permitted records" description="Every access is audited. Sensitivity exclusions are applied server-side.">
          {!records.length ? <EmptyState title="No permitted records" description="The grant covers no currently available records in the selected categories." /> : (
            <div className="mv-stack">
              {records.map((record) => (
                <article key={`${record.category}-${record.resourceId}`} className="mv-note">
                  <div className="mv-spread"><strong>{record.title}</strong><div className="mv-row"><Badge tone="info">{record.category}</Badge><Badge tone="neutral">{record.status}</Badge></div></div>
                  <div className="mv-small mv-muted">{record.sourceFacility} · {record.authorName} · clinical {new Date(record.occurredAt).toLocaleString()} · recorded {new Date(record.recordedAt).toLocaleString()}</div>
                  {record.summary ? <p className="mv-pre" style={{ marginTop: 6 }}>{record.summary}</p> : null}
                </article>
              ))}
            </div>
          )}
        </Card>
      ) : null}
    </div>
  );
}
