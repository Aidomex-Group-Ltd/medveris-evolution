import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import QRCode from "qrcode";
import { Button, Card, ErrorState, Field, Input, LoadingState, Notice } from "@medveris/ui";
import { BrandMark } from "../components/BrandMark";
import { api, errorMessage } from "../lib/api";
import { useAuth } from "../lib/auth";

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
  const navigate = useNavigate();
  const [enrollment, setEnrollment] = useState<EnrollmentStart | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
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

  if (loading) return <LoadingState label="Restoring session" />;
  if (!me) return <Navigate to="/login" replace />;
  if (me.user.mfaEnrolled && me.user.mfaVerified && !recoveryCodes) return <Navigate to="/" replace />;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      setEnrollment(await api<EnrollmentStart>("/auth/mfa/enroll/start", { method: "POST" }));
      setCode("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
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
    await refresh();
    navigate("/", { replace: true });
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
    <div className="mv-auth">
      <section className="mv-auth__intro">
        <Link to="/" className="mv-brand" style={{ color: "inherit" }}>
          <BrandMark />
          <span>Medveris<small style={{ color: "#bcd7ce" }}>Account security</small></span>
        </Link>
        <div>
          <h1>Protect facility access with two-step verification.</h1>
          <p style={{ marginTop: 16 }}>
            Staff accounts must use an authenticator app before opening facility workspaces. Each sign-in then asks for a six-digit code.
          </p>
        </div>
        <p className="mv-small">Works with Google Authenticator, Microsoft Authenticator, 1Password and other TOTP apps.</p>
      </section>
      <section className="mv-auth__panel">
        <div className="mv-auth__card mv-stack">
          <Card title="Set up two-step verification" description={me.user.email}>
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
                <Button type="submit" disabled={busy || code.length !== 6}>{busy ? "Verifying…" : "Verify and turn on"}</Button>
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
      </section>
    </div>
  );
}
