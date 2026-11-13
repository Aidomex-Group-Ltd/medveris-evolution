import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "PEM private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/ },
  { name: "Resend live API key", re: /\bre_[A-Za-z0-9]{20,}/ },
  { name: "LivePay live credential", re: /\blp_(?:live|prod)_[A-Za-z0-9]{16,}/ },
  { name: "Stripe live secret", re: /\bsk_live_[A-Za-z0-9]{16,}/ },
  { name: "Cloudflare API token in assignment", re: /\bCF_API_TOKEN\s*=\s*[A-Za-z0-9_-]{20,}/ },
];

const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".jsonc", ".yml", ".yaml", ".md", ".env.example"]);
const SKIP_PREFIXES = ["node_modules/", ".worktree/", "package-lock.json", "SHA256SUMS.json"];

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\n").filter(Boolean).filter((file) => !SKIP_PREFIXES.some((prefix) => file.startsWith(prefix)))
    .filter((file) => SCANNED_EXTENSIONS.has(file.slice(file.lastIndexOf("."))) || file.endsWith(".env.example"));
}

describe("secret hygiene in tracked files", () => {
  const files = trackedFiles();

  it("scans the tracked source surface", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("contains no private keys or live credential literals", () => {
    const findings: string[] = [];
    for (const file of files) {
      const path = join(REPO_ROOT, file);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        // File deleted in the worktree before its deletion is committed; contains no readable secrets.
        continue;
      }
      if (stat.size > 2 * 1024 * 1024) continue;
      const content = readFileSync(path, "utf8");
      for (const { name, re } of PATTERNS) {
        if (re.test(content)) findings.push(`${file}: ${name}`);
      }
    }
    expect(findings).toEqual([]);
  });
});
