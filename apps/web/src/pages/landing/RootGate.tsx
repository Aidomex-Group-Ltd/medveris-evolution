import { Navigate } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { isOperatorConsoleHost } from "../../lib/host";
import LandingPage from "./LandingPage";

export function RootGate() {
  const { me, loading } = useAuth();
  // The operator console is an internal surface on its own hostname: never a marketing page and
  // never a public sign-up. ProtectedRoute turns an anonymous visit into a sign-in that returns
  // to this console, and a signed-in account without a platform role is refused there.
  if (isOperatorConsoleHost()) return <Navigate to="/platform-observability" replace />;
  if (loading) return null;
  if (me) return <Navigate to="/dashboard" replace />;
  return <LandingPage />;
}
