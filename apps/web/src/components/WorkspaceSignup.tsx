import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { defaultLevelStatus, OWNERSHIP_TYPES } from "@medveris/domain";
import { Button, ErrorState, Field, Input, Notice, Select } from "@medveris/ui";
import { api, ApiError, errorMessage, setCsrfToken } from "../lib/api";
import { useAuth } from "../lib/auth";
import { OWNERSHIP_LABELS } from "./LevelFields";

type Path = "independent" | "organization" | "join";
type JoinMethod = "search" | "code" | "invitation";
type StepId = "unit" | "organization" | "find" | "account" | "review";

export const WORKSPACE_KIND_LABELS: Record<string, string> = {
  facility: "Facility",
  department: "Department operating on its own",
  "service-unit": "Service unit (e.g. pharmacy, laboratory, imaging)",
};

/** The onboarding choices, exactly as offered. */
const PATH_OPTIONS: { value: Path; label: string; description: string }[] = [
  { value: "independent", label: "Independent workspace", description: "Run your own laboratory, imaging centre, pharmacy or clinic. You own it, and nothing is shared with anyone." },
  { value: "organization", label: "New organization or hospital", description: "Set up a hospital or group of facilities and become its first administrator. Add departments and staff after signing in." },
  { value: "join", label: "Join an organization", description: "Link your unit to an existing organization through its join code or approval, or accept a staff invitation." },
];

interface UnitType { value: string; label: string; serviceCategory: string; serviceSubtype?: string; workspaceKind: "facility" | "service-unit" }

const UNIT_TYPES: UnitType[] = [
  { value: "laboratory", label: "Laboratory", serviceCategory: "laboratory", workspaceKind: "service-unit" },
  { value: "imaging", label: "Imaging / radiology centre", serviceCategory: "imaging", workspaceKind: "service-unit" },
  { value: "pharmacy", label: "Pharmacy", serviceCategory: "pharmacy", workspaceKind: "service-unit" },
  { value: "drug-shop", label: "Drug shop", serviceCategory: "drug-shop", workspaceKind: "service-unit" },
  { value: "clinic", label: "General outpatient clinic", serviceCategory: "clinic", serviceSubtype: "general-outpatient", workspaceKind: "facility" },
  { value: "specialty-clinic", label: "Specialty clinic", serviceCategory: "clinic", serviceSubtype: "specialty", workspaceKind: "facility" },
  { value: "dental", label: "Dental clinic", serviceCategory: "dental", workspaceKind: "facility" },
  { value: "ophthalmology", label: "Eye-care centre", serviceCategory: "ophthalmology", workspaceKind: "facility" },
  { value: "medical-centre", label: "Medical centre", serviceCategory: "medical-centre", workspaceKind: "facility" },
  { value: "specialty-service", label: "Other specialist service", serviceCategory: "specialty-service", workspaceKind: "service-unit" },
];

const SITE_TYPES: UnitType[] = [
  { value: "hospital", label: "Hospital", serviceCategory: "hospital", workspaceKind: "facility" },
  { value: "medical-centre", label: "Medical centre", serviceCategory: "medical-centre", workspaceKind: "facility" },
  { value: "health-centre", label: "Health centre", serviceCategory: "health-centre", workspaceKind: "facility" },
  { value: "clinic", label: "Clinic", serviceCategory: "clinic", serviceSubtype: "general-outpatient", workspaceKind: "facility" },
];

const ORGANIZATION_KINDS = [
  { value: "hospital", label: "Hospital" },
  { value: "health-system", label: "Health system" },
  { value: "facility-group", label: "Group of facilities" },
  { value: "faith-based-network", label: "Faith-based network" },
  { value: "other", label: "Other" },
];

const STEP_LABELS: Record<StepId, string> = {
  find: "Find the organization",
  unit: "Your unit",
  organization: "Organization",
  account: "Your account",
  review: "Review",
};

function stepsFor(path: Path | ""): StepId[] {
  if (path === "independent") return ["unit", "account", "review"];
  if (path === "organization") return ["organization", "account", "review"];
  if (path === "join") return ["find", "unit", "account", "review"];
  return [];
}

interface FoundOrganization { id: string; name: string; kind: string }

