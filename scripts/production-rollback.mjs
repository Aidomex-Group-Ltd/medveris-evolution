import { readFileSync } from "node:fs";
import { parseWranglerConfig } from "./staging-gate.mjs";
import { PRODUCTION, declaredDomains, verificationOrigin } from "./production-gate.mjs";
import { attachedDomains } from "./cloudflare-api.mjs";
import { createRelease } from "./release.mjs";

/**
 * Blue-green rollback for production: switches 100% of traffic back to the previous version in one step.
 *
 *   npm run deploy:production:rollback                    # previous fully deployed version, or blue mid-release
 *   npm run deploy:production:rollback -- <version-id>    # a specific earlier version
 *
 * Code rollback does not undo database migrations; the target must still be compatible with the current schema.
 */

const config = parseWranglerConfig(readFileSync("wrangler.jsonc", "utf8"));
const origin = verificationOrigin({ declared: declaredDomains(config.env?.production), attached: (await attachedDomains(PRODUCTION.worker)) ?? [] });
process.exit(await createRelease({ env: PRODUCTION.env, worker: PRODUCTION.worker, origin }).rollback(process.argv[2]));
