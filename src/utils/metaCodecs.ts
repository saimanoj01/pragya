import type {
  Attachment,
  BookCapstone,
  BookFormat,
  BookMetaJson,
  NoteMetaJson,
  NoteSource,
} from '../types/pragya';

/**
 * Defensive metaJson / enum codecs shared by the Sheets codecs and the snapshot
 * validator. Parity with `normalize_*` in scripts/pragya_cli.py.
 *
 * Contract: every unknown key is spread-preserved; known keys are re-validated and
 * dropped only when empty or invalid; legacy aliases are canonicalized
 * (`chapterNote` → `currentChapter`, `q1`/`q2`/`q3` → `socraticQuestions`).
 * Normalizers never throw and are idempotent.
 *
 * Agent-owned structures are stored verbatim and only filtered at render/creation
 * time (decisions.md, Batch 1 fix-up):
 * - `attachments`: every entry (including unknown types and entries beyond 3) is
 *   preserved on read → write; use {@link getRenderableAttachments} to render.
 * - `capstone`: preserved verbatim; use {@link getBookCapstone} for a typed view.
 * - `sparStage`: preserved verbatim (not coerced).
 */

const BOOK_META_STRING_KEYS = ['coverUrl', 'startedAt', 'finishedAt', 'currentChapter'] as const;
const NOTE_META_STRING_KEYS = ['title', 'exportedAt', 'lastReviewedAt', 'chapter'] as const;
const NOTE_META_BOOLEAN_KEYS = ['isPrediction', 'ocrBackfilled'] as const;
const LEGACY_QUESTION_KEYS = ['q1', 'q2', 'q3'] as const;
const MAX_SOCRATIC_QUESTIONS = 3;
export const MAX_ATTACHMENTS = 3;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Strings are kept verbatim when non-blank; finite numbers are stringified; everything else is invalid. */
function coerceMetaString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Empty strings are treated as "absent" (dropped), matching the string-key rule. */
function coerceMetaBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value !== 0 : undefined;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'true' || lowered === '1' || lowered === 'yes') return true;
    if (lowered === 'false' || lowered === '0' || lowered === 'no') return false;
    return undefined;
  }
  return undefined;
}

function applyString(out: Record<string, unknown>, key: string): void {
  if (!(key in out)) return;
  const coerced = coerceMetaString(out[key]);
  if (coerced === undefined) delete out[key];
  else out[key] = coerced;
}

function toQuestionList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed);
    if (out.length >= MAX_SOCRATIC_QUESTIONS) break;
  }
  return out;
}

/** Parses a metaJson cell (string) or accepts an already-decoded object. Never throws. */
export function parseMetaInput(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return isPlainObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isPlainObject(raw) ? raw : {};
}

export function normalizeBookMeta(raw: unknown): BookMetaJson {
  const src = parseMetaInput(raw);
  const out: Record<string, unknown> = { ...src };

  // Legacy alias: chapterNote → currentChapter (an existing currentChapter wins).
  if ('chapterNote' in out) {
    if (coerceMetaString(out.currentChapter) === undefined) {
      const legacy = coerceMetaString(out.chapterNote);
      if (legacy !== undefined) out.currentChapter = legacy;
    }
    delete out.chapterNote;
  }

  for (const key of BOOK_META_STRING_KEYS) applyString(out, key);

  // `capstone` passes through verbatim (see getBookCapstone for the typed view).

  out.updatedAt = coerceMetaString(src.updatedAt) ?? '';
  return out as BookMetaJson;
}

/**
 * Typed, render-safe view of `meta.capstone`. The stored object is never rewritten.
 * Returns undefined for a non-object capstone. `keyLearnings`: a string becomes
 * `[string]`; numbers are stringified; other non-string items are skipped.
 */
export function getBookCapstone(meta: unknown): BookCapstone | undefined {
  const value = isPlainObject(meta) ? meta.capstone : undefined;
  if (!isPlainObject(value)) return undefined;
  const learningsRaw = value.keyLearnings;
  const learningsList = Array.isArray(learningsRaw)
    ? learningsRaw
    : learningsRaw === undefined || learningsRaw === null
      ? []
      : [learningsRaw];
  const keyLearnings: string[] = [];
  for (const item of learningsList) {
    const text =
      typeof item === 'string'
        ? item.trim()
        : typeof item === 'number' && Number.isFinite(item)
          ? String(item)
          : '';
    if (text) keyLearnings.push(text);
  }
  return {
    arcOrThesis: coerceMetaString(value.arcOrThesis) ?? '',
    keyLearnings,
    perspectiveShift: coerceMetaString(value.perspectiveShift) ?? '',
    completedAt: coerceMetaString(value.completedAt) ?? '',
  };
}

