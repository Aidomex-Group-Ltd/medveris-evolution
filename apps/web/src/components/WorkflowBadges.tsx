import { Badge } from "@medveris/ui";
import type { BillingStatus, RecommendationStatus } from "../lib/types";

const STATUS_LABELS: Record<RecommendationStatus, string> = {
  requested: "Requested",
  accepted: "Accepted",
  "in-progress": "In progress",
  completed: "Completed",
  declined: "Declined",
  cancelled: "Cancelled",
};

const STATUS_TONES: Record<RecommendationStatus, "neutral" | "info" | "warning" | "success" | "danger"> = {
  requested: "info",
  accepted: "info",
  "in-progress": "warning",
  completed: "success",
  declined: "danger",
  cancelled: "neutral",
};

export function RequestStatusBadge({ status }: { status: RecommendationStatus }) {
  return <Badge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Badge>;
}

export function PriorityBadge({ priority }: { priority: string }) {
  if (priority === "routine") return <Badge tone="neutral">Routine</Badge>;
  return <Badge tone={priority === "emergency" ? "danger" : "warning"}>{priority === "emergency" ? "Emergency" : "Urgent"}</Badge>;
}

const BILLING_LABELS: Record<BillingStatus, string> = { unbilled: "Not billed", billed: "Billed, unpaid", "part-paid": "Part paid", paid: "Paid" };

export function BillingBadge({ status }: { status: BillingStatus }) {
  return <Badge tone={status === "paid" ? "success" : status === "unbilled" ? "neutral" : "warning"}>{BILLING_LABELS[status]}</Badge>;
}

export function requestStatusLabel(status: RecommendationStatus): string {
  return STATUS_LABELS[status];
}

const VISIT_STATE_LABELS: Record<string, string> = {
  planned: "Booked",
  arrived: "Waiting",
  triaged: "Triaged",
  "in-progress": "In consultation",
  completed: "Completed",
  cancelled: "Cancelled",
  "entered-in-error": "Entered in error",
};

export function VisitStateBadge({ state }: { state: string }) {
  const tone = state === "in-progress" ? "info" : state === "completed" ? "success" : state === "cancelled" || state === "entered-in-error" ? "neutral" : "warning";
  return <Badge tone={tone}>{VISIT_STATE_LABELS[state] ?? state}</Badge>;
}
