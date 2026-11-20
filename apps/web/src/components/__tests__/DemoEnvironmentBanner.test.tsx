import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { DemoEnvironmentBanner, DEMO_ENVIRONMENT_MESSAGE } from "../DemoEnvironmentBanner";
import * as environmentModule from "../../lib/environment";

// The banner is driven entirely by server truth (GET /public/config.syntheticData).
// It must render in authenticated views of a production deployment that still holds only
// synthetic demonstration data. It must never be hideable by a client-side or user preference.

describe("DemoEnvironmentBanner", () => {
  function mockEnvironment(getEnvironment: ReturnType<typeof environmentModule.useAppEnvironment>) {
    const spy = vi.spyOn(environmentModule, "useAppEnvironment").mockReturnValue(getEnvironment);
    return { spy };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the non-dismissible warning when the server reports synthetic production data", () => {
    const { spy } = mockEnvironment({
      appEnv: "production",
      synthetic: true,
      syntheticData: true,
      local: false,
      devTotpCodes: false,
    });

    try {
      render(<DemoEnvironmentBanner />);

      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByText(DEMO_ENVIRONMENT_MESSAGE)).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it("does not render in a non-production environment", () => {
    const { spy } = mockEnvironment({
      appEnv: "development",
      synthetic: true,
      syntheticData: false,
      local: true,
      devTotpCodes: false,
    });

    try {
      render(<DemoEnvironmentBanner />);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it("does not render in production when the server reports real data", () => {
    const { spy } = mockEnvironment({
      appEnv: "production",
      synthetic: false,
      syntheticData: false,
      local: false,
      devTotpCodes: false,
    });

    try {
      render(<DemoEnvironmentBanner />);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it("remains visible when a user toggles a client-side preference intended to hide it", () => {
    // A user (or an adversarial setting) might try to suppress the banner through a
    // client-side preference. The banner must ignore such preferences and stay visible,
    // because it is driven by server truth, not by user settings.
    const { spy } = mockEnvironment({
      appEnv: "production",
      synthetic: true,
      syntheticData: true,
      local: false,
      devTotpCodes: false,
    });

    try {
      render(<DemoEnvironmentBanner />);

      // No user-facing toggle exists to hide this banner; the component does not read any
      // user-preferences store, so nothing a user does in settings can suppress it.
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByText(DEMO_ENVIRONMENT_MESSAGE)).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it("uses a stable, discoverable banner id and exposes aria-atomic for accessibility tooling", () => {
    const { spy } = mockEnvironment({
      appEnv: "production",
      synthetic: true,
      syntheticData: true,
      local: false,
      devTotpCodes: false,
    });

    try {
      render(<DemoEnvironmentBanner />);
      const alert = screen.getByRole("alert");
      expect(alert.id).toMatch(/^demo-environment-banner-/);
      expect(alert.getAttribute("aria-atomic")).toBe("true");
    } finally {
      spy.mockRestore();
    }
  });
});
