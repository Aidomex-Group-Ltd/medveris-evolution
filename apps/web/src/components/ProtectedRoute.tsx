import type { ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { EmptyState, ErrorState, LoadingState } from "@medveris/ui";
import { useAuth } from "../lib/auth";
import type { Role } from "../lib/types";

export function ProtectedRoute({ children, roles, platform, patient }: { children: ReactNode; roles?: Role[]; platform?: boolean; patient?: boolean }) {
  const { me, loading, error, refresh, signedOut } = useAuth();
  const location = useLocation();
  if (loading) return <LoadingState label="Restoring session" variant="page" />;
  if (!me) return <Navigate to="/login" replace state={signedOut ? null : { from: `${location.pathname}${location.search}` }} />;
  if (error) return <ErrorState message={error} onRetry={() => void refresh()} />;
  const staffContext = Boolean(me.activeTenant) && !patient && (!me.patientId || Boolean(roles));
  if (staffContext && !(me.user.mfaEnrolled && me.user.mfaVerified)) return <Navigate to="/mfa-setup" replace />;
  if (patient && !me.patientId) return <EmptyState title="Patient account required" description="This area is available only to a verified patient account." />;
  if (platform && me.platformRoles.length === 0) return <EmptyState title="Access denied" description="Independent credential reviewer permission is required." />;
  if (roles && !roles.some((role) => me.activeTenant?.roles.includes(role))) {
    return <EmptyState title="Access denied" description="Your active facility role does not include this workspace. Facility administration does not grant clinical access." />;
  }
  if (!patient && !me.activeTenant && !platform && !me.patientId) {
    return me.memberships.length
      ? <EmptyState title="Choose a facility" description="Your account has staff access at more than one facility. Choose one to open its workspace." action={<Link to="/facility-staff">Choose a facility</Link>} />
      : <EmptyState title="Not registered as facility staff" description="Accept the invitation your facility administrator emailed you, or ask them to invite you." action={<Link to="/facility-staff">Facility staff sign-in</Link>} />;
  }
  return <>{children}</>;
}
