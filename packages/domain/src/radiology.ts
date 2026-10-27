/**
 * Versioned structured radiology report templates.
 *
 * These are starting structures only. A facility can use a template after a radiologist approves it,
 * which records a facility copy with the approver and note. Fields start empty: nothing here asserts
 * a normal finding. Classification is free text because no classification scheme has been approved.
 */

export const RADIOLOGY_CATALOGUE_VERSION = 1;

export type RadiologyFieldKind = "text" | "longtext" | "select";

export interface RadiologyField {
  key: string;
  label: string;
  section: "request" | "technique" | "findings" | "conclusion";
  kind: RadiologyFieldKind;
  required: boolean;
  options?: readonly string[];
  hint?: string;
}

export interface RadiologyTemplateDefinition {
  code: string;
  name: string;
  modality: string;
  bodyRegion: string;
  fields: readonly RadiologyField[];
  measurementUnits: readonly string[];
}

export interface RadiologyMeasurement {
  label: string;
  value: number;
  unit: string;
}

export interface RadiologyReportContent {
  fields: Record<string, string>;
  measurements: RadiologyMeasurement[];
}

/** Fields that every template must keep required, whatever a facility configures. */
export const RADIOLOGY_CORE_REQUIRED = Object.freeze(["indication", "technique", "imageQuality", "impression"]);

const request: RadiologyField[] = [
  { key: "indication", label: "Clinical indication", section: "request", kind: "longtext", required: true },
  { key: "history", label: "Relevant history", section: "request", kind: "longtext", required: false },
];
const technique = (hint: string): RadiologyField[] => [
  { key: "technique", label: "Technique and protocol", section: "technique", kind: "longtext", required: true, hint },
  { key: "comparison", label: "Comparison studies", section: "technique", kind: "longtext", required: false, hint: "Name the prior study and date, or state that none is available." },
  { key: "imageQuality", label: "Image quality", section: "technique", kind: "select", required: true, options: ["adequate", "limited", "non-diagnostic"] },
  { key: "limitations", label: "Limitations", section: "technique", kind: "longtext", required: false },
];
const conclusion: RadiologyField[] = [
  { key: "impression", label: "Impression", section: "conclusion", kind: "longtext", required: true },
  { key: "recommendations", label: "Recommendations", section: "conclusion", kind: "longtext", required: false },
  { key: "classification", label: "Classification (optional)", section: "conclusion", kind: "text", required: false, hint: "Name the scheme and category if one is used." },
];
const findings = (items: Array<[key: string, label: string, required?: boolean]>): RadiologyField[] =>
  items.map(([key, label, required = true]) => ({ key, label, section: "findings", kind: "longtext", required }));

function template(
  code: string, name: string, modality: string, bodyRegion: string, techniqueHint: string,
  findingFields: Array<[string, string, boolean?]>, measurementUnits: string[] = ["mm", "cm"],
): RadiologyTemplateDefinition {
  return Object.freeze({
    code, name, modality, bodyRegion, measurementUnits: Object.freeze(measurementUnits),
    fields: Object.freeze([...request, ...technique(techniqueHint), ...findings(findingFields), ...conclusion]),
  });
}

