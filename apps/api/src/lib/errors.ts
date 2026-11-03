import type { Context } from "hono";

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly expose = true;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(401, "unauthenticated", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Not permitted") {
    super(403, "forbidden", message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(404, "not_found", message);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Version conflict", details?: unknown) {
    super(409, "conflict", message, details);
  }
}

export class ValidationError extends AppError {
  constructor(message = "Invalid input", details?: unknown) {
    super(422, "validation_error", message, details);
  }
}

export class DependencyError extends AppError {
  constructor(message = "Required service unavailable") {
    super(503, "dependency_unavailable", message);
  }
}

/** Platform operator grant workflow errors. */
export class MfaStepUpRequiredError extends AppError {
  constructor(message = "Two-step verification is required for this action") {
    super(403, "mfa_step_up_required", message);
  }
}

export class StaleMfaError extends AppError {
  constructor(message = "Two-step verification needs to be repeated because it has expired") {
    super(403, "mfa_stale", message);
  }
}

export class PlatformOperatorUnderstaffedError extends AppError {
  constructor(message = "The platform does not have enough active platform operators to approve this request safely") {
    super(409, "platform_operator_understaffed", message);
  }
}

export class DuplicateRequestError extends AppError {
  constructor(message = "A pending platform role request for that user already exists") {
    super(409, "duplicate_request", message);
  }
}

export class RequestAlreadyDecidedError extends AppError {
  constructor(message = "That request has already been decided") {
    super(409, "request_already_decided", message);
  }
}

export class LastOperatorRevocationForbiddenError extends AppError {
  constructor(message = "Revoking this grant would leave the platform without any active platform operator") {
    super(409, "last_operator_revocation_forbidden", message);
  }
}

export class MfaVerificationExpiredError extends AppError {
  constructor(message = "Two-step verification has expired for this session; re-verify before continuing") {
    super(403, "mfa_verification_expired", message);
  }
}

export class SyntheticTargetInProductionError extends AppError {
  constructor(message = "Platform access cannot be granted to a synthetic or demonstration account in production") {
    super(403, "synthetic_target_in_production", message);
  }
}

export function correlationId(c: Context<any>): string {
  return c.get("correlationId") ?? crypto.randomUUID();
}

export function nativeErrorBody(c: Context<any>, err: AppError) {
  return {
    error: {
      code: err.code,
      message: err.message,
      correlationId: correlationId(c),
      details: err.details,
    },
  };
}
