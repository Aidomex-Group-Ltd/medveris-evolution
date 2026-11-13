import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button, ErrorState, Field, Input, Notice } from "@medveris/ui";
import { AuthLayout } from "../features/auth/AuthLayout";
import { AuthBrand } from "../features/auth/AuthBrand";
import { SyntheticDataNote } from "../components/SyntheticDataNote";
import { api, errorMessage } from "../lib/api";
import { FieldIcon } from "../components/FieldIcon";

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
    <AuthLayout>
      <AuthBrand />
      <div className="mv-authx__card">
        <div>
          <h1 className="mv-authx__title">Reset your password</h1>
          <p className="mv-authx__subtitle">We&rsquo;ll email a single-use link that expires in 24 hours. Resetting signs you out everywhere.</p>
        </div>
        {error ? <ErrorState message={error} /> : null}
        {message ? (
          <div className="mv-stack">
            <Notice tone="success" title="Check your email">{message}</Notice>
            <p className="mv-authx__consent mv-authx__inline"><Link to="/login">Return to sign in</Link></p>
          </div>
        ) : (
          <form className="mv-stack" onSubmit={submit}>
            <Field label="Email" htmlFor="forgot-email">
              <Input id="forgot-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Enter your email address" icon={<FieldIcon name="mail" />} required />
            </Field>
            <Button type="submit" disabled={busy}>{busy ? "Sending…" : "Send reset link"}</Button>
            <p className="mv-authx__consent mv-authx__inline">Remembered it? <Link to="/login">Sign in</Link></p>
          </form>
        )}
      </div>
      <SyntheticDataNote />
    </AuthLayout>
  );
}
