import { lazy, Suspense, type ComponentType } from "react";
import { Link, Route, Routes, useLocation } from "react-router-dom";
import { EmptyState, LoadingState, PageHeader } from "@medveris/ui";
import { AppShell } from "./components/AppShell";
import { PageErrorBoundary } from "./components/PageErrorBoundary";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { LoginPage } from "./pages/LoginPage";

function lazyPage<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K): ComponentType {
  const Page = lazy(async () => {
    const component: ComponentType = (await load())[name];
    return { default: component };
  });
  return function LazyPage() {
    const { pathname } = useLocation();
    return (
      <PageErrorBoundary key={pathname}>
        <Suspense fallback={<LoadingState label="Loading workspace" />}>
          <Page />
        </Suspense>
      </PageErrorBoundary>
    );
  };
}

const RegisterPage = lazyPage(() => import("./pages/RegisterPage"), "RegisterPage");
const ForgotPasswordPage = lazyPage(() => import("./pages/ForgotPasswordPage"), "ForgotPasswordPage");
const ResetPasswordPage = lazyPage(() => import("./pages/ResetPasswordPage"), "ResetPasswordPage");
const VerifyEmailPage = lazyPage(() => import("./pages/VerifyEmailPage"), "VerifyEmailPage");
const MfaSetupPage = lazyPage(() => import("./pages/MfaSetupPage"), "MfaSetupPage");
const DashboardPage = lazyPage(() => import("./pages/DashboardPage"), "DashboardPage");
const PatientsPage = lazyPage(() => import("./pages/PatientsPage"), "PatientsPage");
const QueuesPage = lazyPage(() => import("./pages/QueuesPage"), "QueuesPage");
const WorklistPage = lazyPage(() => import("./pages/WorklistPage"), "WorklistPage");
const EncounterPage = lazyPage(() => import("./pages/EncounterPage"), "EncounterPage");
const PatientPortalPage = lazyPage(() => import("./pages/PatientPortalPage"), "PatientPortalPage");
const ConsentPage = lazyPage(() => import("./pages/ConsentPage"), "ConsentPage");
const AccessHistoryPage = lazyPage(() => import("./pages/AccessHistoryPage"), "AccessHistoryPage");
const ExchangePage = lazyPage(() => import("./pages/ExchangePage"), "ExchangePage");
const CredentialsPage = lazyPage(() => import("./pages/CredentialsPage"), "CredentialsPage");
const AdminPage = lazyPage(() => import("./pages/AdminPage"), "AdminPage");
const ReviewerPage = lazyPage(() => import("./pages/ReviewerPage"), "ReviewerPage");
const SecurityPage = lazyPage(() => import("./pages/SecurityPage"), "SecurityPage");
const WardsPage = lazyPage(() => import("./pages/WardsPage"), "WardsPage");
const TheatrePage = lazyPage(() => import("./pages/TheatrePage"), "TheatrePage");
const TheatreCasePage = lazyPage(() => import("./pages/TheatreCasePage"), "TheatreCasePage");
const AdmissionDetailPage = lazyPage(() => import("./pages/AdmissionDetailPage"), "AdmissionDetailPage");
const DiagnosticsPage = lazyPage(() => import("./pages/DiagnosticsPage"), "DiagnosticsPage");
const OrderDetailPage = lazyPage(() => import("./pages/OrderDetailPage"), "OrderDetailPage");
const PharmacyPage = lazyPage(() => import("./pages/PharmacyPage"), "PharmacyPage");
const FinancePage = lazyPage(() => import("./pages/FinancePage"), "FinancePage");
const InvoiceDetailPage = lazyPage(() => import("./pages/InvoiceDetailPage"), "InvoiceDetailPage");
const ProgrammesPage = lazyPage(() => import("./pages/ProgrammesPage"), "ProgrammesPage");
const PublicHealthPage = lazyPage(() => import("./pages/PublicHealthPage"), "PublicHealthPage");
const TelehealthPage = lazyPage(() => import("./pages/TelehealthPage"), "TelehealthPage");
const DevicesPage = lazyPage(() => import("./pages/DevicesPage"), "DevicesPage");
const AIPage = lazyPage(() => import("./pages/AIPage"), "AIPage");
const EmergencyPage = lazyPage(() => import("./pages/EmergencyPage"), "EmergencyPage");
const EmergencyCasePage = lazyPage(() => import("./pages/EmergencyCasePage"), "EmergencyCasePage");
const CareCoordinationPage = lazyPage(() => import("./pages/CareCoordinationPage"), "CareCoordinationPage");
const AppointmentsPage = lazyPage(() => import("./pages/AppointmentsPage"), "AppointmentsPage");
const WorkforcePage = lazyPage(() => import("./pages/WorkforcePage"), "WorkforcePage");
const DocumentsPage = lazyPage(() => import("./pages/DocumentsPage"), "DocumentsPage");
const MaternityPage = lazyPage(() => import("./pages/MaternityPage"), "MaternityPage");
const OperationsPage = lazyPage(() => import("./pages/OperationsPage"), "OperationsPage");
const InventoryPage = lazyPage(() => import("./pages/InventoryPage"), "InventoryPage");
const ContentPage = lazyPage(() => import("./pages/ContentPage"), "ContentPage");
const DirectoryPage = lazyPage(() => import("./pages/DirectoryPage"), "DirectoryPage");
const DirectoryDetailPage = lazyPage(() => import("./pages/DirectoryDetailPage"), "DirectoryDetailPage");
const ProviderDirectoryPage = lazyPage(() => import("./pages/ProviderDirectoryPage"), "ProviderDirectoryPage");
const PromotionsPage = lazyPage(() => import("./pages/PromotionsPage"), "PromotionsPage");
const DirectoryGovernancePage = lazyPage(() => import("./pages/DirectoryGovernancePage"), "DirectoryGovernancePage");
const OnboardingPage = lazyPage(() => import("./pages/OnboardingPage"), "OnboardingPage");
const OnboardingWorkflowPage = lazyPage(() => import("./pages/OnboardingWorkflowPage"), "OnboardingWorkflowPage");
const CatalogueEditorPage = lazyPage(() => import("./pages/CatalogueEditorPage"), "CatalogueEditorPage");
const CaregiversPage = lazyPage(() => import("./pages/CaregiversPage"), "CaregiversPage");

