import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table } from "@medveris/ui";
import { api, errorMessage } from "../lib/api";
import { useQuery } from "../lib/useQuery";
import type { PatientSummary } from "../lib/types";

interface RecentResponse { patients: PatientSummary[] }
interface RegisterResponse { patient: { patientId: string; publicId: string; duplicateReviewQueued: number } }
interface ResolveResponse { matched: boolean; patient: PatientSummary | null; message?: string }
interface SearchResponse { patients: Array<PatientSummary & { localMrn: string | null }>; hasMore: boolean; offset: number; limit: number }

const SEARCH_PAGE_SIZE = 25;

export function PatientsPage() {
  const navigate = useNavigate();
  const recent = useQuery<RecentResponse>("/patients/recent");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [resolved, setResolved] = useState<PatientSummary | null>(null);
  const [reason, setReason] = useState("Outpatient consultation");
  const [noMatch, setNoMatch] = useState<string | null>(null);
  // Stable per selected patient and reason, so a double click or retry cannot open two encounters.
  const encounterKey = useRef(crypto.randomUUID());
  useEffect(() => {
    encounterKey.current = crypto.randomUUID();
  }, [resolved?.id, reason]);
  const [search, setSearch] = useState<{ q: string; dateOfBirth: string; offset: number } | null>(null);
  const [searchResult, setSearchResult] = useState<SearchResponse | null>(null);

  async function runSearch(next: { q: string; dateOfBirth: string; offset: number }) {
    setBusy("search");
    setError(null);
    try {
      const params = new URLSearchParams({ q: next.q, limit: String(SEARCH_PAGE_SIZE), offset: String(next.offset) });
      if (next.dateOfBirth) params.set("dateOfBirth", next.dateOfBirth);
      setSearchResult(await api<SearchResponse>(`/patients/search?${params.toString()}`));
      setSearch(next);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void runSearch({ q: String(data.get("q") ?? "").trim(), dateOfBirth: String(data.get("searchDob") ?? ""), offset: 0 });
  }

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("register");
    setError(null);
    setMessage(null);
    const data = new FormData(event.currentTarget);
    try {
      const response = await api<RegisterResponse>("/reception/patients", {
        method: "POST",
        body: {
          givenName: String(data.get("givenName") ?? ""),
          familyName: String(data.get("familyName") ?? ""),
          dateOfBirth: String(data.get("dateOfBirth") ?? ""),
          sex: String(data.get("sex") ?? "unknown"),
          phone: String(data.get("phone") ?? ""),
          email: String(data.get("email") ?? ""),
          identityConfidence: String(data.get("identityConfidence") ?? "confirmed-verbal"),
          assistedWithoutContactDetails: data.get("assisted") === "on",
        },
      });
      setMessage(`Registered ${response.patient.publicId}.${response.patient.duplicateReviewQueued ? ` ${response.patient.duplicateReviewQueued} duplicate candidate(s) queued for manual review; no automatic merge occurred.` : ""}`);
      setResolved({ id: response.patient.patientId, publicId: response.patient.publicId, givenName: String(data.get("givenName")), familyName: String(data.get("familyName")), dateOfBirth: String(data.get("dateOfBirth")), sex: String(data.get("sex")) });
      event.currentTarget.reset();
      recent.reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function resolve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("resolve");
    setError(null);
    setMessage(null);
    setResolved(null);
    setNoMatch(null);
    const data = new FormData(event.currentTarget);
    try {
      const response = await api<ResolveResponse>("/patients/resolve", {
        method: "POST",
        body: { publicId: String(data.get("publicId") ?? "").trim(), familyName: String(data.get("familyName") ?? ""), dateOfBirth: String(data.get("dateOfBirth") ?? "") },
      });
      if (response.matched && response.patient) setResolved(response.patient);
      else setNoMatch(response.message ?? "No patient matched the supplied details");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function startEncounter() {
    if (!resolved) return;
    setBusy("encounter");
    setError(null);
    try {
      const response = await api<{ encounterId: string }>("/encounters", {
        method: "POST",
        body: { patientId: resolved.id, type: "walk-in", reason },
        headers: { "idempotency-key": `walk-in-${resolved.id}-${encounterKey.current}` },
      });
      navigate(`/encounters/${response.encounterId}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Reception" title="Patients" description="Exact lookup requires the public ID plus identity confirmation. Lists show minimum reception data only." />
      {error ? <ErrorState message={error} /> : null}
      {message ? <Notice tone="success" title="Patient registered">{message}</Notice> : null}
      {noMatch ? (
        <Notice tone="warning" title="No matching patient">
          {noMatch}. Check the ID on the patient's card, the spelling of the family name and the date of birth, or search this facility's patients below. Register a new patient only if they have never been registered.
        </Notice>
      ) : null}
      {resolved ? (
        <Card title="Patient confirmed" description="A patient ID locates identity; it does not authorize clinical record access.">
          <div className="mv-spread">
            <div>
              <strong>{resolved.givenName} {resolved.familyName}</strong>
              <div className="mv-small mv-muted"><span className="mv-id">{resolved.publicId}</span> · DOB {resolved.dateOfBirth} · {resolved.sex}</div>
            </div>
            <div className="mv-row">
              <Field label="Encounter reason" htmlFor="encounter-reason"><Input id="encounter-reason" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              <Button onClick={() => void startEncounter()} disabled={busy === "encounter" || !reason.trim()}>{busy === "encounter" ? "Starting…" : "Start walk-in encounter"}</Button>
            </div>
          </div>
        </Card>
      ) : null}

      <div className="mv-grid mv-grid--2">
        <Card title="Find or confirm a patient" description="Rate-limited and audited exact lookup.">
          <form className="mv-stack" onSubmit={resolve}>
            <Field label="Public patient ID" htmlFor="resolve-id" hint="Format: MV-XXXX-XXXX-XXXX-XXXX"><Input id="resolve-id" name="publicId" required placeholder="MV-…" autoComplete="off" /></Field>
            <div className="mv-form-grid">
              <Field label="Family name" htmlFor="resolve-family"><Input id="resolve-family" name="familyName" required /></Field>
              <Field label="Date of birth" htmlFor="resolve-dob"><Input id="resolve-dob" name="dateOfBirth" type="date" required /></Field>
            </div>
            <Button type="submit" disabled={busy === "resolve"}>{busy === "resolve" ? "Checking…" : "Confirm identity"}</Button>
          </form>
        </Card>
        <Card title="Assisted registration" description="A patient may be registered without a phone or national ID. Temporary and uncertain identities stay visibly marked.">
          <form className="mv-stack" onSubmit={register}>
            <div className="mv-form-grid">
              <Field label="Given name" htmlFor="reg-given"><Input id="reg-given" name="givenName" required /></Field>
              <Field label="Family name" htmlFor="reg-family"><Input id="reg-family" name="familyName" required /></Field>
            </div>
            <div className="mv-form-grid">
              <Field label="Date of birth" htmlFor="reg-dob"><Input id="reg-dob" name="dateOfBirth" type="date" required /></Field>
              <Field label="Sex"><Select name="sex" defaultValue="unknown"><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option><option value="unknown">Unknown</option></Select></Field>
            </div>
            <Field label="Identity confidence"><Select name="identityConfidence" defaultValue="confirmed-verbal"><option value="confirmed-document">Confirmed from document</option><option value="confirmed-verbal">Confirmed verbally</option><option value="temporary">Temporary identity</option><option value="uncertain">Uncertain</option></Select></Field>
            <div className="mv-form-grid">
              <Field label="Phone (optional)" htmlFor="reg-phone"><Input id="reg-phone" name="phone" /></Field>
              <Field label="Email (optional)" htmlFor="reg-email"><Input id="reg-email" name="email" type="email" /></Field>
            </div>
            <label className="mv-row mv-small"><input type="checkbox" name="assisted" /> Registered without contact details</label>
            <Button type="submit" disabled={busy === "register"}>{busy === "register" ? "Registering…" : "Register patient"}</Button>
          </form>
        </Card>
      </div>

      <Card title="Search this facility's patients" description="Name, public ID or local MRN prefix. Only patients already linked to this facility are searched; searches are audited.">
        <form className="mv-form-grid" onSubmit={submitSearch}>
          <Field label="Name, ID or MRN" htmlFor="search-q" hint="At least 2 characters."><Input id="search-q" name="q" minLength={2} maxLength={120} required autoComplete="off" /></Field>
          <Field label="Date of birth (optional)" htmlFor="search-dob"><Input id="search-dob" name="searchDob" type="date" /></Field>
          <div className="mv-row" style={{ alignItems: "flex-end" }}><Button type="submit" disabled={busy === "search"}>{busy === "search" ? "Searching…" : "Search"}</Button></div>
        </form>
        {searchResult && search ? (
          !searchResult.patients.length ? <EmptyState title="No patients found" description="No patient linked to this facility matches. Use exact lookup for patients registered elsewhere." /> : (
            <div className="mv-stack" style={{ marginTop: 12 }}>
              <Table head={["Patient", "Public ID", "MRN", "DOB", "Sex", ""]} caption="Facility patient search results">
                {searchResult.patients.map((patient) => (
                  <tr key={patient.id}>
                    <td><strong>{patient.givenName} {patient.familyName}</strong></td>
                    <td><span className="mv-id">{patient.publicId}</span></td>
                    <td>{patient.localMrn ?? "—"}</td>
                    <td>{patient.dateOfBirth}</td>
                    <td>{patient.sex}</td>
                    <td><Button size="sm" variant="secondary" onClick={() => { setResolved(patient); setNoMatch(null); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Select</Button></td>
                  </tr>
                ))}
              </Table>
              <div className="mv-row">
                <Button size="sm" variant="ghost" disabled={busy === "search" || search.offset === 0} onClick={() => void runSearch({ ...search, offset: Math.max(0, search.offset - SEARCH_PAGE_SIZE) })}>Previous</Button>
                <span className="mv-small mv-muted">Results {search.offset + 1}–{search.offset + searchResult.patients.length}</span>
                <Button size="sm" variant="ghost" disabled={busy === "search" || !searchResult.hasMore} onClick={() => void runSearch({ ...search, offset: search.offset + SEARCH_PAGE_SIZE })}>Next</Button>
              </div>
            </div>
          )
        ) : null}
      </Card>

      <Card title="Recently linked patients" description="This facility's local patient links only.">
        {recent.loading ? <LoadingState /> : recent.error ? <ErrorState message={recent.error} onRetry={recent.reload} /> : !recent.data?.patients.length ? <EmptyState title="No linked patients" description="Register a patient or resolve an existing public ID." /> : (
          <Table head={["Patient", "Public ID", "DOB", "Sex", "Release signed records"]} caption="Recent patient links">
            {recent.data.patients.map((patient) => (
              <tr key={patient.id}>
                <td><strong>{patient.givenName} {patient.familyName}</strong></td>
                <td><span className="mv-id">{patient.publicId}</span></td>
                <td>{patient.dateOfBirth}</td>
                <td>{patient.sex}</td>
                <td><Badge tone={patient.releaseSignedRecords ? "success" : "warning"}>{patient.releaseSignedRecords ? "released" : "not released"}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
