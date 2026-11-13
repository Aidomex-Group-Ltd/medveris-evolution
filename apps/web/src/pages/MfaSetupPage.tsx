import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import QRCode from "qrcode";
import { Button, Card, ErrorState, Field, Input, LoadingState, Notice } from "@medveris/ui";
import { AuthLayout } from "../features/auth/AuthLayout";
import { AuthBrand } from "../features/auth/AuthBrand";
import { api, errorMessage } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useAppEnvironment } from "../lib/environment";

interface EnrollmentStart {
  secret: string;
  otpauthUrl: string;
}

interface EnrollmentResult {
  recoveryCodes: string[];
}

function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

export function MfaSetupPage() {
  const { me, loading, refresh, logout } = useAuth();
  const environment = useAppEnvironment();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const welcome = params.get("welcome") === "1";
  const [enrollment, setEnrollment] = useState<EnrollmentStart | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enrollment) return;
    let cancelled = false;
    QRCode.toDataURL(enrollment.otpauthUrl, { margin: 1, width: 220 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [enrollment]);

  if (loading) return <LoadingState label="Restoring session" variant="page" />;
  if (!me) return <Navigate to="/login" replace />;
  if (me.user.mfaEnrolled && me.user.mfaVerified && !recoveryCodes) return <Navigate to="/dashboard" replace />;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      setEnrollment(await api<EnrollmentStart>("/auth/mfa/enroll/start", { method: "POST" }));
      setCode("");
      setDevCode(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function useDevelopmentCode() {
    setError(null);
    try {
      const result = await api<{ code: string }>("/auth/totp/dev");
      setCode(result.code);
      setDevCode(result.code);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<EnrollmentResult>("/auth/mfa/enroll/verify", { method: "POST", body: { code } });
      setRecoveryCodes(result.recoveryCodes);
      setEnrollment(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    const current = await refresh();
    navigate(current && current.memberships.length > 0 && !current.activeTenant ? "/facility-staff" : "/", { replace: true });
  }

  async function signInAgain() {
    await logout();
    navigate("/login", { replace: true });
  }

  function downloadRecoveryCodes() {
    if (!recoveryCodes) return;
    const blob = new Blob([`Medveris recovery codes for ${me?.user.email ?? "your account"}\n\n${recoveryCodes.join("\n")}\n`], { type: "text/plain" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "medveris-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <AuthLayout>
      <AuthBrand />
      <div className="mv-authx__card">
        <div>
          <h1 className="mv-authx__title">Protect facility access with two-step verification</h1>
          <p className="mv-authx__subtitle">Staff accounts must use an authenticator app before opening facility workspaces. Works with Google Authenticator, Microsoft Authenticator, 1Password and other TOTP apps.</p>
        </div>
          <Card title="Set up two-step verification" description={me.user.email}>
            {welcome && me.activeTenant && !recoveryCodes ? (
              <Notice tone="success" title={`${me.activeTenant.name} is ready`}>One last step: turn on two-step verification, then you go straight to its dashboard.</Notice>
            ) : null}
            {error ? <ErrorState message={error} /> : null}
            {recoveryCodes ? (
              <div className="mv-stack">
                <Notice tone="success" title="Two-step verification is on">Store these recovery codes somewhere safe. Each works once if you lose your authenticator, and they are shown only now.</Notice>
                <ul className="mv-inline-code" style={{ columns: 2, listStyle: "none", padding: 12, margin: 0 }}>
                  {recoveryCodes.map((recoveryCode) => <li key={recoveryCode}>{recoveryCode}</li>)}
                </ul>
                <Button variant="secondary" type="button" onClick={downloadRecoveryCodes}>Download recovery codes</Button>
                <Button type="button" onClick={() => void finish()}>I have saved my codes — continue</Button>
              </div>
            ) : me.user.mfaEnrolled ? (
              <div className="mv-stack">
                <Notice tone="warning" title="Verification required">Two-step verification is set up for this account, but this session has not been verified. Sign in again and enter a code from your authenticator app.</Notice>
                <Button type="button" onClick={() => void signInAgain()}>Sign in again</Button>
              </div>
            ) : enrollment ? (
              <form className="mv-stack" onSubmit={verify}>
                <p className="mv-small mv-muted">Scan this QR code with your authenticator app, or enter the setup key manually.</p>
                {qrDataUrl ? <img src={qrDataUrl} alt="Authenticator setup QR code" width={220} height={220} style={{ alignSelf: "center" }} /> : null}
                <Field label="Setup key" htmlFor="mfa-secret" hint="Time-based, 6 digits, 30 seconds.">
                  <Input id="mfa-secret" value={groupSecret(enrollment.secret)} readOnly onFocus={(event) => event.currentTarget.select()} />
                </Field>
                <Field label="Verification code" htmlFor="mfa-enroll-code" hint="Enter the current six-digit code from the app.">
                  <Input id="mfa-enroll-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} required />
                </Field>
                {devCode ? <Notice tone="warning" title="Local development code">A development-only endpoint supplied code <strong className="mv-id">{devCode}</strong>. It changes every 30 seconds; use the button again if it stops working. Production builds disable this endpoint.</Notice> : null}
                <Button type="submit" disabled={busy || code.length !== 6}>{busy ? "Verifying…" : "Verify and turn on"}</Button>
                {environment.devTotpCodes ? <Button variant="ghost" size="sm" type="button" disabled={busy} onClick={() => void useDevelopmentCode()}>Use local development code</Button> : null}
                <Button variant="ghost" type="button" disabled={busy} onClick={() => void start()}>Generate a new setup key</Button>
              </form>
            ) : (
              <div className="mv-stack">
                <p className="mv-small mv-muted">You need an authenticator app on your phone or password manager. Setup takes about a minute.</p>
                <Button type="button" disabled={busy} onClick={() => void start()}>{busy ? "Preparing…" : "Set up authenticator"}</Button>
                <Button variant="ghost" type="button" onClick={() => void signInAgain()}>Sign out</Button>
              </div>
            )}
          </Card>
      </div>
    </AuthLayout>
  );
}
