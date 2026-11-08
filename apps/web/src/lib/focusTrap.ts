import { useEffect, useRef, type RefObject } from "react";

/**
 * Shared accessible overlay focus management.
 *
 * Dialogs (global search, mobile sheets, later the confirm primitive) use
 * `useFocusTrap` so that keyboard focus is contained while an overlay is
 * open, Escape closes it, and focus returns to the element that opened it.
 *
 * The pure helpers below are unit-testable without a DOM; the React hook
 * is the thin DOM-facing wrapper.
 */

/** Elements that can receive keyboard focus, in DOM order. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Structural subset of HTMLElement used by the visibility filter. */
export interface FocusableLike {
  disabled?: boolean;
  tabIndex: number;
  offsetParent: unknown;
  hasAttribute(name: string): boolean;
}

export function isFocusableElement(element: FocusableLike): boolean {
  return !element.disabled && element.tabIndex >= 0 && element.offsetParent !== null && !element.hasAttribute("hidden");
}

export function getFocusableElements(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isFocusableElement);
}

/**
 * Decide where Tab moves focus inside a trapped container.
 *
 * Returns the index of the element to focus when the natural Tab order
 * would leave the container (or focus is not in the list at all), or `null`
 * to let the browser handle the keystroke normally.
 */
export function resolveWrapIndex(currentIndex: number, count: number, shiftKey: boolean): number | null {
  if (count <= 0) return null;
  if (currentIndex < 0) return shiftKey ? count - 1 : 0;
  if (shiftKey && currentIndex === 0) return count - 1;
  if (!shiftKey && currentIndex === count - 1) return 0;
  return null;
}

/**
 * Contains keyboard focus within `containerRef` while `options.active`.
 * On activation focus moves to the first focusable element (or the
 * container itself when `initialFocus` is "container"); on cleanup the
 * previously focused element is restored when it is still in the document.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  options: { active: boolean; onEscape?: () => void; initialFocus?: "first" | "last" | "container" },
): void {
  const { active, onEscape, initialFocus = "first" } = options;
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previous = document.activeElement;
    returnFocusRef.current = previous instanceof HTMLElement ? previous : null;

    const focusables = getFocusableElements(container);
    const target = initialFocus === "container" ? container : initialFocus === "last" ? focusables.at(-1) : focusables[0];
    target?.focus({ preventScroll: true });

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onEscapeRef.current?.();
        return;
      }
      if (event.key !== "Tab" || !container) return;
      const elements = getFocusableElements(container);
      if (elements.length === 0) {
        event.preventDefault();
        return;
      }
      const currentIndex = elements.indexOf(document.activeElement as HTMLElement);
      const wrapIndex = resolveWrapIndex(currentIndex, elements.length, event.shiftKey);
      if (wrapIndex !== null) {
        event.preventDefault();
        elements[wrapIndex]!.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const restore = returnFocusRef.current;
      if (restore && document.contains(restore)) restore.focus({ preventScroll: true });
    };
  }, [active, containerRef, initialFocus]);
}
