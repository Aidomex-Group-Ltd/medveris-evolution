import { Link, Route, Routes } from "react-router-dom";
import { EmptyState, PageHeader } from "@medveris/ui";
import { AppShell } from "./components/AppShell";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { DashboardPage } from "./pages/DashboardPage";
import { PatientsPage } from "./pages/PatientsPage";
import { QueuesPage } from "./pages/QueuesPage";
import { WorklistPage } from "./pages/WorklistPage";
import { EncounterPage } from "./pages/EncounterPage";
import { PatientPortalPage } from "./pages/PatientPortalPage";
import { ConsentPage } from "./pages/ConsentPage";
import { AccessHistoryPage } from "./pages/AccessHistoryPage";
import { ExchangePage } from "./pages/ExchangePage";
import { CredentialsPage } from "./pages/CredentialsPage";
import { AdminPage } from "./pages/AdminPage";
import { ReviewerPage } from "./pages/ReviewerPage";
import { SecurityPage } from "./pages/SecurityPage";
import { WardsPage } from "./pages/WardsPage";
import { TheatrePage } from "./pages/TheatrePage";
import { TheatreCasePage } from "./pages/TheatreCasePage";
import { AdmissionDetailPage } from "./pages/AdmissionDetailPage";
import { DiagnosticsPage } from "./pages/DiagnosticsPage";
import { OrderDetailPage } from "./pages/OrderDetailPage";
import { PharmacyPage } from "./pages/PharmacyPage";
import { FinancePage } from "./pages/FinancePage";
import { InvoiceDetailPage } from "./pages/InvoiceDetailPage";
import { ProgrammesPage } from "./pages/ProgrammesPage";
import { PublicHealthPage } from "./pages/PublicHealthPage";
import { TelehealthPage } from "./pages/TelehealthPage";
import { DevicesPage } from "./pages/DevicesPage";
import { AIPage } from "./pages/AIPage";
import { EmergencyPage } from "./pages/EmergencyPage";
import { EmergencyCasePage } from "./pages/EmergencyCasePage";

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
      <Route element={<ProtectedRoute><AppShell /></ProtectedRoute>}>
        <Route index element={<DashboardPage />} />
        <Route path="patients" element={<ProtectedRoute roles={["receptionist", "nurse", "clinician", "facility_admin"]}><PatientsPage /></ProtectedRoute>} />
        <Route path="queues" element={<ProtectedRoute roles={["receptionist", "nurse", "clinician", "facility_admin"]}><QueuesPage /></ProtectedRoute>} />
        <Route path="worklist" element={<ProtectedRoute roles={["nurse", "clinician"]}><WorklistPage /></ProtectedRoute>} />
        <Route path="emergency" element={<ProtectedRoute roles={["nurse", "clinician"]}><EmergencyPage /></ProtectedRoute>} />
        <Route path="emergency/:id" element={<ProtectedRoute roles={["nurse", "clinician"]}><EmergencyCasePage /></ProtectedRoute>} />
        <Route path="encounters/:id" element={<ProtectedRoute roles={["nurse", "clinician", "receptionist", "facility_admin"]}><EncounterPage /></ProtectedRoute>} />
        <Route path="exchange" element={<ProtectedRoute roles={["nurse", "clinician"]}><ExchangePage /></ProtectedRoute>} />
        <Route path="wards" element={<ProtectedRoute roles={["nurse", "clinician", "facility_admin"]}><WardsPage /></ProtectedRoute>} />
        <Route path="wards/admissions/:id" element={<ProtectedRoute roles={["nurse", "clinician"]}><AdmissionDetailPage /></ProtectedRoute>} />
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
        <Route path="portal" element={<ProtectedRoute patient><PatientPortalPage /></ProtectedRoute>} />
        <Route path="portal/consents" element={<ProtectedRoute patient><ConsentPage /></ProtectedRoute>} />
        <Route path="portal/access" element={<ProtectedRoute patient><AccessHistoryPage /></ProtectedRoute>} />
        <Route path="credentials" element={<ProtectedRoute><CredentialsPage /></ProtectedRoute>} />
        <Route path="admin" element={<ProtectedRoute roles={["facility_admin"]}><AdminPage /></ProtectedRoute>} />
        <Route path="reviewer" element={<ProtectedRoute platform><ReviewerPage /></ProtectedRoute>} />
        <Route path="security" element={<ProtectedRoute><SecurityPage /></ProtectedRoute>} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
