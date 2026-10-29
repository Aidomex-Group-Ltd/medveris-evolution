import { useMemo } from "react";
import {
  CARE_LEVELS,
  EQUIVALENT_NOTICE,
  MODULES,
  NO_STANDALONE_LEVEL_LABEL,
  OFFICIAL_LEVEL_SOURCES,
  REGISTRATION_KINDS,
  SERVICE_CATEGORIES,
  careLevelLabel,
  describeLevel,
  recommendModules,
  serviceCategory,
  suggestedEquivalent,
  type CareLevel,
  type LevelStatus,
  type OfficialLevelSource,
} from "@medveris/domain";
import { Badge, Button, Field, Input, Notice, Select, Textarea } from "@medveris/ui";

/** Category and level as one form value; official level and Medveris equivalent stay in separate fields. */
export interface ClassificationValue {
  serviceCategory: string;
  serviceSubtype: string;
  levelStatus: LevelStatus;
  officialLevel: string;
  officialLevelSource: string;
  officialLevelReference: string;
  equivalentLevel: string;
  equivalentJustification: string;
}

export interface RegistrationValue {
  kind: string;
  identifier: string;
  issuer: string;
}

export const OWNERSHIP_LABELS: Record<string, string> = {
  "private-for-profit": "Private for-profit",
  "private-not-for-profit": "Private not-for-profit",
  public: "Public",
  other: "Other",
};

const STATUS_LABELS: Record<LevelStatus, string> = {
  official: "Official Ministry / NHFR level",
  "medveris-equivalent": "Medveris equivalent (operational mapping)",
  "not-applicable": NO_STANDALONE_LEVEL_LABEL,
  "not-yet-assigned": "Not yet assigned (registration or confirmation pending)",
};

const SOURCE_LABELS: Record<OfficialLevelSource, string> = {
  nhfr: "National Health Facility Registry (NHFR)",
  "moh-registration": "MoH registration",
  "moh-licence": "MoH / district licence",
  "other-official": "Other official designation",
};

export function initialClassification(category = "clinic"): ClassificationValue {
  const policy = serviceCategory(category).levelPolicy;
  return {
    serviceCategory: category,
    serviceSubtype: "",
    levelStatus: policy === "no-standalone-level" ? "not-applicable" : "not-yet-assigned",
    officialLevel: "",
    officialLevelSource: "nhfr",
    officialLevelReference: "",
    equivalentLevel: "",
    equivalentJustification: "",
  };
}

/** Request fields for the API; only the fields that belong to the chosen status are sent. */
export function classificationPayload(value: ClassificationValue): Record<string, unknown> {
  return {
    serviceCategory: value.serviceCategory,
    serviceSubtype: value.serviceSubtype || null,
    levelStatus: value.levelStatus,
    officialLevel: value.levelStatus === "official" ? value.officialLevel || null : null,
    officialLevelSource: value.levelStatus === "official" ? value.officialLevelSource || null : null,
    officialLevelReference: value.levelStatus === "official" ? value.officialLevelReference.trim() || null : null,
    equivalentLevel: value.levelStatus === "medveris-equivalent" ? value.equivalentLevel || null : null,
    equivalentJustification: value.levelStatus === "medveris-equivalent" ? value.equivalentJustification.trim() || null : null,
  };
}

function allowedStatuses(policy: string): LevelStatus[] {
  switch (policy) {
    case "hospital-registered":
    case "official-only":
      return ["official", "not-yet-assigned"];
    case "equivalent-suggested":
      return ["official", "medveris-equivalent", "not-yet-assigned"];
    default:
      return ["not-applicable", "official"];
  }
}

