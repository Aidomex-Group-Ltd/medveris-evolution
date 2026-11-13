import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button, ErrorState, Field, Notice } from "@medveris/ui";
import { AuthLayout } from "../features/auth/AuthLayout";
import { AuthBrand } from "../features/auth/AuthBrand";
import { PasswordField } from "../features/auth/PasswordField";
import { SyntheticDataNote } from "../components/SyntheticDataNote";
import { api, errorMessage } from "../lib/api";
import { FieldIcon } from "../components/FieldIcon";

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
    <AuthLayout>
      <AuthBrand />
      <div className="mv-authx__card">
        <div>
          <h1 className="mv-authx__title">Choose a new password</h1>
          <p className="mv-authx__subtitle">Reset links work once. Setting a new password signs out every existing session for this account.</p>
        </div>
        {error ? <ErrorState message={error} /> : null}
        {done ? (
          <div className="mv-stack">
            <Notice tone="success" title="Password updated">Sign in with your new password.</Notice>
            <p className="mv-authx__consent mv-authx__inline"><Link to="/login">Continue to sign in</Link></p>
          </div>
        ) : !token ? (
          <div className="mv-stack">
            <Notice tone="warning" title="Reset link missing">Open the link from your reset email, or request a new one.</Notice>
            <p className="mv-authx__consent mv-authx__inline"><Link to="/forgot-password">Request a new reset link</Link></p>
          </div>
        ) : (
          <form className="mv-stack" onSubmit={submit}>
            <Field label="New password" htmlFor="reset-password" hint="Use at least 10 characters.">
              <PasswordField id="reset-password" autoComplete="new-password" minLength={10} maxLength={200} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Create a new password" icon={<FieldIcon name="lock" />} required />
            </Field>
            <Field label="Confirm new password" htmlFor="reset-confirm">
              <PasswordField id="reset-confirm" autoComplete="new-password" minLength={10} maxLength={200} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Confirm your password" icon={<FieldIcon name="lock" />} required />
            </Field>
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Set new password"}</Button>
            <p className="mv-authx__consent mv-authx__inline">Link expired? <Link to="/forgot-password">Request a new one</Link></p>
          </form>
        )}
      </div>
      <SyntheticDataNote />
    </AuthLayout>
  );
}
