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
import { COLLISION_SKIP_KEY } from '../utils/crossBookSynthesis';
import { LAST_DELETE_BACKUP_KEY } from '../utils/deletePlan';
import { flushIdbQueue, idbClear, idbDelete } from '../utils/idbStore';
import { clearPreImportBackupAsync } from '../utils/importSafety';
import {
  adoptLegacyDraftsForAccount,
  applySignedInAccount,
  getPreviousAccountEmail,
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
  GIS_SILENT_REFRESH_WINDOW_MS,
  computeProactiveRefreshDelayMs,
  hasGisOAuth2Runtime,
  loadGisScript,
  requestSilentGisToken,
  shouldAttemptSilentRefresh,
} from '../utils/gisSilentRefresh';
import {
  GOOGLE_AUTH_PROXY_URL_KEY,
  OAUTH_PROXY_TIMEOUT_MS,
  buildGoogleAuthUrl,
  clearOAuthSearchParams,
  clearPendingOAuthTx,
  clearSealedRefreshRecord,
  exchangeAuthCodeViaProxy,
  generatePkcePair,
  getMatchingSealedRefreshRecord,
  isOAuthCodeCallbackSearch,
  normalizeAuthProxyUrl,
  readPendingOAuthTx,
  readSealedRefreshRecord,
  requestProxyAccessToken,
  revokeSealedRefreshViaProxy,
  savePendingOAuthTx,
  writeSealedRefreshRecord,
} from '../utils/oauthProxy';

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
export { GOOGLE_AUTH_PROXY_URL_KEY };

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
  'email',
  'profile',
].join(' ');

interface CustomWindow extends Window {
  VITE_GOOGLE_CLIENT_ID?: string;
  VITE_GOOGLE_AUTH_PROXY_URL?: string;
  __PLAYWRIGHT__?: boolean;
  __LAST_OAUTH_URL__?: string;
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

function resolveConfiguredAuthProxyUrl(override?: string): string | undefined {
  const envId = (import.meta.env.VITE_GOOGLE_CLIENT_ID || '').trim();
  const envUrl = envId ? import.meta.env.VITE_GOOGLE_AUTH_PROXY_URL : undefined;
  const winUrl =
    typeof window !== 'undefined'
      ? (window as unknown as CustomWindow).VITE_GOOGLE_AUTH_PROXY_URL
      : undefined;
  const localUrl =
    override !== undefined ? override : localStorage.getItem(GOOGLE_AUTH_PROXY_URL_KEY) || '';
  return normalizeAuthProxyUrl(envUrl || winUrl || localUrl || '');
}

function readPersistedGoogleUserOrNull(): User | null {
  const saved = localStorage.getItem(GOOGLE_USER_KEY);
  if (!saved) return null;
  try {
    const parsed = JSON.parse(saved) as Partial<User>;
    if (parsed && typeof parsed.email === 'string' && parsed.email.trim()) {
      return {
        email: parsed.email.trim(),
        name: (parsed.name || 'Google User').trim() || 'Google User',
        ...(parsed.picture ? { picture: parsed.picture } : {}),
      };
    }
  } catch {
    // Ignore corrupt user JSON
  }
  return null;
}

function getPersistedGoogleUser(fallbackEmail?: string): User {
  const saved = readPersistedGoogleUserOrNull();
  if (saved) return saved;
  const email = (fallbackEmail || '').trim();
  if (email) {
    return { email, name: email.split('@')[0] || 'Google User' };
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

function requestPersistentStorageBestEffort(): void {
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.storage &&
      typeof navigator.storage.persist === 'function'
    ) {
      void navigator.storage.persist().catch(() => {});
    }
  } catch {
    // Ignore unsupported storage persistence APIs
  }
}

function hasOAuthCallbackInUrlNow(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.location.hash.includes('access_token=') ||
    isOAuthCodeCallbackSearch(window.location.search)
  );
}

function getMatchingSealedRecordNow(expectedEmail?: string) {
  if (localStorage.getItem(MOCK_MODE_KEY) === 'true') return null;
  const clientId = resolveConfiguredClientId();
  const proxyUrl = resolveConfiguredAuthProxyUrl();
  if (!clientId || !proxyUrl) return null;
  return getMatchingSealedRefreshRecord({
    clientId,
    proxyUrl,
    expectedEmail: expectedEmail || readPersistedGoogleUserOrNull()?.email,
  });
}

/**
 * Offline cached-boot guard: when the device opens the PWA completely offline after the
 * 1-hour access token expired, keep the signed-in Cloud profile alive so IndexedDB serves
 * the cached library read-only instead of kicking the reader to `<LoginView />`.
 */