export function LevelFields({ value, onChange, idPrefix }: { value: ClassificationValue; onChange: (next: ClassificationValue) => void; idPrefix: string }) {
  const category = serviceCategory(value.serviceCategory);
  const statuses = allowedStatuses(category.levelPolicy);
  const suggestion = suggestedEquivalent(category.code, value.serviceSubtype || null);
  const set = (patch: Partial<ClassificationValue>) => onChange({ ...value, ...patch });

  function chooseCategory(code: string) {
    const next = initialClassification(code);
    onChange({ ...next, officialLevelReference: value.officialLevelReference });
  }

  function chooseStatus(status: LevelStatus) {
    set({ levelStatus: status, equivalentLevel: status === "medveris-equivalent" ? value.equivalentLevel || suggestion || "" : value.equivalentLevel });
  }

  return (
    <div className="mv-stack">
      <div className="mv-form-grid">
        <Field label="Facility or service category" htmlFor={`${idPrefix}-category`}>
          <Select id={`${idPrefix}-category`} value={value.serviceCategory} onChange={(event) => chooseCategory(event.target.value)}>
            {SERVICE_CATEGORIES.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}
          </Select>
        </Field>
        {category.subtypes?.length ? (
          <Field label="Subtype" htmlFor={`${idPrefix}-subtype`}>
            <Select id={`${idPrefix}-subtype`} value={value.serviceSubtype} onChange={(event) => set({ serviceSubtype: event.target.value })}>
              <option value="">Not specified</option>
              {category.subtypes.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}
            </Select>
          </Field>
        ) : null}
        <Field label="Level of care status" htmlFor={`${idPrefix}-status`}>
          <Select id={`${idPrefix}-status`} value={value.levelStatus} onChange={(event) => chooseStatus(event.target.value as LevelStatus)}>
            {statuses.map((status) => <option key={status} value={status}>{status === "official" && category.levelPolicy === "no-standalone-level" ? "Official level confirmed by the Ministry" : STATUS_LABELS[status]}</option>)}
          </Select>
        </Field>
      </div>

      {category.levelPolicy === "hospital-registered" ? (
        <Notice tone="info" title="Use the registered hospital designation">Select General/District (Level 5), Regional Referral (Level 6) or National Referral (Level 7) from the Ministry registration. Medveris never infers a hospital level from its name or specialty; choose “not yet assigned” until it is confirmed.</Notice>
      ) : null}
      {category.levelPolicy === "no-standalone-level" && value.levelStatus === "not-applicable" ? (
        <Notice tone="info" title={NO_STANDALONE_LEVEL_LABEL}>A standalone {category.label.toLowerCase()} is not placed in an HC tier. Record its regulator licence below; it is kept separately from the care level.</Notice>
      ) : null}

      {value.levelStatus === "official" ? (
        <div className="mv-form-grid">
          <Field label="Official level" htmlFor={`${idPrefix}-official`}>
            <Select id={`${idPrefix}-official`} value={value.officialLevel} onChange={(event) => set({ officialLevel: event.target.value })} required>
              <option value="">Choose the registered level</option>
              {CARE_LEVELS.filter((level) => category.allowedOfficialLevels.includes(level.code)).map((level) => <option key={level.code} value={level.code}>{level.label}</option>)}
            </Select>
          </Field>
          <Field label="Source of the official level" htmlFor={`${idPrefix}-source`}>
            <Select id={`${idPrefix}-source`} value={value.officialLevelSource} onChange={(event) => set({ officialLevelSource: event.target.value })}>
              {OFFICIAL_LEVEL_SOURCES.map((source) => <option key={source} value={source}>{SOURCE_LABELS[source]}</option>)}
            </Select>
          </Field>
          <Field label="Registry ID or registration reference" htmlFor={`${idPrefix}-reference`}>
            <Input id={`${idPrefix}-reference`} value={value.officialLevelReference} onChange={(event) => set({ officialLevelReference: event.target.value })} minLength={2} maxLength={200} required />
          </Field>
        </div>
      ) : null}

      {value.levelStatus === "medveris-equivalent" ? (
        <div className="mv-stack">
          <Notice tone="warning" title="Medveris equivalent — confirm service scope">{EQUIVALENT_NOTICE}</Notice>
          <div className="mv-form-grid">
            <Field label="Equivalent used for product setup" htmlFor={`${idPrefix}-equivalent`} hint={suggestion ? `Suggested: ${careLevelLabel(suggestion)}-equivalent` : undefined}>
              <Select id={`${idPrefix}-equivalent`} value={value.equivalentLevel} onChange={(event) => set({ equivalentLevel: event.target.value })} required>
                <option value="">Choose an equivalent</option>
                {CARE_LEVELS.filter((level) => category.allowedEquivalentLevels.includes(level.code)).map((level) => <option key={level.code} value={level.code}>{level.label}-equivalent</option>)}
              </Select>
            </Field>
          </div>
          {value.equivalentLevel && value.equivalentLevel !== suggestion ? (
            <Field label="Registered services that support this equivalent" htmlFor={`${idPrefix}-justification`} hint="HC III and HC IV profiles imply broader maternity, inpatient, diagnostic, emergency or surgical scope. At least 10 characters.">
              <Textarea id={`${idPrefix}-justification`} value={value.equivalentJustification} onChange={(event) => set({ equivalentJustification: event.target.value })} minLength={10} maxLength={2000} required />
            </Field>
          ) : null}
        </div>
      ) : null}

      <LevelSummary value={value} />
    </div>
  );
}

