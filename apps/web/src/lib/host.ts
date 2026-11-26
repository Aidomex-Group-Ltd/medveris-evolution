/**
 * Dedicated platform-operator console hostname.
 *
 * The subdomain is the same SPA bundle on its own origin, so the entry experience is chosen by
 * hostname: its root opens the observability console and its sign-in page never offers public
 * self-registration. Authorization remains server-side (operator-gated API routes and the
 * platform gate on the page); this only decides what the visitor is shown first.
 */
export const OPERATOR_CONSOLE_HOST = "observability.medveris.online";

export function isOperatorConsoleHost(
  hostname = typeof window === "undefined" ? "" : window.location.hostname,
): boolean {
  return hostname.toLowerCase() === OPERATOR_CONSOLE_HOST;
}
