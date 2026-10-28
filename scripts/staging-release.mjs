import { EXPECTED } from "./staging-gate.mjs";
import { createRelease } from "./release.mjs";

/**
 * Staging-bound release steps used by staging-deploy.mjs and staging-rollback.mjs.
 */
export const { versionsDeploy, verifyVersion, probeHealth, rollback } = createRelease({
  env: "staging",
  worker: EXPECTED.worker,
  origin: EXPECTED.origin,
});
