/**
 * A path to return to after sign-in. Only same-application paths are accepted, so a crafted
 * `from` value cannot send the user to another site; the sign-in page itself is never a target.
 */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  if (/^\/login(?:[/?#]|$)/.test(value)) return null;
  return value;
}
