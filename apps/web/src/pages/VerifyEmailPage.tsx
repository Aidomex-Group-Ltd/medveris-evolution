import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card, ErrorState, Notice } from "@medveris/ui";
import { BrandMark } from "../components/BrandMark";
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
    <div className="mv-auth">
      <section className="mv-auth__intro">
        <Link to="/" className="mv-brand" style={{ color: "inherit" }}>
          <BrandMark />
          <span>Medveris<small style={{ color: "#bcd7ce" }}>Email verification</small></span>
        </Link>
        <div>
          <h1>Confirm your email address.</h1>
          <p style={{ marginTop: 16 }}>Verification links work once and expire after 24 hours.</p>
        </div>
        <SyntheticDataNote />
      </section>
      <section className="mv-auth__panel">
        <div className="mv-auth__card mv-stack">
          <Card title="Verify email">
            {error ? <ErrorState message={error} /> : null}
            {done ? (
              <div className="mv-stack">
                <Notice tone="success" title="Email verified">Your email address is confirmed.</Notice>
                <Link to="/login">Continue to sign in</Link>
              </div>
            ) : !token ? (
              <div className="mv-stack">
                <Notice tone="warning" title="Verification link missing">Open the link from your verification email. Signed-in users can request a new one from their account.</Notice>
                <Link to="/login">Go to sign in</Link>
              </div>
            ) : (
              <div className="mv-stack">
                <p className="mv-small mv-muted">Select the button to confirm this address belongs to you.</p>
                <Button onClick={() => void verify()} disabled={busy}>{busy ? "Verifying…" : "Verify email"}</Button>
              </div>
            )}
          </Card>
        </div>
      </section>
    </div>
  );
}
