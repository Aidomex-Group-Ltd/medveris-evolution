import { describe, expect, it } from "vitest";
import { createHarness } from "./support.js";

/**
 * Regression test for the "Request validation failed (reference ...)" on
 * `/encounters/<id>`. The encounter page used to forward whatever
 * `useParams()` returned straight into the API. A non-UUID id made the route's
 * `uuidSchema.parse(c.req.param("id"))` throw a ZodError, which the global
 * handler in `app.ts` rendered as 422 "Request validation failed". That is now
 * prevented client-side: an invalid id renders the empty state instead of
 * firing a request.
 */
describe("encounter id validation", () => {
  it("rejects a non-UUID encounter id with 422 (documenting the ZodError origin)", async () => {
    const h = createHarness("encounter-bad-id");
    const session = await h.login("clinician@medveris.local");
    const response = await h.call(session, "/api/v1/encounters/not-a-uuid-id");
    const body = await h.json(response);
    expect(response.status).toBe(422);
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).toBe("Request validation failed");
  });

  it("should never render a stack trace or raw code in the DOM for a validation_error", async () => {
    const h = createHarness("encounter-bad-id-dom");
    const session = await h.login("clinician@medveris.local");
    const response = await h.call(session, "/api/v1/encounters/not-a-uuid-id");
    const body = await h.json(response);
    // The code must stay a stable machine token (e.g. validation_error), never
    // a human-facing error string, a zod message, or an internal label.
    expect(body.error.code).not.toMatch(/zod|stack|report/i);
    expect(body.error.message).not.toMatch(/Error:/);
  });
});
