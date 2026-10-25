// Explicit, action-based permissions. A permission never bypasses contextual
// checks (tenant, care relationship, consent, sensitivity, expiry).
import type { Role } from "./index.js";

export const PERMISSIONS = [
  "patient.profile.read_self",
  "patient.record.read_released_self",
  "patient.consent.manage_self",
  "patient.appointment.manage_self",
  "patient.proxy.read",
  "patient.register",
  "patient.lookup.exact",

  "clinical.worklist.read_assigned",
  "clinical.record.read_authorized",
  "clinical.note.create",
  "clinical.note.sign",
  "clinical.note.amend",
  "clinical.order.create",
  "clinical.result.review",
  "clinical.referral.manage",
  "clinical.care_team.manage",
  "emergency.access.activate",

  "nursing.observation.record",
  "nursing.care_plan.manage",
  "ward.assignment.read",
  "medication.administration.record",
  "medication.dispense",

  "diagnostic.report.create",
  "diagnostic.report.sign",
  "diagnostic.report.correct",

  "exchange.access.request",
  "exchange.record.read_granted",

  "organization.membership.manage",
  "organization.structure.manage",
  "workforce.onboard.manage",
  "role_grant.request",
  "role_grant.approve",
  "privilege.review",
  "credential.review",
  "care_team.read",

  "finance.dashboard.read",
  "finance.payment.record",

  "public_health.aggregate.read",
  "public_health.disclosure.authorize",

  "content.read",
  "content.draft",
  "content.review",
  "content.publish",
  "content.archive",
  "content.opportunity.manage",
  "content.opportunity.moderate",
  "content.source.manage",

  "dashboard.patient.read",
  "dashboard.clinician.read",
  "dashboard.specialist.read",
  "dashboard.operations.read",
  "dashboard.administration.read",
  "dashboard.finance.read",
  "dashboard.public_health.read",
  "dashboard.support.read",

  "inventory.catalogue.read",
  "inventory.catalogue.manage",
  "inventory.stock.read",
  "inventory.stock.receive",
  "inventory.stock.issue",
  "inventory.stock.adjust",
  "inventory.transfer.manage",
  "inventory.count.manage",
  "inventory.recall.manage",
  "inventory.asset.read",
  "inventory.asset.manage",
  "inventory.report.read",

  "audit.read",
  "platform.operations.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const patientSelf: Permission[] = [
  "patient.profile.read_self",
  "patient.record.read_released_self",
  "patient.consent.manage_self",
  "patient.appointment.manage_self",
  "content.read",
  "dashboard.patient.read",
];

const inventoryRead: Permission[] = [
  "inventory.catalogue.read",
  "inventory.stock.read",
  "inventory.asset.read",
  "inventory.report.read",
];

const clinicalCore: Permission[] = [
  ...inventoryRead,
  "clinical.worklist.read_assigned",
  "clinical.record.read_authorized",
  "clinical.note.create",
  "clinical.order.create",
  "clinical.result.review",
  "clinical.referral.manage",
  "clinical.care_team.manage",
  "care_team.read",
  "content.read",
  "dashboard.clinician.read",
];

const nursingCore: Permission[] = [
  ...inventoryRead,
  "inventory.stock.receive",
  "inventory.stock.issue",
  "clinical.worklist.read_assigned",
  "clinical.record.read_authorized",
  "clinical.note.create",
  "nursing.observation.record",
  "nursing.care_plan.manage",
  "ward.assignment.read",
  "medication.administration.record",
  "care_team.read",
  "content.read",
  "dashboard.clinician.read",
];

const diagnosticCore: Permission[] = [
  ...inventoryRead,
  "clinical.record.read_authorized",
  "diagnostic.report.create",
  "diagnostic.report.sign",
  "diagnostic.report.correct",
  "clinical.worklist.read_assigned",
  "care_team.read",
  "content.read",
  "dashboard.clinician.read",
];

const contentEditorCore: Permission[] = [
  "content.read",
  "content.draft",
  "content.review",
  "content.source.manage",
];

