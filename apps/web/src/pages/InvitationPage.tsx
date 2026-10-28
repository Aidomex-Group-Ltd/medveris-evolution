import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Badge, Button, Card, DataList, ErrorState, Field, Input, LoadingState, Notice } from "@medveris/ui";
import { AuthFrame } from "../components/AuthFrame";
import { ApiError, api, errorMessage, setCsrfToken } from "../lib/api";
import { useAuth } from "../lib/auth";

type InvitationStatus = "pending" | "accepted" | "revoked" | "declined" | "expired" | "facility_unavailable" | "inviter_unauthorized";

interface InvitationView {
  status: InvitationStatus;
  facility: { id: string; name: string; facilityType: string | null; city: string | null; country: string | null };
  roles: string[];
  invitedEmail: string;
  expiresAt: string;
  recipientHasAccount: boolean;
  viewer: { authenticated: boolean; matchesRecipient: boolean | null; acceptedByViewer: boolean };
}

interface Accepted {
  outcome: "accepted" | "already-accepted";
  facility: { name: string };
  roles: string[];
}

type Load = { kind: "loading" } | { kind: "ready"; view: InvitationView } | { kind: "invalid" } | { kind: "failed"; message: string };

const TOKEN = /^[A-Za-z0-9_-]{20,200}$/;

const CLOSED: Record<Exclude<InvitationStatus, "pending" | "accepted">, { title: string; body: string }> = {
  expired: { title: "Invitation expired", body: "Invitations are valid for 7 days. Ask the facility administrator to send a new one." },
  revoked: { title: "Invitation withdrawn", body: "The facility withdrew this invitation, or replaced it with a newer one. Use the most recent invitation email, or ask the facility administrator." },
  declined: { title: "Invitation declined", body: "This invitation was declined and can no longer be used. Ask the facility administrator if you want to join after all." },
  facility_unavailable: { title: "Facility unavailable", body: "This facility is not currently accepting staff. Contact the facility administrator." },
  inviter_unauthorized: { title: "Invitation no longer valid", body: "The person who sent this invitation can no longer invite staff. Ask a current facility administrator for a new invitation." },
};

function roleLabel(role: string): string {
  return role.replace(/_/g, " ");
}

