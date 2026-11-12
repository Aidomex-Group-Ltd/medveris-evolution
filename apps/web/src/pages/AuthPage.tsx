import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Button, Card, ErrorState, Field, Input, Notice, Select, Tabs } from "@medveris/ui";
import { BrandMark } from "../components/BrandMark";
import { WorkspaceSignup } from "../components/WorkspaceSignup";
import { api, errorMessage } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useAppEnvironment } from "../lib/environment";
import { safeReturnPath } from "../lib/navigation";
import type { MeResponse } from "../lib/types";

type RoleView = "patient" | "provider";
type Mode = "signin" | "signup";
type MfaMethod = "app" | "email" | "recovery";

const MFA_DESCRIPTIONS: Record<MfaMethod, string> = {
  app: "Enter the six-digit code from your authenticator app, or have a code emailed to you.",
  email: "Enter the six-digit code we emailed to you.",
  recovery: "Enter one of the recovery codes you saved when you set up two-step verification.",
};

function destination(me: MeResponse, role: RoleView, returnTo: string | null): string {
  if (returnTo) return returnTo;
  if (role === "provider") return me.memberships.length > 1 && !me.activeTenant ? "/facility-staff" : me.activeTenant ? "/dashboard" : "/facility-staff";
  if (me.patientId) return "/portal";
  return me.memberships.length > 1 && !me.activeTenant ? "/facility-staff" : "/dashboard";
}

function readRole(params: URLSearchParams): RoleView {
  const role = params.get("role");
  if (role === "patient" || role === "provider") return role;
  if (params.get("as") === "staff" || params.get("type") === "facility") return "provider";
  return "patient";
}

function readMode(params: URLSearchParams): Mode {
  const mode = params.get("mode");
  if (mode === "signin" || mode === "signup") return mode;
  if (params.get("type") === "patient" || params.get("type") === "facility") return "signup";
  return "signin";
}

export function AuthPage() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const role = readRole(params);
  const mode = readMode(params);
  const returnTo = safeReturnPath((location.state as { from?: unknown } | null)?.from);

  function update(next: { role?: RoleView; mode?: Mode }) {
    const merged = {
      role: next.role ?? role,
      mode: next.mode ?? mode,
    };
    const nextParams = new URLSearchParams();
    nextParams.set("role", merged.role);
    nextParams.set("mode", merged.mode);
    setParams(nextParams, { replace: true, state: location.state });
  }

  useEffect(() => {
    if (me) navigate(destination(me, role, returnTo), { replace: true });
  }, [me, role, returnTo, navigate]);

  const title = mode === "signin" ? "Sign in" : "Create account";
  const subtitle = mode === "signin"
    ? role === "provider"
      ? "Sign in to your healthcare or facility account."
      : "Sign in to your patient account."
    : role === "provider"
      ? "Set up a healthcare or facility workspace."
      : "Create a free patient account.";

  return (
    <main className="mv-auth mv-auth--single">
      <div className="mv-auth__single">
        <header className="mv-auth__single-head">
          <Link to="/" className="mv-brand" aria-label="Medveris home">
            <BrandMark />
            <span>Medveris</span>
          </Link>
          <p className="mv-small mv-muted">Secure access to your Medveris account.</p>
        </header>

        <div className="mv-auth__toggles" role="group" aria-label="Account options">
          <fieldset className="mv-auth__toggle-group">
            <legend className="mv-auth__legend">I am a</legend>
            <Tabs
              label="Account type"
              value={role}
              onChange={(value) => update({ role: value as RoleView })}
              options={[
                { value: "patient", label: "Patient" },
                { value: "provider", label: "Healthcare Provider" },
              ]}
            />
          </fieldset>
          <fieldset className="mv-auth__toggle-group">
            <legend className="mv-auth__legend">Action</legend>
            <Tabs
              label="Sign in or sign up"
              value={mode}
              onChange={(value) => update({ mode: value as Mode })}
              options={[
                { value: "signin", label: "Sign in" },
                { value: "signup", label: "Sign up" },
              ]}
            />
          </fieldset>
        </div>

        <Card title={title} description={subtitle}>
          {mode === "signin" ? (
            <SignInPanel role={role} />
          ) : role === "patient" ? (
            <PatientSignUpPanel />
          ) : (
            <div className="mv-stack">
              <WorkspaceSignup />
              <p className="mv-small mv-muted">
                Already have an account? <button type="button" className="mv-link-button" onClick={() => update({ mode: "signin" })}>Sign in</button>
              </p>
            </div>
          )}
        </Card>

        <p className="mv-small mv-muted mv-auth__foot">
          By continuing you agree to use Medveris in line with applicable facility policies. <Link to="/help">Help &amp; support</Link>
        </p>
      </div>
    </main>
  );
}