export const RADIOLOGY_TEMPLATE_CATALOGUE: readonly RadiologyTemplateDefinition[] = Object.freeze([
  template("chest-xray", "Chest X-ray", "XR", "Chest", "Projections obtained, for example PA and lateral.", [
    ["linesTubes", "Lines, tubes and devices", false], ["lungs", "Lungs and airways"], ["pleura", "Pleura"],
    ["heartMediastinum", "Heart and mediastinum"], ["bonesSoftTissues", "Bones and soft tissues"],
  ]),
  template("abdominal-xray", "Abdominal X-ray", "XR", "Abdomen", "Projections obtained and patient position.", [
    ["bowelGas", "Bowel gas pattern"], ["freeAir", "Free intraperitoneal air"], ["calcifications", "Calcifications"],
    ["bonesSoftTissues", "Bones and soft tissues"], ["devices", "Lines, tubes and devices", false],
  ]),
  template("msk-xray", "Musculoskeletal X-ray", "XR", "Musculoskeletal", "Region, side and projections obtained.", [
    ["alignment", "Alignment"], ["bones", "Bones, including fracture assessment"], ["joints", "Joints"],
    ["softTissues", "Soft tissues"], ["hardware", "Orthopaedic hardware", false],
  ]),
  template("ct-head", "CT head", "CT", "Head", "Contrast phase, if any, and reconstructions.", [
    ["brainParenchyma", "Brain parenchyma"], ["haemorrhage", "Intracranial haemorrhage"], ["ventricles", "Ventricles and extra-axial spaces"],
    ["midline", "Midline structures"], ["skullSinuses", "Skull, orbits and sinuses"],
  ]),
  template("ct-chest-abdomen", "CT chest and abdomen", "CT", "Chest and abdomen", "Contrast agent, phases and reconstructions.", [
    ["lungsAirways", "Lungs and airways"], ["mediastinum", "Mediastinum and hila"], ["pleura", "Pleura"],
    ["liverBiliary", "Liver and biliary system"], ["pancreasSpleenAdrenals", "Pancreas, spleen and adrenal glands"],
    ["kidneys", "Kidneys and urinary tract"], ["bowel", "Bowel and mesentery"], ["vessels", "Vessels and lymph nodes"],
    ["bones", "Bones"],
  ]),
  template("mri-brain", "MRI brain", "MR", "Brain", "Field strength, sequences and contrast.", [
    ["parenchyma", "Brain parenchyma"], ["diffusion", "Diffusion-weighted imaging"], ["ventricles", "Ventricles and extra-axial spaces"],
    ["vessels", "Vascular flow voids"], ["posteriorFossa", "Posterior fossa"], ["skullBase", "Skull base and orbits", false],
  ]),
  template("mri-spine", "MRI spine", "MR", "Spine", "Spinal level covered, sequences and contrast.", [
    ["alignment", "Alignment"], ["vertebrae", "Vertebral bodies and marrow"], ["discs", "Intervertebral discs by level"],
    ["canal", "Spinal canal and cord or cauda equina"], ["foramina", "Neural foramina"], ["paraspinal", "Paraspinal soft tissues", false],
  ]),
  template("us-abdomen", "Abdominal ultrasound", "US", "Abdomen", "Transducer and approach; fasting status.", [
    ["liver", "Liver"], ["gallbladderBiliary", "Gallbladder and bile ducts"], ["pancreas", "Pancreas", false],
    ["spleen", "Spleen"], ["kidneys", "Kidneys"], ["aorta", "Aorta", false], ["freeFluid", "Free fluid"],
  ]),
  template("us-pelvis", "Pelvic ultrasound", "US", "Pelvis", "Transabdominal and/or transvaginal approach.", [
    ["uterus", "Uterus"], ["endometrium", "Endometrium"], ["rightOvary", "Right ovary and adnexa"],
    ["leftOvary", "Left ovary and adnexa"], ["bladder", "Urinary bladder", false], ["freeFluid", "Free fluid"],
  ]),
  template("us-obstetric", "Obstetric ultrasound", "US", "Obstetric", "Approach and gestational dating method used.", [
    ["fetalNumber", "Number of fetuses and chorionicity"], ["cardiacActivity", "Fetal cardiac activity"], ["presentation", "Presentation"],
    ["placenta", "Placenta"], ["amnioticFluid", "Amniotic fluid"], ["biometry", "Biometry and dating"], ["anatomy", "Fetal anatomy surveyed", false],
  ]),
  template("doppler", "Doppler study", "US", "Vascular", "Vessels examined, side and Doppler modes.", [
    ["vesselsExamined", "Vessels examined"], ["patency", "Patency and flow"], ["waveforms", "Spectral waveforms"],
    ["stenosis", "Stenosis or occlusion"], ["otherFindings", "Other findings", false],
  ], ["cm/s", "mm", "cm"]),
  template("other", "Other examination", "OT", "Other", "Examination performed and technique.", [
    ["findings", "Findings"],
  ]),
]);

