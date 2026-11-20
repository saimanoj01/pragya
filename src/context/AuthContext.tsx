import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  MEDIA_FOLDER_ID_STORAGE_KEY,
  SHEETS_CACHE_STORAGE_KEY,
  SPREADSHEET_ID_STORAGE_KEY,
} from '../services/googleSheetsAdapter';
import { dismissAllToasts, showToast } from '../utils/toast';
import {
  OAUTH_RETURN_ROUTE_KEY,
  isRestorableAppRoute,
  resolvePostLoginHash,
} from '../utils/navigation';
import { OFFLINE_INFO_TOAST } from '../utils/offline';
import { DEMO_DRAFT_SCOPE, clearAllDrafts } from '../utils/draftStorage';
import { CAPSTONE_HIDDEN_KEY } from '../utils/capstonePrompt';
import { LAST_DELETE_BACKUP_KEY } from '../utils/deletePlan';
import { flushIdbQueue, idbClear, idbDelete } from '../utils/idbStore';
import { clearPreImportBackupAsync } from '../utils/importSafety';
import {
  adoptLegacyDraftsForAccount,
  applySignedInAccount,
  rememberCurrentAccount,
} from '../utils/accountSession';
import {
  GOOGLE_TOKEN_EXPIRES_AT_KEY,
  computeExpiresAt,
  isTokenExpired,
  parseStoredExpiresAt,
} from '../utils/tokenExpiry';
import {
  GIS_SILENT_REFRESH_TIMEOUT_MS,
  computeProactiveRefreshDelayMs,
  hasGisOAuth2Runtime,
  requestSilentGisToken,
  shouldAttemptSilentRefresh,
} from '../utils/gisSilentRefresh';

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

function isPlaywrightEnv(): boolean {
  if (typeof window === 'undefined') return false;
  const win = window as unknown as CustomWindow;
  return Boolean(
    win.__PLAYWRIGHT__ === true ||
      (typeof navigator !== 'undefined' && navigator.userAgent.includes('Playwright'))
  );
}

/**
 * R2-2: synchronous mount check so an expired-by-clock Cloud session eligible for silent
 * GIS recovery renders the calm centered spinner instead of briefly flashing `<LoginView />`.
 */
function canAttemptSilentBootRecoveryNow(existingToken: string | null): boolean {
  if (!existingToken || isUsableStoredToken(existingToken)) return false;
  const expiredByClock = !isInvalidOrExpiredToken(existingToken) && isStoredTokenExpired();
  const hasOAuthCallbackInHash =
    typeof window !== 'undefined' && window.location.hash.includes('access_token=');
  return (
    expiredByClock &&
    !hasOAuthCallbackInHash &&
    shouldAttemptSilentRefresh({
      clientId: resolveConfiguredClientId(),
      isMockMode: localStorage.getItem(MOCK_MODE_KEY) === 'true',
      isOffline: typeof navigator !== 'undefined' && navigator.onLine === false,
      isPlaywright: isPlaywrightEnv(),
      hasGisRuntime: hasGisOAuth2Runtime(),
      expiresAt: parseStoredExpiresAt(localStorage.getItem(GOOGLE_TOKEN_EXPIRES_AT_KEY)),
      force: true,
    })
  );
}

export interface LogoutOptions {
  /** "Discard drafts and log out" in the logout confirmation (CD C.1.5). */
  discardDrafts?: boolean;
}

export interface SilentRefreshCallOptions {
  /** True when triggered by an expired/missing token or 401; false for proactive 5-min window. */
  force?: boolean;
  /** Used on boot recovery before React `user` state is hydrated. */
  expectedEmailOverride?: string;
  /** Allows boot recovery before `isMockMode` React state switches to false. */
  allowMountRecovery?: boolean;
}

export interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /** R2-2: true while silent GIS boot recovery is in flight (prevents `<LoginView />` flash). */
  isRecoveringSession: boolean;
  isMockMode: boolean;
  googleClientId: string | undefined;
  googleClientIdExists: boolean;
  saveGoogleClientId: (clientId: string) => void;
  getGoogleToken: () => string | null;
  /** CD Batch 8 (B4.12): attempt a single-flight silent GIS token refresh (`prompt: ''`). */
  refreshGoogleTokenSilent: (options?: SilentRefreshCallOptions) => Promise<string | null>;
  login: () => Promise<{ ok: boolean; reason?: 'missing_client_id' | 'offline' | 'error' }>;
  loginAsMock: () => Promise<void>;
  logout: (options?: LogoutOptions) => Promise<void>;
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
  const [isRecoveringSession, setIsRecoveringSession] = useState<boolean>(() =>
    canAttemptSilentBootRecoveryNow(localStorage.getItem(GOOGLE_TOKEN_KEY))
  );
  const [showSessionExpiredModal, setShowSessionExpiredModal] = useState<boolean>(false);
  const [tokenRefreshTick, setTokenRefreshTick] = useState<number>(0);

  const userRef = useRef<User | null>(user);
  userRef.current = user;
  const isAuthenticatedRef = useRef<boolean>(isAuthenticated);
  isAuthenticatedRef.current = isAuthenticated;
  const isMockModeRef = useRef<boolean>(isMockMode);
  isMockModeRef.current = isMockMode;
  const googleClientIdRef = useRef<string | undefined>(googleClientId);
  googleClientIdRef.current = googleClientId;
  // Monotonic session generation prevents an in-flight silent refresh from resurrecting
  // credentials after an explicit logout, Demo switch, or cross-account OAuth login.
  const sessionGenRef = useRef<number>(0);
  // R1#3: tracks last proactive refresh timestamp so short-lived tokens never tight-loop.
  const lastProactiveRefreshAtRef = useRef<number>(0);

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
    // B4.11: an expired ya29 token yields null → adapter attempts B4.12 silent refresh →
    // falls back to onUnauthorized (SessionExpiredModal) if silent refresh is unavailable.
    if (!isUsableStoredToken(token)) return null;
    return token;
  }, []);

  const triggerSessionExpired = useCallback(() => {
    // QA-48 / R1#2: ignore stale 401s settling after explicit logout or switch to Demo Mode.
    if (
      !isAuthenticatedRef.current ||
      isMockModeRef.current ||
      localStorage.getItem(MOCK_MODE_KEY) === 'true'
    ) {
      return;
    }
    clearStoredToken();
    setShowSessionExpiredModal(true);
  }, []);

  const refreshGoogleTokenSilent = useCallback(
    async (options: SilentRefreshCallOptions = {}): Promise<string | null> => {
      const originGen = sessionGenRef.current;
      if (!options.allowMountRecovery && !isAuthenticatedRef.current) {
        return null;
      }
      const clientId = googleClientIdRef.current || resolveConfiguredClientId();
      const effectiveMockMode = options.allowMountRecovery
        ? localStorage.getItem(MOCK_MODE_KEY) === 'true'
        : isMockModeRef.current || localStorage.getItem(MOCK_MODE_KEY) === 'true';
      const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
      const expiresAt = parseStoredExpiresAt(localStorage.getItem(GOOGLE_TOKEN_EXPIRES_AT_KEY));
      const eligible = shouldAttemptSilentRefresh({
        clientId,
        isMockMode: effectiveMockMode,
        isOffline,
        isPlaywright: isPlaywrightEnv(),
        hasGisRuntime: hasGisOAuth2Runtime(),
        expiresAt,
        force: Boolean(options.force),
      });
      if (!eligible || !clientId) return null;

      const expectedEmail = (
        options.expectedEmailOverride ||
        userRef.current?.email ||
        ''
      ).trim();

      const res = await requestSilentGisToken({
        clientId,
        scope: GOOGLE_SCOPES,
        loginHint: expectedEmail || undefined,
        expectedEmail: expectedEmail || undefined,
        timeoutMs: GIS_SILENT_REFRESH_TIMEOUT_MS,
      });

      if (!res.ok) return null;
      if (sessionGenRef.current !== originGen) return null;
      if (
        !options.allowMountRecovery &&
        (!isAuthenticatedRef.current ||
          isMockModeRef.current ||
          localStorage.getItem(MOCK_MODE_KEY) === 'true')
      ) {
        return null;
      }

      localStorage.setItem(GOOGLE_TOKEN_KEY, res.accessToken);
      if (res.expiresAt !== null) {
        localStorage.setItem(GOOGLE_TOKEN_EXPIRES_AT_KEY, String(res.expiresAt));
      } else {
        localStorage.removeItem(GOOGLE_TOKEN_EXPIRES_AT_KEY);
      }
      setShowSessionExpiredModal(false);
      setTokenRefreshTick(t => t + 1);
      return res.accessToken;
    },
    []
  );

  useEffect(() => {
    rememberCurrentAccount();
    // CD 1a fix-up: adopt pre-scoping drafts into the signed-in real account's scope.
    if (localStorage.getItem(MOCK_MODE_KEY) !== 'true') {
      try {
        const stored = JSON.parse(localStorage.getItem(GOOGLE_USER_KEY) || 'null') as { email?: string } | null;
        if (stored?.email) adoptLegacyDraftsForAccount(stored.email);
      } catch {
        // Unreadable profile: leave legacy drafts alone.
      }
    }
    const existingToken = localStorage.getItem(GOOGLE_TOKEN_KEY);
    if (existingToken && !isUsableStoredToken(existingToken)) {
      const expiredByClock = !isInvalidOrExpiredToken(existingToken) && isStoredTokenExpired();
      const canTrySilentBootRecovery = canAttemptSilentBootRecoveryNow(existingToken);

      if (canTrySilentBootRecovery) {
        const mountGen = sessionGenRef.current;
        const savedProfile = getPersistedGoogleUser();
        setIsRecoveringSession(true);
        void refreshGoogleTokenSilent({
          force: true,
          expectedEmailOverride: savedProfile.email,
          allowMountRecovery: true,
        }).then(refreshed => {
          if (sessionGenRef.current !== mountGen) return;
          if (refreshed) {
            localStorage.setItem(MOCK_MODE_KEY, 'false');
            userRef.current = savedProfile;
            isMockModeRef.current = false;
            isAuthenticatedRef.current = true;
            setUser(savedProfile);
            setIsMockMode(false);
            setIsAuthenticated(true);
            setShowSessionExpiredModal(false);
            setIsRecoveringSession(false);
            setIsLoading(false);
          } else {
            clearStoredToken();
            localStorage.removeItem(GOOGLE_USER_KEY);
            userRef.current = null;
            isAuthenticatedRef.current = false;
            setShowSessionExpiredModal(true);
            setUser(null);
            setIsAuthenticated(false);
            setIsRecoveringSession(false);
            setIsLoading(false);
          }
        });
      } else {
        setIsRecoveringSession(false);
        clearStoredToken();
        localStorage.removeItem(GOOGLE_USER_KEY);
        if (expiredByClock || isExpiredSessionToken(existingToken)) {
          setShowSessionExpiredModal(true);
          setUser(null);
          setIsAuthenticated(false);
          setIsLoading(false);
        }
      }
    } else {
      setIsRecoveringSession(false);
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
        sessionGenRef.current += 1;

        const expiresAt = computeExpiresAt(params.get('expires_in'));
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

        // R1#1 / R1#3 / CD7: compare against the durable last-account marker and finish any
        // cross-account IndexedDB wipe BEFORE activating Cloud mode (token, MOCK_MODE_KEY,
        // setIsMockMode(false)) so PragyaProvider never constructs a Cloud adapter with a
        // stale Demo/previous-account identity or races loadWorkspace() against flushIdbQueue().
        if (applySignedInAccount(profile.email)) {
          await flushIdbQueue();
          // R2 N3: say so calmly instead of silently dropping drafts.
          showToast(
            'Signed in as a different account. Unsaved drafts from the previous account were cleared on this device.',
            'info'
          );
        }

        localStorage.setItem(GOOGLE_TOKEN_KEY, token);
        if (expiresAt !== null) {
          localStorage.setItem(GOOGLE_TOKEN_EXPIRES_AT_KEY, String(expiresAt));
        } else {
          localStorage.removeItem(GOOGLE_TOKEN_EXPIRES_AT_KEY);
        }
        localStorage.setItem(MOCK_MODE_KEY, 'false');
        localStorage.removeItem(MOCK_SESSION_KEY);
        localStorage.setItem(GOOGLE_USER_KEY, JSON.stringify(profile));
        // CD 1a fix-up: legacy unscoped drafts belong to this (same) account.
        adoptLegacyDraftsForAccount(profile.email);
        lastProactiveRefreshAtRef.current = 0;
        userRef.current = profile;
        isMockModeRef.current = false;
        isAuthenticatedRef.current = true;
        setIsMockMode(false);
        setShowSessionExpiredModal(false);
        setIsRecoveringSession(false);
        setUser(profile);
        setIsAuthenticated(true);
        setTokenRefreshTick(t => t + 1);
        // M4.4: restore the validated pre-login route (fallback #/shelf).
        window.location.hash = resolvePostLoginHash(storedReturnRoute);
      }
      setIsLoading(false);
    };

    void handleHashAuth();
    window.addEventListener('hashchange', handleHashAuth);
    return () => window.removeEventListener('hashchange', handleHashAuth);
  }, [refreshGoogleTokenSilent]);

  // CD Batch 8 (B4.12) + R1#3: proactive background GIS silent refresh when within 5 minutes
  // of expiry, with cooldown / short-token loop protection.
  useEffect(() => {
    if (!isAuthenticated || isMockMode) return;
    const expiresAt = parseStoredExpiresAt(localStorage.getItem(GOOGLE_TOKEN_EXPIRES_AT_KEY));
    const clientId = googleClientIdRef.current || resolveConfiguredClientId();
    const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (!clientId || isOffline || (isPlaywrightEnv() && !hasGisOAuth2Runtime())) return;

    const delayMs = computeProactiveRefreshDelayMs({
      expiresAt,
      lastProactiveRefreshAt: lastProactiveRefreshAtRef.current,
    });
    if (delayMs === null) return;

    const timer = window.setTimeout(() => {
      lastProactiveRefreshAtRef.current = Date.now();
      void refreshGoogleTokenSilent({ force: false });
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [isAuthenticated, isMockMode, googleClientId, tokenRefreshTick, refreshGoogleTokenSilent]);

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

      // B4.11: a runtime `window.VITE_GOOGLE_CLIENT_ID` (self-hosted config) is a real
      // client id, not a test signal — it must still redirect to Google.
      if (isPlaywrightEnv()) {
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
    sessionGenRef.current += 1;
    lastProactiveRefreshAtRef.current = 0;
    const demoUser: User = {
      email: 'demo@pragya.local',
      name: 'Demo Reader',
    };
    isMockModeRef.current = true;
    userRef.current = demoUser;
    // CD 1a fix-up (R1#1): drafts are scoped per account, so a real account's kept
    // drafts are invisible in Demo by construction — nothing is wiped here.
    clearStoredToken();
    localStorage.removeItem(GOOGLE_USER_KEY);
    await clearPreImportBackupAsync();
    localStorage.setItem(MOCK_SESSION_KEY, JSON.stringify(demoUser));
    localStorage.setItem(MOCK_MODE_KEY, 'true');
    isAuthenticatedRef.current = true;
    setUser(demoUser);
    setIsMockMode(true);
    setIsAuthenticated(true);
    setIsRecoveringSession(false);
    setShowSessionExpiredModal(false);
  }, []);

  const logout = useCallback(async (options: LogoutOptions = {}) => {
    sessionGenRef.current += 1;
    lastProactiveRefreshAtRef.current = 0;
    // QA-48 / R1#2: update refs synchronously before any async cleanup so in-flight
    // Cloud 401s or DriveImage callbacks can never pop SessionExpiredModal or resurrect cache.
    isAuthenticatedRef.current = false;
    isMockModeRef.current = true;
    userRef.current = null;
    setIsLoading(true);
    setIsRecoveringSession(false);
    // CD C1.2 fix-up: an Undo toast (delete/archive) must not outlive the session.
    dismissAllToasts();
    const wasDemo = localStorage.getItem(MOCK_MODE_KEY) === 'true';
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
    localStorage.removeItem(MEDIA_FOLDER_ID_STORAGE_KEY);
    localStorage.removeItem(SPREADSHEET_ID_STORAGE_KEY);
    // CD C.1.5 / decisions Q2: unsaved drafts STAY on this device after logout (the
    // confirm dialog says so). The last-account marker is kept too, so a different
    // account signing in later still triggers the account-switch wipe + N3 toast.
    // Demo drafts are throwaway and never carried into a real account.
    if (options.discardDrafts) clearAllDrafts({ scope: 'all' });
    else if (wasDemo) clearAllDrafts({ scope: DEMO_DRAFT_SCOPE });
    await Promise.all([
      idbDelete(SHEETS_CACHE_STORAGE_KEY),
      clearPreImportBackupAsync(),
      idbClear(),
      typeof caches !== 'undefined'
        ? caches.delete('pragya-media-v1').catch(() => false)
        : Promise.resolve(false),
    ]);
    localStorage.removeItem(CAPSTONE_HIDDEN_KEY);
    localStorage.removeItem(LAST_DELETE_BACKUP_KEY);
    sessionStorage.removeItem(OAUTH_CSRF_STATE_KEY);
    sessionStorage.removeItem(OAUTH_RETURN_ROUTE_KEY);
    setUser(null);
    setIsAuthenticated(false);
    setIsMockMode(true);
    setShowSessionExpiredModal(false);
    setIsLoading(false);
  }, []);

  const value = useMemo<AuthContextType>(
    () => ({
      user,
      isAuthenticated,
      isLoading,
      isRecoveringSession,
      isMockMode,
      googleClientId,
      googleClientIdExists,
      saveGoogleClientId,
      getGoogleToken,
      refreshGoogleTokenSilent,
      login,
      loginAsMock,
      logout,
      showSessionExpiredModal,
      setShowSessionExpiredModal,
      triggerSessionExpired,
    }),
    [
      user,
      isAuthenticated,
      isLoading,
      isRecoveringSession,
      isMockMode,
      googleClientId,
      googleClientIdExists,
      saveGoogleClientId,
      getGoogleToken,
      refreshGoogleTokenSilent,
      login,
      loginAsMock,
      logout,
      showSessionExpiredModal,
      triggerSessionExpired,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
