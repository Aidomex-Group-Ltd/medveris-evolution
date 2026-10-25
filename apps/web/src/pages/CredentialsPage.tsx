import { useState, type FormEvent } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table } from "@medveris/ui";
import { api, errorMessage } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useQuery } from "../lib/useQuery";

interface CredentialRow {
  id: string;
  subjectType: string;
  credentialType: string;
  issuer: string;
  jurisdiction: string;
  scope: string | null;
  issuedOn: string;
  expiresOn: string;
  status: string;
  effectiveStatus: string;
  reviewedAt: string | null;
  decisionReason: string | null;
  createdAt: string;
}

export function CredentialsPage() {
  const { me } = useAuth();
  const mine = useQuery<{ credentials: CredentialRow[] }>("/credentials/mine");
  const admin = me?.activeTenant?.roles.includes("facility_admin");
  const facility = useQuery<{ credentials: CredentialRow[] }>("/credentials/facility", { enabled: admin });
  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Provider trust" title="Credentials" description="Submitted evidence is not verified evidence. Verification means an independent reviewer checked the stated evidence and expiry." />
      <SubmitCredential onSaved={mine.reload} />
      <Card title="My submissions">
        {mine.loading ? <LoadingState /> : mine.error ? <ErrorState message={mine.error} onRetry={mine.reload} /> : !mine.data?.credentials.length ? <EmptyState title="No submissions" description="You have not submitted credential evidence." /> : <CredentialTable rows={mine.data.credentials} />}
      </Card>
      {admin ? (
        <Card title="Facility credentials" description="Facility-level evidence only. A verified facility is not a claim that every practitioner is verified.">
          {facility.loading ? <LoadingState /> : facility.error ? <ErrorState message={facility.error} onRetry={facility.reload} /> : !facility.data?.credentials.length ? <EmptyState title="No facility credentials" description="No facility credential evidence has been submitted." /> : <CredentialTable rows={facility.data.credentials} />}
        </Card>
      ) : null}
    </div>
  );
}

function CredentialTable({ rows }: { rows: CredentialRow[] }) {
  return (
    <Table head={["Credential", "Subject", "Validity", "Status", "Decision"]}>
      {rows.map((row) => (
        <tr key={row.id}>
          <td><strong>{row.credentialType}</strong><div className="mv-small mv-muted">{row.issuer} · {row.jurisdiction}</div></td>
          <td>{row.subjectType}</td>
          <td className="mv-small">{row.issuedOn} → {row.expiresOn}</td>
          <td><Badge tone={row.effectiveStatus === "verified" ? "success" : row.effectiveStatus === "expired" || row.effectiveStatus === "rejected" ? "danger" : "warning"}>{row.effectiveStatus}</Badge></td>
          <td className="mv-small">{row.decisionReason ?? "Awaiting review"}</td>
        </tr>
      ))}
    </Table>
  );
}

function SubmitCredential({ onSaved }: { onSaved: () => void }) {
  const { me } = useAuth();
  const [subjectType, setSubjectType] = useState("practitioner");
  const [file, setFile] = useState<File | null>(null);
  const [credentialType, setCredentialType] = useState("Professional licence");
  const [issuer, setIssuer] = useState("");
  const [jurisdiction, setJurisdiction] = useState("Uganda");
  const [number, setNumber] = useState("");
  const [issuedOn, setIssuedOn] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [scope, setScope] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const dataBase64 = await fileToBase64(file);
      const upload = await api<{ upload: { id: string }; note: string }>("/uploads", { method: "POST", body: { filename: file.name, declaredType: file.type, dataBase64 } });
      await api("/credentials", {
        method: "POST",
        body: {
          subjectType,
          subjectUserId: subjectType === "practitioner" ? me?.user.id : null,
          subjectTenantId: subjectType === "facility" ? me?.activeTenant?.id : null,
          credentialType,
          issuer,
          jurisdiction,
          credentialNumber: number,
          scope,
          issuedOn,
          expiresOn,
          evidenceUploadId: upload.upload.id,
        },
      });
      setMessage(`Credential submitted with status pending. Evidence upload is available only through an authorized private path. ${upload.note}`);
      setFile(null);
      setNumber("");
      setIssuer("");
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Submit credential evidence" description="Private upload, signature check and a pending independent review. No automatic verification claim is made.">
      {error ? <ErrorState message={error} /> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      <form className="mv-stack" onSubmit={submit}>
        <div className="mv-form-grid">
          <Field label="Subject"><Select value={subjectType} onChange={(e) => setSubjectType(e.target.value)}><option value="practitioner">Practitioner (myself)</option><option value="facility">Facility</option></Select></Field>
          <Field label="Credential type" htmlFor="cred-type"><Input id="cred-type" value={credentialType} onChange={(e) => setCredentialType(e.target.value)} required /></Field>
        </div>
        <div className="mv-form-grid">
          <Field label="Issuer" htmlFor="cred-issuer"><Input id="cred-issuer" value={issuer} onChange={(e) => setIssuer(e.target.value)} required /></Field>
          <Field label="Jurisdiction" htmlFor="cred-jurisdiction"><Input id="cred-jurisdiction" value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} required /></Field>
        </div>
        <div className="mv-form-grid">
          <Field label="Credential number" htmlFor="cred-number"><Input id="cred-number" value={number} onChange={(e) => setNumber(e.target.value)} required /></Field>
          <Field label="Scope (optional)" htmlFor="cred-scope"><Input id="cred-scope" value={scope} onChange={(e) => setScope(e.target.value)} /></Field>
        </div>
        <div className="mv-form-grid">
          <Field label="Issued on"><Input type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} required /></Field>
          <Field label="Expires on"><Input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} required /></Field>
        </div>
        <Field label="Evidence file" hint="PDF, PNG or JPEG. Maximum 5 MB. Local signature validation only; production malware scanning is not configured.">
          <Input type="file" accept="application/pdf,image/png,image/jpeg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
        </Field>
        <Button type="submit" disabled={busy || !file}>{busy ? "Uploading…" : "Submit for review"}</Button>
      </form>
    </Card>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("Unable to read the selected file"));
    reader.readAsDataURL(file);
  });
}