export function radiologyTemplate(code: string): RadiologyTemplateDefinition | undefined {
  return RADIOLOGY_TEMPLATE_CATALOGUE.find((item) => item.code === code);
}

/**
 * Applies a facility's required-field choices. Core fields stay required; unknown keys are rejected.
 */
export function configureRadiologyTemplate(definition: RadiologyTemplateDefinition, requiredKeys?: readonly string[]): RadiologyTemplateDefinition {
  if (!requiredKeys) return definition;
  const known = new Set(definition.fields.map((field) => field.key));
  const unknown = requiredKeys.filter((key) => !known.has(key));
  if (unknown.length) throw new Error(`Unknown template fields: ${unknown.join(", ")}`);
  const required = new Set([...RADIOLOGY_CORE_REQUIRED, ...requiredKeys]);
  return { ...definition, fields: definition.fields.map((field) => ({ ...field, required: required.has(field.key) })) };
}

export interface RadiologyContentProblems {
  /** Structural problems: always rejected, even for drafts. */
  invalid: string[];
  /** Required fields still empty: rejected only when signing. */
  missing: string[];
}

/** Validates report content against a template definition. */
export function checkRadiologyContent(definition: RadiologyTemplateDefinition, content: RadiologyReportContent): RadiologyContentProblems {
  const invalid: string[] = [];
  const byKey = new Map(definition.fields.map((field) => [field.key, field]));
  for (const [key, value] of Object.entries(content.fields)) {
    const field = byKey.get(key);
    if (!field) {
      invalid.push(`unknown field ${key}`);
      continue;
    }
    if (typeof value !== "string") invalid.push(`${field.label} must be text`);
    else if (field.kind === "select" && value !== "" && !field.options?.includes(value)) invalid.push(`${field.label} must be one of ${field.options?.join(", ")}`);
    else if (value.length > 20_000) invalid.push(`${field.label} is too long`);
  }
  for (const [index, measurement] of content.measurements.entries()) {
    if (!measurement.label?.trim()) invalid.push(`measurement ${index + 1} needs a label`);
    if (typeof measurement.value !== "number" || !Number.isFinite(measurement.value) || measurement.value < 0) invalid.push(`measurement ${index + 1} needs a non-negative number`);
    if (!definition.measurementUnits.includes(measurement.unit)) invalid.push(`measurement ${index + 1} unit must be one of ${definition.measurementUnits.join(", ")}`);
  }
  const missing = definition.fields
    .filter((field) => field.required && !(content.fields[field.key] ?? "").trim())
    .map((field) => field.label);
  return { invalid, missing };
}

export type RadiologyReportStatus = "draft" | "preliminary" | "final" | "corrected" | "cancelled";

const RADIOLOGY_TRANSITIONS: Record<RadiologyReportStatus, readonly RadiologyReportStatus[]> = {
  draft: ["preliminary", "final", "cancelled"],
  preliminary: ["final", "cancelled"],
  final: ["corrected"],
  corrected: ["corrected"],
  cancelled: [],
};

export function canTransitionRadiologyReport(from: RadiologyReportStatus, to: RadiologyReportStatus): boolean {
  return RADIOLOGY_TRANSITIONS[from].includes(to);
}

/** Server-generated accession: facility prefix, date and a random suffix (unique index enforces uniqueness). */
export function radiologyAccession(facilitySlug: string, at = new Date(), random = crypto.getRandomValues(new Uint8Array(3))): string {
  const prefix = facilitySlug.replace(/[^a-z0-9]/gi, "").slice(0, 4).toUpperCase() || "FAC";
  const date = at.toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = [...random].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `RAD-${prefix}-${date}-${suffix}`;
}
