export function assertTestDatabase(urlName = "DATABASE_URL"): void {
  const url = process.env[urlName];
  if (!url) throw new Error(`${urlName} is required for tests`);
  const parsed = new URL(url);
  const host = parsed.hostname;
  const db = parsed.pathname.replace(/^\//, "");
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
  if (!local || !db.endsWith("_test")) {
    throw new Error(`Refusing to run tests: ${urlName} must target a local *_test database`);
  }
}
