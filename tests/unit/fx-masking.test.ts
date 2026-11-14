import { describe, expect, it } from "vitest";
import { maskFxSecrets } from "../../apps/api/src/integrations/fx.js";

describe("FX secret masking", () => {
  it("redacts app_id and common key params from messages", () => {
    expect(maskFxSecrets("https://x.test?a=1&app_id=SECRET123&b=2")).not.toContain("SECRET123");
    expect(maskFxSecrets("https://x.test?a=1&app_id=SECRET123&b=2")).toContain("app_id=[redacted]");
    expect(maskFxSecrets("api_key=abcDEF1234567890")).toContain("[redacted]");
    expect(maskFxSecrets("token=sk_live_supersecret")).toContain("[redacted]");
  });
});
