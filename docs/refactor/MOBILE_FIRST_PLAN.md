# Universal Mobile-First UX Plan (Phase 4)

## Target behavior (all modules/pages)
- Mobile: vertically stacked, full-width containers/fields/actions; consistent left alignment for content, labels, headings, forms, controls; no text clipping, overlap, horizontal overflow, or inaccessible touch targets.
- Tablet/desktop: may use multi-column layouts where appropriate, but mobile-first stacking/full-width remains intact at small breakpoints.
- Consistent spacing/typography/navigation; responsive tables (stacked/card or labeled cells), forms, dashboards, modals/sheets, queues/boards.
- Accessibility: keyboard/focus management, visible labels, sufficient contrast/target sizes (verify), semantic structure.

## Current gaps (audit)
- Mixed systems: `packages/ui` primitives/CSS, global `apps/web/src/styles.css`, page-specific CSS (`pages/PricingPage.css`, `pages/landing/landing.css`), bespoke components.
- Grid/form min-widths and multi-column patterns can prevent full-width stacking on narrow screens.
- `Table` primitive does not enforce mobile `data-label` contract used by CSS.
- Many large monolithic pages/components (`AppShell`, `CatalogueEditorPage`, `OnboardingWorkflowPage`, `InventoryPage`, `FinancePage`, etc.) embed layout logic.
- Dialog/modal patterns inconsistent (UI Dialog vs custom modals/sheets).

## Implementation increments

### 4.1 Foundations (shared)
- **`packages/ui/src/primitives.tsx` + `styles.css`:** add responsive container/stack/grid helpers; enhance `Table` to support mobile labels (e.g. `columns` meta or render `data-label` on `td`); standardize `Dialog/Sheet`, form field full-width defaults, button groups that stack on mobile.
- **`apps/web/src/styles.css`:** mobile-first base rules (`box-sizing`, media/iframes/tables max-width, overflow safety), utility classes for stack/full-width/left-align, breakpoint tokens; ensure `.mv-form-grid`, `.mv-grid-*`, `.mv-row` collapse to single-column/full-width under mobile breakpoint without fixed mins causing overflow.
- **Verification:** story-like/manual viewport checks (320/375/768/1024+), lint/typecheck.

### 4.2 Shell/navigation
- **`apps/web/src/components/AppShell.tsx`, `lib/nav.ts`:** audit fixed/overlay behavior, bottom nav safe areas, search/sheets/notifications, topbar content wrapping, left-aligned menus; ensure all actions reachable and no clipped text.

### 4.3 Module retrofit order (one PR/commit slice each)
1. Auth/invitation/onboarding/MFA/profile (`LoginPage`, `RegisterPage`, `ForgotPasswordPage`, `ResetPasswordPage`, `VerifyEmailPage`, `MfaSetupPage`, `InvitationPage`, `Onboarding*`, `WorkspaceSignup`).
2. Dashboard & work queues (`DashboardPage`, `QueuesPage`, `WorklistPage`, `VisitsPage`, `AppointmentsPage`).
3. Patient/reception/encounter/care (`PatientsPage`, `PatientPortal*`, `EncounterPage`, `Care*`, `ClinicalNotePanel`, `TriagePanel`, `VisitWorkflowPanel`).
4. Diagnostics/radiology/lab orders & reports (`DiagnosticsPage`, `OrderDetailPage`, `Radiology*`, `PacsImagesPanel`).
5. Pharmacy & POS (`PharmacyPage`, `PharmacyPosPage`, `PointOfSalePage`).
6. Inpatient/theatre/maternity/emergency (`Wards*`, `AdmissionDetailPage`, `Theatre*`, `MaternityPage`, `Emergency*`).
7. Finance/billing/subscription/reports/receipts (`FinancePage`, `InvoiceDetailPage`, `ReceiptPage`, `PriceListPage`, `SubscriptionPage`, `ReportsPage`, `PlatformBillingPage`).
8. Inventory/procurement/operations/assets (`InventoryPage`, `ProcurementPage`, `OperationsPage`).
9. Admin/workforce/credentials/documents/org/directory (`AdminPage`, `WorkforcePage`, `PayrollPage`, `CredentialsPage`, `DocumentsPage`, `WorkspacePage`, `OrganizationsPage`, `Directory*`, `FacilityStaffPage`).
10. Content/AI/telehealth/devices/integrations/public/legal (`ContentPage`, `AI*`, `TelehealthPage`, `DevicesPage`, `PlatformIntegrationsPage`, `PlatformObservabilityPage`, public/landing/pricing/legal/about/help/contacts).

### Per-module checklist
- [ ] No horizontal scroll at 320px width; media/tables contained.
- [ ] Forms/filters/actions stack full-width with left-aligned labels.
- [ ] Tables readable (responsive mode with labels or horizontal-safe pattern per policy).
- [ ] Modals/sheets fit viewport, scroll internally, focus trapped.
- [ ] Role/subscription states visible and accessible.
- [ ] Desktop layout preserved/improved.

## Risks/dependencies
- Large page rewrites risk behavior regressions; mitigate with characterization tests and incremental extraction.
- Shared primitive changes affect all consumers; test broadly.