function canBootIntoOfflineCacheNow(existingToken: string | null): boolean {
  if (typeof navigator === 'undefined' || navigator.onLine !== false) return false;
  if (localStorage.getItem(MOCK_MODE_KEY) === 'true') return false;
  if (hasOAuthCallbackInUrlNow()) return false;
  if (isUsableStoredToken(existingToken)) return false;
  const savedUser = readPersistedGoogleUserOrNull();
  if (!savedUser) return false;

  if (getMatchingSealedRecordNow(savedUser.email) !== null) {
    return true;
  }
  const expiredByClock =
    Boolean(existingToken) && !isInvalidOrExpiredToken(existingToken) && isStoredTokenExpired();
  return expiredByClock;
}

/**
 * R2-2 + Persistent PWA Auth: synchronous mount check so an expired Cloud session
 * eligible for silent Auth Proxy or GIS recovery renders the calm centered spinner
 * instead of briefly flashing `<LoginView />`.
 */
function canAttemptSilentBootRecoveryNow(existingToken: string | null): boolean {
  if (isUsableStoredToken(existingToken)) return false;
  if (hasOAuthCallbackInUrlNow()) return false;
  if (localStorage.getItem(MOCK_MODE_KEY) === 'true') return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;

  if (getMatchingSealedRecordNow() !== null) {
    return true;
  }

  if (!existingToken) return false;
  const expiredByClock = !isInvalidOrExpiredToken(existingToken) && isStoredTokenExpired();
  return (
    expiredByClock &&
    shouldAttemptSilentRefresh({
      clientId: resolveConfiguredClientId(),
      isMockMode: false,
      isOffline: false,
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

export interface LoginOptions {
  /** True when reconnecting an expired session (uses login_hint / 1-tap GIS when available). */
  reconnect?: boolean;
  /** True when explicitly choosing a different Google account. */
  switchAccount?: boolean;
}

export interface SilentRefreshCallOptions {
  /** True when triggered by an expired/missing token or 401; false for proactive 5-min window. */
  force?: boolean;
  /** Used on boot recovery before React `user` state is hydrated. */
  expectedEmailOverride?: string;
  /** Allows boot recovery before `isMockMode` React state switches to false. */
  allowMountRecovery?: boolean;
}

export interface SilentRefreshOutcome {
  accessToken: string | null;
  /** True when a configured Auth Proxy refresh failed due to a transient network/server issue. */
  networkError?: boolean;
}

export interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /** R2-2: true while silent boot recovery or PKCE code exchange is in flight. */
  isRecoveringSession: boolean;
  isMockMode: boolean;
  googleClientId: string | undefined;
  googleClientIdExists: boolean;
  authProxyUrl: string | undefined;
  authProxyUrlExists: boolean;
  /** True when a valid sealed refresh token is stored for automatic background renewal. */
  hasPersistentSession: boolean;
  saveGoogleClientId: (clientId: string) => void;
  saveGoogleAuthProxyUrl: (url: string) => void;
  getGoogleToken: () => string | null;
  /** CD Batch 8 (B4.12) + Auth Proxy: single-flight silent token refresh. */
  refreshGoogleTokenSilent: (options?: SilentRefreshCallOptions) => Promise<string | null>;
  /** Detailed variant distinguishing transient proxy network failures from auth revocations. */
  refreshGoogleTokenDetailed: (options?: SilentRefreshCallOptions) => Promise<SilentRefreshOutcome>;
  login: (options?: LoginOptions) => Promise<{ ok: boolean; reason?: 'missing_client_id' | 'offline' | 'error' }>;
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

  const [customAuthProxyUrl, setCustomAuthProxyUrl] = useState<string>(() => {
    try {
      return localStorage.getItem(GOOGLE_AUTH_PROXY_URL_KEY) || '';
    } catch {
      return '';
    }
  });

  const googleClientId = resolveConfiguredClientId(customClientId);
  const googleClientIdExists = Boolean(googleClientId);
  const authProxyUrl = resolveConfiguredAuthProxyUrl(customAuthProxyUrl);
  const authProxyUrlExists = Boolean(authProxyUrl);

  const [user, setUser] = useState<User | null>(() => {
    const token = localStorage.getItem(GOOGLE_TOKEN_KEY);
    if (isUsableStoredToken(token) || canBootIntoOfflineCacheNow(token)) {
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
    if (isUsableStoredToken(token) || canBootIntoOfflineCacheNow(token)) return true;
    return Boolean(localStorage.getItem(MOCK_SESSION_KEY));
  });

  const [isMockMode, setIsMockMode] = useState<boolean>(() => {
    const token = localStorage.getItem(GOOGLE_TOKEN_KEY);
    if (isUsableStoredToken(token) || canBootIntoOfflineCacheNow(token)) return false;
    return true;
  });

  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isRecoveringSession, setIsRecoveringSession] = useState<boolean>(() => {
    if (typeof window !== 'undefined' && isOAuthCodeCallbackSearch(window.location.search)) {
      return true;
    }
    return canAttemptSilentBootRecoveryNow(localStorage.getItem(GOOGLE_TOKEN_KEY));
  });
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
  const authProxyUrlRef = useRef<string | undefined>(authProxyUrl);
  authProxyUrlRef.current = authProxyUrl;
  // Monotonic session generation prevents an in-flight silent refresh from resurrecting
  // credentials after an explicit logout, Demo switch, or cross-account OAuth login.
  const sessionGenRef = useRef<number>(0);
  // R1#3: tracks last proactive refresh timestamp so short-lived tokens never tight-loop.
  const lastProactiveRefreshAtRef = useRef<number>(0);
  // StrictMode guard so PKCE code exchange / boot recovery isn't interrupted by mount 2.
  const bootFlowInFlightRef = useRef<boolean>(false);

  const hasPersistentSession = useMemo(() => {
    // Re-evaluate whenever auth state, config, or token refresh tick changes.
    void tokenRefreshTick;
    if (!isAuthenticated || isMockMode) return false;
    return (
      getMatchingSealedRefreshRecord({
        clientId: googleClientId,
        proxyUrl: authProxyUrl,
        expectedEmail: user?.email,
      }) !== null
    );
  }, [isAuthenticated, isMockMode, googleClientId, authProxyUrl, user?.email, tokenRefreshTick]);

  const saveGoogleClientId = useCallback((nextId: string) => {
    const trimmed = nextId.trim();
    if (trimmed) {
      localStorage.setItem(GOOGLE_CLIENT_ID_KEY, trimmed);
    } else {
      localStorage.removeItem(GOOGLE_CLIENT_ID_KEY);
    }
    setCustomClientId(trimmed);
  }, []);

  const saveGoogleAuthProxyUrl = useCallback((nextUrl: string) => {
    const normalized = normalizeAuthProxyUrl(nextUrl);
    if (normalized) {
      localStorage.setItem(GOOGLE_AUTH_PROXY_URL_KEY, normalized);
      setCustomAuthProxyUrl(normalized);
    } else {
      localStorage.removeItem(GOOGLE_AUTH_PROXY_URL_KEY);
      setCustomAuthProxyUrl('');
    }
  }, []);

  const getGoogleToken = useCallback(() => {
    const token = localStorage.getItem(GOOGLE_TOKEN_KEY);
    // B4.11: an expired ya29 token yields null → adapter attempts silent refresh →
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

  const refreshGoogleTokenDetailed = useCallback(
    async (options: SilentRefreshCallOptions = {}): Promise<SilentRefreshOutcome> => {
      const originGen = sessionGenRef.current;
      if (!options.allowMountRecovery && !isAuthenticatedRef.current) {
        return { accessToken: null };
      }
      const clientId = googleClientIdRef.current || resolveConfiguredClientId();
      const proxyUrl = authProxyUrlRef.current || resolveConfiguredAuthProxyUrl();
      const effectiveMockMode = options.allowMountRecovery
        ? localStorage.getItem(MOCK_MODE_KEY) === 'true'
        : isMockModeRef.current || localStorage.getItem(MOCK_MODE_KEY) === 'true';
      const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
      if (effectiveMockMode || isOffline || !clientId) {
        return { accessToken: null };
      }

      const expiresAt = parseStoredExpiresAt(localStorage.getItem(GOOGLE_TOKEN_EXPIRES_AT_KEY));
      const expectedEmail = (
        options.expectedEmailOverride ||
        userRef.current?.email ||
        ''
      ).trim();

      // Priority 1: Stateless Auth Proxy background refresh (zero popups, zero cookies).
      const sealed = getMatchingSealedRefreshRecord({
        clientId,
        proxyUrl,
        expectedEmail: expectedEmail || undefined,
      });
      const withinProactiveWindow =
        expiresAt !== null && expiresAt <= Date.now() + GIS_SILENT_REFRESH_WINDOW_MS;

      if (sealed && (options.force || withinProactiveWindow)) {
        const proxyRes = await requestProxyAccessToken({
          proxyUrl: sealed.proxyUrl,
          clientId: sealed.clientId,
          sealedRefreshToken: sealed.token,
          expectedEmail: expectedEmail || sealed.email,
          timeoutMs: OAUTH_PROXY_TIMEOUT_MS,
        });

        if (sessionGenRef.current !== originGen) return { accessToken: null };
        if (
          !options.allowMountRecovery &&
          (!isAuthenticatedRef.current ||
            isMockModeRef.current ||
            localStorage.getItem(MOCK_MODE_KEY) === 'true')
        ) {
          return { accessToken: null };
        }

        if (proxyRes.ok) {
          localStorage.setItem(GOOGLE_TOKEN_KEY, proxyRes.accessToken);
          if (proxyRes.expiresAt !== null) {
            localStorage.setItem(GOOGLE_TOKEN_EXPIRES_AT_KEY, String(proxyRes.expiresAt));
          } else {
            localStorage.removeItem(GOOGLE_TOKEN_EXPIRES_AT_KEY);
          }
          if (proxyRes.rotatedSealedRefreshToken) {
            writeSealedRefreshRecord({
              ...sealed,
              token: proxyRes.rotatedSealedRefreshToken,
              savedAt: Date.now(),
            });
          }
          setShowSessionExpiredModal(false);
          setTokenRefreshTick(t => t + 1);
          return { accessToken: proxyRes.accessToken };
        }

        if (proxyRes.reason === 'revoked' || proxyRes.reason === 'account_mismatch') {
          clearSealedRefreshRecord();
          setTokenRefreshTick(t => t + 1);
          if (proxyRes.reason === 'account_mismatch') {
            return { accessToken: null };
          }
          // Revoked refresh token falls through to GIS if eligible (or SessionExpiredModal).
        } else if (
          proxyRes.reason === 'network_error' ||
          proxyRes.reason === 'timeout' ||
          proxyRes.reason === 'server_error'
        ) {
          // Transient failure: preserve sealed refresh token so offline/flaky mobile signal
          // never wipes the user's persistent login.
          return { accessToken: null, networkError: true };
        } else {
          return { accessToken: null };
        }
      }

      // Priority 2: Browser-only GIS silent refresh (CD Batch 8 B4.12).
      const eligible = shouldAttemptSilentRefresh({
        clientId,
        isMockMode: effectiveMockMode,
        isOffline,
        isPlaywright: isPlaywrightEnv(),
        hasGisRuntime: hasGisOAuth2Runtime(),
        expiresAt,
        force: Boolean(options.force),
      });
      if (!eligible) return { accessToken: null };

      const res = await requestSilentGisToken({
        clientId,
        scope: GOOGLE_SCOPES,
        loginHint: expectedEmail || undefined,
        expectedEmail: expectedEmail || undefined,
        timeoutMs: GIS_SILENT_REFRESH_TIMEOUT_MS,
      });

      if (!res.ok) return { accessToken: null };
      if (sessionGenRef.current !== originGen) return { accessToken: null };
      if (
        !options.allowMountRecovery &&
        (!isAuthenticatedRef.current ||
          isMockModeRef.current ||
          localStorage.getItem(MOCK_MODE_KEY) === 'true')
      ) {
        return { accessToken: null };
      }

      localStorage.setItem(GOOGLE_TOKEN_KEY, res.accessToken);
      if (res.expiresAt !== null) {
        localStorage.setItem(GOOGLE_TOKEN_EXPIRES_AT_KEY, String(res.expiresAt));
      } else {
        localStorage.removeItem(GOOGLE_TOKEN_EXPIRES_AT_KEY);
      }
      setShowSessionExpiredModal(false);
      setTokenRefreshTick(t => t + 1);
      return { accessToken: res.accessToken };
    },
    []
  );

  const refreshGoogleTokenSilent = useCallback(
    async (options: SilentRefreshCallOptions = {}): Promise<string | null> => {
      const outcome = await refreshGoogleTokenDetailed(options);
      return outcome.accessToken;
    },
    [refreshGoogleTokenDetailed]
  );

  const completeCloudSignIn = useCallback(
    async (params: {
      accessToken: string;
      expiresAt: number | null;
      sealedRefreshToken?: string;
      clientId?: string;
      proxyUrl?: string;
      returnRoute?: string | null;
      preserveCurrentHash?: boolean;
      originGen: number;
    }): Promise<boolean> => {
      let profile: User = { email: 'cloud@example.com', name: 'Google User' };
      try {
        const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${params.accessToken}` },
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

      if (sessionGenRef.current !== params.originGen) {
        return false;
      }

      // R1#1 / R1#3 / CD7: compare against the durable last-account marker and finish any
      // cross-account IndexedDB wipe BEFORE activating Cloud mode (token, MOCK_MODE_KEY,
      // setIsMockMode(false)) so PragyaProvider never constructs a Cloud adapter with a
      // stale Demo/previous-account identity or races loadWorkspace() against flushIdbQueue().
      if (applySignedInAccount(profile.email)) {
        await flushIdbQueue();
        if (sessionGenRef.current !== params.originGen) {
          return false;
        }
        // R2 N3: say so calmly instead of silently dropping drafts.
        showToast(
          'Signed in as a different account. Unsaved drafts from the previous account were cleared on this device.',
          'info'
        );
      }

      localStorage.setItem(GOOGLE_TOKEN_KEY, params.accessToken);
      if (params.expiresAt !== null) {
        localStorage.setItem(GOOGLE_TOKEN_EXPIRES_AT_KEY, String(params.expiresAt));
      } else {
        localStorage.removeItem(GOOGLE_TOKEN_EXPIRES_AT_KEY);
      }
      if (params.sealedRefreshToken && params.clientId && params.proxyUrl) {
        writeSealedRefreshRecord({
          token: params.sealedRefreshToken,
          email: profile.email,
          clientId: params.clientId,
          proxyUrl: params.proxyUrl,
          savedAt: Date.now(),
        });
      }
      localStorage.setItem(MOCK_MODE_KEY, 'false');
      localStorage.removeItem(MOCK_SESSION_KEY);
      localStorage.setItem(GOOGLE_USER_KEY, JSON.stringify(profile));
      // CD 1a fix-up: legacy unscoped drafts belong to this (same) account.
      adoptLegacyDraftsForAccount(profile.email);
      requestPersistentStorageBestEffort();

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
      if (!params.preserveCurrentHash) {
        // M4.4: restore the validated pre-login route (fallback #/shelf).
        window.location.hash = resolvePostLoginHash(params.returnRoute);
      }
      return true;
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
      requestPersistentStorageBestEffort();
    }

    const handleCodeCallback = async (): Promise<boolean> => {
      if (typeof window === 'undefined' || !isOAuthCodeCallbackSearch(window.location.search)) {
        return false;
      }

      const params = new URLSearchParams(window.location.search);
      const oauthError = params.get('error');
      const code = (params.get('code') || '').trim();
      const returnedState = params.get('state');

      // Immediately clean the URL so reloads never attempt to reuse a one-time code.
      clearOAuthSearchParams();

      const sessionState = sessionStorage.getItem(OAUTH_CSRF_STATE_KEY);
      const sessionReturnRoute = sessionStorage.getItem(OAUTH_RETURN_ROUTE_KEY);
      const pendingTx = readPendingOAuthTx();
      sessionStorage.removeItem(OAUTH_CSRF_STATE_KEY);
      sessionStorage.removeItem(OAUTH_RETURN_ROUTE_KEY);
      clearPendingOAuthTx();

      if (oauthError !== null) {
        showToast(
          oauthError === 'access_denied'
            ? 'Access Denied'
            : `Authentication error: ${oauthError || 'Unknown error'}`,
          'error'
        );
        setIsRecoveringSession(false);
        setIsLoading(false);
        return true;
      }

      const expectedState = sessionState || pendingTx?.state || null;
      const storedReturnRoute = sessionReturnRoute || pendingTx?.returnRoute || null;

      if (!expectedState || !returnedState || returnedState !== expectedState) {
        showToast('Authentication error: Invalid CSRF state', 'error');
        setIsRecoveringSession(false);
        setIsLoading(false);
        return true;
      }

      if (!pendingTx || pendingTx.state !== returnedState || !pendingTx.codeVerifier) {
        showToast('Authentication error: Missing PKCE verification state. Please sign in again.', 'error');
        setIsRecoveringSession(false);
        setIsLoading(false);
        return true;
      }

      const proxyUrl = pendingTx.proxyUrl || resolveConfiguredAuthProxyUrl();
      const clientId = pendingTx.clientId || resolveConfiguredClientId();
      const redirectUri = pendingTx.redirectUri || window.location.origin + window.location.pathname;

      if (!proxyUrl || !clientId) {
        showToast('Authentication error: Auth Proxy is not configured', 'error');
        setIsRecoveringSession(false);
        setIsLoading(false);
        return true;
      }

      bootFlowInFlightRef.current = true;
      setIsRecoveringSession(true);
      sessionGenRef.current += 1;
      const originGen = sessionGenRef.current;

      try {
        const exchanged = await exchangeAuthCodeViaProxy({
          proxyUrl,
          code,
          codeVerifier: pendingTx.codeVerifier,
          redirectUri,
          clientId,
        });
        if (sessionGenRef.current !== originGen) return true;

        if (!exchanged.ok) {
          showToast(
            exchanged.reason === 'client_id_mismatch'
              ? 'Auth Proxy Client ID mismatch — verify your Client ID and Auth Proxy URL.'
              : `Authentication error: ${exchanged.detail || 'Failed to complete Google sign-in'}`,
            'error'
          );
          setIsRecoveringSession(false);
          setIsLoading(false);
          return true;
        }

        if (isInvalidOrExpiredToken(exchanged.accessToken)) {
          showToast('Authentication error: Invalid access token', 'error');
          setIsRecoveringSession(false);
          setIsLoading(false);
          return true;
        }

        await completeCloudSignIn({
          accessToken: exchanged.accessToken,
          expiresAt: exchanged.expiresAt,
          sealedRefreshToken: exchanged.sealedRefreshToken,
          clientId,
          proxyUrl,
          returnRoute: storedReturnRoute,
          originGen,
        });
      } finally {
        bootFlowInFlightRef.current = false;
        setIsLoading(false);
      }
      return true;
    };

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
        clearPendingOAuthTx();
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
        const sessionState = sessionStorage.getItem(OAUTH_CSRF_STATE_KEY);
        const sessionReturnRoute = sessionStorage.getItem(OAUTH_RETURN_ROUTE_KEY);
        const pendingTx = readPendingOAuthTx();
        sessionStorage.removeItem(OAUTH_CSRF_STATE_KEY);
        sessionStorage.removeItem(OAUTH_RETURN_ROUTE_KEY);
        clearPendingOAuthTx();

        const storedState =
          sessionState || (pendingTx?.mode === 'implicit' ? pendingTx.state : null);
        const storedReturnRoute = sessionReturnRoute || pendingTx?.returnRoute || null;

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
        const originGen = sessionGenRef.current;

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

        if (sessionGenRef.current !== originGen) {
          setIsLoading(false);
          return;
        }

        // R1#1 / R1#3 / CD7: compare against the durable last-account marker and finish any
        // cross-account IndexedDB wipe BEFORE activating Cloud mode (token, MOCK_MODE_KEY,
        // setIsMockMode(false)) so PragyaProvider never constructs a Cloud adapter with a
        // stale Demo/previous-account identity or races loadWorkspace() against flushIdbQueue().
        if (applySignedInAccount(profile.email)) {
          await flushIdbQueue();
          if (sessionGenRef.current !== originGen) {
            setIsLoading(false);
            return;
          }
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
        requestPersistentStorageBestEffort();
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

    const runBoot = async () => {
      if (bootFlowInFlightRef.current) return;

      // 1. PKCE authorization code callback in query string (`?code=...&state=...`).
      if (await handleCodeCallback()) {
        return;
      }

      // 2. Existing token / sealed refresh boot recovery (when no OAuth callback is present).
      const existingToken = localStorage.getItem(GOOGLE_TOKEN_KEY);
      const hasHashCallback =
        typeof window !== 'undefined' && window.location.hash.includes('access_token=');

      if (!hasHashCallback && !isUsableStoredToken(existingToken)) {
        if (canBootIntoOfflineCacheNow(existingToken)) {
          // Offline with expired-by-clock token or sealed refresh: keep cached Cloud session.
          setIsRecoveringSession(false);
        } else if (canAttemptSilentBootRecoveryNow(existingToken)) {
          bootFlowInFlightRef.current = true;
          const mountGen = sessionGenRef.current;
          const sealed = getMatchingSealedRecordNow();
          const savedProfile = getPersistedGoogleUser(sealed?.email);
          setIsRecoveringSession(true);
          try {
            const outcome = await refreshGoogleTokenDetailed({
              force: true,
              expectedEmailOverride: savedProfile.email,
              allowMountRecovery: true,
            });
            if (sessionGenRef.current !== mountGen) return;
            if (outcome.accessToken) {
              localStorage.setItem(MOCK_MODE_KEY, 'false');
              localStorage.setItem(GOOGLE_USER_KEY, JSON.stringify(savedProfile));
              userRef.current = savedProfile;
              isMockModeRef.current = false;
              isAuthenticatedRef.current = true;
              setUser(savedProfile);
              setIsMockMode(false);
              setIsAuthenticated(true);
              setShowSessionExpiredModal(false);
              setIsRecoveringSession(false);
              setIsLoading(false);
            } else if (outcome.networkError && readPersistedGoogleUserOrNull()) {
              // Transient network/proxy outage on boot (e.g. flaky cellular): stay in cached
              // read-only Cloud mode and preserve sealed refresh token for when signal returns.
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
          } finally {
            bootFlowInFlightRef.current = false;
          }
        } else {
          setIsRecoveringSession(false);
          if (existingToken) {
            const expiredByClock =
              !isInvalidOrExpiredToken(existingToken) && isStoredTokenExpired();
            clearStoredToken();
            localStorage.removeItem(GOOGLE_USER_KEY);
            if (expiredByClock || isExpiredSessionToken(existingToken)) {
              setShowSessionExpiredModal(true);
              setUser(null);
              setIsAuthenticated(false);
              setIsLoading(false);
            }
          }
        }
      } else if (!hasHashCallback) {
        setIsRecoveringSession(false);
      }

      // 3. Implicit OAuth hash callback (`#access_token=...`).
      void handleHashAuth();
    };

    void runBoot();
    window.addEventListener('hashchange', handleHashAuth);
    return () => window.removeEventListener('hashchange', handleHashAuth);
  }, [completeCloudSignIn, refreshGoogleTokenDetailed]);

  // CD Batch 8 (B4.12) + Auth Proxy: proactive background refresh when within 5 minutes
  // of expiry, with cooldown / short-token loop protection.
  useEffect(() => {
    if (!isAuthenticated || isMockMode) return;
    const expiresAt = parseStoredExpiresAt(localStorage.getItem(GOOGLE_TOKEN_EXPIRES_AT_KEY));
    const clientId = googleClientIdRef.current || resolveConfiguredClientId();
    const proxyUrl = authProxyUrlRef.current || resolveConfiguredAuthProxyUrl();
    const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const hasProxy =
      getMatchingSealedRefreshRecord({
        clientId,
        proxyUrl,
        expectedEmail: userRef.current?.email,
      }) !== null;
    if (!clientId || isOffline || (!hasProxy && isPlaywrightEnv() && !hasGisOAuth2Runtime())) return;

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
  }, [
    isAuthenticated,
    isMockMode,
    googleClientId,
    authProxyUrl,
    tokenRefreshTick,
    refreshGoogleTokenSilent,
  ]);

  // Mobile PWA resume & network recovery: Android freezes timers while the PWA is
  // backgrounded, so silently renew expired/expiring tokens via Auth Proxy on resume/online.
  useEffect(() => {
    if (!isAuthenticated || isMockMode) return;

    const maybeRenewViaProxy = () => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      const clientId = googleClientIdRef.current || resolveConfiguredClientId();
      const proxyUrl = authProxyUrlRef.current || resolveConfiguredAuthProxyUrl();
      const sealed = getMatchingSealedRefreshRecord({
        clientId,
        proxyUrl,
        expectedEmail: userRef.current?.email,
      });
      if (!sealed) return;

      const token = localStorage.getItem(GOOGLE_TOKEN_KEY);
      const expiresAt = parseStoredExpiresAt(localStorage.getItem(GOOGLE_TOKEN_EXPIRES_AT_KEY));
      const needsRefresh =
        !isUsableStoredToken(token) ||
        (expiresAt !== null && expiresAt <= Date.now() + GIS_SILENT_REFRESH_WINDOW_MS);
      if (needsRefresh) {
        void refreshGoogleTokenSilent({ force: true });
      }
    };

    const handleVisibility = () => {
      if (!document.hidden) maybeRenewViaProxy();
    };
    window.addEventListener('online', maybeRenewViaProxy);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('online', maybeRenewViaProxy);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [isAuthenticated, isMockMode, googleClientId, authProxyUrl, refreshGoogleTokenSilent]);

  // Browser-only Cloud Mode: lazily warm the GIS script after sign-in (never in Demo,
  // offline, or Playwright) so a future 1-tap Reconnect can fire synchronously in the click.
  useEffect(() => {
    if (!isAuthenticated || isMockMode) return;
    if (!googleClientId || authProxyUrl) return;
    if (isPlaywrightEnv()) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (hasGisOAuth2Runtime()) return;

    const timer = window.setTimeout(() => {
      if (
        isAuthenticatedRef.current &&
        !isMockModeRef.current &&
        !(typeof navigator !== 'undefined' && navigator.onLine === false)
      ) {
        void loadGisScript();
      }
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [isAuthenticated, isMockMode, googleClientId, authProxyUrl]);

  useEffect(() => {
    const handleOffline = () => {
      if (!localStorage.getItem(GOOGLE_TOKEN_KEY) && !readSealedRefreshRecord()) return;
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

  const login = useCallback(
    async (
      options: LoginOptions = {}
    ): Promise<{
      ok: boolean;
      reason?: 'missing_client_id' | 'offline' | 'error';
    }> => {
      const clientId = resolveConfiguredClientId();
      if (!clientId) {
        return { ok: false, reason: 'missing_client_id' };
      }
      const proxyUrl = resolveConfiguredAuthProxyUrl();
      const loginHint = options.switchAccount
        ? undefined
        : userRef.current?.email || getPreviousAccountEmail() || undefined;

      // Fast 1-tap in-place GIS reconnect (browser-only mode): runs SYNCHRONOUSLY inside
      // the tap handler (before any await) so Android Chrome allows the popup without a
      // Custom Tab redirect or account picker.
      if (
        options.reconnect &&
        !options.switchAccount &&
        !proxyUrl &&
        hasGisOAuth2Runtime() &&
        !(typeof navigator !== 'undefined' && navigator.onLine === false)
      ) {
        setIsLoading(true);
        const reconnectGen = sessionGenRef.current;
        const gisRes = await requestSilentGisToken({
          clientId,
          scope: GOOGLE_SCOPES,
          loginHint,
          expectedEmail: loginHint,
          timeoutMs: 15_000,
        });
        if (sessionGenRef.current !== reconnectGen) {
          setIsLoading(false);
          return { ok: false, reason: 'error' };
        }
        if (gisRes.ok) {
          sessionGenRef.current += 1;
          await completeCloudSignIn({
            accessToken: gisRes.accessToken,
            expiresAt: gisRes.expiresAt,
            preserveCurrentHash: true,
            originGen: sessionGenRef.current,
          });
          setIsLoading(false);
          return { ok: true };
        }
        // GIS couldn't renew silently (e.g. interaction_required / blocked) -> fall through to redirect.
      }

      const csrfState =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2);
      sessionStorage.setItem(OAUTH_CSRF_STATE_KEY, csrfState);
      // M4.4: remember the in-app route so the user lands back where they started.
      const currentHash = typeof window !== 'undefined' ? window.location.hash : '';
      const restorableRoute = isRestorableAppRoute(currentHash) ? currentHash : undefined;
      if (restorableRoute) {
        sessionStorage.setItem(OAUTH_RETURN_ROUTE_KEY, restorableRoute);
      } else {
        sessionStorage.removeItem(OAUTH_RETURN_ROUTE_KEY);
      }

      if (await checkIsTrulyOffline()) {
        sessionStorage.removeItem(OAUTH_CSRF_STATE_KEY);
        sessionStorage.removeItem(OAUTH_RETURN_ROUTE_KEY);
        clearPendingOAuthTx();
        showToast('You are currently offline', 'error');
        setIsLoading(false);
        return { ok: false, reason: 'offline' };
      }

      setIsLoading(true);
      try {
        const redirectUri = window.location.origin + window.location.pathname;
        const pkce = proxyUrl ? await generatePkcePair() : null;
        const usePkce = Boolean(proxyUrl && pkce);

        // Persist a short-lived pending tx in localStorage too so Android Chrome Custom Tab
        // handoffs or background tab evictions don't lose CSRF state or PKCE codeVerifier.
        savePendingOAuthTx({
          state: csrfState,
          mode: usePkce ? 'pkce' : 'implicit',
          ...(usePkce && pkce ? { codeVerifier: pkce.codeVerifier } : {}),
          ...(restorableRoute ? { returnRoute: restorableRoute } : {}),
          redirectUri,
          ...(usePkce && proxyUrl ? { proxyUrl } : {}),
          clientId,
          createdAt: Date.now(),
        });

        const authUrl = buildGoogleAuthUrl({
          mode: usePkce ? 'pkce' : 'implicit',
          clientId,
          redirectUri,
          scope: GOOGLE_SCOPES,
          state: csrfState,
          ...(usePkce && pkce ? { codeChallenge: pkce.codeChallenge } : {}),
          loginHint,
          reconnect: options.reconnect,
          switchAccount: options.switchAccount,
        });

        // B4.11: a runtime `window.VITE_GOOGLE_CLIENT_ID` (self-hosted config) is a real
        // client id, not a test signal — it must still redirect to Google.
        if (isPlaywrightEnv()) {
          (window as unknown as CustomWindow).__LAST_OAUTH_URL__ = authUrl;
          setIsLoading(false);
        } else {
          window.location.href = authUrl;
        }
        return { ok: true };
      } catch {
        clearPendingOAuthTx();
        setIsLoading(false);
        showToast('Failed to start Google sign-in', 'error');
        return { ok: false, reason: 'error' };
      }
    },
    [completeCloudSignIn]
  );

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
    clearSealedRefreshRecord();
    clearPendingOAuthTx();
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
    setTokenRefreshTick(t => t + 1);
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
    const sealed = readSealedRefreshRecord();
    if (sealed) {
      void revokeSealedRefreshViaProxy({
        proxyUrl: sealed.proxyUrl,
        sealedRefreshToken: sealed.token,
        clientId: sealed.clientId,
      });
    }
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
    clearSealedRefreshRecord();
    clearPendingOAuthTx();
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
    localStorage.removeItem(COLLISION_SKIP_KEY);
    localStorage.removeItem(LAST_DELETE_BACKUP_KEY);
    sessionStorage.removeItem(OAUTH_CSRF_STATE_KEY);
    sessionStorage.removeItem(OAUTH_RETURN_ROUTE_KEY);
    setUser(null);
    setIsAuthenticated(false);
    setIsMockMode(true);
    setShowSessionExpiredModal(false);
    setTokenRefreshTick(t => t + 1);
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
      authProxyUrl,
      authProxyUrlExists,
      hasPersistentSession,
      saveGoogleClientId,
      saveGoogleAuthProxyUrl,
      getGoogleToken,
      refreshGoogleTokenSilent,
      refreshGoogleTokenDetailed,
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
      authProxyUrl,
      authProxyUrlExists,
      hasPersistentSession,
      saveGoogleClientId,
      saveGoogleAuthProxyUrl,
      getGoogleToken,
      refreshGoogleTokenSilent,
      refreshGoogleTokenDetailed,
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
