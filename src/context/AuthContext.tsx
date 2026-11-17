import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  MEDIA_FOLDER_ID_STORAGE_KEY,
  SHEETS_CACHE_STORAGE_KEY,
  SPREADSHEET_ID_STORAGE_KEY,
} from '../services/googleSheetsAdapter';
import { showToast } from '../utils/toast';
import {
  OAUTH_RETURN_ROUTE_KEY,
  isRestorableAppRoute,
  resolvePostLoginHash,
} from '../utils/navigation';
import { OFFLINE_INFO_TOAST } from '../utils/offline';
import { clearAllDrafts } from '../utils/draftStorage';
import { clearPreImportBackup } from '../utils/importSafety';
import {
  applySignedInAccount,
  forgetLastAccount,
  rememberCurrentAccount,
} from '../utils/accountSession';
import {
  GOOGLE_TOKEN_EXPIRES_AT_KEY,
  computeExpiresAt,
  isTokenExpired,
  parseStoredExpiresAt,
} from '../utils/tokenExpiry';

export interface User {
  email: string;
  name: string;
  picture?: string;
}

export const GOOGLE_TOKEN_KEY = 'pragya_google_token';
export const GOOGLE_USER_KEY = 'pragya_google_user'; // === GOOGLE_USER_STORAGE_KEY
export const MOCK_SESSION_KEY = 'pragya_mock_session';
export const MOCK_MODE_KEY = 'pragya_mock_mode';
export const GOOGLE_CLIENT_ID_KEY = 'pragya_google_client_id';
export const OAUTH_CSRF_STATE_KEY = 'pragya_oauth_csrf_state';

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
  'email',
  'profile',
].join(' ');

interface CustomWindow extends Window {
  VITE_GOOGLE_CLIENT_ID?: string;
  __PLAYWRIGHT__?: boolean;
}