function SignInPanel({ role }: { role: RoleView }) {
  const { login, loginMfa } = useAuth();
  const environment = useAppEnvironment();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [method, setMethod] = useState<MfaMethod>("app");
  const [emailSentTo, setEmailSentTo] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await login(email, password);
      if (result.mfaRequired && result.challengeId) setChallengeId(result.challengeId);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function submitMfa(event: FormEvent) {
    event.preventDefault();
    if (!challengeId) return;
    setBusy(true);
    setError(null);
    try {
      await loginMfa(challengeId, code);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function useDevelopmentCode() {
    setError(null);
    try {
      const result = await api<{ code: string }>(`/auth/totp/dev?email=${encodeURIComponent(email)}`);
      setMethod("app");
      setDevCode(result.code);
      setCode(result.code);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function sendEmailCode() {
    if (!challengeId) return;
    setSending(true);
    setError(null);
    try {
      const result = await api<{ sentTo: string }>("/auth/login/mfa/email", { method: "POST", body: { challengeId } });
      setMethod("email");
      setEmailSentTo(result.sentTo);
      setCode("");
      setDevCode(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSending(false);
    }
  }

  function chooseMethod(next: MfaMethod) {
    setMethod(next);
    setCode("");
    setDevCode(null);
    setError(null);
  }

  function resetChallenge() {
    setChallengeId(null);
    setCode("");
    setDevCode(null);
    setMethod("app");
    setEmailSentTo(null);
  }

  const codeReady = method === "recovery" ? code.length === 12 : code.length === 6;

  if (challengeId) {
    return (
      <form className="mv-stack" onSubmit={submitMfa}>
        <Notice tone="info" title="Two-step verification">{MFA_DESCRIPTIONS[method]}</Notice>
        {error ? <ErrorState message={error} /> : null}
        {method === "email" && emailSentTo ? <Notice tone="info" title="Code sent">We emailed a six-digit code to {emailSentTo}. It expires in 10 minutes. Check your spam folder if it hasn't arrived.</Notice> : null}
        {method === "recovery" ? (
          <Field label="Recovery code" htmlFor="mfa-recovery" hint="Each recovery code works once.">
            <Input id="mfa-recovery" autoComplete="off" spellCheck={false} maxLength={12} value={code} onChange={(e) => setCode(e.target.value.replace(/[^A-Za-z0-9_-]/g, ""))} required />
          </Field>
        ) : (
          <Field label="Verification code" htmlFor="mfa-code" hint={method === "email" ? "Enter the code from the email." : "Codes rotate every 30 seconds."}>
            <Input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required />
          </Field>
        )}
        {devCode ? <Notice tone="warning" title="Local development code">A development-only endpoint supplied code <strong className="mv-id">{devCode}</strong>. It changes every 30 seconds; use the button again if it stops working. Production builds disable this endpoint.</Notice> : null}
        <Button type="submit" disabled={busy || !codeReady}>{busy ? "Verifying…" : "Verify and continue"}</Button>
        <Button variant="secondary" type="button" disabled={sending} onClick={() => void sendEmailCode()}>
          {sending ? "Sending…" : method === "email" ? "Send a new code" : "Email me a code instead"}
        </Button>
        {method !== "app" ? <Button variant="ghost" size="sm" type="button" onClick={() => chooseMethod("app")}>Use my authenticator app</Button> : null}
        {method !== "recovery" ? <Button variant="ghost" size="sm" type="button" onClick={() => chooseMethod("recovery")}>Use a recovery code</Button> : null}
        <Button variant="ghost" type="button" onClick={resetChallenge}>Use a different account</Button>
        {environment.devTotpCodes ? <Button variant="ghost" size="sm" type="button" onClick={() => void useDevelopmentCode()}>Use local development code</Button> : null}
        {environment.local && !environment.devTotpCodes ? (
          <p className="mv-small mv-muted">
            Local development codes are off. Set <span className="mv-inline-code">DEV_SHOW_TOTP_SECRETS=true</span> in the API environment and restart it to enable them.
          </p>
        ) : null}
      </form>
    );
  }

  return (
    <form className="mv-stack" onSubmit={submitPassword}>
      {error ? <ErrorState message={error} /> : null}
      {role === "provider" ? (
        <p className="mv-small mv-muted">Healthcare staff sign in with their verified account. New staff should use the invitation link from their facility administrator.</p>
      ) : null}
      <Field label="Email" htmlFor="auth-email">
        <Input id="auth-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </Field>
      <Field label="Password" htmlFor="auth-password">
        <Input id="auth-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </Field>
      <Button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
      <p className="mv-small"><Link to="/forgot-password">Forgot password?</Link></p>
    </form>
  );
}

function PatientSignUpPanel() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ publicId?: string; delivery?: string } | null>(null);
  const [legalVersions, setLegalVersions] = useState<{ terms: string; privacy: string } | null>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [privacyAcknowledged, setPrivacyAcknowledged] = useState(false);

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
    const common = {
      email: String(data.get("email") ?? ""),
      password: String(data.get("password") ?? ""),
      givenName: String(data.get("givenName") ?? ""),
      familyName: String(data.get("familyName") ?? ""),
    };
    if (!legalVersions || !termsAccepted || !privacyAcknowledged) {
      setError("Accept the Terms of Service and acknowledge the Privacy Notice before registering.");
      setBusy(false);
      return;
    }
    try {
      const response = await api<{ patient: { publicId: string }; verificationEmail: { delivered: boolean; detail?: string } }>("/auth/register/patient", {
        method: "POST",
        body: {
          ...common,
          dateOfBirth: String(data.get("dateOfBirth") ?? ""),
          sex: String(data.get("sex") ?? "unknown"),
          phone: String(data.get("phone") ?? ""),
          legal: {
            termsVersion: legalVersions.terms,
            privacyVersion: legalVersions.privacy,
            termsAccepted,
            privacyAcknowledged,
          },
        },
      });
      setResult({ publicId: response.patient.publicId, delivery: response.verificationEmail.delivered ? "Verification email delivered." : response.verificationEmail.detail ?? "Verification email was not delivered." });
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
      <div className="mv-form-grid">
        <Field label="Given name" htmlFor="givenName"><Input id="givenName" name="givenName" autoComplete="given-name" required maxLength={120} /></Field>
        <Field label="Family name" htmlFor="familyName"><Input id="familyName" name="familyName" autoComplete="family-name" required maxLength={120} /></Field>
      </div>
      <Field label="Email" htmlFor="reg-email"><Input id="reg-email" name="email" type="email" autoComplete="email" required /></Field>
      <Field label="Password" htmlFor="reg-password" hint="At least 10 characters."><Input id="reg-password" name="password" type="password" autoComplete="new-password" minLength={10} required /></Field>
      <div className="mv-form-grid">
        <Field label="Date of birth" htmlFor="dob"><Input id="dob" name="dateOfBirth" type="date" required /></Field>
        <Field label="Sex"><Select name="sex" defaultValue="unknown"><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option><option value="unknown">Unknown</option></Select></Field>
      </div>
      <Field label="Phone" htmlFor="phone" hint="Optional."><Input id="phone" name="phone" autoComplete="tel" /></Field>
      <label className="mv-check">
        <input type="checkbox" checked={termsAccepted} onChange={(event) => setTermsAccepted(event.target.checked)} />
        <span>
          I have read and accept the <Link to="/terms" target="_blank" rel="noreferrer">Terms of Service</Link>
          {legalVersions ? ` (version ${legalVersions.terms})` : ""}.
        </span>
      </label>
      <label className="mv-check">
        <input type="checkbox" checked={privacyAcknowledged} onChange={(event) => setPrivacyAcknowledged(event.target.checked)} />
        <span>
          I have read the <Link to="/privacy" target="_blank" rel="noreferrer">Privacy Notice</Link>
          {legalVersions ? ` (version ${legalVersions.privacy})` : ""}.
        </span>
      </label>
      <Button type="submit" disabled={busy || !legalVersions || !termsAccepted || !privacyAcknowledged}>{busy ? "Creating account…" : "Create patient account"}</Button>
    </form>
  );
}