function NotFoundPage() {
  return (
    <div className="mv-stack">
      <PageHeader title="Not found" description="The requested workspace does not exist or is not available in this release." />
      <EmptyState title="Check the address" description="Use the navigation to return to an available workspace." action={<Link to="/">Return to overview</Link>} />
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/mfa-setup" element={<MfaSetupPage />} />
      <Route path="/directory" element={<DirectoryPage />} />
      <Route path="/directory/:publicId" element={<DirectoryDetailPage />} />
      <Route element={<ProtectedRoute><AppShell /></ProtectedRoute>}>
        <Route index element={<DashboardPage />} />
        <Route path="patients" element={<ProtectedRoute roles={["receptionist", "nurse", "clinician", "facility_admin"]}><PatientsPage /></ProtectedRoute>} />
        <Route path="queues" element={<ProtectedRoute roles={["receptionist", "nurse", "clinician", "facility_admin"]}><QueuesPage /></ProtectedRoute>} />
        <Route path="appointments" element={<ProtectedRoute roles={["receptionist", "nurse", "clinician", "facility_admin"]}><AppointmentsPage /></ProtectedRoute>} />
        <Route path="worklist" element={<ProtectedRoute roles={["nurse", "clinician"]}><WorklistPage /></ProtectedRoute>} />
        <Route path="care" element={<ProtectedRoute roles={["nurse", "clinician"]}><CareCoordinationPage /></ProtectedRoute>} />
        <Route path="emergency" element={<ProtectedRoute roles={["nurse", "clinician"]}><EmergencyPage /></ProtectedRoute>} />
        <Route path="emergency/:id" element={<ProtectedRoute roles={["nurse", "clinician"]}><EmergencyCasePage /></ProtectedRoute>} />
        <Route path="encounters/:id" element={<ProtectedRoute roles={["nurse", "clinician", "receptionist", "facility_admin"]}><EncounterPage /></ProtectedRoute>} />
        <Route path="exchange" element={<ProtectedRoute roles={["nurse", "clinician"]}><ExchangePage /></ProtectedRoute>} />
        <Route path="wards" element={<ProtectedRoute roles={["nurse", "clinician", "facility_admin"]}><WardsPage /></ProtectedRoute>} />
        <Route path="wards/admissions/:id" element={<ProtectedRoute roles={["nurse", "clinician"]}><AdmissionDetailPage /></ProtectedRoute>} />
        <Route path="maternity" element={<ProtectedRoute roles={["nurse", "clinician", "facility_admin"]}><MaternityPage /></ProtectedRoute>} />
        <Route path="operations" element={<ProtectedRoute roles={["nurse", "clinician", "facility_admin", "housekeeping", "porter", "mortuary", "cssd", "biomedical", "auditor"]}><OperationsPage /></ProtectedRoute>} />
        <Route path="inventory" element={<ProtectedRoute roles={["nurse", "midwife", "clinician", "specialist_clinician", "diagnostic_practitioner", "department_lead", "laboratory", "radiology", "pharmacist", "theatre", "facility_admin", "hr", "records", "quality", "finance", "auditor", "housekeeping", "porter", "mortuary", "cssd", "biomedical"]}><InventoryPage /></ProtectedRoute>} />
        <Route path="theatre" element={<ProtectedRoute roles={["nurse", "clinician", "facility_admin"]}><TheatrePage /></ProtectedRoute>} />
        <Route path="theatre/:id" element={<ProtectedRoute roles={["nurse", "clinician"]}><TheatreCasePage /></ProtectedRoute>} />
        <Route path="diagnostics" element={<ProtectedRoute roles={["nurse", "clinician", "laboratory", "radiology"]}><DiagnosticsPage /></ProtectedRoute>} />
        <Route path="diagnostics/orders/:id" element={<ProtectedRoute roles={["nurse", "clinician", "laboratory", "radiology"]}><OrderDetailPage /></ProtectedRoute>} />
        <Route path="pharmacy" element={<ProtectedRoute roles={["nurse", "clinician", "pharmacist", "facility_admin"]}><PharmacyPage /></ProtectedRoute>} />
        <Route path="finance" element={<ProtectedRoute roles={["finance", "facility_admin"]}><FinancePage /></ProtectedRoute>} />
        <Route path="finance/invoices/:id" element={<ProtectedRoute roles={["finance", "facility_admin"]}><InvoiceDetailPage /></ProtectedRoute>} />
        <Route path="programmes" element={<ProtectedRoute roles={["nurse", "clinician"]}><ProgrammesPage /></ProtectedRoute>} />
        <Route path="public-health" element={<ProtectedRoute roles={["public_health", "facility_admin"]}><PublicHealthPage /></ProtectedRoute>} />
        <Route path="telehealth" element={<ProtectedRoute roles={["nurse", "clinician"]}><TelehealthPage /></ProtectedRoute>} />
        <Route path="devices" element={<ProtectedRoute roles={["nurse", "clinician", "facility_admin"]}><DevicesPage /></ProtectedRoute>} />
        <Route path="ai" element={<ProtectedRoute roles={["nurse", "clinician"]}><AIPage /></ProtectedRoute>} />
        <Route path="content" element={<ProtectedRoute><ContentPage /></ProtectedRoute>} />
        <Route path="portal" element={<ProtectedRoute patient><PatientPortalPage /></ProtectedRoute>} />
        <Route path="portal/consents" element={<ProtectedRoute patient><ConsentPage /></ProtectedRoute>} />
        <Route path="portal/access" element={<ProtectedRoute patient><AccessHistoryPage /></ProtectedRoute>} />
        <Route path="credentials" element={<ProtectedRoute><CredentialsPage /></ProtectedRoute>} />
        <Route path="documents" element={<ProtectedRoute roles={["clinician", "nurse", "records", "receptionist", "facility_admin", "hr", "quality"]}><DocumentsPage /></ProtectedRoute>} />
        <Route path="workforce" element={<ProtectedRoute roles={["hr", "facility_admin"]}><WorkforcePage /></ProtectedRoute>} />
        <Route path="onboarding" element={<ProtectedRoute><OnboardingPage /></ProtectedRoute>} />
        <Route path="caregivers" element={<ProtectedRoute patient><CaregiversPage /></ProtectedRoute>} />
        <Route path="caregiver-requests" element={<ProtectedRoute roles={["facility_admin", "records"]}><CaregiversPage /></ProtectedRoute>} />
        <Route path="onboarding-workflow" element={<ProtectedRoute><OnboardingWorkflowPage /></ProtectedRoute>} />
        <Route path="catalogue-editor" element={<ProtectedRoute><CatalogueEditorPage /></ProtectedRoute>} />
        <Route path="admin" element={<ProtectedRoute roles={["facility_admin"]}><AdminPage /></ProtectedRoute>} />
        <Route path="provider-directory" element={<ProtectedRoute roles={["facility_admin"]}><ProviderDirectoryPage /></ProtectedRoute>} />
        <Route path="promotions" element={<ProtectedRoute roles={["facility_admin"]}><PromotionsPage /></ProtectedRoute>} />
        <Route path="directory-governance" element={<ProtectedRoute platform><DirectoryGovernancePage /></ProtectedRoute>} />
        <Route path="reviewer" element={<ProtectedRoute platform><ReviewerPage /></ProtectedRoute>} />
        <Route path="security" element={<ProtectedRoute><SecurityPage /></ProtectedRoute>} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
