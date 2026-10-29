import { createPublicKey } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

/**
 * Validates the shape of the Yo! Payments configuration without printing any secret value.
 * Exits non-zero when the configuration cannot safely be used.
 */
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key!] !== undefined) continue;
    let value = rawValue!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key!] = value;
  }
}

for (const file of [".dev.vars", ".env.local", ".env"]) loadEnvFile(file);

const problems: string[] = [];
const notes: string[] = [];

const mode = (process.env.YO_MODE ?? "disabled").trim();
if (!["disabled", "sandbox"].includes(mode)) {
  problems.push("YO_MODE must be disabled or sandbox in staging; production is never validated by this command");
}
if (mode !== "sandbox") notes.push("YO_MODE is not sandbox; payment collection is disabled");

for (const name of ["YO_API_USERNAME", "YO_API_PASSWORD"]) {
  if (!process.env[name]?.trim()) problems.push(`${name} is missing`);
}

const publicKey = process.env.YO_PUBLIC_KEY?.trim();
if (!publicKey) {
  problems.push("YO_PUBLIC_KEY is missing");
} else {
  const candidates = [
    publicKey,
    `-----BEGIN PUBLIC KEY-----\n${publicKey.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "").match(/.{1,64}/g)?.join("\n") ?? publicKey}\n-----END PUBLIC KEY-----`,
  ];
  let parsed = false;
  for (const candidate of candidates) {
    try {
      createPublicKey(candidate);
      parsed = true;
      break;
    } catch {
      // Try the next shape; the error never includes key material.
    }
  }
  if (!parsed) problems.push("YO_PUBLIC_KEY is not a valid public key");
}

const notificationBase = process.env.YO_NOTIFICATION_BASE_URL?.trim();
if (!notificationBase) {
  problems.push("YO_NOTIFICATION_BASE_URL is missing");
} else {
  try {
    const url = new URL(notificationBase);
    const host = url.hostname.toLowerCase();
    const privateHost = host === "localhost" || host.endsWith(".local") || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (url.protocol !== "https:") problems.push("YO_NOTIFICATION_BASE_URL must be HTTPS");
    if (privateHost) problems.push("YO_NOTIFICATION_BASE_URL must be reachable from the public internet, not a local or private host");
  } catch {
    problems.push("YO_NOTIFICATION_BASE_URL is not a valid URL");
  }
}

for (const name of ["YO_API_URL", "YO_BACKUP_API_URL"]) {
  const value = process.env[name]?.trim();
  if (!value) continue;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") problems.push(`${name} must be HTTPS`);
    if (mode === "sandbox" && !url.hostname.includes("sandbox")) problems.push(`${name} does not look like the Yo! sandbox endpoint`);
  } catch {
    problems.push(`${name} is not a valid URL`);
  }
}

const callbackPath = "/api/v1/public/payments/yo/notifications";
if (notificationBase) {
  try {
    const callback = new URL(notificationBase.endsWith("/") ? `${notificationBase}${callbackPath.slice(1)}` : `${notificationBase}${callbackPath}`);
    if (callback.protocol !== "https:") problems.push("The notification callback URL must be HTTPS");
  } catch {
    problems.push("The notification callback URL could not be built");
  }
}

for (const note of notes) console.log(`note: ${note}`);
if (problems.length) {
  for (const problem of problems) console.error(`fail: ${problem}`);
  process.exit(1);
}
console.log(`ok: Yo! configuration shape is valid (mode ${mode}); no values were printed`);