/** The label, source and recommendations that the server will derive from this choice. */
export function LevelSummary({ value }: { value: ClassificationValue }) {
  const preview = useMemo(() => {
    const level = {
      levelStatus: value.levelStatus,
      officialLevel: (value.officialLevel || null) as CareLevel | null,
      officialLevelSource: (value.officialLevelSource || null) as OfficialLevelSource | null,
      officialLevelReference: value.officialLevelReference || null,
      equivalentLevel: (value.equivalentLevel || null) as CareLevel | null,
    };
    return { display: describeLevel(level), recommendation: recommendModules(value.serviceCategory, level) };
  }, [value]);
  const moduleLabel = (code: string) => MODULES.find((module) => module.code === code)?.label ?? code;
  return (
    <div className="mv-stack mv-small" style={{ gap: 8 }}>
      <div className="mv-row">
        <span className="mv-level-badge"><Badge tone={preview.display.official ? "success" : preview.display.status === "medveris-equivalent" ? "warning" : "neutral"}>{preview.display.label}</Badge></span>
        <span className="mv-muted">{preview.display.source}</span>
      </div>
      <div><strong>Suggested modules:</strong> {preview.recommendation.modules.map(moduleLabel).join(", ")}</div>
      {preview.recommendation.hmisCandidates.length ? <div><strong>National HMIS forms to confirm:</strong> {preview.recommendation.hmisCandidates.join(", ")}</div> : null}
      {preview.recommendation.notes.map((note) => <div key={note} className="mv-muted">{note}</div>)}
    </div>
  );
}

export function RegistrationFields({ category, value, onChange, idPrefix }: { category: string; value: RegistrationValue[]; onChange: (next: RegistrationValue[]) => void; idPrefix: string }) {
  const suggested = serviceCategory(category).registrationKinds;
  const kinds = [...REGISTRATION_KINDS].sort((a, b) => Number(suggested.includes(b.code)) - Number(suggested.includes(a.code)));
  const update = (index: number, patch: Partial<RegistrationValue>) => onChange(value.map((entry, position) => position === index ? { ...entry, ...patch } : entry));
  return (
    <div className="mv-stack" style={{ gap: 10 }}>
      <div className="mv-small mv-muted">Regulator, licence and registry identifiers are recorded separately from the care level. Usually collected for this category: {suggested.map((code) => REGISTRATION_KINDS.find((kind) => kind.code === code)?.label ?? code).join("; ")}.</div>
      {value.map((entry, index) => (
        <div className="mv-form-grid" key={index}>
          <Field label="Identifier type" htmlFor={`${idPrefix}-kind-${index}`}>
            <Select id={`${idPrefix}-kind-${index}`} value={entry.kind} onChange={(event) => update(index, { kind: event.target.value })}>
              {kinds.map((kind) => <option key={kind.code} value={kind.code}>{kind.label}</option>)}
            </Select>
          </Field>
          <Field label="Identifier" htmlFor={`${idPrefix}-id-${index}`}><Input id={`${idPrefix}-id-${index}`} value={entry.identifier} onChange={(event) => update(index, { identifier: event.target.value })} maxLength={120} required /></Field>
          <Field label="Issuer (optional)" htmlFor={`${idPrefix}-issuer-${index}`}><Input id={`${idPrefix}-issuer-${index}`} value={entry.issuer} onChange={(event) => update(index, { issuer: event.target.value })} maxLength={200} /></Field>
          <div><Button type="button" variant="ghost" size="sm" onClick={() => onChange(value.filter((_, position) => position !== index))}>Remove</Button></div>
        </div>
      ))}
      {value.length < 10 ? (
        <div><Button type="button" variant="secondary" size="sm" onClick={() => onChange([...value, { kind: suggested[0] ?? "other", identifier: "", issuer: "" }])}>Add an identifier</Button></div>
      ) : null}
    </div>
  );
}

export function registrationsPayload(value: RegistrationValue[]): Array<Record<string, string>> {
  return value.filter((entry) => entry.identifier.trim()).map((entry) => ({ kind: entry.kind, identifier: entry.identifier.trim(), ...(entry.issuer.trim() ? { issuer: entry.issuer.trim() } : {}) }));
}
