/**
 * Runs test files in small sequential slices, one child process per slice, so a large suite never
 * loads every file (and every module graph) into a single Vitest worker at once. Integration and
 * end-to-end workflows are skipped unless explicitly requested.
 *
 *   node scripts/test-slices.mjs                     # tests/unit in batches of 2
 *   node scripts/test-slices.mjs --size 1            # one file per process (lowest memory)
 *   node scripts/test-slices.mjs --dir tests/integration --size 1
 *   node scripts/test-slices.mjs --only pharmacy     # files whose path matches a regex
 *   node scripts/test-slices.mjs --list              # print the slices without running them
 *
 * Exit code is non-zero if any slice fails; every slice still runs unless --fail-fast is passed.
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
function flag(name) {
  return args.includes(`--${name}`);
}
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}

const root = process.cwd();
const directories = option("dir", "tests/unit")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const size = Math.max(1, Number(option("size", process.env.TEST_SLICE_SIZE ?? 2)));
const only = option("only", null);
const includeDb = flag("include-db");
const failFast = flag("fail-fast");
const heapMb = Number(option("heap", process.env.TEST_SLICE_HEAP_MB ?? 768));

/** Tests that open a live Postgres connection are opt-in so unit slices stay self-contained. */
const LIVE_DB_TESTS = new Set(["tests/unit/046_facility_logo.test.ts"]);

function collect(directory) {
  const absolute = resolve(root, directory);
  const files = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const path = join(absolute, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "e2e" || entry.name === "node_modules") continue;
      files.push(...collect(relative(root, path)));
    } else if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) {
      files.push(relative(root, path));
    }
  }
  return files;
}

const matcher = only ? new RegExp(only, "i") : null;

// Increase node max memory size to 4GB before running tests to avoid memory pressure.
const files = directories
  .flatMap(collect)
  .filter((file) => !matcher || matcher.test(file))
  .filter((file) => includeDb || !LIVE_DB_TESTS.has(file))
  .sort();

if (!files.length) {
  console.error("No test files matched the requested slices.");
  process.exit(1);
}

const slices = [];
for (let index = 0; index < files.length; index += size) slices.push(files.slice(index, index + size));

console.log(`Running ${files.length} file(s) in ${slices.length} slice(s) of up to ${size}, heap cap ${heapMb} MB.`);
if (!includeDb) console.log("Skipping live-database tests (pass --include-db to run them).");

if (flag("list")) {
  slices.forEach((slice, index) => console.log(`  [${index + 1}/${slices.length}] ${slice.join(" ")}`));
  process.exit(0);
}

const vitest = resolve(root, "node_modules/.bin/vitest");
const failures = [];
const started = Date.now();

for (const [index, slice] of slices.entries()) {
  const label = `[${index + 1}/${slices.length}]`;
  console.log(`\n${label} ${slice.join(" ")}`);
  const result = spawnSync(vitest, ["run", "--config", "vitest.config.ts", ...slice], {
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--max-old-space-size=${heapMb}`].filter(Boolean).join(" ") },
  });
  if (result.status !== 0) {
    failures.push(slice);
    if (failFast) break;
  }
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (failures.length) {
  console.error(`\n${failures.length} of ${slices.length} slice(s) failed in ${seconds}s:`);
  for (const slice of failures) console.error(`  ${slice.join(" ")}`);
  process.exit(1);
}

console.log(`\nAll ${slices.length} slice(s) passed in ${seconds}s.`);
