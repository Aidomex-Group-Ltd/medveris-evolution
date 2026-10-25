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
        <Route path="encounters/:id" element={<ProtectedRoute roles={["nurse", "clinician", "receptionist", "facility_admin"]}><EncounterPage /></ProtectedRoute>} />
        <Route path="exchange" element={<ProtectedRoute roles={["nurse", "clinician"]}><ExchangePage /></ProtectedRoute>} />
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
