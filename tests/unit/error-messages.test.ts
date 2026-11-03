import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../apps/web/src/lib/api.js";
import { describeError, describeMessage } from "../../apps/web/src/lib/errorMessages.js";
import { FriendlyError, FriendlyErrorToast } from "../../packages/ui/src/primitives.js";

describe("describeError maps each error class to plain language", () => {
  it("validation errors ask the person to check the fields and keep hints path-free", () => {
    const view = describeError(new ApiError(422, "validation_error", "Request validation failed", "abc12345", [
      { path: "patient.dateOfBirth", message: "Enter a valid date" },
    ]));
    expect(view.title).toBe("Some details need another look");
    expect(view.message).toMatch(/check the highlighted fields/i);
    expect(view.hints).toEqual(["Enter a valid date"]);
    expect(JSON.stringify(view)).not.toContain("patient.dateOfBirth");
    expect(JSON.stringify(view)).not.toContain("422");
    expect(JSON.stringify(view)).not.toContain("validation_error");
  });

  it("not found, forbidden and unauthenticated stay calm and actionable", () => {
    expect(describeError(new ApiError(404, "not_found", "Not found")).title).toMatch(/could not find/i);
    const forbidden = describeError(new ApiError(403, "forbidden", "Forbidden"));
    expect(forbidden.message).toMatch(/does not have access/i);
    expect(JSON.stringify(forbidden)).not.toMatch(/403|forbidden/);
    expect(describeError(new ApiError(401, "unauthenticated", "Authentication required")).title).toMatch(/sign in/i);
  });

  it("step-up errors explain that verification is needed", () => {
    const view = describeError(new ApiError(403, "mfa_step_up_required", "Two-step verification is required"));
    expect(view.title).toMatch(/verify/i);
    expect(view.tone).toBe("warning");
  });

  it("server failures never blame the user and offer a reference", () => {
    const view = describeError(new ApiError(500, "internal_error", "TypeError: x is undefined", "d2f20580"));
    expect(view.message).toMatch(/not your fault/i);
    expect(view.reference).toBe("d2f20580");
    expect(view.message).not.toMatch(/TypeError|undefined/);
  });

  it("network failures explain connectivity rather than code", () => {
    const view = describeError(new TypeError("Failed to fetch"));
    expect(view.title).toMatch(/could not reach/i);
    expect(view.message).toMatch(/connection/i);
  });

  it("raw codes and field paths never appear in any mapped text", () => {
    const cases = [
      new ApiError(400, "validation_error", "Request validation failed"),
      new ApiError(409, "conflict", "Version conflict"),
      new ApiError(429, "rate_limited", "Too many requests"),
      new ApiError(503, "database_unavailable", "connection refused"),
      new Error("at Object.<anonymous> (/app/x.ts:1:1)"),
    ];
    for (const error of cases) {
      const view = describeError(error);
      const text = `${view.title} ${view.message} ${(view.hints ?? []).join(" ")}`;
      expect(text).not.toMatch(/\b(TS\d+|ECONN|Error:|status \d{3}|validation_error|forbidden)\b/);
      expect(text).not.toMatch(/at \w+ \(/);
      expect(text).not.toMatch(/!/);
      expect(text).not.toBe(text.toUpperCase());
    }
  });

  it("describeMessage strips a technical string down to a safe sentence", () => {
    const view = describeMessage("Request validation failed (reference d2f2058a)");
    expect(view.message).not.toMatch(/validation/i);
    expect(view.reference).toBe("d2f2058a");
  });
});

describe("FriendlyError renders accessible, non-technical markup", () => {
  it("renders one calm sentence, an action and a muted reference disclosure", () => {
    const html = renderToStaticMarkup(createElement(FriendlyError, {
      title: "Something needs another look",
      message: "Please check the highlighted fields and try again.",
      hints: ["Enter a valid date"],
      reference: "d2f20580-1111-4aaa-8aaa-aaaaaaaaaaaa",
      onRetry: () => {},
    }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Enter a valid date");
    expect(html).toContain("Details");
    // The reference is only ever inside the disclosure, never the headline copy.
    expect(html).toContain("d2f20580");
    expect(html).not.toMatch(/<strong[^>]*>[^<]*d2f20580/);
  });

  it("never renders stack traces, HTTP codes or machine error codes", () => {
    const view = describeError(new ApiError(422, "validation_error", "Request validation failed", "ref12345", [
      { path: "items.0.qty", message: "Quantity must be positive" },
    ]));
    const html = renderToStaticMarkup(createElement(FriendlyError, { ...view }));
    expect(html).not.toMatch(/stack|TS\d+|ECONN|validation_error|items\.0\.qty|\b422\b/);
    expect(html).toContain("Quantity must be positive");
  });

  it("has a compact toast variant with the same restraint", () => {
    const html = renderToStaticMarkup(createElement(FriendlyErrorToast, {
      title: "This changed while you were working",
      message: "Reload the page to see the latest version, then try again.",
    }));
    expect(html).toContain('role="status"');
    expect(html).toContain("Reload the page");
    expect(html).not.toMatch(/!/);
  });
});
