import { describe, expect, it } from "vitest";
import {
  getFocusableElements,
  resolveWrapIndex,
  type FocusableLike,
} from "../../apps/web/src/lib/focusTrap";

/**
 * The `useFocusTrap` hook itself needs a DOM, which the Node test
 * environment does not provide, so the keyboard contract is asserted
 * through its pure helpers. Live overlay behaviour (initial focus,
 * Escape, focus restoration) requires browser verification, which is
 * unavailable in this environment and is reported as a limitation.
 */

function element(overrides: Partial<FocusableLike> = {}): FocusableLike {
  return { tabIndex: 0, offsetParent: {}, hasAttribute: () => false, ...overrides };
}

function rootWith(elements: FocusableLike[]) {
  return { querySelectorAll: () => elements } as unknown as ParentNode;
}

describe("resolveWrapIndex", () => {
  it("wraps forward from the last element to the first", () => {
    expect(resolveWrapIndex(2, 3, false)).toBe(0);
  });

  it("wraps backward from the first element to the last", () => {
    expect(resolveWrapIndex(0, 3, true)).toBe(2);
  });

  it("does not intervene in the middle of the list", () => {
    expect(resolveWrapIndex(1, 3, false)).toBeNull();
    expect(resolveWrapIndex(1, 3, true)).toBeNull();
  });

  it("focuses the first or last element when focus is not in the list", () => {
    expect(resolveWrapIndex(-1, 3, false)).toBe(0);
    expect(resolveWrapIndex(-1, 3, true)).toBe(2);
  });

  it("wraps a single-element container onto itself", () => {
    expect(resolveWrapIndex(0, 1, false)).toBe(0);
    expect(resolveWrapIndex(0, 1, true)).toBe(0);
  });

  it("never intervenes when there are no focusables", () => {
    expect(resolveWrapIndex(0, 0, false)).toBeNull();
    expect(resolveWrapIndex(-1, 0, true)).toBeNull();
  });
});

describe("getFocusableElements", () => {
  it("keeps visible, enabled elements in DOM order", () => {
    const first = element();
    const second = element();
    expect(getFocusableElements(rootWith([first, second]))).toEqual([first, second]);
  });

  it("drops disabled, hidden and removed-from-tab-order elements", () => {
    const kept = element();
    const disabled = element({ disabled: true });
    const hidden = element({ hasAttribute: (name: string) => name === "hidden" });
    const detached = element({ offsetParent: null });
    const negative = element({ tabIndex: -1 });
    expect(getFocusableElements(rootWith([disabled, hidden, detached, negative, kept]))).toEqual([kept]);
  });
});
