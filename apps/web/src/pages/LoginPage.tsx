import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, Card, ErrorState, Field, Input, Notice } from "@medveris/ui";
import { BrandMark } from "../components/BrandMark";
import { api, errorMessage } from "../lib/api";
import { useAuth } from "../lib/auth";

type MfaMethod = "app" | "email" | "recovery";

const MFA_DESCRIPTIONS: Record<MfaMethod, string> = {
  app: "Enter the six-digit code from your authenticator app, or have a code emailed to you.",
  email: "Enter the six-digit code we emailed to you.",
  recovery: "Enter one of the recovery codes you saved when you set up two-step verification.",
};

export function LoginPage() {
  const { login, loginMfa, me } = useAuth();
  const navigate = useNavigate();
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
    if (me) navigate(me.patientId ? "/portal" : "/", { replace: true });
  }, [me, navigate]);

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await login(email, password);
      if (result.mfaRequired && result.challengeId) {
        setChallengeId(result.challengeId);
      } else {
        navigate("/", { replace: true });
      }
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
      navigate("/", { replace: true });
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
          <span>Medveris<small style={{ color: "#bcd7ce" }}>Synthetic outpatient foundation</small></span>
        </Link>
        <div>
          <h1>Care that follows the patient, safely.</h1>
          <p style={{ marginTop: 16 }}>
            One longitudinal identity across participating facilities, source-owned signed records, and consent-scoped exchange.
            This local environment uses synthetic patients only.
          </p>
          <ul className="mv-auth__features" style={{ marginTop: 22 }}>
            <li>Facility-isolated clinical records</li>
            <li>Immutable signed notes and reasoned amendments</li>
            <li>Patient-controlled exchange consent</li>
            <li>Durable audit and transactional outbox</li>
          </ul>
        </div>
        <p className="mv-small">Not clinically validated. Development terminology is synthetic.</p>
      </section>
      <section className="mv-auth__panel">
        <div className="mv-auth__card mv-stack">
          <Card title={challengeId ? "Two-step verification" : "Sign in"} description={challengeId ? MFA_DESCRIPTIONS[method] : "Use your facility or patient account."}>
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
                <Button variant="ghost" size="sm" type="button" onClick={() => void useDevelopmentCode()}>Use local development code</Button>
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
                <p className="mv-small mv-muted">Patient account? <Link to="/register?type=patient">Create a free patient account</Link>. Facility? <Link to="/register?type=facility">Register a facility</Link>.</p>
              </form>
            )}
          </Card>
          <Card title="Synthetic demo accounts">
            <p className="mv-small mv-muted">Password: <span className="mv-inline-code">Medveris!2026</span>. Staff accounts require MFA; use the local development code button.</p>
            <ul className="mv-small" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
              <li>clinician@medveris.local — clinician, Kampala</li>
              <li>admin@medveris.local — facility administrator</li>
              <li>reception@medveris.local — receptionist</li>
              <li>patient@medveris.local — patient portal</li>
            </ul>
          </Card>
        </div>
      </section>
    </div>
  );
}
