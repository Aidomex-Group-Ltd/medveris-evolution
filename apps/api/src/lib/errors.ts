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

export function correlationId(c: Context): string {
  const existing = c.get("correlationId" as never) as string | undefined;
  if (existing) return existing;
  const id = crypto.randomUUID();
  c.set("correlationId" as never, id as never);
  return id;
}

export function nativeErrorBody(c: Context, error: AppError) {
  return {
    error: {
      code: error.code,
      message: error.message,
      correlationId: correlationId(c),
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
  };
}
