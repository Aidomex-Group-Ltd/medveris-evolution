import { describe, expect, it } from "vitest";
import { describeEnvironment } from "../../apps/web/src/lib/environment.js";

describe("web environment description", () => {
  it("shows no synthetic content or development helpers until the server environment is known", () => {
    expect(describeEnvironment(null)).toEqual({ appEnv: null, synthetic: false, local: false });
  });

  it("treats production as real data without development helpers", () => {
    expect(describeEnvironment("production")).toEqual({ appEnv: "production", synthetic: false, local: false });
  });

  it("labels staging synthetic but keeps development sign-in helpers local only", () => {
    expect(describeEnvironment("staging")).toEqual({ appEnv: "staging", synthetic: true, local: false });
    expect(describeEnvironment("development")).toMatchObject({ synthetic: true, local: true });
    expect(describeEnvironment("test")).toMatchObject({ synthetic: true, local: true });
  });
});
