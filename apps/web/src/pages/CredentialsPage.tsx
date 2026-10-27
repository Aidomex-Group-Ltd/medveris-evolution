import { useState, type FormEvent } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Textarea } from "@medveris/ui";
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

interface FacilityQueueRow {
  id: string; credentialType: string; issuer: string; jurisdiction: string;
  regulatorCode: string | null; registrationNumber: string | null; licenceNumber: string | null;
  credentialNumber: string; qualifications: string | null; specialtyCredentials: string[];
  scope: string | null; issuedOn: string; expiresOn: string; status: string;
  verificationMethod: string; verificationSource: string | null; createdAt: string;
  onboardingCaseId: string; subjectName: string | null; subjectEmail: string | null;
  onboardingPath: string | null; evidenceUploadIds: string[] | null;
}

export function CredentialsPage() {
  const { me } = useAuth();
  const mine = useQuery<{ credentials: CredentialRow[] }>("/credentials/mine");
  const roles = me?.activeTenant?.roles ?? [];
  const admin = roles.includes("facility_admin");
  const reviewer = admin || roles.includes("hr");
  const facility = useQuery<{ credentials: CredentialRow[] }>("/credentials/facility", { enabled: admin });
  const queue = useQuery<{ queue: FacilityQueueRow[] }>("/credentials/facility/queue", { enabled: reviewer });
  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Provider trust" title="Credentials" description="Submitted evidence is not verified evidence. Verification means an independent reviewer checked the stated evidence and expiry. No regulator integration is configured." />
      <SubmitCredential onSaved={mine.reload} />
      <Card title="My submissions">
        {mine.loading ? <LoadingState /> : mine.error ? <ErrorState message={mine.error} onRetry={mine.reload} /> : !mine.data?.credentials.length ? <EmptyState title="No submissions" description="You have not submitted credential evidence." /> : <CredentialTable rows={mine.data.credentials} />}
      </Card>
      {reviewer ? <FacilityReviewQueue rows={queue.data?.queue ?? []} loading={queue.loading} error={queue.error} onReload={queue.reload} /> : null}
      {admin ? (
        <Card title="Facility credentials" description="Facility-level evidence only. A verified facility is not a claim that every practitioner is verified.">
          {facility.loading ? <LoadingState /> : facility.error ? <ErrorState message={facility.error} onRetry={facility.reload} /> : !facility.data?.credentials.length ? <EmptyState title="No facility credentials" description="No facility credential evidence has been submitted." /> : <CredentialTable rows={facility.data.credentials} />}
        </Card>
      ) : null}
    </div>
  );
}

