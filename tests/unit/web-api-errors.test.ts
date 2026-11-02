import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../apps/web/src/lib/api.js";

describe("web API error messages", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses a safe message instead of the raw status when a 503 body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream unavailable", { status: 503 })));
    await expect(api("/auth/register/workspace", { method: "POST", body: {} })).rejects.toMatchObject({
      status: 503,
      message: "Medveris is temporarily unavailable. Try again shortly.",
    });
  });

  it("prefers the API error message when the body has one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { error: { code: "database_unavailable", message: "The service is temporarily unavailable. Try again shortly." } },
      { status: 503 },
    )));
    await expect(api("/auth/register/workspace", { method: "POST", body: {} })).rejects.toMatchObject({
      status: 503,
      code: "database_unavailable",
      message: "The service is temporarily unavailable. Try again shortly.",
    });
  });
});
