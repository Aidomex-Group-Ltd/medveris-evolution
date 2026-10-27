import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button, Card, ErrorState, Field, Input, Notice } from "@medveris/ui";
import { BrandMark } from "../components/BrandMark";
import { api, errorMessage } from "../lib/api";

function readTokenFromUrl(): string {
  return new URLSearchParams(window.location.search).get("token") ?? "";
}

export function ResetPasswordPage() {
  const [token] = useState(readTokenFromUrl);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    // Keep the single-use token out of browser history, bookmarks and screenshots.
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setError("The passwords do not match");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/auth/reset-password", { method: "POST", body: { token, password } });
      setDone(true);
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
          <h1>Choose a new password.</h1>
          <p style={{ marginTop: 16 }}>Reset links work once. Setting a new password signs out every existing session for this account.</p>
        </div>
        <p className="mv-small">Synthetic data only in this environment.</p>
      </section>
      <section className="mv-auth__panel">
        <div className="mv-auth__card mv-stack">
          <Card title="Reset password" description="Use at least 10 characters.">
            {error ? <ErrorState message={error} /> : null}
            {done ? (
              <div className="mv-stack">
                <Notice tone="success" title="Password updated">Sign in with your new password.</Notice>
                <Link to="/login">Continue to sign in</Link>
              </div>
            ) : !token ? (
              <div className="mv-stack">
                <Notice tone="warning" title="Reset link missing">Open the link from your reset email, or request a new one.</Notice>
                <Link to="/forgot-password">Request a new reset link</Link>
              </div>
            ) : (
              <form className="mv-stack" onSubmit={submit}>
                <Field label="New password" htmlFor="reset-password">
                  <Input id="reset-password" type="password" autoComplete="new-password" minLength={10} maxLength={200} value={password} onChange={(e) => setPassword(e.target.value)} required />
                </Field>
                <Field label="Confirm new password" htmlFor="reset-confirm">
                  <Input id="reset-confirm" type="password" autoComplete="new-password" minLength={10} maxLength={200} value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
                </Field>
                <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Set new password"}</Button>
                <p className="mv-small mv-muted">Link expired? <Link to="/forgot-password">Request a new one</Link>.</p>
              </form>
            )}
          </Card>
        </div>
      </section>
    </div>
  );
}