function FacilityReviewQueue({ rows, loading, error, onReload }: { rows: FacilityQueueRow[]; loading: boolean; error: string | null; onReload: () => void }) {
  const [selected, setSelected] = useState("");
  const [decision, setDecision] = useState<"verified" | "rejected" | "suspended" | "expired">("verified");
  const [reason, setReason] = useState("");
  const [checksPerformed, setChecksPerformed] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const selectedRow = rows.find((row) => row.id === selected) ?? null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!selectedRow) return;
    setBusy(true);
    setFailure(null);
    setMessage(null);
    try {
      const result = await api<{ publicClaim: string; notice: string }>(`/credentials/${selectedRow.id}/facility-decision`, {
        method: "POST",
        body: { decision, reason, checksPerformed, expiresOn: selectedRow.expiresOn },
      });
      setMessage(`${result.publicClaim} ${result.notice}`);
      setSelected("");
      setReason("");
      setChecksPerformed("");
      onReload();
    } catch (cause) {
      setFailure(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Onboarding credentials awaiting facility review" description="Manual-first review. A document upload does not prove a licence is valid. Record exactly which authority or approved source you checked.">
      {failure ? <ErrorState message={failure} /> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      {loading ? <LoadingState /> : error ? <ErrorState message={error} onRetry={onReload} /> : !rows.length ? <EmptyState title="No credentials awaiting review" description="Credentials attached to this facility's onboarding cases appear here." /> : (
        <Table head={["Subject", "Credential", "Identifiers", "Evidence", "Status"]} caption="Facility credential review queue">
          {rows.map((row) => (
            <tr key={row.id}>
              <td><strong>{row.subjectName ?? "Unnamed staff"}</strong><div className="mv-small mv-muted">{row.subjectEmail ?? "—"} · {row.onboardingPath ?? "onboarding"}</div></td>
              <td><strong>{row.credentialType}</strong><div className="mv-small mv-muted">{row.issuer} · {row.jurisdiction}</div><div className="mv-small mv-muted">{row.qualifications ?? "No qualifications recorded"}</div></td>
              <td className="mv-small">
                <div>Regulator: {row.regulatorCode ?? "—"}</div>
                <div>Registration: {row.registrationNumber ?? "—"}</div>
                <div>Licence: {row.licenceNumber ?? row.credentialNumber}</div>
                <div>Expires: {row.expiresOn}</div>
              </td>
              <td>{row.evidenceUploadIds?.length ? <Badge tone="info">{row.evidenceUploadIds.length} document(s)</Badge> : <Badge tone="warning">No document</Badge>}</td>
              <td><Badge tone="warning">{row.status}</Badge><div className="mv-small mv-muted">{row.verificationMethod}</div></td>
            </tr>
          ))}
        </Table>
      )}
      {rows.length ? (
        <form className="mv-stack" onSubmit={submit} style={{ marginTop: 16 }}>
          <Field label="Credential">
            <Select value={selected} onChange={(event) => setSelected(event.target.value)} required>
              <option value="">Select a credential…</option>
              {rows.map((row) => <option key={row.id} value={row.id}>{row.subjectName ?? row.id} — {row.credentialType}</option>)}
            </Select>
          </Field>
          <Field label="Decision">
            <Select value={decision} onChange={(event) => setDecision(event.target.value as typeof decision)}>
              <option value="verified">Verified after manual check</option>
              <option value="rejected">Rejected</option>
              <option value="suspended">Suspended</option>
              <option value="expired">Expired</option>
            </Select>
          </Field>
          <Field label="Checks performed" hint="Required for verification. Name the regulator or approved source and what you checked.">
            <Textarea value={checksPerformed} onChange={(event) => setChecksPerformed(event.target.value)} />
          </Field>
          <Field label="Reason" hint="At least 10 characters. Stored in the append-only review history and audit trail.">
            <Textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={10} required />
          </Field>
          <Button type="submit" disabled={busy || !selected || reason.trim().length < 10 || (decision === "verified" && checksPerformed.trim().length < 5)}>
            {busy ? "Recording…" : "Record facility decision"}
          </Button>
        </form>
      ) : null}
    </Card>
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
  const [regulatorCode, setRegulatorCode] = useState("");
  const [registrationNumber, setRegistrationNumber] = useState("");
  const [licenceNumber, setLicenceNumber] = useState("");
  const [qualifications, setQualifications] = useState("");
  const [onboardingCaseId, setOnboardingCaseId] = useState("");
  const [number, setNumber] = useState("");
  const [issuedOn, setIssuedOn] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [scope, setScope] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      let evidenceUploadId: string | undefined;
      let uploadNote = "No supporting document was attached. A reviewer must verify the licence with the authority before any verified status.";
      if (file) {
        const dataBase64 = await fileToBase64(file);
        const upload = await api<{ upload: { id: string }; note: string }>("/uploads", { method: "POST", body: { filename: file.name, declaredType: file.type, dataBase64 } });
        evidenceUploadId = upload.upload.id;
        uploadNote = upload.note;
      }
      await api("/credentials", {
        method: "POST",
        body: {
          subjectType,
          subjectUserId: subjectType === "practitioner" ? me?.user.id : null,
          subjectTenantId: subjectType === "facility" ? me?.activeTenant?.id : null,
          onboardingCaseId: onboardingCaseId || null,
          credentialType,
          issuer,
          jurisdiction,
          regulatorCode,
          registrationNumber,
          licenceNumber,
          credentialNumber: number,
          qualifications,
          specialtyCredentials: [],
          scope,
          issuedOn,
          expiresOn,
          evidenceUploadId: evidenceUploadId ?? null,
        },
      });
      setMessage(`Credential submitted with status pending. A document upload or self-declaration does not prove a licence is valid. ${uploadNote}`);
      setFile(null);
      setNumber("");
      setIssuer("");
      setRegistrationNumber("");
      setLicenceNumber("");
      setQualifications("");
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
          <Field label="Regulator code (optional)" htmlFor="cred-regulator" hint="For example the council or board code, kept separate from the licence number."><Input id="cred-regulator" value={regulatorCode} onChange={(e) => setRegulatorCode(e.target.value)} /></Field>
          <Field label="Registration number (optional)" htmlFor="cred-registration"><Input id="cred-registration" value={registrationNumber} onChange={(e) => setRegistrationNumber(e.target.value)} /></Field>
        </div>
        <div className="mv-form-grid">
          <Field label="Licence number (optional)" htmlFor="cred-licence"><Input id="cred-licence" value={licenceNumber} onChange={(e) => setLicenceNumber(e.target.value)} /></Field>
          <Field label="Credential number" htmlFor="cred-number"><Input id="cred-number" value={number} onChange={(e) => setNumber(e.target.value)} required /></Field>
        </div>
        <div className="mv-form-grid">
          <Field label="Qualifications (optional)" htmlFor="cred-qualifications"><Input id="cred-qualifications" value={qualifications} onChange={(e) => setQualifications(e.target.value)} /></Field>
          <Field label="Scope (optional)" htmlFor="cred-scope"><Input id="cred-scope" value={scope} onChange={(e) => setScope(e.target.value)} /></Field>
        </div>
        <Field label="Onboarding case (optional)" htmlFor="cred-onboarding" hint="Attach this credential to an onboarding case at your facility for facility review.">
          <Input id="cred-onboarding" value={onboardingCaseId} onChange={(e) => setOnboardingCaseId(e.target.value)} placeholder="Onboarding case identifier" />
        </Field>
        <div className="mv-form-grid">
          <Field label="Issued on"><Input type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} required /></Field>
          <Field label="Expires on"><Input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} required /></Field>
        </div>
        <Field label="Evidence file (optional)" hint="PDF, PNG or JPEG. Maximum 5 MB. Local signature validation only; production malware scanning is not configured. Manual verification still requires an attached document.">
          <Input type="file" accept="application/pdf,image/png,image/jpeg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        <Button type="submit" disabled={busy}>{busy ? "Submitting…" : "Submit for review"}</Button>
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
