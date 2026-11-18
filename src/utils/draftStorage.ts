import type { DeltaStatus, NoteStatus } from '../types/pragya';
import { ensureLocalStorage } from '../services/storage';

ensureLocalStorage();

export const CAPTURE_DRAFT_KEY = 'pragya_draft_capture_v1';
export const DEEPEN_DRAFT_PREFIX = 'pragya_draft_deepen_';
export const EDIT_NOTE_DRAFT_PREFIX = 'pragya_draft_edit_';
/** ux_spec A.6 `capstone:{bookId}`, namespaced like the other drafts so account switches wipe it. */
export const CAPSTONE_DRAFT_PREFIX = 'pragya_draft_capstone:';

export function getDeepenDraftKey(noteId: string): string {
  return `${DEEPEN_DRAFT_PREFIX}${noteId}`;
}

export function getEditNoteDraftKey(noteId: string): string {
  return `${EDIT_NOTE_DRAFT_PREFIX}${noteId}`;
}

export function getCapstoneDraftKey(bookId: string): string {
  return `${CAPSTONE_DRAFT_PREFIX}${bookId}`;
}

export interface CapstoneDraft {
  baseUpdatedAt: string;
  arcOrThesis: string;
  learningsText: string;
  perspectiveShift: string;
  savedAt: string;
}

export interface CaptureDraft {
  bookId: string;
  pos: string;
  quote: string;
  takeaway: string;
  tagsRaw: string;
  sparLater: boolean;
  isPrediction: boolean;
  /** A3.3 (optional for older drafts). */
  chapter?: string;
  chapterTouched?: boolean;
  updatedAt: string;
}

export interface DeepenDraft {
  baseUpdatedAt: string;
  title: string;
  slug: string;
  takeaway: string;
  contextMechanism: string;
  deltaTrigger: string;
  deltaAction: string;
  deltaStatus: DeltaStatus;
  critique: string;
  /** A3.3 (optional for older drafts). */
  chapter?: string;
  savedAt: string;
}

export interface EditNoteDraft {
  baseUpdatedAt: string;
  title: string;
  slug: string;
  pos: string;
  status: NoteStatus;
  quote: string;
  takeaway: string;
  tagsRaw: string;
  isPrediction: boolean;
  contextMechanism: string;
  critique: string;
  deltaTrigger: string;
  deltaAction: string;
  deltaStatus: DeltaStatus;
  /** A3.3 (optional for older drafts). */
  chapter?: string;
  savedAt: string;
}

/**
 * CD 1a fix-up (R1#1 / QA-28): drafts are scoped per account so one account's drafts can
 * never surface in another (or in Demo), and nothing has to be wiped to guarantee it.
 *
 * Stored key: `pragya_draft:<scope>:<logical key>`, where scope is `demo` or a short hash
 * of the signed-in email (the raw email never appears in keys). Callers keep using the
 * logical keys above (CAPTURE_DRAFT_KEY, getEditNoteDraftKey(), …).
 *
 * The scope is derived from persisted auth state, so it is always in sync with the
 * session: Demo → `demo`; a Google profile → `u<hash>`; nobody signed in (or Node unit
 * tests without auth state) → no scope, which reads/writes the legacy unscoped keys.
 */
export const SCOPED_DRAFT_PREFIX = 'pragya_draft:';
export const DEMO_DRAFT_SCOPE = 'demo';
const MOCK_MODE_STORAGE_KEY = 'pragya_mock_mode';
const MOCK_SESSION_STORAGE_KEY = 'pragya_mock_session';
const GOOGLE_USER_STORAGE_KEY = 'pragya_google_user';

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Draft scope for a signed-in Google account (`u` + fnv1a of the lower-cased email). */
export function accountDraftScope(email: string): string {
  return `u${fnv1a((email || '').trim().toLowerCase())}`;
}

/** The scope of the current session, or null when nobody is signed in. */
export function currentDraftScope(): string | null {
  try {
    if (
      localStorage.getItem(MOCK_MODE_STORAGE_KEY) === 'true' &&
      localStorage.getItem(MOCK_SESSION_STORAGE_KEY)
    ) {
      return DEMO_DRAFT_SCOPE;
    }
    const raw = localStorage.getItem(GOOGLE_USER_STORAGE_KEY);
    if (raw) {
      const email = (JSON.parse(raw) as { email?: unknown })?.email;
      if (typeof email === 'string' && email.trim()) return accountDraftScope(email);
    }
  } catch {
    // Unreadable auth state → unscoped.
  }
  return null;
}

function isLogicalDraftKey(k: string): boolean {
  return (
    k === CAPTURE_DRAFT_KEY ||
    k.startsWith(DEEPEN_DRAFT_PREFIX) ||
    k.startsWith(EDIT_NOTE_DRAFT_PREFIX) ||
    k.startsWith(CAPSTONE_DRAFT_PREFIX)
  );
}

/** Physical storage key for a logical draft key in a scope (null scope = legacy key). */
export function scopedDraftKey(key: string, scope: string | null = currentDraftScope()): string {
  return scope ? `${SCOPED_DRAFT_PREFIX}${scope}:${key}` : key;
}

