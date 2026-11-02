import { Navigate } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import LandingPage from "./LandingPage";

export function RootGate() {
  const { me, loading } = useAuth();
  if (loading) return null;
  if (me) return <Navigate to="/dashboard" replace />;
  return <LandingPage />;
}
