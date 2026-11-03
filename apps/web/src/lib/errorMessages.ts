import { ApiError } from "./api";

export type FriendlyTone = "neutral" | "warning";

export interface FriendlyErrorView {
  tone: FriendlyTone;
  title: string;
  message: string;
  actionLabel: string;
  /** Only ever shown under a "Details" disclosure, in small muted text. */
  reference?: string;
  /** Short, human hints derived from validation issues. Never field paths or codes. */
  hints?: string[];
}

type Classified = Omit<FriendlyErrorView, "actionLabel">;

const GENERIC: Classified = {
  tone: "neutral",
  title: "Something needs another look",
  message: "We could not complete that just now. Please try again.",
};

function validationHints(details: unknown): string[] {
  if (!Array.isArray(details)) return [];
  const hints: string[] = [];
  for (const issue of details) {
    if (!issue || typeof issue !== "object") continue;
    const message = (issue as { message?: unknown }).message;
    // Field paths are deliberately dropped: they are technical, not user facing.
    if (typeof message === "string" && message.trim()) hints.push(message.trim());
  }
  return [...new Set(hints)].slice(0, 4);
}

function classifyByCode(code: string): Classified | null {
  switch (code) {
    case "validation_error":
      return {
        tone: "warning",
        title: "Some details need another look",
        message: "Please check the highlighted fields and try again.",
      };
    case "not_found":
      return { tone: "neutral", title: "We could not find that", message: "It may have been moved, or you may not have access to it." };
    case "forbidden":
      return { tone: "neutral", title: "That is not available to you", message: "Your account does not have access to this. Ask a facility administrator if you need it." };
    case "unauthenticated":
      return { tone: "neutral", title: "Please sign in again", message: "Your session has ended. Sign in to continue where you left off." };
    case "conflict":
    case "request_already_decided":
    case "duplicate_request":
      return { tone: "warning", title: "This changed while you were working", message: "Reload the page to see the latest version, then try again." };
    case "mfa_step_up_required":
    case "mfa_stale":
    case "mfa_verification_expired":
      return { tone: "warning", title: "Please verify it is you", message: "For this action we need a fresh two-step verification. Verify and try again." };
    case "rate_limited":
      return { tone: "neutral", title: "One moment", message: "Too many attempts in a short time. Wait a little, then try again." };
    case "tenant_unavailable":
    case "database_unavailable":
    case "dependency_unavailable":
      return { tone: "neutral", title: "Temporarily unavailable", message: "The service is catching up. Try again in a moment." };
    default:
      return null;
  }
}

function classifyByStatus(status: number): Classified {
  if (status === 400 || status === 422) return classifyByCode("validation_error")!;
  if (status === 401) return classifyByCode("unauthenticated")!;
  if (status === 403) return classifyByCode("forbidden")!;
  if (status === 404) return classifyByCode("not_found")!;
  if (status === 409) return classifyByCode("conflict")!;
  if (status === 429) return classifyByCode("rate_limited")!;
  if (status >= 500) {
    return { tone: "neutral", title: "Something went wrong on our side", message: "This is not your fault. Try again in a moment; if it keeps happening, share the reference with support." };
  }
  return GENERIC;
}

/**
 * Turns any thrown value into calm, plain language. Machine codes, HTTP status numbers,
 * field paths, stack traces and raw server messages never reach the rendered text.
 */
export function describeError(error: unknown): FriendlyErrorView {
  if (error instanceof ApiError) {
    const base = classifyByCode(error.code) ?? classifyByStatus(error.status);
    const hints = base.tone === "warning" && error.code === "validation_error" ? validationHints(error.details) : [];
    return {
      ...base,
      actionLabel: base.tone === "warning" ? "Try again" : "Try again",
      ...(error.correlationId ? { reference: error.correlationId } : {}),
      ...(hints.length ? { hints } : {}),
    };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return { ...GENERIC, title: "That took too long", message: "The request was cancelled before it finished. Try again.", actionLabel: "Try again" };
  }
  if (error instanceof TypeError) {
    return {
      tone: "neutral",
      title: "We could not reach Medveris",
      message: "Check your connection and try again. Nothing you entered has been lost.",
      actionLabel: "Try again",
    };
  }
  if (error instanceof Error) {
    // An unexpected client-side failure: never surface the raw message.
    return { ...GENERIC, actionLabel: "Try again" };
  }
  return { ...GENERIC, actionLabel: "Try again" };
}

/** For the few places that still hold a pre-formatted string rather than the error object. */
export function describeMessage(message: string | null | undefined): FriendlyErrorView {
  if (!message) return { ...GENERIC, actionLabel: "Try again" };
  // A formatted message may carry "(reference xxxxxxxx)" — keep the reference, drop the rest
  // if it looks technical (a code, a path or a stack trace).
  const reference = message.match(/reference ([0-9a-f]{8})/i)?.[1];
  const looksTechnical = /(\bTS\d+\b|\bError:|\bat \w+\.|\bvalidation_error\b|\bECONN|\bstatus \d{3}\b|\b(request|query) validation failed\b)/i.test(message);
  return {
    tone: "neutral",
    title: looksTechnical ? GENERIC.title : "Something needs another look",
    message: looksTechnical ? GENERIC.message : message.replace(/\s*\(reference [0-9a-f]{8}\)/i, ""),
    actionLabel: "Try again",
    ...(reference ? { reference } : {}),
  };
}
