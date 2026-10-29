import { useState, type FormEvent } from "react";
import { OWNERSHIP_TYPES, WORKSPACE_KINDS } from "@medveris/domain";
import { Button, ErrorState, Field, Input, Notice, Select, Tabs } from "@medveris/ui";
import { api, errorMessage } from "../lib/api";
import {
  LevelFields,
  OWNERSHIP_LABELS,
  RegistrationFields,
  classificationPayload,
  initialClassification,
  registrationsPayload,
  type ClassificationValue,
  type RegistrationValue,
} from "./LevelFields";

type Path = "independent" | "organization" | "join";

const PATHS: { value: Path; label: string }[] = [
  { value: "independent", label: "Independent workspace" },
  { value: "organization", label: "New organization or hospital" },
  { value: "join", label: "Join an organization" },
];

const PATH_DESCRIPTIONS: Record<Path, string> = {
  independent: "A standalone facility, department or service unit. You become its owner and can run it alone; invite staff whenever you are ready. It can join a larger organization later.",
  organization: "Create a hospital, health system or facility group with its first site. Add more sites, departments and units once you are signed in.",
  join: "Create your workspace and ask an organization to link it, using the join code its administrator gave you. Nothing is shared until an organization administrator approves.",
};

export const WORKSPACE_KIND_LABELS: Record<string, string> = {
  facility: "Facility",
  department: "Department operating on its own",
  "service-unit": "Service unit (e.g. pharmacy, laboratory, imaging)",
};

interface Result {
  workspace: { id: string; name: string };
  organization: { id: string; name: string } | null;
  link: { status: string; organizationName: string } | null;
  verificationEmail: { delivered: boolean; detail?: string };
}

