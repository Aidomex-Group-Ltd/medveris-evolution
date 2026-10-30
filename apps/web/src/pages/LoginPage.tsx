import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Button, Card, ErrorState, Field, Input, Notice, Tabs } from "@medveris/ui";
import { BrandMark } from "../components/BrandMark";
import { api, errorMessage } from "../lib/api";
import { COMPANY } from "../content/company";
import { useAuth } from "../lib/auth";
import { useAppEnvironment } from "../lib/environment";
import { safeReturnPath } from "../lib/navigation";
import type { MeResponse } from "../lib/types";

type MfaMethod = "app" | "email" | "recovery";

const MFA_DESCRIPTIONS: Record<MfaMethod, string> = {
  app: "Enter the six-digit code from your authenticator app, or have a code emailed to you.",
  email: "Enter the six-digit code we emailed to you.",
  recovery: "Enter one of the recovery codes you saved when you set up two-step verification.",
};

type SignInMode = "general" | "staff";

/** Where a completed sign-in goes: back to the page that asked for it, else the workspace for the chosen mode. */
function destination(me: MeResponse, mode: SignInMode, returnTo: string | null): string {
  if (returnTo) return returnTo;
  if (mode === "staff") return "/facility-staff";
  if (me.patientId) return "/portal";
  return me.memberships.length > 1 && !me.activeTenant ? "/facility-staff" : "/";
}

export function LoginPage() {
  const { login, loginMfa, me } = useAuth();
  const environment = useAppEnvironment();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const mode: SignInMode = params.get("as") === "staff" ? "staff" : "general";
  const returnTo = safeReturnPath((location.state as { from?: unknown } | null)?.from);
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

  useEffect(() => {
    if (me) navigate(destination(me, mode, returnTo), { replace: true });
  }, [me, mode, returnTo, navigate]);

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

  return (
    <div className="mv-auth">
      <section className="mv-auth__intro">
        <Link to="/" className="mv-brand" style={{ color: "inherit" }}>
          <BrandMark />
          <span>Medveris<small style={{ color: "#bcd7ce" }}>{environment.synthetic ? "Synthetic outpatient foundation" : "Connected outpatient care"}</small></span>
        </Link>
        <div>
          <h1>Independent, affordable &amp; Secure</h1>
          <p style={{ marginTop: 16 }}>
            One longitudinal identity across participating facilities, source-owned signed records, and consent-scoped exchange.
            {environment.synthetic ? " This environment uses synthetic patients only." : null}
          </p>
          <ul className="mv-auth__features" style={{ marginTop: 22 }}>
            <li>Facility-isolated clinical records</li>
            <li>Immutable signed notes and reasoned amendments</li>
            <li>Patient-controlled exchange consent</li>
            <li>Durable audit and transactional outbox</li>
          </ul>
        </div>
        <p className="mv-small">{environment.synthetic ? "Not clinically validated. Development terminology is synthetic." : "Facility access always requires a verified staff assignment and two-step verification."}</p>
        <p className="mv-small">
          <Link to="/about">About us</Link> · <Link to="/help">Help &amp; support</Link> · <Link to="/contacts">Contacts</Link>
          <br />
          <a href={COMPANY.phoneHref}>{COMPANY.phone}</a> · <a href={COMPANY.emailHref}>{COMPANY.email}</a>
          <br />
          <span className="mv-muted">{COMPANY.attribution}</span>
        </p>
      </section>
      <section className="mv-auth__panel">
        <div className="mv-auth__card mv-stack">
          {!challengeId ? (
            <Tabs label="Sign-in type" value={mode} onChange={(next) => setParams(next === "staff" ? { as: "staff" } : {}, { replace: true, state: location.state })}
              options={[{ value: "general", label: "Sign in" }, { value: "staff", label: "Facility staff sign-in" }]} />
          ) : null}
          <Card
            title={challengeId ? "Two-step verification" : mode === "staff" ? "Facility staff sign-in" : "Sign in"}
            description={challengeId ? MFA_DESCRIPTIONS[method] : mode === "staff"
              ? "Sign in with your staff account. Your facility is opened from your verified staff assignment."
              : "Use your facility or patient account."}
          >
            {error ? <ErrorState message={error} /> : null}
            {challengeId ? (
              <form className="mv-stack" onSubmit={submitMfa}>
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
                {devCode ? <Notice tone="warning" title="Local development code">A development-only endpoint supplied code <strong className="mv-id">{devCode}</strong>. Production builds disable this endpoint.</Notice> : null}
                <Button type="submit" disabled={busy || !codeReady}>{busy ? "Verifying…" : "Verify and continue"}</Button>
                <Button variant="secondary" type="button" disabled={sending} onClick={() => void sendEmailCode()}>
                  {sending ? "Sending…" : method === "email" ? "Send a new code" : "Email me a code instead"}
                </Button>
                {method !== "app" ? <Button variant="ghost" size="sm" type="button" onClick={() => chooseMethod("app")}>Use my authenticator app</Button> : null}
                {method !== "recovery" ? <Button variant="ghost" size="sm" type="button" onClick={() => chooseMethod("recovery")}>Use a recovery code</Button> : null}
                <Button variant="ghost" type="button" onClick={resetChallenge}>Use a different account</Button>
                {environment.local ? <Button variant="ghost" size="sm" type="button" onClick={() => void useDevelopmentCode()}>Use local development code</Button> : null}
              </form>
            ) : (
              <form className="mv-stack" onSubmit={submitPassword}>
                <Field label="Email" htmlFor="login-email">
                  <Input id="login-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </Field>
                <Field label="Password" htmlFor="login-password">
                  <Input id="login-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                </Field>
                <Button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
                <p className="mv-small"><Link to="/forgot-password">Forgot password?</Link></p>
                {mode === "staff" ? (
                  <p className="mv-small mv-muted">New staff member? Open the invitation link your facility administrator emailed you to create your account.</p>
                ) : (
                  <p className="mv-small mv-muted">Patient account? <Link to="/register?type=patient">Create a free patient account</Link>. Facility? <Link to="/register?type=facility">Register a facility</Link>.</p>
                )}
              </form>
            )}
          </Card>
          {environment.synthetic ? (
            <Card title="Synthetic demo accounts">
              <p className="mv-small mv-muted">Password: <span className="mv-inline-code">Medveris!2026</span>. Staff accounts require MFA; use the local development code button.</p>
              <ul className="mv-small" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                <li>clinician@medveris.local — clinician, Kampala</li>
                <li>admin@medveris.local — facility administrator</li>
                <li>reception@medveris.local — receptionist</li>
                <li>patient@medveris.local — patient portal</li>
              </ul>
            </Card>
          ) : null}
        </div>
      </section>
    </div>
  );
}
