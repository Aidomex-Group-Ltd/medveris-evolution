import { useMemo, useState, type FormEvent } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Textarea } from "@medveris/ui";
import { api, errorMessage } from "../lib/api";
import { useQuery } from "../lib/useQuery";
import type { ConsentRow, PatientPortalProfile } from "../lib/types";

const CATEGORIES = ["note", "observation", "condition", "allergy", "follow-up", "referral", "encounter"];

export function ConsentPage() {
  const profile = useQuery<PatientPortalProfile>("/me/patient");
  const consents = useQuery<{ consents: ConsentRow[] }>("/me/consents");
  const facilities = useQuery<{ facilities: Array<{ id: string; name: string; facilityType: string; city: string | null }> }>("/public/facilities");
  const [recipient, setRecipient] = useState("");
  const [sources, setSources] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>(["note", "observation", "condition", "allergy"]);
  const [purpose, setPurpose] = useState("Continuity of outpatient care");
  const [legalBasis, setLegalBasis] = useState("patient-consent");
  const [evidence, setEvidence] = useState("Patient selected this facility and scope in the portal");
  const [days, setDays] = useState("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const releasedLinks = useMemo(() => profile.data?.facilityLinks.filter((link) => link.releaseSignedRecords) ?? [], [profile.data]);
  const recipientOptions = facilities.data?.facilities.filter((facility) => !releasedLinks.some((link) => link.tenantId === facility.id)) ?? [];

  async function grant(event: FormEvent) {
    event.preventDefault();
    if (!profile.data) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const startsAt = new Date();
      const expiresAt = new Date(startsAt.getTime() + Math.max(1, Number(days)) * 24 * 60 * 60 * 1000);
      await api(`/patients/${profile.data.patient.id}/consents`, {
        method: "POST",
        body: {
          patientId: profile.data.patient.id,
          recipientTenantId: recipient,
          sourceTenantIds: sources,
          categories,
          purpose,
          legalBasis,
          authorizationEvidence: evidence,
          startsAt: startsAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          sensitivityExclusions: [],
        },
      });
      setMessage("Consent recorded. The recipient facility can now request only the permitted categories for the stated period.");
      consents.reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    const reason = window.prompt("Reason for revoking this consent (minimum 5 characters):");
    if (!reason || reason.trim().length < 5) return;
    setError(null);
    try {
      await api(`/consents/${id}/revoke`, { method: "POST", body: { reason } });
      setMessage("Consent revoked. Subsequent exchange requests and pending deliveries must be denied.");
      consents.reload();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Patient portal" title="Consent and record sharing" description="Consent is scoped by recipient, source facility, category, purpose and time. Revocation is checked again at delivery." />
      {error ? <ErrorState message={error} /> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      <div className="mv-grid mv-grid--2">
        <Card title="Grant scoped access" description="Recipient facilities never gain edit rights over another source's signed records.">
          {!releasedLinks.length ? <Notice tone="warning" title="No released source facility">A source facility must release your signed records before you can authorize exchange.</Notice> : (
            <form className="mv-stack" onSubmit={grant}>
              <Field label="Recipient facility">
                <Select value={recipient} onChange={(e) => setRecipient(e.target.value)} required>
                  <option value="">Select facility…</option>
                  {recipientOptions.map((facility) => <option key={facility.id} value={facility.id}>{facility.name}{facility.city ? ` — ${facility.city}` : ""}</option>)}
                </Select>
              </Field>
              <fieldset className="mv-note">
                <legend className="mv-field__label">Source facilities</legend>
                {releasedLinks.map((link) => (
                  <label key={link.tenantId} className="mv-row" style={{ marginBottom: 6 }}>
                    <input type="checkbox" checked={sources.includes(link.tenantId)} onChange={(e) => setSources((current) => e.target.checked ? [...current, link.tenantId] : current.filter((id) => id !== link.tenantId))} />
                    {link.tenantName}
                  </label>
                ))}
              </fieldset>
              <fieldset className="mv-note">
                <legend className="mv-field__label">Record categories</legend>
                <div className="mv-form-grid">
                  {CATEGORIES.map((category) => (
                    <label key={category} className="mv-row"><input type="checkbox" checked={categories.includes(category)} onChange={(e) => setCategories((current) => e.target.checked ? [...current, category] : current.filter((value) => value !== category))} />{category}</label>
                  ))}
                </div>
              </fieldset>
              <Field label="Purpose" htmlFor="purpose"><Input id="purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} required minLength={5} /></Field>
              <div className="mv-form-grid">
                <Field label="Legal basis"><Select value={legalBasis} onChange={(e) => setLegalBasis(e.target.value)}><option value="patient-consent">Patient consent</option><option value="continuing-care">Continuing care</option><option value="statutory">Statutory obligation</option><option value="emergency">Emergency</option></Select></Field>
                <Field label="Duration (days)" htmlFor="days"><Input id="days" type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} required /></Field>
              </div>
              <Field label="Authorization evidence" htmlFor="evidence"><Textarea id="evidence" value={evidence} onChange={(e) => setEvidence(e.target.value)} required minLength={5} /></Field>
              <Button type="submit" disabled={busy || !recipient || !sources.length || !categories.length}>{busy ? "Recording…" : "Grant scoped access"}</Button>
            </form>
          )}
        </Card>
        <Card title="How sharing is enforced" description="Patient safety and source ownership limits are not optional.">
          <ul className="mv-small mv-muted" style={{ paddingLeft: 18, lineHeight: 1.8 }}>
            <li>The recipient must be a different active facility.</li>
            <li>Only categories you select are projected, with source labels.</li>
            <li>The recipient cannot amend or delete the source facility's records.</li>
            <li>Revocation takes effect for subsequent queries and pending deliveries.</li>
            <li>Break-glass access is separate and requires reason, reauthentication and review.</li>
          </ul>
        </Card>
      </div>

      <Card title="Consent history" description="Active and historical grants; revoked grants remain visible.">
        {consents.loading ? <LoadingState /> : consents.error ? <ErrorState message={consents.error} onRetry={consents.reload} /> : !consents.data?.consents.length ? <EmptyState title="No consents" description="You have not authorized any facility exchange." /> : (
          <Table head={["Recipient", "Sources", "Scope", "Period", "Status", ""]} caption="Consent history">
            {consents.data.consents.map((consent) => (
              <tr key={consent.id}>
                <td><strong>{consent.recipientFacility}</strong><div className="mv-small mv-muted">{consent.purpose}</div></td>
                <td>{consent.sourceFacilities?.join(", ") ?? consent.sourceTenantIds.length}</td>
                <td>{consent.categories.join(", ")}</td>
                <td className="mv-small">{new Date(consent.startsAt).toLocaleDateString()} → {new Date(consent.expiresAt).toLocaleDateString()}</td>
                <td>{consent.revokedAt ? <Badge tone="danger">revoked</Badge> : new Date(consent.expiresAt) < new Date() ? <Badge tone="warning">expired</Badge> : <Badge tone="success">active</Badge>}</td>
                <td>{!consent.revokedAt && new Date(consent.expiresAt) >= new Date() ? <Button variant="danger" size="sm" onClick={() => void revoke(consent.id)}>Revoke</Button> : null}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
