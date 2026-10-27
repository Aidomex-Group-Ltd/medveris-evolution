import { spawnSync } from "node:child_process";
import { EXPECTED, parseJsonOutput, rollbackTarget } from "./staging-gate.mjs";
import { verifyVersion, versionsDeploy } from "./staging-release.mjs";

/**
 * Blue-green rollback for staging: switches 100% of traffic back to the previous version in one step.
 *
 *   node scripts/staging-rollback.mjs                # previous fully deployed version, or blue during an unfinished release
 *   node scripts/staging-rollback.mjs <version-id>   # a specific earlier version
 *
 * Code rollback does not undo database migrations; blue must still be compatible with the current schema.
 */

function wrangler(...args) {
  const result = spawnSync("npx", ["wrangler", ...args], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "" };
}

const requested = process.argv[2];
if (requested && !/^[0-9a-f-]{36}$/.test(requested)) {
  console.error("staging rollback: the version id must be a Worker version UUID");
  process.exit(1);
}

const status = parseJsonOutput(wrangler("deployments", "status", "--env", "staging", "--json").stdout);
const deployments = parseJsonOutput(wrangler("deployments", "list", "--env", "staging", "--json").stdout);
const plan = rollbackTarget(status, Array.isArray(deployments) ? deployments : []);
const target = requested ?? plan.target;
if (!target) {
  for (const problem of plan.problems) console.error(`staging rollback: BLOCKED: ${problem}`);
  process.exit(1);
}
if (plan.current && target === plan.current) {
  console.error(`staging rollback: ${target} already serves all traffic`);
  process.exit(1);
}

console.log(`staging rollback: switching ${EXPECTED.worker} from ${plan.current ?? "a split deployment"} to ${target}`);
if (!versionsDeploy([`${target}@100%`], `rollback to ${target}`)) {
  console.error("staging rollback: wrangler versions deploy failed; traffic is unchanged");
  process.exit(1);
}
const check = await verifyVersion(target, { override: false, allowUntagged: true });
console.log(`staging rollback: ${check.ok ? "verified" : "VERIFICATION FAILED"} (${check.detail})`);
process.exit(check.ok ? 0 : 1);