export function readDraft<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(scopedDraftKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

export function writeDraft<T>(key: string, value: T): void {
  try {
    localStorage.setItem(scopedDraftKey(key), JSON.stringify(value));
  } catch {
    // Ignore quota or restricted storage errors
  }
}

export function clearDraft(key: string): void {
  try {
    localStorage.removeItem(scopedDraftKey(key));
  } catch {
    // Ignore storage errors
  }
}

function allStorageKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
  } catch {
    // Ignore storage errors
  }
  return keys;
}

/** Logical draft keys stored in `scope` (null = legacy unscoped keys). */
function listDraftKeys(scope: string | null = currentDraftScope()): string[] {
  const out: string[] = [];
  const prefix = scope ? `${SCOPED_DRAFT_PREFIX}${scope}:` : null;
  for (const k of allStorageKeys()) {
    if (prefix) {
      if (k.startsWith(prefix) && isLogicalDraftKey(k.slice(prefix.length))) out.push(k.slice(prefix.length));
    } else if (isLogicalDraftKey(k)) {
      out.push(k);
    }
  }
  return out;
}

/** CD C.1.3: any unsaved draft in the current scope (capture / edit / deepen / capstone). */
export function hasAnyDraft(): boolean {
  return listDraftKeys().length > 0;
}

/**
 * Human list of draft kinds (current scope) for the logout confirmation, e.g.
 * `a capture, a note edit, a Whole-Book Picture` (unique kinds, stable order).
 */
export function describeDrafts(): string {
  const keys = listDraftKeys();
  const kinds: string[] = [];
  const add = (label: string) => {
    if (!kinds.includes(label)) kinds.push(label);
  };
  if (keys.includes(CAPTURE_DRAFT_KEY)) add('a capture');
  if (keys.some(k => k.startsWith(EDIT_NOTE_DRAFT_PREFIX))) add('a note edit');
  if (keys.some(k => k.startsWith(DEEPEN_DRAFT_PREFIX))) add('a Deepen draft');
  if (keys.some(k => k.startsWith(CAPSTONE_DRAFT_PREFIX))) add('a Whole-Book Picture');
  return kinds.join(', ');
}

/**
 * Clear drafts.
 * - `{ scope: 'all' }` (default): every scope plus legacy keys. Used by the account-switch
 *   privacy wipe and the explicit "Discard drafts and log out".
 * - `{ scope: 'demo' }` / any scope string: only that scope (Demo logout, Reset Demo).
 * - `{ scope: 'current' }`: the current session's scope.
 */
export function clearAllDrafts(options: { scope?: 'all' | 'current' | string } = {}): void {
  const target = options.scope ?? 'all';
  try {
    if (target === 'all') {
      for (const k of allStorageKeys()) {
        if (isLogicalDraftKey(k) || k.startsWith(SCOPED_DRAFT_PREFIX)) localStorage.removeItem(k);
      }
      return;
    }
    const scope = target === 'current' ? currentDraftScope() : target;
    for (const k of listDraftKeys(scope)) localStorage.removeItem(scopedDraftKey(k, scope));
  } catch {
    // Ignore storage errors
  }
}

/**
 * Migration: legacy unscoped draft keys (written before scoping) belong to the account
 * that was signed in at the time — adopt them into `accountDraftScope(email)`. Called
 * only for a real account whose email matches the last-account marker; never for Demo.
 * An existing scoped draft wins over a legacy one. Returns the number of adopted keys.
 */
/**
 * QA-29: legacy unscoped drafts that can't be attributed to an account (no last-account
 * marker existed when an account signed in — e.g. drafts a pre-scoping build wrote in
 * Demo) are dropped rather than adopted. Returns the number of removed keys.
 */
export function dropLegacyDrafts(): number {
  const keys = listDraftKeys(null);
  for (const k of keys) {
    try {
      localStorage.removeItem(k);
    } catch {
      // Ignore storage errors
    }
  }
  return keys.length;
}

export function adoptLegacyDrafts(email: string): number {
  const scope = accountDraftScope(email);
  let adopted = 0;
  for (const k of listDraftKeys(null)) {
    try {
      const raw = localStorage.getItem(k);
      const target = scopedDraftKey(k, scope);
      if (raw !== null && localStorage.getItem(target) === null) {
        localStorage.setItem(target, raw);
        adopted += 1;
      }
      localStorage.removeItem(k);
    } catch {
      // Ignore storage errors
    }
  }
  return adopted;
}

export function isNoteDraftStale(
  draftBaseUpdatedAt: string | undefined,
  noteUpdatedAt: string | undefined
): boolean {
  if (!draftBaseUpdatedAt || !noteUpdatedAt) return false;
  const draftMs = Date.parse(draftBaseUpdatedAt);
  const noteMs = Date.parse(noteUpdatedAt);
  if (Number.isFinite(draftMs) && Number.isFinite(noteMs)) {
    return noteMs > draftMs;
  }
  return noteUpdatedAt > draftBaseUpdatedAt;
}
