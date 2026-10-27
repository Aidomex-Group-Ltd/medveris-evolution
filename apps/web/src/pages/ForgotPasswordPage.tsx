import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button, Card, ErrorState, Field, Input, Notice } from "@medveris/ui";
import { BrandMark } from "../components/BrandMark";
import { api, errorMessage } from "../lib/api";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ message: string }>("/auth/forgot-password", { method: "POST", body: { email } });
      setMessage(result.message);
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
          <span>Medveris<small style={{ color: "#bcd7ce" }}>Account recovery</small></span>
        </Link>
        <div>
          <h1>Reset your password.</h1>
          <p style={{ marginTop: 16 }}>
            We will email a single-use reset link that expires in 24 hours. Resetting your password signs you out everywhere.
            Staff accounts still need their authenticator code after a reset.
          </p>
        </div>
        <p className="mv-small">Synthetic data only in this environment.</p>
      </section>
      <section className="mv-auth__panel">
        <div className="mv-auth__card mv-stack">
          <Card title="Forgot password" description="Enter the email address you use to sign in.">
            {error ? <ErrorState message={error} /> : null}
            {message ? (
              <div className="mv-stack">
                <Notice tone="success" title="Check your email">{message}</Notice>
                <Link to="/login">Return to sign in</Link>
              </div>
            ) : (
              <form className="mv-stack" onSubmit={submit}>
                <Field label="Email" htmlFor="forgot-email">
                  <Input id="forgot-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </Field>
                <Button type="submit" disabled={busy}>{busy ? "Sending…" : "Send reset link"}</Button>
                <p className="mv-small mv-muted">Remembered it? <Link to="/login">Sign in</Link>.</p>
              </form>
            )}
          </Card>
        </div>
      </section>
    </div>
  );
}
