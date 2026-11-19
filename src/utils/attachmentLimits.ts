import type { Attachment } from '../types/pragya';
import { MAX_ATTACHMENTS, mergeEditedAttachments, splitAttachments } from './metaCodecs';

export const MAX_RENDERABLE_ATTACHMENTS = MAX_ATTACHMENTS;
export const DOC_URL_REGEX = /https?:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/i;
export const HTTP_URL_REGEX = /^https?:\/\/\S+$/i;

export function isAtAttachmentLimit(attachments: readonly Attachment[]): boolean {
  return attachments.length >= MAX_RENDERABLE_ATTACHMENTS;
}

export type ParsedUrlAttachment =
  | {
      ok: true;
      kind: 'doc';
      docId: string;
      url: string;
      title: string;
      needsTitleResolve: boolean;
    }
  | {
      ok: true;
      kind: 'link';
      url: string;
      title: string;
      needsTitleResolve: false;
    }
  | {
      ok: false;
      error: string;
    };

/**
 * Validates and classifies an http(s) attachment URL as a Google Doc or generic link.
 * Pure string helper shared by QuickCaptureModal and EditNoteModal via `<AttachmentManager>`.
 */
export function parseUrlAttachmentInput(rawUrl: string, explicitTitle?: string): ParsedUrlAttachment {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed || !HTTP_URL_REGEX.test(trimmed)) {
    return { ok: false, error: 'Enter a valid http(s) URL' };
  }
  const cleanTitle = explicitTitle?.trim() || '';
  const docMatch = trimmed.match(DOC_URL_REGEX);
  if (docMatch) {
    return {
      ok: true,
      kind: 'doc',
      docId: docMatch[1],
      url: trimmed,
      title: cleanTitle || 'Google Doc',
      needsTitleResolve: !cleanTitle,
    };
  }
  let fallbackTitle = cleanTitle;
  if (!fallbackTitle) {
    try {
      fallbackTitle = new URL(trimmed).hostname;
    } catch {
      fallbackTitle = trimmed;
    }
  }
  return {
    ok: true,
    kind: 'link',
    url: trimmed,
    title: fallbackTitle,
    needsTitleResolve: false,
  };
}

/** Appends `next` only when `prev` is still below the 3-attachment renderable cap. */
export function appendAttachmentUnderCap(
  prev: readonly Attachment[],
  next: Attachment
): { attachments: Attachment[]; added: boolean } {
  if (prev.length >= MAX_RENDERABLE_ATTACHMENTS) {
    return { attachments: [...prev], added: false };
  }
  return { attachments: [...prev, next], added: true };
}

const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox',
  'radio',
  'file',
  'number',
  'button',
  'submit',
  'reset',
  'range',
  'color',
]);

/**
 * True when focus sits on a prose/URL field where pasting an `https://…` string should insert
 * text normally rather than being intercepted as an attachment chip. `<select>`, checkboxes,
 * file inputs, numeric position inputs, and buttons return false so modal-level URL paste works.
 */
export function isTextPasteTarget(
  tagName: string | undefined,
  inputType?: string | null,
  isContentEditable?: boolean
): boolean {
  if (isContentEditable) return true;
  const tag = (tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const normalizedType = (inputType || 'text').toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(normalizedType);
  }
  return false;
}

/**
 * R-4 / Batch 1 override: captures a shallow copy of the raw stored attachments array on
 * modal open alongside its up-to-3 renderable slice. Combine on save via `saveEditedAttachments`
 * so unknown/invalid entries and any entries beyond the 3-cap survive round-trip verbatim.
 */
export function openEditableAttachments(raw: unknown): {
  originalRaw: unknown[];
  renderable: Attachment[];
} {
  const originalRaw = Array.isArray(raw) ? [...raw] : [];
  return {
    originalRaw,
    renderable: splitAttachments(originalRaw).renderable,
  };
}

export function saveEditedAttachments(originalRaw: unknown, edited: readonly Attachment[]): unknown[] {
  return mergeEditedAttachments(originalRaw, edited.slice(0, MAX_RENDERABLE_ATTACHMENTS));
}

/**
 * QA-43: unmodified `Enter` inside the inline Attachment URL / Title inputs confirms the
 * attachment subform instead of implicitly submitting the parent note modal `<form>`.
 * `⌘/Ctrl+Enter` and IME composition events are left untouched.
 */
export function isAttachmentSubformEnter(event: {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}): boolean {
  if (event.key !== 'Enter') return false;
  if (event.isComposing || event.keyCode === 229) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  return true;
}