export function WorkspaceSignup() {
  const [path, setPath] = useState<Path>("independent");
  const [owner, setOwner] = useState({ givenName: "", familyName: "", email: "", password: "" });
  const [organization, setOrganization] = useState({ name: "", kind: "hospital", ownership: "private-for-profit" });
  const [joinCode, setJoinCode] = useState("");
  const [shareHistory, setShareHistory] = useState(false);
  const [details, setDetails] = useState({ name: "", workspaceKind: "facility", ownership: "private-for-profit", district: "", city: "" });
  const [classification, setClassification] = useState<ClassificationValue>(() => initialClassification("clinic"));
  const [registrations, setRegistrations] = useState<RegistrationValue[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const workspace = {
      name: details.name, workspaceKind: details.workspaceKind, ownership: details.ownership, district: details.district, city: details.city,
      country: "Uganda", registrations: registrationsPayload(registrations), ...classificationPayload(classification),
    };
    const body = path === "organization"
      ? { path, owner, organization, workspace }
      : path === "join"
        ? { path, owner, workspace, joinCode: joinCode.trim(), historyVisibility: shareHistory ? "full-history" : "from-link-date" }
        : { path, owner, workspace };
    try {
      setResult(await api<Result>("/auth/register/workspace", { method: "POST", body }));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="mv-stack">
        <Notice tone="success" title="Workspace created">
          <strong>{result.workspace.name}</strong> is ready and you are its owner.
          {result.organization ? <> It is the first site of <strong>{result.organization.name}</strong>.</> : null}
          {result.link ? <> Your request to join <strong>{result.link.organizationName}</strong> is waiting for an organization administrator; until then the workspace runs independently and shares nothing.</> : null}
          <div className="mv-small" style={{ marginTop: 6 }}>{result.verificationEmail.delivered ? "A verification email was sent." : result.verificationEmail.detail ?? "The verification email could not be sent."}</div>
        </Notice>
        <Notice tone="info">Registration does not verify licences, registry IDs or credentials. Staff features need MFA enrolment at first sign-in.</Notice>
        <Button onClick={() => window.location.assign("/login")}>Continue to sign in</Button>
      </div>
    );
  }

  return (
    <form className="mv-stack" onSubmit={submit}>
      {error ? <ErrorState title="Not registered" message={error} /> : null}
      <Tabs label="Onboarding path" value={path} onChange={setPath} options={PATHS} />
      <p className="mv-small mv-muted" style={{ margin: 0 }}>{PATH_DESCRIPTIONS[path]}</p>

      <fieldset className="mv-stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="mv-small"><strong>Primary owner</strong></legend>
        <div className="mv-form-grid">
          <Field label="Given name" htmlFor="ws-given"><Input id="ws-given" autoComplete="given-name" value={owner.givenName} onChange={(event) => setOwner({ ...owner, givenName: event.target.value })} required maxLength={120} /></Field>
          <Field label="Family name" htmlFor="ws-family"><Input id="ws-family" autoComplete="family-name" value={owner.familyName} onChange={(event) => setOwner({ ...owner, familyName: event.target.value })} required maxLength={120} /></Field>
        </div>
        <Field label="Email" htmlFor="ws-email"><Input id="ws-email" type="email" autoComplete="email" value={owner.email} onChange={(event) => setOwner({ ...owner, email: event.target.value })} required /></Field>
        <Field label="Password" htmlFor="ws-password" hint="At least 10 characters."><Input id="ws-password" type="password" autoComplete="new-password" minLength={10} value={owner.password} onChange={(event) => setOwner({ ...owner, password: event.target.value })} required /></Field>
      </fieldset>

      {path === "organization" ? (
        <fieldset className="mv-stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="mv-small"><strong>Organization</strong></legend>
          <Field label="Organization name" htmlFor="ws-org-name"><Input id="ws-org-name" value={organization.name} onChange={(event) => setOrganization({ ...organization, name: event.target.value })} required minLength={2} maxLength={200} /></Field>
          <div className="mv-form-grid">
            <Field label="Kind" htmlFor="ws-org-kind">
              <Select id="ws-org-kind" value={organization.kind} onChange={(event) => setOrganization({ ...organization, kind: event.target.value })}>
                <option value="hospital">Hospital</option><option value="health-system">Health system</option><option value="facility-group">Facility group</option>
                <option value="faith-based-network">Faith-based network</option><option value="other">Other</option>
              </Select>
            </Field>
            <Field label="Ownership" htmlFor="ws-org-ownership">
              <Select id="ws-org-ownership" value={organization.ownership} onChange={(event) => setOrganization({ ...organization, ownership: event.target.value })}>
                {OWNERSHIP_TYPES.map((type) => <option key={type} value={type}>{OWNERSHIP_LABELS[type]}</option>)}
              </Select>
            </Field>
          </div>
        </fieldset>
      ) : null}

      {path === "join" ? (
        <fieldset className="mv-stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="mv-small"><strong>Organization to join</strong></legend>
          <Field label="Join code" htmlFor="ws-join" hint="Given to you by the organization's administrator. Approval is still required."><Input id="ws-join" value={joinCode} onChange={(event) => setJoinCode(event.target.value)} required minLength={12} maxLength={64} autoComplete="off" /></Field>
          <label className="mv-row mv-small">
            <input type="checkbox" checked={shareHistory} onChange={(event) => setShareHistory(event.target.checked)} />
            Include this workspace's activity from before approval in the organization's aggregate reports
          </label>
        </fieldset>
      ) : null}

      <fieldset className="mv-stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="mv-small"><strong>{path === "organization" ? "First site" : "Workspace"}</strong></legend>
        <Field label="Name" htmlFor="ws-name"><Input id="ws-name" value={details.name} onChange={(event) => setDetails({ ...details, name: event.target.value })} required minLength={2} maxLength={200} /></Field>
        <div className="mv-form-grid">
          <Field label="Workspace type" htmlFor="ws-kind">
            <Select id="ws-kind" value={details.workspaceKind} onChange={(event) => setDetails({ ...details, workspaceKind: event.target.value })}>
              {WORKSPACE_KINDS.map((kind) => <option key={kind} value={kind}>{WORKSPACE_KIND_LABELS[kind]}</option>)}
            </Select>
          </Field>
          <Field label="Ownership" htmlFor="ws-ownership">
            <Select id="ws-ownership" value={details.ownership} onChange={(event) => setDetails({ ...details, ownership: event.target.value })}>
              {OWNERSHIP_TYPES.map((type) => <option key={type} value={type}>{OWNERSHIP_LABELS[type]}</option>)}
            </Select>
          </Field>
          <Field label="District" htmlFor="ws-district"><Input id="ws-district" value={details.district} onChange={(event) => setDetails({ ...details, district: event.target.value })} maxLength={120} /></Field>
          <Field label="Town or city" htmlFor="ws-city"><Input id="ws-city" value={details.city} onChange={(event) => setDetails({ ...details, city: event.target.value })} maxLength={120} /></Field>
        </div>
        <LevelFields idPrefix="ws" value={classification} onChange={setClassification} />
        <RegistrationFields idPrefix="ws-reg" category={classification.serviceCategory} value={registrations} onChange={setRegistrations} />
      </fieldset>

      <Button type="submit" disabled={busy}>{busy ? "Creating…" : path === "join" ? "Create workspace and request to join" : "Create workspace"}</Button>
    </form>
  );
}
