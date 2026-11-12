import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErpnextAdapter } from "../../apps/api/src/integrations/erpnext.js";
import type { ErpnextConfig } from "../../apps/api/src/config.js";

const strong = {
  baseUrl: "http://127.0.0.1:8069",
  apiKey: "test-key",
  apiSecret: "test-secret",
  timeoutMs: 1000,
  company: "Medveris Test Company",
} satisfies ErpnextConfig;

const off = { baseUrl: null, apiKey: null, apiSecret: null, timeoutMs: 1000, company: null } satisfies ErpnextConfig;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("ERPNext integration adapter", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is off when credentials are missing (fail-closed)", () => {
    const adapter = new ErpnextAdapter(off);
    expect(adapter.mode).toBe("off");
    expect(adapter.status.configured).toBe(false);
  });

  it("throws dependency_unavailable for operations when off", async () => {
    const adapter = new ErpnextAdapter(off);
    await expect(adapter.listEmployees()).rejects.toThrow(/not configured/i);
  });

  it("sends Frappe token auth header without transmitting secrets in the URL", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { message: "Administrator" }));
    const adapter = new ErpnextAdapter(strong);
    await adapter.verifyConnection();
    expect(adapter.status.connected).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8069/api/method/frappe.auth.get_logged_user");
    expect((init.headers as Record<string, string>).authorization).toBe("token test-key:test-secret");
    expect(url).not.toContain("test-secret");
  });

  it("never includes credentials in the status object", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { message: "Administrator" }));
    const adapter = new ErpnextAdapter(strong);
    await adapter.verifyConnection();
    const status = adapter.status;
    expect(JSON.stringify(status)).not.toContain("test-secret");
    expect(JSON.stringify(status)).not.toContain("test-key");
  });

  it("throws DependencyError for non-retryable auth failure (401), without retrying", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, {}));
    const adapter = new ErpnextAdapter(strong);
    await expect(adapter.listEmployees()).rejects.toThrow(/401|unavailable|ERPNext returned/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws DependencyError when ERPNext returns 500 (after bounded retry)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, {}));
    const adapter = new ErpnextAdapter(strong);
    await expect(adapter.listEmployees()).rejects.toThrow(/unavailable|500/);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 2 attempts, bounded
  });

  it("maps listEmployees response to the data array and bounds the limit", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ name: "HR-EMP-0001", employee_number: "42" }] }));
    const adapter = new ErpnextAdapter(strong);
    const employees = await adapter.listEmployees(500);
    expect(employees).toEqual([{ name: "HR-EMP-0001", employee_number: "42" }]);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("limit_page_length=100");
  });
});
