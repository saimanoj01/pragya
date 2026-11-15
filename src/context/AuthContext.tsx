import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  MEDIA_FOLDER_ID_STORAGE_KEY,
  SHEETS_CACHE_STORAGE_KEY,
  SPREADSHEET_ID_STORAGE_KEY,
} from '../services/googleSheetsAdapter';
import { showToast } from '../utils/toast';

export interface User {
  email: string;
  name: string;
  picture?: string;
}

export const GOOGLE_TOKEN_KEY = 'pragya_google_token';
export const GOOGLE_USER_KEY = 'pragya_google_user';
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
  login: () => Promise<void>;
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
    if (!isInvalidOrExpiredToken(token)) {
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
    if (!isInvalidOrExpiredToken(token)) return true;
    return Boolean(localStorage.getItem(MOCK_SESSION_KEY));
  });

  const [isMockMode, setIsMockMode] = useState<boolean>(() => {
    const token = localStorage.getItem(GOOGLE_TOKEN_KEY);
    if (!isInvalidOrExpiredToken(token)) return false;
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
    if (isInvalidOrExpiredToken(token)) return null;
    return token;
  }, []);

  const triggerSessionExpired = useCallback(() => {
    localStorage.removeItem(GOOGLE_TOKEN_KEY);
    setShowSessionExpiredModal(true);
  }, []);

  useEffect(() => {
    const existingToken = localStorage.getItem(GOOGLE_TOKEN_KEY);
    if (existingToken && isInvalidOrExpiredToken(existingToken)) {
      localStorage.removeItem(GOOGLE_TOKEN_KEY);
      localStorage.removeItem(GOOGLE_USER_KEY);
      if (isExpiredSessionToken(existingToken)) {
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
        const previousUserRaw = localStorage.getItem(GOOGLE_USER_KEY);
        let previousEmail: string | null = null;
        if (previousUserRaw) {
          try {
            previousEmail = (JSON.parse(previousUserRaw) as Partial<User>).email || null;
          } catch {
            // Ignore malformed persisted user
          }
        }

        localStorage.setItem(GOOGLE_TOKEN_KEY, token);
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

        if (previousEmail && profile.email && previousEmail !== profile.email) {
          localStorage.removeItem(SHEETS_CACHE_STORAGE_KEY);
          localStorage.removeItem(MEDIA_FOLDER_ID_STORAGE_KEY);
          localStorage.removeItem(SPREADSHEET_ID_STORAGE_KEY);
        }

        localStorage.setItem(GOOGLE_USER_KEY, JSON.stringify(profile));
        setUser(profile);
        setIsAuthenticated(true);
        window.location.hash = '#/shelf';
      }
      setIsLoading(false);
    };

    void handleHashAuth();
    window.addEventListener('hashchange', handleHashAuth);
    return () => window.removeEventListener('hashchange', handleHashAuth);
  }, []);

  useEffect(() => {
    const handleOffline = () => {
      showToast('You are currently offline', 'error');
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

  const login = useCallback(async () => {
    const clientId = resolveConfiguredClientId();
    if (!clientId) {
      showToast('Please configure a Google OAuth Client ID or continue in Demo Mode.', 'error');
      return;
    }

    const csrfState =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2);
    sessionStorage.setItem(OAUTH_CSRF_STATE_KEY, csrfState);

    if (await checkIsTrulyOffline()) {
      sessionStorage.removeItem(OAUTH_CSRF_STATE_KEY);
      showToast('You are currently offline', 'error');
      return;
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
          (typeof navigator !== 'undefined' && navigator.userAgent.includes('Playwright')) ||
          win?.VITE_GOOGLE_CLIENT_ID !== undefined);

      if (isPlaywright) {
        setIsLoading(false);
      } else {
        window.location.href = authUrl;
      }
    } catch {
      setIsLoading(false);
      showToast('Failed to start Google sign-in', 'error');
    }
  }, []);

  const loginAsMock = useCallback(async () => {
    const demoUser: User = {
      email: 'demo@pragya.local',
      name: 'Demo Reader',
    };
    localStorage.removeItem(GOOGLE_TOKEN_KEY);
    localStorage.removeItem(GOOGLE_USER_KEY);
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
    localStorage.removeItem(GOOGLE_TOKEN_KEY);
    localStorage.removeItem(GOOGLE_USER_KEY);
    localStorage.removeItem(MOCK_SESSION_KEY);
    localStorage.removeItem(MOCK_MODE_KEY);
    localStorage.removeItem(SHEETS_CACHE_STORAGE_KEY);
    localStorage.removeItem(MEDIA_FOLDER_ID_STORAGE_KEY);
    localStorage.removeItem(SPREADSHEET_ID_STORAGE_KEY);
    sessionStorage.removeItem(OAUTH_CSRF_STATE_KEY);
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
