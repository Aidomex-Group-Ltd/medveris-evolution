import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button, ErrorState, Notice } from "@medveris/ui";
import { AuthLayout } from "../features/auth/AuthLayout";
import { AuthBrand } from "../features/auth/AuthBrand";
import { SyntheticDataNote } from "../components/SyntheticDataNote";
import { api, errorMessage } from "../lib/api";

function readTokenFromUrl(): string {
  return new URLSearchParams(window.location.search).get("token") ?? "";
}

export function VerifyEmailPage() {
  const [token] = useState(readTokenFromUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    // Keep the single-use token out of browser history, bookmarks and screenshots.
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  // Verification waits for a click: mail scanners that prefetch links must not consume the token.
  async function verify() {
    setBusy(true);
    setError(null);
    try {
      await api("/auth/verify-email", { method: "POST", body: { token } });
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
          <h1 className="mv-authx__title">Confirm your email address</h1>
          <p className="mv-authx__subtitle">Verification links work once and expire after 24 hours.</p>
        </div>
        {error ? <ErrorState message={error} /> : null}
        {done ? (
          <div className="mv-stack">
            <Notice tone="success" title="Email verified">Your email address is confirmed.</Notice>
            <p className="mv-authx__consent mv-authx__inline"><Link to="/login">Continue to sign in</Link></p>
          </div>
        ) : !token ? (
          <div className="mv-stack">
            <Notice tone="warning" title="Verification link missing">Open the link from your verification email. Signed-in users can request a new one from their account.</Notice>
            <p className="mv-authx__consent mv-authx__inline"><Link to="/login">Go to sign in</Link></p>
          </div>
        ) : (
          <div className="mv-stack">
            <p className="mv-small mv-muted">Select the button to confirm this address belongs to you.</p>
            <Button onClick={() => void verify()} disabled={busy}>{busy ? "Verifying…" : "Verify email"}</Button>
          </div>
        )}
      </div>
      <SyntheticDataNote />
    </AuthLayout>
  );
}
