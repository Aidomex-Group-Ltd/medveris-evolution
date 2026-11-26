import { DomainError } from "./errors.js";
import { CURRENCIES, isCurrencyCode } from "./currency.js";

/**
 * Global price-catalogue rules shared by the API and the web client.
 *
 * A price list moves through a controlled lifecycle. Nothing here converts money between
 * currencies: every price in a list is stated in that list's own currency, and a different
 * currency needs its own approved list.
 */

export const PRICE_LIST_STATUSES = [
  "DRAFT",
  "VALIDATED",
  "PENDING_APPROVAL",
  "APPROVED",
  "PUBLISHED",
  "EXPIRED",
  "ARCHIVED",
] as const;

export type PriceListStatus = (typeof PRICE_LIST_STATUSES)[number];

export type PriceListAction =
  | "validate"
  | "submit"
  | "approve"
  | "reject"
  | "publish"
  | "expire"
  | "archive";

/** Who may take each lifecycle step. Finance owns the money; publishing needs a second role. */
export const PRICE_LIST_ACTION_ROLES: Readonly<Record<PriceListAction, readonly string[]>> = Object.freeze({
  validate: ["facility_admin", "finance", "facility_finance_manager", "global_price_manager", "country_price_administrator", "global_system_administrator"],
  submit: ["facility_admin", "finance", "facility_finance_manager", "global_price_manager", "country_price_administrator", "global_system_administrator"],
  approve: ["facility_admin", "global_system_administrator"],
  reject: ["facility_admin", "global_system_administrator"],
  publish: ["facility_admin", "global_system_administrator"],
  expire: ["facility_admin", "finance", "facility_finance_manager", "global_price_manager", "country_price_administrator", "global_system_administrator"],
  archive: ["facility_admin", "finance", "facility_finance_manager", "global_price_manager", "country_price_administrator", "global_system_administrator"],
});

const TRANSITIONS: Readonly<Record<PriceListStatus, readonly PriceListStatus[]>> = Object.freeze({
  DRAFT: ["VALIDATED", "ARCHIVED"],
  VALIDATED: ["PENDING_APPROVAL", "DRAFT", "ARCHIVED"],
  PENDING_APPROVAL: ["APPROVED", "DRAFT", "ARCHIVED"],
  APPROVED: ["PUBLISHED", "DRAFT", "ARCHIVED"],
  PUBLISHED: ["EXPIRED", "ARCHIVED"],
  EXPIRED: ["ARCHIVED"],
  ARCHIVED: [],
});

const ACTION_TARGET: Readonly<Record<PriceListAction, PriceListStatus>> = Object.freeze({
  validate: "VALIDATED",
  submit: "PENDING_APPROVAL",
  approve: "APPROVED",
  // A rejected list goes back to the editor as a draft, keeping its rows and its history.
  reject: "DRAFT",
  publish: "PUBLISHED",
  expire: "EXPIRED",
  archive: "ARCHIVED",
});

export const PRICE_LIST_STATUS_LABELS: Readonly<Record<PriceListStatus, string>> = Object.freeze({
  DRAFT: "Draft",
  VALIDATED: "Validated",
  PENDING_APPROVAL: "Pending approval",
  APPROVED: "Approved",
  PUBLISHED: "Published",
  EXPIRED: "Expired",
  ARCHIVED: "Archived",
});

/** Rows written before this module existed were lowercase; normalise without losing them. */
export function normalizePriceListStatus(value: string | null | undefined): PriceListStatus {
  const status = String(value ?? "").trim().toUpperCase();
  if ((PRICE_LIST_STATUSES as readonly string[]).includes(status)) return status as PriceListStatus;
  throw new DomainError(`Unknown price list status "${value ?? ""}"`);
}

