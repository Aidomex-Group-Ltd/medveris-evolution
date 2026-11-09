# Global Mobile-First UI/UX Audit

**Date:** 2026-11-09  
**Scope:** Global styles, design tokens, app shell, navigation, shared UI, charts/tables/dialogs, dashboards, messaging/AI assistant, public homepage/pricing, and responsive automated tests.

## Exec summary

Medveris is already close to mobile-first in its core shell and shared UI. The main work completed in this audit was not a rewrite; it was hardening: fixing shared form primitives, adding the two missing shared primitives (Dialog, ChartFrame), enabling proper iOS safe-area behavior, and adding focused regression coverage for the responsive foundations.

## Audit coverage

### 1. Global viewport, box-sizing, overflow, and tokens

**Audited:**
- `packages/ui/src/styles.css`
- `apps/web/index.html`
- `apps/web/src/main.tsx`

**Findings:**
- The UI package uses `box-sizing: border-box` globally, `100dvh`, safe-area CSS variables, `overflow-x` containment, `overscroll-behavior`, `prefers-reduced-motion`, and fluid `clamp()` spacing/type.
- Cards, grids, tables, sheets, search, menus, and the app shell already use breakpoint-aware layouts.
- The main gap was that `index.html` did not expose the iOS notch/edge viewport, so safe-area insets were defined but not reliably available on iOS devices.

**Implemented:**
- Changed the viewport meta tag to `width=device-width, initial-scale=1.0, viewport-fit=cover`.
- Added `touch-action: manipulation` to the root HTML rule to reduce mobile double-tap zoom behavior.
- Added responsive `Dialog` and `ChartFrame` primitives so future work does not reimplement sheet/chart containment.
- Added `mv-button--busy` styling with a reduced-motion-safe spinner keyframe.

### 2. App shell, header, sidebar/drawer, bottom navigation

**Audited:**
- `apps/web/src/components/AppShell.tsx`
- `apps/web/src/lib/nav.ts`
- `packages/ui/src/styles.css`

**Findings:**
- The shell has a single navigation source of truth (`nav.ts`) for desktop sections, mobile tabs, bottom navigation, quick actions, and search.
- The sidebar is a fixed drawer with hidden visibility, scrim, Escape close, focus trapping, body scroll lock, and safe-area padding.
- The bottom navigation is mobile-only at the 900px breakpoint, uses `env(safe-area-inset-bottom)`, and the content area reserves bottom padding.
- The global search overlay and mobile sheet both constrain themselves to the viewport.

**Implemented:**
- No structural shell changes were needed.
- The shared input focus fix improves the reliability of focus management in dialogs, search inputs, and conversation composers.

### 3. Shared grids, cards, forms, tables, dialogs, and charts

**Audited:**
- `packages/ui/src/primitives.tsx`
- `packages/ui/src/styles.css`
- `packages/ui/src/ConversationPanel.tsx`
- `packages/ui/src/ConversationPanel.css`

**Findings:**
- Grids use `auto-fit` with `minmax(min(100%, ...), 1fr)`, so they collapse safely.
- Forms use 16px base font size, 44px minimum input height, and 48px under 600px to avoid iOS zoom and preserve touch targets.
- Tables convert to mobile card rows at 600px using `data-label`.
- Dialog-like surfaces existed (search dialog, mobile sheet, conversation modal), but there was no reusable `Dialog` primitive.
- No chart library or shared chart primitive was found; dashboards and reports use tables and lists.

**Implemented:**
- Added `Dialog` to shared UI:
  - Returns a modal dialog with `role="dialog"`, `aria-modal="true"`, `aria-label`.
  - Closes on Escape.
  - Locks body scroll while open.
  - Centers on larger screens and becomes a bottom sheet at 600px or below with safe-area padding.
- Added `ChartFrame` to shared UI:
  - Responsive section, header, description, and viewport.
  - Uses `mv-scroll-x` for touch scrolling and horizontal containment.
  - Keeps SVG/canvas charts inside the parent width while allowing overflow scrolling for dense charts.
  - Supports an empty state.
- Fixed shared input primitives:
  - `Input`, `Textarea`, and `Select` now accept and forward `ref`.
  - Class names are merged so callers can add custom input classes while retaining `mv-input` constraints.
- Added `busy` support to `Button`, including disabled state and spinner styling.

### 4. Patient dashboard, medical-user dashboards, public homepage/pricing

**Audited:**
- `apps/web/src/pages/DashboardPage.tsx`
- `apps/web/src/pages/PatientPortalPage.tsx`
- `apps/web/src/pages/WorklistPage.tsx`
- `apps/web/src/pages/ReportsPage.tsx`
- `apps/web/src/pages/AIPage.tsx`
- `apps/web/src/pages/PricingPage.tsx`
- `apps/web/src/pages/landing/LandingPage.tsx`
- `apps/web/src/pages/landing/landing.css`
- `apps/web/src/pages/PricingPage.css`

