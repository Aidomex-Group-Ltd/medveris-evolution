/**
 * Organization patient workflow: a doctor's recommendation for a service or procedure is routed to a
 * department work queue, progressed by that department and, where charged, billed exactly once.
 */

import { DomainError } from "./errors.js";

export const WORKFLOW_DEPARTMENTS = ["laboratory", "imaging", "theatre", "pharmacy", "procedure", "other"] as const;
export type WorkflowDepartment = (typeof WORKFLOW_DEPARTMENTS)[number];

export const WORKFLOW_DEPARTMENT_LABELS: Record<WorkflowDepartment, string> = {
  laboratory: "Laboratory",
  imaging: "Imaging / radiology",
  theatre: "Theatre",
  pharmacy: "Pharmacy",
  procedure: "Procedure / treatment room",
  other: "Other services",
};

export const RECOMMENDATION_STATUSES = ["requested", "accepted", "in-progress", "completed", "declined", "cancelled"] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

/** Statuses in which a recommendation still occupies its department's queue. */
export const OPEN_RECOMMENDATION_STATUSES: readonly RecommendationStatus[] = ["requested", "accepted", "in-progress"];

const recommendationTransitions: Record<RecommendationStatus, readonly RecommendationStatus[]> = {
  requested: ["accepted", "in-progress", "completed", "declined", "cancelled"],
  accepted: ["in-progress", "completed", "declined", "cancelled"],
  "in-progress": ["completed", "declined"],
  completed: [],
  declined: [],
  cancelled: [],
};

/** Department staff progress the work; the requesting side may only withdraw it before work starts. */
export type RecommendationActor = "department" | "requester";

const REQUESTER_STATUSES: readonly RecommendationStatus[] = ["cancelled"];
const DEPARTMENT_STATUSES: readonly RecommendationStatus[] = ["accepted", "in-progress", "completed", "declined"];

export function canTransitionRecommendation(from: RecommendationStatus, to: RecommendationStatus): boolean {
  return recommendationTransitions[from]?.includes(to) ?? false;
}

export function assertRecommendationTransition(from: RecommendationStatus, to: RecommendationStatus, actor: RecommendationActor): void {
  if (to === "cancelled" && from === "in-progress") throw new DomainError("Work has started; ask the department to decline it instead");
  if (!canTransitionRecommendation(from, to)) throw new DomainError(`A ${from} request cannot become ${to}`);
  const allowed = actor === "requester" ? REQUESTER_STATUSES : DEPARTMENT_STATUSES;
  if (!allowed.includes(to)) {
    throw new DomainError(actor === "requester"
      ? "Only the receiving department can accept, start, complete or decline this request"
      : "Only the requesting clinician can cancel this request; decline it instead");
  }
}

export const BILLABLE_ITEM_TYPES = ["service", "procedure", "supply", "pharmacy-item"] as const;
export type BillableItemType = (typeof BILLABLE_ITEM_TYPES)[number];

export const BILLABLE_ITEM_TYPE_LABELS: Record<BillableItemType, string> = {
  service: "Service",
  procedure: "Procedure",
  supply: "Supply",
  "pharmacy-item": "Pharmacy item",
};

/** Price-list categories. They double as the department a recommended item is routed to. */
export const CATALOGUE_CATEGORIES = ["consultation", "laboratory", "imaging", "theatre", "pharmacy", "procedure", "nursing", "supply", "bed", "other"] as const;
export type CatalogueCategory = (typeof CATALOGUE_CATEGORIES)[number];

export function departmentForCategory(category: string): WorkflowDepartment {
  switch (category) {
    case "laboratory":
    case "imaging":
    case "theatre":
    case "pharmacy":
    case "procedure":
      return category;
    case "nursing":
      return "procedure";
    default:
      return "other";
  }
}

export const BILLING_STATUSES = ["unbilled", "billed", "part-paid", "paid"] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

/** Billing state of a line from its invoice's status. */
export function billingStatusForInvoice(invoiceStatus: string | null | undefined): BillingStatus {
  if (invoiceStatus === "paid") return "paid";
  if (invoiceStatus === "part-paid") return "part-paid";
  if (invoiceStatus === "open") return "billed";
  return "unbilled";
}

/**
 * The department a standalone workspace exists to run, so its owner lands on that work queue.
 * Facilities with several departments have none.
 */
export function primaryDepartmentForCategory(serviceCategory: string | null | undefined): WorkflowDepartment | null {
  switch (serviceCategory) {
    case "laboratory":
      return "laboratory";
    case "imaging":
      return "imaging";
    case "pharmacy":
    case "drug-shop":
      return "pharmacy";
    default:
      return null;
  }
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Normalises a Ugandan mobile number to the 2567XXXXXXXX form mobile money providers expect.
 * Accepts 07XXXXXXXX, 7XXXXXXXX, 2567XXXXXXXX and +256 7XX XXX XXX. Returns null for anything else.
 */
export function normalizeUgandaMsisdn(input: string): string | null {
  const digits = input.replace(/[\s()+.-]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  let national: string;
  if (digits.startsWith("256") && digits.length === 12) national = digits.slice(3);
  else if (digits.startsWith("0") && digits.length === 10) national = digits.slice(1);
  else if (digits.length === 9) national = digits;
  else return null;
  if (!/^7\d{8}$/.test(national)) return null;
  return `256${national}`;
}

/** 256772123456 → 2567•••••456, for receipts, lists and logs. */
export function maskMsisdn(msisdn: string): string {
  if (msisdn.length < 7) return "•••";
  return `${msisdn.slice(0, 4)}${"•".repeat(msisdn.length - 7)}${msisdn.slice(-3)}`;
}