export function canTransitionPriceList(from: PriceListStatus, to: PriceListStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function availablePriceListActions(status: PriceListStatus): PriceListAction[] {
  return (Object.keys(ACTION_TARGET) as PriceListAction[]).filter((action) =>
    canTransitionPriceList(status, ACTION_TARGET[action]),
  );
}

export function nextPriceListStatus(current: PriceListStatus, action: PriceListAction): PriceListStatus {
  const target = ACTION_TARGET[action];
  if (!canTransitionPriceList(current, target)) {
    throw new DomainError(
      `A price list cannot go from ${PRICE_LIST_STATUS_LABELS[current]} to ${PRICE_LIST_STATUS_LABELS[target]}.`,
    );
  }
  return target;
}

export function assertPriceListActionRole(action: PriceListAction, roles: readonly string[], platformOperator = false): void {
  if (platformOperator) return;
  const allowed = PRICE_LIST_ACTION_ROLES[action];
  if (!roles.some((role) => allowed.includes(role))) {
    throw new DomainError(`Your role cannot ${action} a price list.`);
  }
}

export function priceListIsEditable(status: PriceListStatus): boolean {
  return status === "DRAFT" || status === "VALIDATED";
}

export interface PriceListPriceInput {
  masterPriceCode?: string | null;
  name: string;
  category: string;
  price: number;
  currency: string;
  isService?: boolean;
  unitType?: string;
}

export interface PriceListInput {
  code: string;
  name: string;
  description?: string | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
  items: PriceListPriceInput[];
}

export interface PriceListIssue {
  field: string;
  message: string;
}

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,49}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isDate(value: string): boolean {
  return DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function decimalsOf(value: number): number {
  const text = String(value);
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

/** Everything that must be true before a list may be validated, approved or published. */
export function validatePriceList(input: PriceListInput): PriceListIssue[] {
  const issues: PriceListIssue[] = [];
  if (!CODE_PATTERN.test(input.code ?? "")) {
    issues.push({ field: "code", message: "Use 2–50 letters, digits, dots, dashes or underscores for the code." });
  }
  if (!input.name?.trim() || input.name.trim().length < 2) {
    issues.push({ field: "name", message: "Give the price list a name of at least two characters." });
  }
  if (!isDate(input.effectiveFrom ?? "")) {
    issues.push({ field: "effectiveFrom", message: "Choose the date this list takes effect." });
  }
  if (input.effectiveTo) {
    if (!isDate(input.effectiveTo)) issues.push({ field: "effectiveTo", message: "That end date is not a valid date." });
    else if (isDate(input.effectiveFrom) && input.effectiveTo <= input.effectiveFrom) {
      issues.push({ field: "effectiveTo", message: "The end date must be after the start date." });
    }
  }
  if (!input.items?.length) {
    issues.push({ field: "items", message: "Add at least one catalogue item before validating." });
    return issues;
  }

  const currencies = new Set<string>();
  const seenCodes = new Set<string>();
  input.items.forEach((item, index) => {
    const at = `items.${index}`;
    if (!item.name?.trim()) issues.push({ field: `${at}.name`, message: "Every price needs an item name." });
    if (!item.category?.trim()) issues.push({ field: `${at}.category`, message: "Every price needs a category." });
    if (!isCurrencyCode(item.currency)) {
      issues.push({ field: `${at}.currency`, message: `"${item.currency}" is not a supported currency.` });
    } else {
      currencies.add(item.currency);
      if (!Number.isFinite(item.price) || item.price < 0) {
        issues.push({ field: `${at}.price`, message: "A price must be zero or more." });
      } else if (decimalsOf(item.price) > CURRENCIES[item.currency].minorDigits) {
        issues.push({
          field: `${at}.price`,
          message: `${item.currency} is recorded with ${CURRENCIES[item.currency].minorDigits} decimal place(s).`,
        });
      }
    }
    if (item.masterPriceCode) {
      if (seenCodes.has(item.masterPriceCode)) {
        issues.push({ field: `${at}.masterPriceCode`, message: "That catalogue item appears twice in this list." });
      }
      seenCodes.add(item.masterPriceCode);
    }
  });

  if (currencies.size > 1) {
    issues.push({
      field: "items",
      message: "A price list uses one currency. A price in another currency needs its own approved list.",
    });
  }
  return issues;
}

export function assertValidPriceList(input: PriceListInput): void {
  const issues = validatePriceList(input);
  if (issues.length) throw new DomainError(issues[0]!.message);
}