interface RegisterResult {
  workspace: { id: string; name: string; serviceCategory: string };
  organization: { id: string; name: string } | null;
  link: { status: string; organizationName: string } | null;
  verificationEmail: { delivered: boolean; detail?: string };
  session: { csrfToken: string; next: string };
}

type Errors = Partial<Record<string, string>>;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function invitationToken(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.searchParams.get("token");
  } catch {
    return /^[A-Za-z0-9_-]{20,}$/.test(trimmed) ? trimmed : null;
  }
}

export function WorkspaceSignup() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [path, setPath] = useState<Path | "">("");
  const [stepIndex, setStepIndex] = useState(0);
  const [unit, setUnit] = useState({ type: "", name: "", district: "", city: "", ownership: "private-for-profit" });
  const [organization, setOrganization] = useState({ name: "", kind: "hospital", ownership: "private-for-profit", siteType: "hospital", siteName: "", district: "" });
  const [owner, setOwner] = useState({ givenName: "", familyName: "", email: "", password: "", confirm: "" });
  const [joinMethod, setJoinMethod] = useState<JoinMethod>("search");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FoundOrganization[] | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [invitation, setInvitation] = useState("");
  const [target, setTarget] = useState<FoundOrganization | null>(null);
  const [shareHistory, setShareHistory] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<{ message: string; action?: ReactNode } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [created, setCreated] = useState<RegisterResult | null>(null);

  const steps = stepsFor(path);
  const step = steps[stepIndex] ?? null;

  function choosePath(next: Path | "") {
    setPath(next);
    setStepIndex(0);
    setErrors({});
    setFailure(null);
  }

  function validate(id: StepId): Errors {
    const found: Errors = {};
    if (id === "unit") {
      if (!unit.type) found.unitType = "Choose what kind of unit or service this is";
      if (unit.name.trim().length < 2) found.unitName = "Enter the name patients and staff know it by";
    }
    if (id === "organization") {
      if (organization.name.trim().length < 2) found.orgName = "Enter the organization or hospital name";
    }
    if (id === "find") {
      if (joinMethod === "invitation") {
        if (!invitationToken(invitation)) found.invitation = "Paste the full link from the invitation email";
      } else if (!target) {
        found.find = joinMethod === "code" ? "Check the join code to confirm the organization" : "Search for the organization and select it";
      }
    }
    if (id === "account") {
      if (!owner.givenName.trim()) found.givenName = "Required";
      if (!owner.familyName.trim()) found.familyName = "Required";
      if (!EMAIL_PATTERN.test(owner.email.trim())) found.email = "Enter a valid email address; it is used to sign in and recover your account";
      if (owner.password.length < 10) found.password = "Use at least 10 characters";
      else if (owner.password !== owner.confirm) found.confirm = "The passwords do not match";
    }
    return found;
  }

  function next() {
    if (!step) return;
    const found = validate(step);
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length) return;
    if (step === "find" && joinMethod === "invitation") {
      navigate(`/accept-invitation?token=${encodeURIComponent(invitationToken(invitation)!)}`);
      return;
    }
    setStepIndex((index) => Math.min(index + 1, steps.length - 1));
  }

  function back() {
    setErrors({});
    setFailure(null);
    setStepIndex((index) => Math.max(index - 1, 0));
  }

  async function searchOrganizations() {
    if (query.trim().length < 3) {
      setErrors({ query: "Type at least 3 letters of the name" });
      return;
    }
    setBusy("search");
    setErrors({});
    setTarget(null);
    try {
      const response = await api<{ organizations: FoundOrganization[] }>(`/auth/organizations/search?q=${encodeURIComponent(query.trim())}`);
      setResults(response.organizations);
    } catch (cause) {
      setErrors({ query: errorMessage(cause) });
    } finally {
      setBusy(null);
    }
  }

  async function checkCode() {
    setBusy("code");
    setErrors({});
    setTarget(null);
    try {
      const response = await api<{ organization: FoundOrganization }>("/auth/join-codes/lookup", { method: "POST", body: { joinCode: joinCode.trim() } });
      setTarget(response.organization);
    } catch (cause) {
      setErrors({ code: cause instanceof ApiError && cause.code === "validation_error" ? "Join codes are at least 12 letters, numbers, dashes or underscores" : errorMessage(cause) });
    } finally {
      setBusy(null);
    }
  }

  function payload() {
    const ownerBody = { givenName: owner.givenName.trim(), familyName: owner.familyName.trim(), email: owner.email.trim(), password: owner.password };
    if (path === "organization") {
      const site = SITE_TYPES.find((type) => type.value === organization.siteType)!;
      return {
        path, owner: ownerBody,
        organization: { name: organization.name.trim(), kind: organization.kind, ownership: organization.ownership },
        workspace: {
          name: organization.siteName.trim() || organization.name.trim(), workspaceKind: site.workspaceKind, serviceCategory: site.serviceCategory,
          serviceSubtype: site.serviceSubtype ?? null, ownership: organization.ownership, district: organization.district.trim(), country: "Uganda",
          levelStatus: defaultLevelStatus(site.serviceCategory), registrations: [],
        },
      };
    }
    const type = UNIT_TYPES.find((candidate) => candidate.value === unit.type)!;
    const workspace = {
      name: unit.name.trim(), workspaceKind: type.workspaceKind, serviceCategory: type.serviceCategory, serviceSubtype: type.serviceSubtype ?? null,
      ownership: unit.ownership, district: unit.district.trim(), city: unit.city.trim(), country: "Uganda",
      levelStatus: defaultLevelStatus(type.serviceCategory), registrations: [],
    };
    if (path === "join") {
      return {
        path, owner: ownerBody, workspace, historyVisibility: shareHistory ? "full-history" : "from-link-date",
        ...(joinMethod === "code" ? { joinCode: joinCode.trim() } : { organizationId: target?.id }),
      };
    }
    return { path, owner: ownerBody, workspace };
  }

  /** Sends the user back to the step that can fix the problem, keeping everything they entered. */
  function recover(cause: unknown) {
    const goTo = (id: StepId) => setStepIndex(Math.max(steps.indexOf(id), 0));
    if (cause instanceof ApiError) {
      if (cause.code === "email_exists") {
        goTo("account");
        setErrors({ email: "This email already has a Medveris account" });
        setFailure({ message: cause.message, action: <span className="mv-row mv-small"><Link to="/login">Sign in</Link><Link to="/forgot-password">Reset password</Link></span> });
        return;
      }
      if (cause.code === "join_code_invalid" || cause.code === "organization_not_found") {
        goTo("find");
        setTarget(null);
        setFailure({ message: cause.message });
        return;
      }
      if (cause.status === 429) {
        setFailure({ message: "Too many signup attempts from this network. Wait a minute, then submit again; nothing was created." });
        return;
      }
      const details = Array.isArray(cause.details) ? (cause.details as Array<{ path?: string; message?: string }>) : [];
      const first = details[0]?.path ?? "";
      if (first.startsWith("owner")) goTo("account");
      else if (first.startsWith("organization")) goTo("organization");
      else if (first.startsWith("workspace")) goTo(path === "organization" ? "organization" : "unit");
      else if (first.startsWith("joinCode")) goTo("find");
      setFailure({ message: details.length ? `${cause.message}: ${details.map((detail) => detail.message).join("; ")}` : cause.message });
      return;
    }
    setFailure({ message: `${errorMessage(cause)}. Check your connection and submit again; nothing was created.` });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (step !== "review") {
      next();
      return;
    }
    for (const id of steps) {
      const found = validate(id);
      if (Object.keys(found).length) {
        setErrors(found);
        setStepIndex(steps.indexOf(id));
        return;
      }
    }
    setBusy("submit");
    setFailure(null);
    try {
      const result = await api<RegisterResult>("/auth/register/workspace", { method: "POST", body: payload() });
      setCreated(result);
      setCsrfToken(result.session.csrfToken);
      const me = await refresh();
      if (me) navigate(`${result.session.next}?welcome=1`, { replace: true });
    } catch (cause) {
      recover(cause);
    } finally {
      setBusy(null);
    }
  }

  if (created) {
    return (
      <Notice tone="success" title="Workspace created">
        <strong>{created.workspace.name}</strong> is ready. <Link to="/login">Sign in</Link> to set up two-step verification and open it.
      </Notice>
    );
  }

  const selectedUnit = UNIT_TYPES.find((type) => type.value === unit.type);
  const option = PATH_OPTIONS.find((candidate) => candidate.value === path);

  return (
    <form className="mv-stack" onSubmit={submit} noValidate>
      <Field label="How will you use Medveris?" htmlFor="ws-path" hint={option?.description}>
        <Select id="ws-path" value={path} onChange={(event) => choosePath(event.target.value as Path | "")} disabled={busy === "submit"}>
          <option value="">Choose an option</option>
          {PATH_OPTIONS.map((candidate) => <option key={candidate.value} value={candidate.value}>{candidate.label}</option>)}
        </Select>
      </Field>

      {steps.length ? <StepProgress steps={steps} current={stepIndex} /> : null}
      {!created ? <Notice tone="info" title="Free to start">Creating a workspace costs nothing and starts a free trial. There is no onboarding fee, and nothing is charged until an administrator reviews and accepts a paid plan.</Notice> : null}
      {failure ? <ErrorState title="Not finished yet" message={failure.message} /> : null}
      {failure?.action ?? null}

      {step === "unit" ? (
        <div className="mv-stack">
          <Field label={path === "join" ? "Type of unit joining" : "What are you setting up?"} htmlFor="ws-unit-type" error={errors.unitType}>
            <Select id="ws-unit-type" value={unit.type} onChange={(event) => setUnit({ ...unit, type: event.target.value })}>
              <option value="">Choose your unit or service</option>
              {UNIT_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
            </Select>
          </Field>
          <Field label="Unit name" htmlFor="ws-unit-name" error={errors.unitName} hint="For example, Kisenyi Diagnostic Laboratory.">
            <Input id="ws-unit-name" value={unit.name} onChange={(event) => setUnit({ ...unit, name: event.target.value })} maxLength={200} autoComplete="organization" />
          </Field>
          <div className="mv-form-grid">
            <Field label="District (optional)" htmlFor="ws-unit-district"><Input id="ws-unit-district" value={unit.district} onChange={(event) => setUnit({ ...unit, district: event.target.value })} maxLength={120} /></Field>
            <Field label="Town or city (optional)" htmlFor="ws-unit-city"><Input id="ws-unit-city" value={unit.city} onChange={(event) => setUnit({ ...unit, city: event.target.value })} maxLength={120} /></Field>
          </div>
          <Field label="Ownership" htmlFor="ws-unit-ownership">
            <Select id="ws-unit-ownership" value={unit.ownership} onChange={(event) => setUnit({ ...unit, ownership: event.target.value })}>
              {OWNERSHIP_TYPES.map((type) => <option key={type} value={type}>{OWNERSHIP_LABELS[type]}</option>)}
            </Select>
          </Field>
          {selectedUnit && ["laboratory", "imaging", "pharmacy", "drug-shop"].includes(selectedUnit.serviceCategory) ? (
            <p className="mv-small mv-muted" style={{ margin: 0 }}>You will land on your {selectedUnit.label.toLowerCase()} work queue, with reception and the till ready to use.</p>
          ) : null}
        </div>
      ) : null}

      {step === "organization" ? (
        <div className="mv-stack">
          <Field label="Organization or hospital name" htmlFor="ws-org-name" error={errors.orgName}>
            <Input id="ws-org-name" value={organization.name} onChange={(event) => setOrganization({ ...organization, name: event.target.value })} maxLength={200} autoComplete="organization" />
          </Field>
          <div className="mv-form-grid">
            <Field label="Type" htmlFor="ws-org-kind">
              <Select id="ws-org-kind" value={organization.kind} onChange={(event) => setOrganization({ ...organization, kind: event.target.value })}>
                {ORGANIZATION_KINDS.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
              </Select>
            </Field>
            <Field label="Ownership" htmlFor="ws-org-ownership">
              <Select id="ws-org-ownership" value={organization.ownership} onChange={(event) => setOrganization({ ...organization, ownership: event.target.value })}>
                {OWNERSHIP_TYPES.map((type) => <option key={type} value={type}>{OWNERSHIP_LABELS[type]}</option>)}
              </Select>
            </Field>
          </div>
          <div className="mv-form-grid">
            <Field label="Main site type" htmlFor="ws-site-type">
              <Select id="ws-site-type" value={organization.siteType} onChange={(event) => setOrganization({ ...organization, siteType: event.target.value })}>
                {SITE_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
              </Select>
            </Field>
            <Field label="District (optional)" htmlFor="ws-org-district"><Input id="ws-org-district" value={organization.district} onChange={(event) => setOrganization({ ...organization, district: event.target.value })} maxLength={120} /></Field>
          </div>
          <Field label="Main site name (optional)" htmlFor="ws-site-name" hint="Leave blank to use the organization name.">
            <Input id="ws-site-name" value={organization.siteName} onChange={(event) => setOrganization({ ...organization, siteName: event.target.value })} maxLength={200} />
          </Field>
        </div>
      ) : null}

      {step === "find" ? (
        <div className="mv-stack">
          <Field label="How were you invited?" htmlFor="ws-join-method">
            <Select id="ws-join-method" value={joinMethod} onChange={(event) => { setJoinMethod(event.target.value as JoinMethod); setTarget(null); setErrors({}); }}>
              <option value="search">Find the organization by name and request approval</option>
              <option value="code">I have a join code from its administrator</option>
              <option value="invitation">I received a staff invitation email</option>
            </Select>
          </Field>
          {joinMethod === "search" ? (
            <div className="mv-stack">
              <div className="mv-row" style={{ alignItems: "flex-end" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Field label="Organization name" htmlFor="ws-org-search" error={errors.query}>
                    <Input id="ws-org-search" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void searchOrganizations(); } }} maxLength={120} autoComplete="off" />
                  </Field>
                </div>
                <Button variant="secondary" onClick={() => void searchOrganizations()} disabled={busy === "search"}>{busy === "search" ? "Searching…" : "Search"}</Button>
              </div>
              {results && !results.length ? <p className="mv-small mv-muted" style={{ margin: 0 }}>No organization matches “{query.trim()}”. Check the spelling, or ask its administrator for a join code.</p> : null}
              {results?.length ? (
                <fieldset className="mv-stack" style={{ border: 0, padding: 0, margin: 0, gap: 6 }}>
                  <legend className="mv-small">Select the organization</legend>
                  {results.map((found) => (
                    <label key={found.id} className="mv-check mv-choice">
                      <input type="radio" name="ws-org" checked={target?.id === found.id} onChange={() => setTarget(found)} />
                      <span><strong>{found.name}</strong> <span className="mv-small mv-muted">{ORGANIZATION_KINDS.find((kind) => kind.value === found.kind)?.label ?? found.kind}</span></span>
                    </label>
                  ))}
                </fieldset>
              ) : null}
              <p className="mv-small mv-muted" style={{ margin: 0 }}>Your request waits for an organization administrator to approve it. Until then your unit runs on its own and shares nothing.</p>
            </div>
          ) : null}
          {joinMethod === "code" ? (
            <div className="mv-row" style={{ alignItems: "flex-end" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Field label="Join code" htmlFor="ws-join-code" error={errors.code} hint="Approval is still required after you join.">
                  <Input id="ws-join-code" value={joinCode} onChange={(event) => { setJoinCode(event.target.value); setTarget(null); }} maxLength={64} autoComplete="off" spellCheck={false} />
                </Field>
              </div>
              <Button variant="secondary" onClick={() => void checkCode()} disabled={busy === "code" || joinCode.trim().length < 12}>{busy === "code" ? "Checking…" : "Check code"}</Button>
            </div>
          ) : null}
          {joinMethod === "invitation" ? (
            <Field label="Invitation link" htmlFor="ws-invitation" error={errors.invitation} hint="Paste the link from the email. You will set your password on the next page.">
              <Input id="ws-invitation" value={invitation} onChange={(event) => setInvitation(event.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
          ) : null}
          {target ? <Notice tone="success">Joining <strong>{target.name}</strong></Notice> : null}
          {errors.find ? <p className="mv-field__error" role="alert">{errors.find}</p> : null}
        </div>
      ) : null}

      {step === "account" ? (
        <div className="mv-stack">
          <p className="mv-small mv-muted" style={{ margin: 0 }}>{path === "organization" ? "You will be the organization's first administrator." : "You will be the owner of this workspace."}</p>
          <div className="mv-form-grid">
            <Field label="Given name" htmlFor="ws-given" error={errors.givenName}><Input id="ws-given" autoComplete="given-name" value={owner.givenName} onChange={(event) => setOwner({ ...owner, givenName: event.target.value })} maxLength={120} /></Field>
            <Field label="Family name" htmlFor="ws-family" error={errors.familyName}><Input id="ws-family" autoComplete="family-name" value={owner.familyName} onChange={(event) => setOwner({ ...owner, familyName: event.target.value })} maxLength={120} /></Field>
          </div>
          <Field label="Email" htmlFor="ws-email" error={errors.email}><Input id="ws-email" type="email" autoComplete="email" inputMode="email" value={owner.email} onChange={(event) => setOwner({ ...owner, email: event.target.value })} /></Field>
          <div className="mv-form-grid">
            <Field label="Password" htmlFor="ws-password" error={errors.password} hint="At least 10 characters."><Input id="ws-password" type="password" autoComplete="new-password" value={owner.password} onChange={(event) => setOwner({ ...owner, password: event.target.value })} /></Field>
            <Field label="Confirm password" htmlFor="ws-confirm" error={errors.confirm}><Input id="ws-confirm" type="password" autoComplete="new-password" value={owner.confirm} onChange={(event) => setOwner({ ...owner, confirm: event.target.value })} /></Field>
          </div>
        </div>
      ) : null}

      {step === "review" ? (
        <div className="mv-stack">
          <dl className="mv-review">
            <dt>Option</dt><dd>{option?.label}</dd>
            {path === "organization" ? (
              <>
                <dt>Organization</dt><dd>{organization.name}</dd>
                <dt>Main site</dt><dd>{organization.siteName.trim() || organization.name} · {SITE_TYPES.find((type) => type.value === organization.siteType)?.label}</dd>
              </>
            ) : (
              <>
                <dt>Unit</dt><dd>{unit.name} · {selectedUnit?.label}</dd>
                {unit.district || unit.city ? <><dt>Location</dt><dd>{[unit.city, unit.district].filter(Boolean).join(", ")}</dd></> : null}
              </>
            )}
            {path === "join" ? <><dt>Joining</dt><dd>{target?.name} <span className="mv-small mv-muted">(after approval)</span></dd></> : null}
            <dt>{path === "organization" ? "Administrator" : "Owner"}</dt><dd>{owner.givenName} {owner.familyName} · {owner.email}</dd>
          </dl>
          {path === "join" ? (
            <label className="mv-check">
              <input type="checkbox" checked={shareHistory} onChange={(event) => setShareHistory(event.target.checked)} />
              Include activity from before approval in the organization's summary reports (counts and amounts only)
            </label>
          ) : null}
          <p className="mv-small mv-muted" style={{ margin: 0 }}>Next you will set up two-step verification, then {path === "organization" ? "open your organization's main site" : "go straight to your unit's dashboard"}. Licences and registry numbers can be added later in the workspace profile.</p>
        </div>
      ) : null}

      {steps.length ? (
        <div className="mv-row mv-row--between">
          {stepIndex > 0 ? <Button variant="ghost" onClick={back} disabled={busy === "submit"}>Back</Button> : <span />}
          <Button type="submit" disabled={busy === "submit"}>
            {step === "review" ? (busy === "submit" ? "Creating…" : path === "join" ? "Create and request to join" : "Create workspace")
              : step === "find" && joinMethod === "invitation" ? "Open invitation" : "Continue"}
          </Button>
        </div>
      ) : null}
    </form>
  );
}

function StepProgress({ steps, current }: { steps: StepId[]; current: number }) {
  return (
    <div className="mv-steps" aria-label={`Step ${current + 1} of ${steps.length}: ${STEP_LABELS[steps[current]!]}`}>
      <div className="mv-steps__bar" role="progressbar" aria-valuemin={1} aria-valuemax={steps.length} aria-valuenow={current + 1}>
        <span style={{ width: `${((current + 1) / steps.length) * 100}%` }} />
      </div>
      <ol className="mv-steps__list">
        {steps.map((id, index) => (
          <li key={id} className={index === current ? "mv-steps__item mv-steps__item--current" : index < current ? "mv-steps__item mv-steps__item--done" : "mv-steps__item"} aria-current={index === current ? "step" : undefined}>
            {STEP_LABELS[id]}
          </li>
        ))}
      </ol>
    </div>
  );
}