function toValidAttachment(item: unknown): Attachment | null {
  if (!isPlainObject(item) || typeof item.id !== 'string' || !item.id.trim()) return null;
  if (item.type === 'image') {
    return {
      ...item,
      type: 'image',
      id: item.id,
      fileName:
        typeof item.fileName === 'string' && item.fileName.trim() ? item.fileName : 'image.webp',
      mimeType:
        typeof item.mimeType === 'string' && item.mimeType.trim() ? item.mimeType : 'image/webp',
    } as Attachment;
  }
  if (item.type === 'doc' || item.type === 'link') {
    if (typeof item.url !== 'string' || !item.url.trim()) return null;
    return {
      ...item,
      type: item.type,
      id: item.id,
      url: item.url,
      title: typeof item.title === 'string' ? item.title : '',
    } as Attachment;
  }
  return null;
}

/**
 * Render/creation-time validation: at most 3 objects with a string `id` and
 * `type ∈ {image, doc, link}` (doc/link need a `url`; images get file defaults).
 * Never used on the storage round-trip.
 */
export function normalizeAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  const out: Attachment[] = [];
  for (const item of raw) {
    if (out.length >= MAX_ATTACHMENTS) break;
    const valid = toValidAttachment(item);
    if (valid) out.push(valid);
  }
  return out;
}

/** Render-safe attachments for a note meta (see {@link normalizeAttachments}). */
export function getRenderableAttachments(meta: unknown): Attachment[] {
  return normalizeAttachments(isPlainObject(meta) ? meta.attachments : undefined);
}

/**
 * Splits stored attachments into the editable/renderable list and the entries an
 * editor must carry through untouched (unknown/invalid items and valid items
 * beyond the cap). Recombine with {@link mergePreservedAttachments}.
 */
export function splitAttachments(raw: unknown): {
  renderable: Attachment[];
  preserved: unknown[];
} {
  const renderable: Attachment[] = [];
  const preserved: unknown[] = [];
  if (!Array.isArray(raw)) return { renderable, preserved };
  for (const item of raw) {
    const valid = renderable.length < MAX_ATTACHMENTS ? toValidAttachment(item) : null;
    if (valid) renderable.push(valid);
    else preserved.push(item);
  }
  return { renderable, preserved };
}

export function mergePreservedAttachments(edited: Attachment[], preserved: unknown[]): Attachment[] {
  return [...edited, ...(preserved as Attachment[])];
}

function normalizeLinks(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const coerced = coerceMetaString(item);
    if (coerced !== undefined) out.push(coerced);
  }
  return out;
}

export function normalizeNoteMeta(raw: unknown): NoteMetaJson {
  const src = parseMetaInput(raw);
  const out: Record<string, unknown> = { ...src };

  for (const key of NOTE_META_STRING_KEYS) applyString(out, key);

  for (const key of NOTE_META_BOOLEAN_KEYS) {
    if (!(key in out)) continue;
    const coerced = coerceMetaBoolean(out[key]);
    if (coerced === undefined) delete out[key];
    else out[key] = coerced;
  }

  // socraticQuestions: keep 1–3 trimmed non-empty strings. Legacy q1/q2(/q3) fill in
  // only when no valid canonical list exists; the legacy keys are always removed.
  let questions = toQuestionList(out.socraticQuestions);
  if (questions.length === 0) {
    questions = toQuestionList(LEGACY_QUESTION_KEYS.map(key => out[key]));
  }
  for (const key of LEGACY_QUESTION_KEYS) delete out[key];
  if (questions.length > 0) out.socraticQuestions = questions;
  else delete out.socraticQuestions;

  // Stored verbatim (every entry, any count); filtered only at render/creation time.
  out.attachments = Array.isArray(out.attachments) ? [...out.attachments] : [];
  out.links = normalizeLinks(out.links);

  return out as NoteMetaJson;
}

/** Books!D drift: `print`/`hardcover`/`paperback` → `physical`; `ebook` → `kindle`. */
export function normalizeBookFormat(raw: unknown): BookFormat {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'kindle' || value === 'ebook') return 'kindle';
  return 'physical';
}

/** Notes!I drift: companion/assistant/cli/skill → `agent`; everything else → `app`. */
export function normalizeNoteSource(raw: unknown): NoteSource {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (
    value === 'agent' ||
    value === 'companion' ||
    value === 'assistant' ||
    value === 'cli' ||
    value === 'skill'
  ) {
    return 'agent';
  }
  return 'app';
}