function parseJwtExp(token: string): number | null {
  if (token.startsWith('eyJ') || token.toLowerCase().includes('jwt')) {
    const parts = token.split('.');
    if (parts.length === 3) {
      try {
        const base64Url = parts[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
        const payload = JSON.parse(atob(padded)) as { exp?: unknown };
        if (payload && typeof payload.exp === 'number') {
          return payload.exp * 1000;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

function isExpiredSessionToken(token: string): boolean {
  if (token === 'EXPIRED_TOKEN') return true;
  const exp = parseJwtExp(token);
  if (exp !== null) return exp <= Date.now();
  return false;
}

// eslint-disable-next-line react-refresh/only-export-components
export function isInvalidOrExpiredToken(token: string | null): boolean {
  if (!token || token.trim() === '') return true;
  if (token === 'EXPIRED_TOKEN') return true;

  if (token.startsWith('eyJ') || token.toLowerCase().includes('jwt')) {
    const parts = token.split('.');
    if (parts.length !== 3) return true;
    const exp = parseJwtExp(token);
    if (exp !== null) return exp <= Date.now();
  }
  return false;
}

/** B4.11: `ya29.*` tokens expire per the stored `expires_in`; tokens without it never do. */
function isStoredTokenExpired(): boolean {
  try {
    return isTokenExpired(parseStoredExpiresAt(localStorage.getItem(GOOGLE_TOKEN_EXPIRES_AT_KEY)));
  } catch {
    return false;
  }
}

function isUsableStoredToken(token: string | null): boolean {
  return !isInvalidOrExpiredToken(token) && !isStoredTokenExpired();
}

function clearStoredToken(): void {
  localStorage.removeItem(GOOGLE_TOKEN_KEY);
  localStorage.removeItem(GOOGLE_TOKEN_EXPIRES_AT_KEY);
}

function resolveConfiguredClientId(override?: string): string | undefined {
  const envId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  const winId =
    typeof window !== 'undefined' ? (window as unknown as CustomWindow).VITE_GOOGLE_CLIENT_ID : undefined;
  const localId = override !== undefined ? override : localStorage.getItem(GOOGLE_CLIENT_ID_KEY) || '';
  const candidate = (envId || winId || localId || '').trim();
  return candidate ? candidate : undefined;
}

function getPersistedGoogleUser(): User {
  const saved = localStorage.getItem(GOOGLE_USER_KEY);
  if (saved) {
    try {
      return JSON.parse(saved) as User;
    } catch {
      // Ignore corrupt user JSON
    }
  }
  return { email: 'cloud@example.com', name: 'Google User' };
}

function clearOAuthHash(): void {
  if (typeof window === 'undefined' || !window.location.hash) return;
  try {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  } catch {
    window.location.hash = '';
  }
}

export interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isMockMode: boolean;
  googleClientId: string | undefined;
  googleClientIdExists: boolean;
  saveGoogleClientId: (clientId: string) => void;
  getGoogleToken: () => string | null;
  login: () => Promise<{ ok: boolean; reason?: 'missing_client_id' | 'offline' | 'error' }>;
  loginAsMock: () => Promise<void>;
  logout: () => Promise<void>;
  showSessionExpiredModal: boolean;
  setShowSessionExpiredModal: (show: boolean) => void;
  triggerSessionExpired: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [customClientId, setCustomClientId] = useState<string>(() => {
    try {
      return localStorage.getItem(GOOGLE_CLIENT_ID_KEY) || '';
    } catch {
      return '';
    }
  });

  const googleClientId = resolveConfiguredClientId(customClientId);
  const googleClientIdExists = Boolean(googleClientId);

  const [user, setUser] = useState<User | null>(() => {
    const token = localStorage.getItem(GOOGLE_TOKEN_KEY);
    if (isUsableStoredToken(token)) {
      return getPersistedGoogleUser();
    }
    const mockRaw = localStorage.getItem(MOCK_SESSION_KEY);
    if (mockRaw) {
      try {
        return JSON.parse(mockRaw) as User;
      } catch {
        // Ignore corrupt mock user
      }
    }
    return null;
  });

  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => {
    const token = localStorage.getItem(GOOGLE_TOKEN_KEY);
    if (isUsableStoredToken(token)) return true;
    return Boolean(localStorage.getItem(MOCK_SESSION_KEY));
  });

  const [isMockMode, setIsMockMode] = useState<boolean>(() => {
    const token = localStorage.getItem(GOOGLE_TOKEN_KEY);
    if (isUsableStoredToken(token)) return false;
    return true;
  });

  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [showSessionExpiredModal, setShowSessionExpiredModal] = useState<boolean>(false);

  const saveGoogleClientId = useCallback((nextId: string) => {
    const trimmed = nextId.trim();
    if (trimmed) {
      localStorage.setItem(GOOGLE_CLIENT_ID_KEY, trimmed);
    } else {
      localStorage.removeItem(GOOGLE_CLIENT_ID_KEY);
    }
    setCustomClientId(trimmed);
  }, []);

  const getGoogleToken = useCallback(() => {
    const token = localStorage.getItem(GOOGLE_TOKEN_KEY);
    // B4.11: an expired ya29 token yields null → adapter calls onUnauthorized →
    // SessionExpiredModal (instead of a 401 round-trip with a dead token).
    if (!isUsableStoredToken(token)) return null;
    return token;
  }, []);

  const triggerSessionExpired = useCallback(() => {
    clearStoredToken();
    setShowSessionExpiredModal(true);
  }, []);

  useEffect(() => {
    rememberCurrentAccount();
    const existingToken = localStorage.getItem(GOOGLE_TOKEN_KEY);
    if (existingToken && !isUsableStoredToken(existingToken)) {
      const expiredByClock = !isInvalidOrExpiredToken(existingToken) && isStoredTokenExpired();
      clearStoredToken();
      localStorage.removeItem(GOOGLE_USER_KEY);
      if (expiredByClock || isExpiredSessionToken(existingToken)) {
        setShowSessionExpiredModal(true);
        setUser(null);
        setIsAuthenticated(false);
        setIsLoading(false);
      }
    }

    const handleHashAuth = async () => {
      const hash = window.location.hash;
      const rawFragment = hash.includes('#')
        ? hash.slice(hash.lastIndexOf('#') + 1).replace(/^\//, '')
        : hash;
      const params = new URLSearchParams(rawFragment);
      const oauthError = params.get('error');

      if (oauthError !== null) {
        sessionStorage.removeItem(OAUTH_CSRF_STATE_KEY);
        sessionStorage.removeItem(OAUTH_RETURN_ROUTE_KEY);
        clearOAuthHash();
        showToast(
          oauthError === 'access_denied'
            ? 'Access Denied'
            : `Authentication error: ${oauthError || 'Unknown error'}`,
          'error'
        );
        setIsLoading(false);
        return;
      }

      if (params.has('access_token')) {
        const token = params.get('access_token');
        const returnedState = params.get('state');
        const storedState = sessionStorage.getItem(OAUTH_CSRF_STATE_KEY);
        sessionStorage.removeItem(OAUTH_CSRF_STATE_KEY);
        const storedReturnRoute = sessionStorage.getItem(OAUTH_RETURN_ROUTE_KEY);
        sessionStorage.removeItem(OAUTH_RETURN_ROUTE_KEY);

        if (!storedState || returnedState !== storedState) {
          clearOAuthHash();
          showToast('Authentication error: Invalid CSRF state', 'error');
          setIsLoading(false);
          return;
        }

        if (!token || isInvalidOrExpiredToken(token)) {
          clearOAuthHash();
          showToast('Authentication error: Invalid access token', 'error');
          setIsLoading(false);
          return;
        }

        clearOAuthHash();

        localStorage.setItem(GOOGLE_TOKEN_KEY, token);
        const expiresAt = computeExpiresAt(params.get('expires_in'));
        if (expiresAt !== null) {
          localStorage.setItem(GOOGLE_TOKEN_EXPIRES_AT_KEY, String(expiresAt));
        } else {
          localStorage.removeItem(GOOGLE_TOKEN_EXPIRES_AT_KEY);
        }
        localStorage.setItem(MOCK_MODE_KEY, 'false');
        localStorage.removeItem(MOCK_SESSION_KEY);
        setIsMockMode(false);
        setShowSessionExpiredModal(false);

        let profile: User = { email: 'cloud@example.com', name: 'Google User' };
        try {
          const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (res.ok) {
            const info = (await res.json()) as {
              email?: string;
              name?: string;
              picture?: string;
            };
            profile = {
              email: info.email || 'cloud@example.com',
              name: info.name || 'Google User',
              picture: info.picture,
            };
          }
        } catch {
          // Network fallback profile
        }

        // R1#1: compare against the durable last-account marker (survives token expiry),
        // clearing the previous account's drafts/backup/media/cache on a switch.
        applySignedInAccount(profile.email);

        localStorage.setItem(GOOGLE_USER_KEY, JSON.stringify(profile));
        setUser(profile);
        setIsAuthenticated(true);
        // M4.4: restore the validated pre-login route (fallback #/shelf).
        window.location.hash = resolvePostLoginHash(storedReturnRoute);
      }
      setIsLoading(false);
    };

    void handleHashAuth();
    window.addEventListener('hashchange', handleHashAuth);
    return () => window.removeEventListener('hashchange', handleHashAuth);
  }, []);

  useEffect(() => {
    const handleOffline = () => {
      if (!localStorage.getItem(GOOGLE_TOKEN_KEY)) return;
      showToast(OFFLINE_INFO_TOAST, 'info');
    };
    window.addEventListener('offline', handleOffline);
    return () => window.removeEventListener('offline', handleOffline);
  }, []);

  const checkIsTrulyOffline = async (): Promise<boolean> => {
    if (typeof fetch === 'undefined' || typeof window === 'undefined') {
      return typeof navigator !== 'undefined' && !navigator.onLine;
    }
    try {
      await fetch(window.location.origin + window.location.pathname, {
        method: 'HEAD',
        cache: 'no-store',
      });
      return false;
    } catch {
      return true;
    }
  };

  const login = useCallback(async (): Promise<{
    ok: boolean;
    reason?: 'missing_client_id' | 'offline' | 'error';
  }> => {
    const clientId = resolveConfiguredClientId();
    if (!clientId) {
      return { ok: false, reason: 'missing_client_id' };
    }

    const csrfState =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2);
    sessionStorage.setItem(OAUTH_CSRF_STATE_KEY, csrfState);
    // M4.4: remember the in-app route so the user lands back where they started.
    const currentHash = typeof window !== 'undefined' ? window.location.hash : '';
    if (isRestorableAppRoute(currentHash)) {
      sessionStorage.setItem(OAUTH_RETURN_ROUTE_KEY, currentHash);
    } else {
      sessionStorage.removeItem(OAUTH_RETURN_ROUTE_KEY);
    }

    if (await checkIsTrulyOffline()) {
      sessionStorage.removeItem(OAUTH_CSRF_STATE_KEY);
      sessionStorage.removeItem(OAUTH_RETURN_ROUTE_KEY);
      showToast('You are currently offline', 'error');
      return { ok: false, reason: 'offline' };
    }

    setIsLoading(true);
    try {
      const redirectUri = window.location.origin + window.location.pathname;

      const authUrl =
        'https://accounts.google.com/o/oauth2/v2/auth?' +
        new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'token',
          scope: GOOGLE_SCOPES,
          state: csrfState,
          include_granted_scopes: 'true',
          prompt: 'select_account',
        }).toString();

      const win = typeof window !== 'undefined' ? (window as unknown as CustomWindow) : undefined;
      const isPlaywright =
        Boolean(win) &&
        (win?.__PLAYWRIGHT__ === true ||
          (typeof navigator !== 'undefined' && navigator.userAgent.includes('Playwright')));
      // B4.11: a runtime `window.VITE_GOOGLE_CLIENT_ID` (self-hosted config) is a real
      // client id, not a test signal — it must still redirect to Google.

      if (isPlaywright) {
        setIsLoading(false);
      } else {
        window.location.href = authUrl;
      }
      return { ok: true };
    } catch {
      setIsLoading(false);
      showToast('Failed to start Google sign-in', 'error');
      return { ok: false, reason: 'error' };
    }
  }, []);

  const loginAsMock = useCallback(async () => {
    const demoUser: User = {
      email: 'demo@pragya.local',
      name: 'Demo Reader',
    };
    clearStoredToken();
    localStorage.removeItem(GOOGLE_USER_KEY);
    clearPreImportBackup();
    localStorage.setItem(MOCK_SESSION_KEY, JSON.stringify(demoUser));
    localStorage.setItem(MOCK_MODE_KEY, 'true');
    setUser(demoUser);
    setIsMockMode(true);
    setIsAuthenticated(true);
    setShowSessionExpiredModal(false);
  }, []);

  const logout = useCallback(async () => {
    setIsLoading(true);
    const token = localStorage.getItem(GOOGLE_TOKEN_KEY);
    if (token) {
      try {
        fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }).catch(() => {});
      } catch {
        // Ignore network errors
      }
    }
    clearStoredToken();
    localStorage.removeItem(GOOGLE_USER_KEY);
    localStorage.removeItem(MOCK_SESSION_KEY);
    localStorage.removeItem(MOCK_MODE_KEY);
    localStorage.removeItem(SHEETS_CACHE_STORAGE_KEY);
    localStorage.removeItem(MEDIA_FOLDER_ID_STORAGE_KEY);
    localStorage.removeItem(SPREADSHEET_ID_STORAGE_KEY);
    clearAllDrafts();
    clearPreImportBackup();
    forgetLastAccount();
    sessionStorage.removeItem(OAUTH_CSRF_STATE_KEY);
    sessionStorage.removeItem(OAUTH_RETURN_ROUTE_KEY);
    if (typeof caches !== 'undefined') {
      caches.delete('pragya-media-v1').catch(() => {});
    }
    setUser(null);
    setIsAuthenticated(false);
    setIsMockMode(true);
    setShowSessionExpiredModal(false);
    setIsLoading(false);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated,
        isLoading,
        isMockMode,
        googleClientId,
        googleClientIdExists,
        saveGoogleClientId,
        getGoogleToken,
        login,
        loginAsMock,
        logout,
        showSessionExpiredModal,
        setShowSessionExpiredModal,
        triggerSessionExpired,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
