import { afterEach, describe, expect, it, vi } from "vitest";
import { ResendEmailAdapter } from "../../apps/api/src/lib/email.js";

const message = { to: "patient@example.org", subject: "Reset", text: "link" };

describe("ResendEmailAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records the provider's rejection reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ statusCode: 403, message: "The medveris.online domain is not verified." }, { status: 403 })));
    const result = await new ResendEmailAdapter("re_test_key_value", "Medveris <no-reply@medveris.online>").send(message);
    expect(result).toEqual({ delivered: false, adapter: "resend", detail: "Provider returned HTTP 403: The medveris.online domain is not verified." });
  });

  it("reports an unreachable provider as undelivered instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    const result = await new ResendEmailAdapter("re_test_key_value", "Medveris <no-reply@medveris.online>").send(message);
    expect(result).toEqual({ delivered: false, adapter: "resend", detail: "Provider unreachable (TypeError)" });
  });

  it("returns the provider message id on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "msg_123" })));
    const result = await new ResendEmailAdapter("re_test_key_value", "Medveris <no-reply@medveris.online>").send(message);
    expect(result).toEqual({ delivered: true, adapter: "resend", detail: "msg_123" });
  });
});