**Findings:**
- Patient dashboard uses responsive grids, stats, quick actions, and cards.
- Medical-user dashboards use responsive grids, lists, cards, and tables.
- Public homepage/pricing have their own responsive breakpoints, mobile menus, safe stacking, and card grids.
- Pricing/landing page CSS is large and duplicative, but it is functionally responsive; a full consolidation would be a larger refactor.

**Implemented:**
- No page-level rewrite was needed.
- The shared input/button fixes reduce future form focus and async-button issues across these pages.

### 5. Messaging and AI assistant mobile-first behavior

**Audited:**
- `packages/ui/src/ConversationPanel.tsx`
- `packages/ui/src/ConversationPanel.css`
- `apps/web/src/pages/AIChatPage.tsx`

**Findings:**
- The conversation panel is mobile-first:
  - Modal becomes full width / bottom-anchored on small screens.
  - Composer stays at the bottom with safe-area padding.
  - Message list scrolls independently.
  - Short-height screens reduce list height.
  - Reduced motion is respected.
- The prior `Input` primitive did not forward refs, which broke focus restoration after sending.
- The `Button` primitive did not accept the `busy` prop used by the conversation panel.

**Implemented:**
- Fixed `Input` ref forwarding.
- Added `Button` `busy` support.
- Fixed the Escape handler optional callback type issue in `ConversationPanel.tsx`.

### 6. Automated responsive regression testing

**Existing coverage:**
- `tests/e2e/responsive.spec.ts` covers public routes, clinician shell, worklist, AI page, global search overlay, bottom navigation, patient portal, AI chat, and desktop shell.
- `tests/unit/nav-route-parity.test.ts` validates navigation parity and mobile tab structure.
- `tests/unit/focus-trap.test.ts` validates overlay focus helpers.

**Added:**
- `tests/unit/responsive-ui.test.ts`
  - Verifies `viewport-fit=cover` and safe-area tokens.
  - Verifies `100dvh`, reduced motion, and `touch-action`.
  - Verifies bottom navigation safe-area padding and table card responsiveness.
  - Verifies `Dialog` and `ChartFrame` exports and responsive classes.
  - Verifies shared form primitives forward refs.
  - Verifies conversation composer safe-area and reduced-motion behavior.

## Validation run

### Focused tests
Ran:
```bash
npx vitest run --config vitest.config.ts tests/unit/responsive-ui.test.ts tests/unit/nav-route-parity.test.ts tests/unit/focus-trap.test.ts
```

Result:
- 3 test files passed
- 25 tests passed

### Web build
Ran:
```bash
npm run build:web
```

Result:
- Build passed in 1.59s.

### Typecheck
Ran:
```bash
npm run typecheck
```

Result:
- No `packages/ui` or `apps/web` errors remained after the ref/callback fixes.
- The repo-wide typecheck still fails on pre-existing unrelated errors in API and scripts (for example, `apps/api/src/integrations/ollama.ts`, `apps/api/src/integrations/verification.ts`, `tests/unit/production-gate.test.ts`, `tests/unit/scaling-gate.test.ts`).

### Lint
Ran:
```bash
npm run lint
```

Result:
- 5 pre-existing unused-variable errors remain in unrelated files:
  - `apps/api/src/routes/clinical.ts`
  - `apps/web/src/components/ClinicalNotePanel.tsx`
  - `apps/web/src/pages/EncounterPage.tsx`
  - `scripts/production-gate.mjs`
  - `tests/integration/clinical-notes-stage2.test.ts`

## Remaining recommendations

1. **Consolidate landing/pricing page CSS**: `landing.css` and `PricingPage.css` duplicate a large amount of responsive marketing-page styling. A future refactor can extract shared marketing tokens and header/footer utilities.
2. **Introduce chart components only when needed**: `ChartFrame` now provides responsive containment, but there is still no charting library. If trend charts are added, pair them with this frame and add screenshot tests.
3. **Add DOM-based unit tests when a DOM runner is available**: The current Vitest environment is Node-only. Adding jsdom/happy-dom would allow component-level responsive tests without full Playwright runs.
4. **Fix unrelated pre-existing typecheck/lint failures**: These are outside the responsive audit scope but block a fully clean repo verification.

## Bottom line

Medveris has a solid mobile-first foundation: safe-area aware shell, drawer/bottom navigation, responsive grids/forms/tables, mobile-first conversation composer, and strong Playwright evidence. This audit closed the most concrete gaps by fixing shared form primitives, adding reusable responsive dialog/chart infrastructure, enabling `viewport-fit=cover`, and adding focused regression tests.
