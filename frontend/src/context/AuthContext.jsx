import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, getSession, loadSession, saveSession, setUnauthorizedHandler } from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(() => loadSession());

  // A rejected token (expired, logged out elsewhere) signs the user out everywhere in the UI.
  useEffect(() => {
    setUnauthorizedHandler(() => setSession(null));
    return () => setUnauthorizedHandler(() => {});
  }, []);

  const login = useCallback(async (email, password) => {
    const res = await api.login(email, password);
    const next = { token: res.access_token, user: res.user };
    saveSession(next);
    setSession(next);
    return res.user;
  }, []);

  const register = useCallback(async (fields) => api.register(fields), []);

  const logout = useCallback(async () => {
    try {
      if (getSession()) await api.logout();
    } catch {
      // the token may already be dead; local sign-out must still succeed
    }
    saveSession(null);
    setSession(null);
  }, []);

  const value = useMemo(
    () => ({ user: session?.user ?? null, isAuthenticated: Boolean(session), login, register, logout }),
    [session, login, register, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
