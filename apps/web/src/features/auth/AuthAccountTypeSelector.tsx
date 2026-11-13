import { Tabs } from "@medveris/ui";
import type { ReactElement } from "react";

export type AuthRole = "patient" | "provider";

/** Exclusive Patient / Healthcare Provider selector (segmented toggle). */
export function AuthAccountTypeSelector({
  role,
  onRoleChange,
}: {
  role: AuthRole;
  onRoleChange: (role: AuthRole) => void;
}): ReactElement {
  return (
    <div className="mv-authx__selector" role="group" aria-label="Account type">
      <span className="mv-authx__selector-label" id="auth-account-type-label">I am a</span>
      <Tabs
        label="Account type"
        value={role}
        onChange={(value) => onRoleChange(value as AuthRole)}
        options={[
          { value: "patient", label: "Patient" },
          { value: "provider", label: "Healthcare Provider" },
        ]}
      />
    </div>
  );
}
