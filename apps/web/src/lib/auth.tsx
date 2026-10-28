import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, clearCsrfToken, errorMessage, hasCsrfToken, setCsrfToken } from "./api";
import type { MeResponse } from "./types";

interface AuthState {
  me: MeResponse | null;
  loading: boolean;
  error: string | null;
  /** True after an explicit sign-out, so the next sign-in does not return to the previous user's page. */
  signedOut: boolean;
}

interface AuthActions {
  refresh: () => Promise<MeResponse | null>;
  login: (email: string, password: string) => Promise<{ mfaRequired: boolean; challengeId?: string }>;
  loginMfa: (challengeId: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  switchTenant: (tenantId: string) => Promise<void>;
  clearError: () => void;
}

const AuthContext = createContext<(AuthState & AuthActions) | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ me: null, loading: true, error: null, signedOut: false });
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      // A CSRF token means sign-in just succeeded; otherwise probe the session so signed-out loads avoid a 401 from /me.
      const session = hasCsrfToken() ? { authenticated: true } : await api<{ authenticated: boolean }>("/auth/session");
      if (current !== generation.current) return null;
      if (!session.authenticated) {
        clearCsrfToken();
        setState((s) => ({ ...s, me: null, loading: false, error: null }));
        return null;
      }
      const me = await api<MeResponse>("/me");
      if (current !== generation.current) return null;
      setCsrfToken(me.csrfToken);
      setState({ me, loading: false, error: null, signedOut: false });
      return me;
    } catch (error) {
      if (current !== generation.current) return null;
      clearCsrfToken();
      setState((s) => ({ ...s, me: null, loading: false, error: error instanceof Error && !("status" in error) ? errorMessage(error) : null }));
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api<{ mfaRequired?: boolean; challengeId?: string; csrfToken?: string }>("/auth/login", {
      method: "POST",
      body: { email, password },
    });
    if (result.mfaRequired) return { mfaRequired: true, challengeId: result.challengeId };
    if (result.csrfToken) setCsrfToken(result.csrfToken);
    await refresh();
    return { mfaRequired: false };
  }, [refresh]);

  const loginMfa = useCallback(async (challengeId: string, code: string) => {
    const result = await api<{ csrfToken: string }>("/auth/login/mfa", { method: "POST", body: { challengeId, code } });
    setCsrfToken(result.csrfToken);
    await refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } finally {
      generation.current += 1;
      clearCsrfToken();
      setState({ me: null, loading: false, error: null, signedOut: true });
    }
  }, []);

  const switchTenant = useCallback(async (tenantId: string) => {
    await api("/me/context", { method: "POST", body: { tenantId } });
    await refresh();
  }, [refresh]);

  const clearError = useCallback(() => setState((s) => ({ ...s, error: null })), []);

  const value = useMemo(() => ({ ...state, refresh, login, loginMfa, logout, switchTenant, clearError }), [state, refresh, login, loginMfa, logout, switchTenant, clearError]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider");
  return value;
}