export function InvitationPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const location = useLocation();
  const navigate = useNavigate();
  const { me, loading: authLoading, refresh, logout } = useAuth();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [version, setVersion] = useState(0);
  const [accepted, setAccepted] = useState<Accepted | null>(null);
  const [busy, setBusy] = useState<"accept" | "decline" | "register" | "switch" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (authLoading) return;
    if (!TOKEN.test(token)) {
      setLoad({ kind: "invalid" });
      return;
    }
    const controller = new AbortController();
    setLoad({ kind: "loading" });
    api<InvitationView>("/auth/invitations/status", { method: "POST", body: { token }, signal: controller.signal })
      .then((view) => setLoad({ kind: "ready", view }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad(error instanceof ApiError && error.status === 404 ? { kind: "invalid" } : { kind: "failed", message: errorMessage(error) });
      });
    return () => controller.abort();
  }, [token, authLoading, me?.user.id, version]);

  async function run(action: NonNullable<typeof busy>, fn: () => Promise<void>) {
    setBusy(action);
    setActionError(null);
    try {
      await fn();
    } catch (error) {
      setActionError(errorMessage(error));
      reload();
    } finally {
      setBusy(null);
    }
  }

  const accept = () => run("accept", async () => {
    const result = await api<Accepted>("/auth/invitations/accept", { method: "POST", body: { token } });
    setAccepted(result);
    await refresh();
  });

  const decline = () => {
    if (!window.confirm("Decline this invitation? The link will stop working.")) return;
    void run("decline", async () => {
      await api("/auth/invitations/decline", { method: "POST", body: { token } });
      reload();
    });
  };

  const switchAccount = () => run("switch", async () => {
    await logout();
    reload();
  });

  const signIn = () => navigate("/login?as=staff", { state: { from: `${location.pathname}${location.search}` } });

  const register = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (data.get("password") !== data.get("confirm")) {
      setActionError("The passwords do not match");
      return;
    }
    void run("register", async () => {
      const result = await api<{ csrfToken: string }>("/auth/invitations/register", {
        method: "POST",
        body: { token, givenName: String(data.get("givenName") ?? ""), familyName: String(data.get("familyName") ?? ""), password: String(data.get("password") ?? "") },
      });
      setCsrfToken(result.csrfToken);
      await refresh();
    });
  };

  const continueToStaffSignIn = <Button type="button" onClick={() => navigate("/facility-staff")}>Continue to Facility staff sign-in</Button>;
  const home = <Link to={me ? "/" : "/login"}>{me ? "Return to Medveris" : "Go to sign in"}</Link>;

  function body() {
    if (accepted) {
      return (
        <Card title="Invitation accepted">
          <div className="mv-stack">
            <Notice tone="success" title={accepted.outcome === "accepted" ? "Invitation accepted" : "Already accepted"}>
              You are now registered as staff at <strong>{accepted.facility.name}</strong> ({accepted.roles.map(roleLabel).join(", ")}). Continue to Facility staff sign-in to access your authorized workspace.
            </Notice>
            {me && !me.user.mfaEnrolled ? <p className="mv-small mv-muted">Before the workspace opens you will set up two-step verification with an authenticator app.</p> : null}
            {continueToStaffSignIn}
          </div>
        </Card>
      );
    }
    if (load.kind === "loading") return <Card title="Facility invitation"><LoadingState label="Checking your invitation" /></Card>;
    if (load.kind === "failed") return <ErrorState title="Could not check the invitation" message={load.message} onRetry={reload} />;
    if (load.kind === "invalid") {
      return (
        <Card title="Invitation not found" description="This invitation link is incomplete or not valid.">
          <div className="mv-stack">
            <p className="mv-small">Open the link directly from the invitation email, without editing it. If it still fails, ask the facility administrator to send a new invitation.</p>
            <p className="mv-small">{home}</p>
          </div>
        </Card>
      );
    }

    const { view } = load;
    const facility = (
      <DataList items={[
        { label: "Facility", value: <strong>{view.facility.name}</strong> },
        { label: "Location", value: [view.facility.city, view.facility.country].filter(Boolean).join(", ") || "Not provided" },
        ...(view.facility.facilityType ? [{ label: "Facility type", value: view.facility.facilityType }] : []),
        ...(view.roles.length ? [{ label: "Role", value: <span className="mv-row">{view.roles.map((role) => <Badge key={role} tone="info">{roleLabel(role)}</Badge>)}</span> }] : []),
        { label: "Invited email", value: view.invitedEmail },
      ]} />
    );

    if (view.status === "accepted") {
      if (view.viewer.acceptedByViewer) {
        return (
          <Card title="Invitation already accepted">
            <div className="mv-stack">
              {facility}
              <Notice tone="success">You already accepted this invitation. Continue to Facility staff sign-in to open your workspace.</Notice>
              {continueToStaffSignIn}
            </div>
          </Card>
        );
      }
      return (
        <Card title="Invitation already used">
          <div className="mv-stack">
            <Notice tone="warning">{view.viewer.authenticated
              ? "This invitation was accepted by a different account and cannot be transferred. Sign in with the account that accepted it, or ask the facility administrator for a new invitation."
              : "This invitation has already been accepted. If you accepted it, use Facility staff sign-in."}</Notice>
            <div className="mv-row">
              {view.viewer.authenticated ? <Button variant="secondary" type="button" disabled={busy !== null} onClick={() => void switchAccount()}>Sign out and switch account</Button> : <Button type="button" onClick={() => navigate("/login?as=staff")}>Facility staff sign-in</Button>}
              {home}
            </div>
          </div>
        </Card>
      );
    }

    if (view.status !== "pending") {
      const closed = CLOSED[view.status];
      return (
        <Card title={closed.title}>
          <div className="mv-stack">
            <Notice tone="warning">{closed.body}</Notice>
            <p className="mv-small">{home}</p>
          </div>
        </Card>
      );
    }

    return (
      <Card title="Join this facility" description={`Invitation valid until ${new Date(view.expiresAt).toLocaleString()}`}>
        <div className="mv-stack">
          {facility}
          <p className="mv-small">
            Accepting associates your Medveris account with this facility in the role shown. Opening the facility workspace also requires two-step verification, and the facility can change or remove your access at any time.
          </p>
          {actionError ? <ErrorState title="Action not completed" message={actionError} /> : null}
          {!view.viewer.authenticated ? (
            view.recipientHasAccount ? (
              <div className="mv-stack">
                <Notice tone="info" title="Sign in to continue">An account already exists for {view.invitedEmail}. Sign in with it; you will return here to accept.</Notice>
                <Button type="button" onClick={signIn}>Sign in to accept</Button>
                <Button variant="ghost" type="button" disabled={busy !== null} onClick={decline}>Decline invitation</Button>
              </div>
            ) : (
              <form className="mv-stack" onSubmit={register}>
                <Notice tone="info" title="Create your staff account">Create the account for {view.invitedEmail}. You will then confirm the invitation.</Notice>
                <div className="mv-form-grid">
                  <Field label="Given name" htmlFor="invite-given"><Input id="invite-given" name="givenName" autoComplete="given-name" required maxLength={120} /></Field>
                  <Field label="Family name" htmlFor="invite-family"><Input id="invite-family" name="familyName" autoComplete="family-name" required maxLength={120} /></Field>
                </div>
                <Field label="Password" htmlFor="invite-password" hint="At least 10 characters."><Input id="invite-password" name="password" type="password" autoComplete="new-password" minLength={10} required /></Field>
                <Field label="Confirm password" htmlFor="invite-confirm"><Input id="invite-confirm" name="confirm" type="password" autoComplete="new-password" minLength={10} required /></Field>
                <Button type="submit" disabled={busy !== null}>{busy === "register" ? "Creating account…" : "Create account"}</Button>
                <Button variant="ghost" type="button" disabled={busy !== null} onClick={decline}>Decline invitation</Button>
                <p className="mv-small mv-muted">Already have a Medveris account under this email? <Button variant="ghost" size="sm" type="button" onClick={signIn}>Sign in instead</Button></p>
              </form>
            )
          ) : view.viewer.matchesRecipient ? (
            <div className="mv-stack">
              <p className="mv-small mv-muted">Signed in as {me?.user.email}.</p>
              <Button type="button" disabled={busy !== null} onClick={() => void accept()}>{busy === "accept" ? "Accepting…" : "Accept invitation"}</Button>
              <Button variant="secondary" type="button" disabled={busy !== null} onClick={decline}>Decline invitation</Button>
            </div>
          ) : (
            <div className="mv-stack">
              <Notice tone="warning" title="Different account">
                You are signed in as {me?.user.email}, but this invitation was sent to {view.invitedEmail}. It can only be accepted by the invited account.
              </Notice>
              <Button type="button" disabled={busy !== null} onClick={() => void switchAccount()}>{busy === "switch" ? "Signing out…" : "Sign out and switch account"}</Button>
              <p className="mv-small">{home}</p>
            </div>
          )}
        </div>
      </Card>
    );
  }

  return (
    <AuthFrame
      eyebrow="Staff invitation"
      heading="You have been invited to join a facility."
      intro={<p>Review the invitation, then accept it to be registered as staff. The facility and role come from the invitation the administrator sent and cannot be changed here.</p>}
    >
      {body()}
    </AuthFrame>
  );
}
