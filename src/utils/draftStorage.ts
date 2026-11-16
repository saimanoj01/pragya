import type { DeltaStatus, NoteStatus } from '../types/pragya';
import { ensureLocalStorage } from '../services/storage';

ensureLocalStorage();

export const CAPTURE_DRAFT_KEY = 'pragya_draft_capture_v1';
export const DEEPEN_DRAFT_PREFIX = 'pragya_draft_deepen_';
export const EDIT_NOTE_DRAFT_PREFIX = 'pragya_draft_edit_';

export function getDeepenDraftKey(noteId: string): string {
  return `${DEEPEN_DRAFT_PREFIX}${noteId}`;
}

export function getEditNoteDraftKey(noteId: string): string {
  return `${EDIT_NOTE_DRAFT_PREFIX}${noteId}`;
}

export interface CaptureDraft {
  bookId: string;
  pos: string;
  quote: string;
  takeaway: string;
  tagsRaw: string;
  sparLater: boolean;
  isPrediction: boolean;
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
  savedAt: string;
}

export function readDraft<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
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
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore quota or restricted storage errors
  }
}

export function clearDraft(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore storage errors
  }
}

export function clearAllDrafts(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (
        k &&
        (k === CAPTURE_DRAFT_KEY ||
          k.startsWith(DEEPEN_DRAFT_PREFIX) ||
          k.startsWith(EDIT_NOTE_DRAFT_PREFIX))
      ) {
        keys.push(k);
      }
    }
    for (const k of keys) {
      localStorage.removeItem(k);
    }
  } catch {
    // Ignore storage errors
  }
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
