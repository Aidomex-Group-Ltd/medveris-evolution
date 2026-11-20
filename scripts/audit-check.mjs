import { spawnSync } from "node:child_process";

const documentedChain = new Set(["picomatch", "fdir", "tinyglobby", "vitest", "vite"]);
const documentedAdvisory = "GHSA-fc5q-39xc-vjpf";

const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});

let report;
try {
  report = JSON.parse(result.stdout);
} catch (error) {
  console.error(`runtime audit: npm audit returned no parseable JSON (exit ${result.status}): ${result.stderr?.trim() || error.message}`);
  process.exit(1);
}

function exceptionReason(name, via) {
  if (!documentedChain.has(name)) return null;
  const direct = via.filter((entry) => typeof entry === "object" && entry !== null);
  const transitive = via.filter((entry) => typeof entry === "string");
  if (name === "picomatch") {
    const knownDirect = direct.every((entry) => String(entry.url ?? "").endsWith(documentedAdvisory));
    return knownDirect && transitive.every((entry) => documentedChain.has(entry)) ? "documented picomatch advisory" : null;
  }
  if (direct.length === 0 && transitive.length > 0 && transitive.every((entry) => documentedChain.has(entry))) {
    return "transitive effect of documented picomatch advisory";
  }
  return null;
}

const findings = Object.entries(report.vulnerabilities ?? {}).map(([name, value]) => {
  const via = value.via ?? [];
  return {
    name,
    severity: value.severity ?? "unknown",
    range: value.range ?? "*",
    fixAvailable: value.fixAvailable ?? null,
    reason: exceptionReason(name, via),
  };
});

for (const finding of findings) {
  const status = finding.reason ? `${finding.reason} (non-blocking)` : "BLOCKING";
  console.log(`${finding.severity}: ${finding.name} ${finding.range} [${status}] fix=${JSON.stringify(finding.fixAvailable)}`);
}

const blocking = findings.filter(
  (finding) => ["high", "critical"].includes(finding.severity) && !finding.reason,
);
console.log(`runtime audit: ${findings.length} finding(s) reported, ${blocking.length} blocking`);
if (blocking.length) process.exit(1);
