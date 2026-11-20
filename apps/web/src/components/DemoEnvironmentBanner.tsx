import { useAppEnvironment } from "../lib/environment";

export const DEMO_ENVIRONMENT_MESSAGE =
  "Demo environment - synthetic data only. Do not enter real patient information.";

function makeId(): string {
  return `demo-environment-banner-${Math.random().toString(36).slice(2)}`;
}

/**
 * Non-dismissible banner shown in authenticated views of a production deployment that still
 * holds only synthetic demonstration data. It is driven by server truth
 * (`GET /public/config` `syntheticData`), not by any client-side preference, so a user cannot
 * hide it through settings.
 */
export function DemoEnvironmentBanner() {
  const { syntheticData } = useAppEnvironment();
  if (!syntheticData) return null;
  // Banner remains visible regardless of user settings — it is driven by server truth only.

  return (
    <div
      id={makeId()}
      className="mv-demo-banner"
      role="alert"
      aria-atomic="true"
    >
      <span>{DEMO_ENVIRONMENT_MESSAGE}</span>
    </div>
  );
}