const adminCore: Permission[] = [
  "organization.membership.manage",
  "inventory.catalogue.read",
  "inventory.catalogue.manage",
  "inventory.stock.read",
  "inventory.stock.receive",
  "inventory.stock.issue",
  "inventory.stock.adjust",
  "inventory.transfer.manage",
  "inventory.count.manage",
  "inventory.recall.manage",
  "inventory.asset.read",
  "inventory.asset.manage",
  "inventory.report.read",
  "organization.structure.manage",
  "workforce.onboard.manage",
  "role_grant.request",
  "role_grant.approve",
  "privilege.review",
  "clinical.care_team.manage",
  "care_team.read",
  "audit.read",
  "content.read",
  "content.draft",
  "content.review",
  "content.publish",
  "content.archive",
  "content.opportunity.manage",
  "content.opportunity.moderate",
  "content.source.manage",
  "dashboard.administration.read",
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  patient: patientSelf,
  proxy: [
    "patient.profile.read_self",
    "patient.record.read_released_self",
    "patient.appointment.manage_self",
    "patient.proxy.read",
    "content.read",
    "dashboard.patient.read",
  ],
  receptionist: [
    "patient.register",
    "patient.lookup.exact",
    "content.read",
    "dashboard.operations.read",
  ],
  nurse: nursingCore,
  midwife: [...nursingCore, "clinical.note.sign"],
  clinician: [...clinicalCore, "clinical.note.sign", "clinical.note.amend", "emergency.access.activate"],
  specialist_clinician: [
    ...clinicalCore,
    "clinical.note.sign",
    "clinical.note.amend",
    "emergency.access.activate",
    "dashboard.specialist.read",
  ],
  diagnostic_practitioner: diagnosticCore,
  pharmacist: [
    ...inventoryRead,
    "inventory.catalogue.manage",
    "inventory.stock.receive",
    "inventory.stock.issue",
    "inventory.stock.adjust",
    "inventory.transfer.manage",
    "inventory.count.manage",
    "inventory.recall.manage",
    "clinical.record.read_authorized",
    "medication.dispense",
    "content.read",
    "dashboard.operations.read",
  ],
  theatre: [...inventoryRead, "inventory.stock.issue", "clinical.worklist.read_assigned", "ward.assignment.read", "content.read", "dashboard.operations.read"],
  laboratory: diagnosticCore,
  radiology: diagnosticCore,
  department_lead: [
    ...clinicalCore,
    "clinical.note.sign",
    "clinical.note.amend",
    "role_grant.request",
    "care_team.read",
    "dashboard.specialist.read",
  ],
  facility_admin: adminCore,
  hr: [
    ...inventoryRead,
    "organization.structure.manage",
    "workforce.onboard.manage",
    "role_grant.request",
    "care_team.read",
    "content.read",
    "dashboard.administration.read",
  ],
  records: [
    ...inventoryRead,
    "patient.register",
    "patient.lookup.exact",
    "care_team.read",
    "content.read",
    "dashboard.operations.read",
  ],
  quality: [
    ...inventoryRead,
    "care_team.read",
    "audit.read",
    "content.read",
    "content.review",
    "content.publish",
    "content.archive",
    "dashboard.administration.read",
  ],
  finance: [
    ...inventoryRead,
    "finance.dashboard.read",
    "finance.payment.record",
    "content.read",
    "dashboard.finance.read",
  ],
  public_health: [
    "public_health.aggregate.read",
    "public_health.disclosure.authorize",
    "content.read",
    "content.draft",
    "content.review",
    "dashboard.public_health.read",
  ],
  research: ["public_health.aggregate.read", "content.read", "dashboard.public_health.read"],
  auditor: [...inventoryRead, "audit.read", "care_team.read", "content.read", "dashboard.administration.read"],
  credential_reviewer: ["credential.review", "content.read", "dashboard.administration.read"],
  housekeeping: [...inventoryRead, "inventory.stock.issue", "inventory.stock.receive", "content.read", "dashboard.support.read"],
  porter: [...inventoryRead, "content.read", "dashboard.support.read"],
  mortuary: [...inventoryRead, "inventory.stock.issue", "content.read", "dashboard.support.read"],
  cssd: [...inventoryRead, "inventory.stock.receive", "inventory.stock.issue", "inventory.transfer.manage", "inventory.count.manage", "content.read", "dashboard.support.read"],
  biomedical: [...inventoryRead, "inventory.catalogue.manage", "inventory.stock.receive", "inventory.stock.adjust", "inventory.transfer.manage", "inventory.asset.manage", "content.read", "dashboard.support.read"],
  it_admin: ["platform.operations.manage", "content.read", "dashboard.support.read"],
  content_editor: [...contentEditorCore, "dashboard.operations.read"],
  content_reviewer: [...contentEditorCore, "content.publish", "content.archive", "dashboard.operations.read"],
  opportunity_moderator: [
    "content.read",
    "content.opportunity.manage",
    "content.opportunity.moderate",
    "dashboard.operations.read",
  ],
};

export function permissionsForRoles(roles: readonly Role[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) out.add(permission);
  }
  return out;
}
