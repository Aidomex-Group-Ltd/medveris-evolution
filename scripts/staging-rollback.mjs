import { rollback } from "./staging-release.mjs";

/**
 * Blue-green rollback for staging: switches 100% of traffic back to the previous version in one step.
 *
 *   node scripts/staging-rollback.mjs                # previous fully deployed version, or blue during an unfinished release
 *   node scripts/staging-rollback.mjs <version-id>   # a specific earlier version
 *
 * Code rollback does not undo database migrations; blue must still be compatible with the current schema.
 */

process.exit(await rollback(process.argv[2]));
