import { useEffect } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { AuthLayout } from "./AuthLayout";
import { AuthBrand } from "./AuthBrand";
import { AuthAccountTypeSelector, type AuthRole } from "./AuthAccountTypeSelector";
import { SignInForm } from "./SignInForm";
import { PatientSignUpForm } from "./PatientSignUpForm";
import { ProviderSignUpForm } from "./ProviderSignUpForm";
import { AuthLegalNotice } from "./AuthLegalNotice";
import { useAuth } from "../../lib/auth";
import { safeReturnPath } from "../../lib/navigation";
import { destination, readMode, readRole, type AuthMode } from "./auth-params";

type Mode = AuthMode;

/**
 * Route-level authentication experience: one streamlined container with an exclusive
 * Patient | Healthcare Provider selector and both sign-in and sign-up journeys.
 *
 * Routes: /login (canonical), /auth (redirect), legacy /register?type=* → /login?role&mode.
 * Query parameters: role (patient|provider), mode (signin|signup), as=staff (legacy),
 * type=patient|facility (legacy). Invitation and recovery flows stay on their own pages:
 * /accept-invitation, /forgot-password, /reset-password, /verify-email, /mfa-setup.
 */
export function AuthComposition() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const role = readRole(params);
  const mode = readMode(params);
  const returnTo = safeReturnPath((location.state as { from?: unknown } | null)?.from);

  function update(next: { role?: AuthRole; mode?: Mode }) {
    const merged = { role: next.role ?? role, mode: next.mode ?? mode };
    const nextParams = new URLSearchParams();
    nextParams.set("role", merged.role);
    nextParams.set("mode", merged.mode);
    setParams(nextParams, { replace: true, state: location.state });
  }

  useEffect(() => {
    if (me) navigate(destination(me, role, returnTo), { replace: true });
  }, [me, role, returnTo, navigate]);

  const title = mode === "signin" ? "Welcome back" : "Create your account";
  const subtitle = mode === "signin"
    ? role === "provider"
      ? "Sign in to your healthcare or facility account."
      : "Sign in to your patient account."
    : role === "provider"
      ? "Set up your organization or join an existing one."
      : "Set up your free patient account to access Medveris.";

  const switchLink = mode === "signin" ? { to: `/login?role=${role}&mode=signup`, label: "Don't have an account? Create one" } : { to: `/login?role=${role}&mode=signin`, label: "Already have an account? Sign in" };

  return (
    <AuthLayout>
      <AuthBrand />
      <AuthAccountTypeSelector role={role} onRoleChange={(nextRole) => update({ role: nextRole })} />
      <div className="mv-authx__card" aria-labelledby="authx-title">
        <header>
          <h1 id="authx-title" className="mv-authx__title">{title}</h1>
          <p className="mv-authx__subtitle">{subtitle}</p>
        </header>
        {mode === "signin" ? (
          <SignInForm role={role} />
        ) : role === "patient" ? (
          <PatientSignUpForm />
        ) : (
          <ProviderSignUpForm />
        )}
        <p className="mv-authx__consent mv-authx__inline">
          <Link to={switchLink.to}>{switchLink.label}</Link>
        </p>
      </div>
      <AuthLegalNotice />
    </AuthLayout>
  );
}
