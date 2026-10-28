import { describe, expect, it } from "vitest";
import { clientKey } from "../../apps/api/src/lib/rate-limit.js";

describe("rate-limit client key", () => {
  it("uses Cloudflare's connecting IP, which a client cannot set, over a client-supplied X-Forwarded-For", () => {
    const headers = new Headers({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1, 203.0.113.9" });
    expect(clientKey(headers, "login")).toBe("203.0.113.9:login");
  });

  it("falls back to the first forwarded address, then to a local key, outside Cloudflare", () => {
    expect(clientKey(new Headers({ "x-forwarded-for": "198.51.100.7, 10.0.0.1" }), "login")).toBe("198.51.100.7:login");
    expect(clientKey(new Headers(), "login")).toBe("local:login");
  });
});
