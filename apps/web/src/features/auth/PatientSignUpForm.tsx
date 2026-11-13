import { useEffect, useState, type FormEvent } from "react";
import type { ReactElement } from "react";
import { Link } from "react-router-dom";
import { Button, ErrorState, Field, Input, Notice, Select } from "@medveris/ui";
import { api, errorMessage } from "../../lib/api";
import { PasswordField } from "./PasswordField";
import { FieldIcon } from "../../components/FieldIcon";

/**
 * Patient self-registration (POST /auth/register/patient).
 * The reference design shows Full name / Email / Phone / Password; the backend
 * additionally requires dateOfBirth and sex, which are presented as compact
 * visually consistent rows below the reference fields.
 */
export function PatientSignUpForm(): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ publicId?: string; delivery?: string } | null>(null);
  const [legalVersions, setLegalVersions] = useState<{ terms: string; privacy: string } | null>(null);
  const [consentAccepted, setConsentAccepted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<{ documents: Array<{ kind: "terms" | "privacy"; version: string }> }>("/public/legal")
      .then((payload) => {
        if (cancelled) return;
        const terms = payload.documents.find((document) => document.kind === "terms")?.version;
        const privacy = payload.documents.find((document) => document.kind === "privacy")?.version;
        if (terms && privacy) setLegalVersions({ terms, privacy });
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const fullName = String(data.get("fullName") ?? "").trim();
    const parts = fullName.split(/\s+/).filter(Boolean);
    const givenName = parts[0] ?? "";
    const familyName = parts.length > 1 ? parts.slice(1).join(" ") : givenName;
    if (!legalVersions || !consentAccepted) {
      setError("Accept the Terms of Service and acknowledge the Privacy Notice before registering.");
      setBusy(false);
      return;
    }
    try {
      const response = await api<{ patient: { publicId: string }; verificationEmail: { delivered: boolean; detail?: string } }>("/auth/register/patient", {
        method: "POST",
        body: {
          email: String(data.get("email") ?? ""),
          password: String(data.get("password") ?? ""),
          givenName,
          familyName,
          dateOfBirth: String(data.get("dateOfBirth") ?? ""),
          sex: String(data.get("sex") ?? "unknown"),
          phone: String(data.get("phone") ?? ""),
          legal: {
            termsVersion: legalVersions.terms,
            privacyVersion: legalVersions.privacy,
            termsAccepted: consentAccepted,
            privacyAcknowledged: consentAccepted,
          },
        },
      });
      setResult({
        publicId: response.patient.publicId,
        delivery: response.verificationEmail.delivered ? "Verification email delivered." : response.verificationEmail.detail ?? "Verification email was not delivered.",
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="mv-stack">
        <Notice tone="success" title="Patient account created">
          Your public patient ID is <strong className="mv-id">{result.publicId}</strong>. Keep it safe; it does not grant record access by itself.
          <div className="mv-small" style={{ marginTop: 6 }}>{result.delivery}</div>
        </Notice>
        <Button type="button" onClick={() => window.location.assign("/login?role=patient&mode=signin")}>Continue to sign in</Button>
      </div>
    );
  }

  return (
    <form className="mv-stack" onSubmit={submit}>
      {error ? <ErrorState message={error} /> : null}
      <Field label="Full name" htmlFor="fullName" hint="Given and family name.">
        <Input id="fullName" name="fullName" autoComplete="name" required maxLength={241} placeholder="Enter your full name" icon={<FieldIcon name="user" />} />
      </Field>
      <Field label="Email" htmlFor="reg-email">
        <Input id="reg-email" name="email" type="email" autoComplete="email" placeholder="Enter your email address" icon={<FieldIcon name="mail" />} required />
      </Field>
      <Field label="Phone" htmlFor="phone" hint="Optional.">
        <Input id="phone" name="phone" autoComplete="tel" maxLength={40} placeholder="Enter phone number" icon={<FieldIcon name="phone" />} />
      </Field>
      <Field label="Password" htmlFor="reg-password" hint="At least 10 characters.">
        <PasswordField id="reg-password" name="password" autoComplete="new-password" minLength={10} placeholder="Create a password" icon={<FieldIcon name="lock" />} required />
      </Field>
      <Field label="Date of birth" htmlFor="dob" hint="Required for clinical matching.">
        <Input id="dob" name="dateOfBirth" type="date" required placeholder="Select date of birth" icon={<FieldIcon name="calendar" />} />
      </Field>
      <Field label="Sex" htmlFor="sex">
        <Select id="sex" name="sex" defaultValue="unknown">
          <option value="female">Female</option>
          <option value="male">Male</option>
          <option value="other">Other</option>
          <option value="unknown">Unknown</option>
        </Select>
      </Field>
      <label className="mv-check">
        <input type="checkbox" checked={consentAccepted} onChange={(event) => setConsentAccepted(event.target.checked)} required aria-describedby="consent-detail" />
        <span id="consent-detail">
          I agree to the <Link to="/terms" target="_blank" rel="noreferrer">Terms of Service</Link> and acknowledge the <Link to="/privacy" target="_blank" rel="noreferrer">Privacy Notice</Link>
          {legalVersions ? ` (versions ${legalVersions.terms} / ${legalVersions.privacy})` : ""}.
        </span>
      </label>
      <Button type="submit" disabled={busy || !legalVersions || !consentAccepted}>{busy ? "Creating account…" : "Create patient account"}</Button>
    </form>
  );
}
