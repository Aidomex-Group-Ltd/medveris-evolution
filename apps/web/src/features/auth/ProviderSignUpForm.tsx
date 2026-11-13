import type { ReactElement } from "react";
import { WorkspaceSignup } from "../../components/WorkspaceSignup";

/**
 * Healthcare provider registration. Reuses the existing WorkspaceSignup wizard
 * unchanged: independent workspace / new organization / join an organization
 * with invitation approval. No new roles, permissions or endpoints are introduced.
 */
export function ProviderSignUpForm(): ReactElement {
  return (
    <div className="mv-stack">
      <WorkspaceSignup />
    </div>
  );
}
