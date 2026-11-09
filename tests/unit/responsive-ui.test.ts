import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const uiStyles = read("packages/ui/src/styles.css");
const primitives = read("packages/ui/src/primitives.tsx");
const uiIndex = read("packages/ui/src/index.ts");
const indexHtml = read("apps/web/index.html");
const conversationStyles = read("packages/ui/src/ConversationPanel.css");

describe("responsive UI foundations", () => {
  it("enables edge-to-edge safe-area handling on mobile browsers", () => {
    expect(indexHtml).toContain("viewport-fit=cover");
    expect(uiStyles).toContain("--mv-safe-bottom: env(safe-area-inset-bottom, 0px)");
    expect(uiStyles).toContain("--mv-safe-top: env(safe-area-inset-top, 0px)");
  });

  it("uses dynamic viewport units and reduced motion safeguards", () => {
    expect(uiStyles).toContain("100dvh");
    expect(uiStyles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(uiStyles).toContain("touch-action");
  });

  it("keeps mobile bottom navigation and tables within viewport-aware scroll containers", () => {
    expect(uiStyles).toContain("padding: 4px 6px calc(4px + env(safe-area-inset-bottom, 0px))");
    expect(uiStyles).toContain("overscroll-behavior-x: contain");
    expect(uiStyles).toContain(".mv-table-wrap--responsive");
  });

  it("provides responsive dialog and chart primitives", () => {
    expect(uiIndex).toContain("Dialog");
    expect(uiIndex).toContain("ChartFrame");
    expect(primitives).toContain('role="dialog"');
    expect(primitives).toContain('aria-modal="true"');
    expect(primitives).toContain("mv-chart__viewport");
    expect(uiStyles).toContain(".mv-dialog__panel");
    expect(uiStyles).toContain(".mv-chart__viewport");
  });

  it("forwards refs through shared form inputs so focus management works", () => {
    expect(primitives).toContain("<input ref={ref}");
    expect(primitives).toContain("<textarea ref={ref}");
    expect(primitives).toContain("<select ref={ref}");
  });

  it("keeps the conversation composer usable with keyboard and safe areas", () => {
    expect(conversationStyles).toContain(".mv-conversation__composer");
    expect(conversationStyles).toContain("padding-bottom: calc(12px + var(--mv-safe-bottom))");
    expect(conversationStyles).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
