import { useState, type FormEvent } from "react";
import type { ReactElement } from "react";
import { Link } from "react-router-dom";
import { Button, ErrorState, Field, Input } from "@medveris/ui";
import { errorMessage } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { MfaChallenge } from "./MfaChallenge";
import { PasswordField } from "./PasswordField";
import { FieldIcon } from "../../components/FieldIcon";
import type { AuthRole } from "./AuthAccountTypeSelector";

/**
 * Email + password sign-in for patient and healthcare provider accounts.
 * Distinct post-auth destinations: providers land on the staff workspace flow,
 * patients land on the portal. MFA challenge is preserved end-to-end.
 */
export function SignInForm({ role }: { role: AuthRole }): ReactElement {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await login(email, password);
      if (result.mfaRequired && result.challengeId) setChallengeId(result.challengeId);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  if (challengeId) {
    return <MfaChallenge challengeId={challengeId} email={email} onReset={() => { setChallengeId(null); setPassword(""); }} />;
  }

  return (
    <form className="mv-stack" onSubmit={submitPassword} noValidate={false}>
      {error ? <ErrorState message={error} /> : null}
      {role === "provider" ? <p className="mv-small mv-muted">Healthcare staff sign in with their verified account. New staff should use the invitation link from their facility administrator.</p> : null}
      <Field label="Email" htmlFor="auth-email">
        <Input id="auth-email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Enter your email address" icon={<FieldIcon name="mail" />} required />
      </Field>
      <Field label="Password" htmlFor="auth-password">
        <PasswordField id="auth-password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" icon={<FieldIcon name="lock" />} required />
      </Field>
      <Button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
      <p className="mv-authx__consent mv-authx__inline">
        <Link to="/forgot-password">Forgot password?</Link>
      </p>
    </form>
  );
}
