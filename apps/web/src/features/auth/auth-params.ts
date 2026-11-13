import type { MeResponse } from "../../lib/types";
import type { AuthRole } from "./AuthAccountTypeSelector";

export type AuthMode = "signin" | "signup";

/** Post-authentication destination, honoring an explicit, safe return path. */
export function destination(me: MeResponse, role: AuthRole, returnTo: string | null): string {
  if (returnTo) return returnTo;
  if (role === "provider") {
    return me.memberships.length > 1 && !me.activeTenant ? "/facility-staff" : me.activeTenant ? "/dashboard" : "/facility-staff";
  }
  if (me.patientId) return "/portal";
  return me.memberships.length > 1 && !me.activeTenant ? "/facility-staff" : "/dashboard";
}

/** Role resolution honors legacy aliases: as=staff and type=facility both mean provider. */
export function readRole(params: URLSearchParams): AuthRole {
  const role = params.get("role");
  if (role === "patient" || role === "provider") return role;
  if (params.get("as") === "staff" || params.get("type") === "facility") return "provider";
  return "patient";
}

/** Mode resolution: explicit mode wins; legacy ?type= implies sign-up; default sign-in. */
export function readMode(params: URLSearchParams): AuthMode {
  const mode = params.get("mode");
  if (mode === "signin" || mode === "signup") return mode;
  if (params.get("type") === "patient" || params.get("type") === "facility") return "signup";
  return "signin";
}
