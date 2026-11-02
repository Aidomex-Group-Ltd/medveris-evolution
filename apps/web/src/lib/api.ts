export interface ApiErrorBody {
  error?: { code?: string; message?: string; correlationId?: string; details?: unknown };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId?: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, correlationId?: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
    this.details = details;
  }
}

let csrfToken = "";

export function setCsrfToken(token: string): void {
  csrfToken = token;
}

export function clearCsrfToken(): void {
  csrfToken = "";
}

export function hasCsrfToken(): boolean {
  return csrfToken !== "";
}

function fallbackMessage(status: number): string {
  if (status === 400 || status === 422) return "Some of the details are not valid. Check them and try again.";
  if (status === 401) return "Please sign in and try again.";
  if (status === 403) return "You do not have permission to do that.";
  if (status === 404) return "We could not find what you were looking for.";
  if (status === 409) return "That conflicts with something that already exists. Refresh and try again.";
  if (status === 429) return "Too many attempts. Wait a moment and try again.";
  if (status === 503) return "Medveris is temporarily unavailable. Try again shortly.";
  if (status >= 500) return "Something went wrong on our side. Try again shortly.";
  return `Request failed (${status})`;
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; headers?: Record<string, string> } = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json", ...(options.headers ?? {}) };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (csrfToken && !["GET", "HEAD", "OPTIONS"].includes(method)) headers["x-medveris-csrf"] = csrfToken;
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: "same-origin",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const body = (payload ?? {}) as ApiErrorBody;
    throw new ApiError(
      response.status,
      body.error?.code ?? "request_failed",
      body.error?.message ?? fallbackMessage(response.status),
      body.error?.correlationId,
      body.error?.details,
    );
  }
  return payload as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.correlationId ? `${error.message} (reference ${error.correlationId.slice(0, 8)})` : error.message;
  }
  if (error instanceof DOMException && error.name === "AbortError") return "The request was cancelled";
  if (error instanceof Error) return error.message;
  return "An unexpected error occurred";
}
