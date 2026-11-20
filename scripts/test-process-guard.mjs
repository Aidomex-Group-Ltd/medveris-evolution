import { spawnSync } from "node:child_process";

const reap = process.argv.includes("--reap");
const olderThanArg = process.argv.find((arg) => arg.startsWith("--older-than-minutes="));
const olderThanMinutes = Number(olderThanArg?.split("=")[1] ?? 10);

function elapsedMinutes(value) {
  const dayPart = /^(\d+)-/.exec(value);
  const days = dayPart ? Number(dayPart[1]) : 0;
  const rest = dayPart ? value.slice(dayPart[0].length) : value;
  const parts = rest.split(":").map(Number);
  const [hours, minutes] = parts.length === 3 ? parts : [0, ...parts];
  return days * 1440 + hours * 60 + minutes;
}

const ps = spawnSync("ps", ["-eo", "pid=,ppid=,etime=,args="], { encoding: "utf8" });
if (ps.status !== 0) throw new Error(`ps failed: ${ps.stderr?.trim() ?? `exit ${ps.status}`}`);

const processes = new Map();
for (const line of ps.stdout.split("\n")) {
  const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
  if (!match) continue;
  const [, pid, ppid, etime, args] = match;
  processes.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), etime, minutes: elapsedMinutes(etime), args });
}

function isTestRelated(processInfo) {
  // Match only explicit vitest runs and `npm test` / `npm exec vitest` invocations,
  // not any process whose args merely contain the repo path (which would also match
  // VS Code, tsserver, eslint, dev servers, and other editor/build tooling).
  return /\bvitest\b/.test(processInfo.args) || /^\s*npm (test|exec)\b/.test(processInfo.args);
}

const roots = [...processes.values()].filter(
  (processInfo) => processInfo.ppid === 1 && isTestRelated(processInfo) && processInfo.minutes >= olderThanMinutes,
);

const orphans = [];
const seen = new Set();
function collect(processInfo) {
  if (seen.has(processInfo.pid)) return;
  seen.add(processInfo.pid);
  orphans.push(processInfo);
  for (const child of processes.values()) if (child.ppid === processInfo.pid) collect(child);
}
for (const root of roots) collect(root);

console.log(`test-related processes visible: ${[...processes.values()].filter(isTestRelated).length}`);
console.log(`orphaned vitest trees (root parent=1, age>=${olderThanMinutes}m): ${roots.length} root(s), ${orphans.length} process(es)`);
for (const processInfo of orphans.sort((a, b) => a.pid - b.pid)) {
  console.log(`  pid=${processInfo.pid} ppid=${processInfo.ppid} age=${processInfo.etime} args=${processInfo.args}`);
}

if (!reap) {
  console.log("check only; no processes changed (pass --reap to terminate the listed PIDs)");
} else {
  for (const processInfo of orphans.sort((a, b) => b.pid - a.pid)) {
    if (processInfo.pid === process.pid) continue;
    try {
      process.kill(processInfo.pid, "SIGKILL");
      console.log(`terminated pid=${processInfo.pid}`);
    } catch (error) {
      console.log(`could not terminate pid=${processInfo.pid}: ${error.message}`);
    }
  }
}
