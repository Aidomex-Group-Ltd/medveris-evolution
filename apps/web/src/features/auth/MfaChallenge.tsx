import { useState, type FormEvent } from "react";
import type { ReactElement } from "react";
import { Button, ErrorState, Field, Input, Notice } from "@medveris/ui";
import { useAuth } from "../../lib/auth";
import { FieldIcon } from "../../components/FieldIcon";
import { api, errorMessage } from "../../lib/api";
import { useAppEnvironment } from "../../lib/environment";

export type MfaMethod = "app" | "email" | "recovery";

const MFA_DESCRIPTIONS: Record<MfaMethod, string> = {
  app: "Enter the six-digit code from your authenticator app, or have a code emailed to you.",
  email: "Enter the six-digit code we emailed to you.",
  recovery: "Enter one of the recovery codes you saved when you set up two-step verification.",
};

/**
 * Two-step verification challenge. TOTP via authenticator app, emailed code, or
 * single-use recovery code. Never bypasses or weakens MFA; all paths call the
 * existing /auth/login/mfa* endpoints through useAuth().loginMfa / /auth/login/mfa/email.
 */
export function MfaChallenge({ challengeId, email, onReset }: { challengeId: string; email: string; onReset: () => void }): ReactElement {
  const { loginMfa } = useAuth();
  const environment = useAppEnvironment();
  const [code, setCode] = useState("");
  const [method, setMethod] = useState<MfaMethod>("app");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [emailSentTo, setEmailSentTo] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const codeReady = method === "recovery" ? code.length === 12 : code.length === 6;

  async function submitMfa(event: FormEvent) {
    event.preventDefault();
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

  async function sendEmailCode() {
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

  async function useDevelopmentCode() {
    setError(null);
    try {
      // Dev-only helper; server refuses outside development/test. Email is intentionally not sent here.
      const result = await api<{ code: string }>(`/auth/totp/dev?email=${encodeURIComponent(email)}`);
      setMethod("app");
      setDevCode(result.code);
      setCode(result.code);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function chooseMethod(next: MfaMethod) {
    setMethod(next);
    setCode("");
    setDevCode(null);
    setError(null);
  }

  return (
    <form className="mv-stack" onSubmit={submitMfa} noValidate={false}>
      <Notice tone="info" title="Two-step verification">{MFA_DESCRIPTIONS[method]}</Notice>
      {error ? <ErrorState message={error} /> : null}
      {method === "email" && emailSentTo ? (
        <Notice tone="info" title="Code sent">We emailed a six-digit code to {emailSentTo}. It expires in 10 minutes. Check your spam folder if it hasn&rsquo;t arrived.</Notice>
      ) : null}
      {method === "recovery" ? (
        <Field label="Recovery code" htmlFor="mfa-recovery" hint="Each recovery code works once.">
          <Input id="mfa-recovery" autoComplete="off" spellCheck={false} maxLength={12} value={code} onChange={(event) => setCode(event.target.value.replace(/[^A-Za-z0-9_-]/g, ""))} required />
        </Field>
      ) : (
        <Field label="Verification code" htmlFor="mfa-code" hint={method === "email" ? "Enter the code from the email." : "Codes rotate every 30 seconds."}>
          <Input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} placeholder="Enter 6-digit code" icon={<FieldIcon name="hash" />} required />
        </Field>
      )}
      {devCode ? <Notice tone="warning" title="Local development code">A development-only endpoint supplied code <strong className="mv-id">{devCode}</strong>.</Notice> : null}
      <Button type="submit" disabled={busy || !codeReady}>{busy ? "Verifying…" : "Verify and continue"}</Button>
      <Button variant="secondary" type="button" disabled={sending} onClick={() => void sendEmailCode()}>
        {sending ? "Sending…" : method === "email" ? "Send a new code" : "Email me a code instead"}
      </Button>
      {method !== "app" ? <Button variant="ghost" size="sm" type="button" onClick={() => chooseMethod("app")}>Use my authenticator app</Button> : null}
      {method !== "recovery" ? <Button variant="ghost" size="sm" type="button" onClick={() => chooseMethod("recovery")}>Use a recovery code</Button> : null}
      <Button variant="ghost" type="button" onClick={onReset}>Use a different account</Button>
      {environment.devTotpCodes ? <Button variant="ghost" size="sm" type="button" onClick={() => void useDevelopmentCode()}>Use local development code</Button> : null}
      {environment.local && !environment.devTotpCodes ? (
        <p className="mv-small mv-muted">Local development codes are off. Set <span className="mv-inline-code">DEV_SHOW_TOTP_SECRETS=true</span> in the API environment and restart it to enable them.</p>
      ) : null}
    </form>
  );
}
