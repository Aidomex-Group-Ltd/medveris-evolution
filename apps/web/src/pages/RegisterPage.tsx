import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button, Card, ErrorState, Field, Input, Notice, Select } from "@medveris/ui";
import { BrandMark } from "../components/BrandMark";
import { api, errorMessage } from "../lib/api";

export function RegisterPage() {
  const [params, setParams] = useSearchParams();
  const type = params.get("type") === "facility" ? "facility" : "patient";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ publicId?: string; facility?: { name: string }; delivery?: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const common = {
      email: String(data.get("email") ?? ""),
      password: String(data.get("password") ?? ""),
      givenName: String(data.get("givenName") ?? ""),
      familyName: String(data.get("familyName") ?? ""),
    };
    try {
      if (type === "facility") {
        const response = await api<{ facility: { name: string }; verificationEmail: { delivered: boolean; detail?: string } }>("/auth/register/facility", {
          method: "POST",
          body: {
            ...common,
            facilityName: String(data.get("facilityName") ?? ""),
            facilityType: String(data.get("facilityType") ?? "outpatient"),
            city: String(data.get("city") ?? ""),
            country: String(data.get("country") ?? "Uganda"),
          },
        });
        setResult({ facility: response.facility, delivery: response.verificationEmail.delivered ? "Verification email delivered to the local mail sink." : response.verificationEmail.detail ?? "Verification email was not delivered." });
      } else {
        const response = await api<{ patient: { publicId: string }; verificationEmail: { delivered: boolean; detail?: string } }>("/auth/register/patient", {
          method: "POST",
          body: {
            ...common,
            dateOfBirth: String(data.get("dateOfBirth") ?? ""),
            sex: String(data.get("sex") ?? "unknown"),
            phone: String(data.get("phone") ?? ""),
          },
        });
        setResult({ publicId: response.patient.publicId, delivery: response.verificationEmail.delivered ? "Verification email delivered to the local mail sink." : response.verificationEmail.detail ?? "Verification email was not delivered." });
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mv-auth">
      <section className="mv-auth__intro">
        <Link to="/" className="mv-brand" style={{ color: "inherit" }}>
          <BrandMark />
          <span>Medveris<small style={{ color: "#bcd7ce" }}>Free registration</small></span>
        </Link>
        <div>
          <h1>{type === "facility" ? "Register your facility." : "Create your patient identity."}</h1>
          <p style={{ marginTop: 16 }}>
            {type === "facility"
              ? "Facility registration is free and does not imply credential verification. Clinical features require staff MFA enrolment and role assignment."
              : "Your public patient ID locates your identity but never authorizes record access by itself. Only released records and explicit sharing appear in your portal."}
          </p>
        </div>
        <p className="mv-small">Synthetic data only in this environment.</p>
      </section>
      <section className="mv-auth__panel">
        <div className="mv-auth__card mv-stack">
          <Card title={type === "facility" ? "Facility signup" : "Patient signup"} description={type === "facility" ? "The first account becomes a facility administrator." : "Use a valid email for recovery and verification."}>
            {error ? <ErrorState message={error} /> : null}
            {result ? (
              <div className="mv-stack">
                <Notice tone="success" title={type === "facility" ? "Facility registered" : "Patient account registered"}>
                  {result.publicId ? <>Your public patient ID is <strong className="mv-id">{result.publicId}</strong>. Keep it safe; it is not a password.</> : <>{result.facility?.name} is registered without a verified-credential claim.</>}
                  <div className="mv-small" style={{ marginTop: 6 }}>{result.delivery}</div>
                </Notice>
                <Button onClick={() => window.location.assign("/login")}>Continue to sign in</Button>
              </div>
            ) : (
              <form className="mv-stack" onSubmit={submit}>
                <div className="mv-form-grid">
                  <Field label="Given name" htmlFor="givenName"><Input id="givenName" name="givenName" autoComplete="given-name" required maxLength={120} /></Field>
                  <Field label="Family name" htmlFor="familyName"><Input id="familyName" name="familyName" autoComplete="family-name" required maxLength={120} /></Field>
                </div>
                <Field label="Email" htmlFor="reg-email"><Input id="reg-email" name="email" type="email" autoComplete="email" required /></Field>
                <Field label="Password" htmlFor="reg-password" hint="At least 10 characters."><Input id="reg-password" name="password" type="password" autoComplete="new-password" minLength={10} required /></Field>
                {type === "patient" ? (
                  <>
                    <div className="mv-form-grid">
                      <Field label="Date of birth" htmlFor="dob"><Input id="dob" name="dateOfBirth" type="date" required /></Field>
                      <Field label="Sex"><Select name="sex" defaultValue="unknown"><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option><option value="unknown">Unknown</option></Select></Field>
                    </div>
                    <Field label="Phone" htmlFor="phone" hint="Optional. You may register without a phone or national ID."><Input id="phone" name="phone" autoComplete="tel" /></Field>
                  </>
                ) : (
                  <>
                    <Field label="Facility name" htmlFor="facilityName"><Input id="facilityName" name="facilityName" required minLength={2} /></Field>
                    <div className="mv-form-grid">
                      <Field label="Facility type"><Select name="facilityType" defaultValue="outpatient"><option value="outpatient">Outpatient</option><option value="clinic">Clinic</option><option value="hospital">Hospital</option></Select></Field>
                      <Field label="City" htmlFor="city"><Input id="city" name="city" /></Field>
                    </div>
                    <Field label="Country" htmlFor="country"><Input id="country" name="country" defaultValue="Uganda" /></Field>
                  </>
                )}
                <Button type="submit" disabled={busy}>{busy ? "Registering…" : "Register"}</Button>
                <div className="mv-row mv-small">
                  <span className="mv-muted">Already registered?</span>
                  <Link to="/login">Sign in</Link>
                  <Button variant="ghost" size="sm" onClick={() => setParams({ type: type === "patient" ? "facility" : "patient" })}>
                    {type === "patient" ? "Register a facility instead" : "Register as a patient instead"}
                  </Button>
                </div>
              </form>
            )}
          </Card>
        </div>
      </section>
    </div>
  );
}
