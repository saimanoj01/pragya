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

const BOOK_META_STRING_KEYS = ['coverUrl', 'startedAt', 'finishedAt', 'currentChapter', 'archivedAt'] as const;
const NOTE_META_STRING_KEYS = ['title', 'exportedAt', 'lastReviewedAt', 'chapter', 'archivedAt'] as const;
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

export function mergePreservedAttachments(edited: Attachment[], preserved: unknown[]): unknown[] {
  return [...edited, ...preserved];
}

/**
 * R-4: recombine an editor's renderable list with the *original* stored list captured
 * when the editor opened, keeping every stored entry in its original position:
 * - an originally-renderable entry is replaced by its edited version (matched by id),
 *   or dropped if the user removed it;
 * - preserved entries (unknown/invalid/beyond the cap) stay exactly where they were;
 * - newly added attachments are appended at the end.
 */
export function mergeEditedAttachments(originalRaw: unknown, edited: Attachment[]): unknown[] {
  const original = Array.isArray(originalRaw) ? originalRaw : [];
  // QA-13: match by occurrence (a queue per id), so duplicate ids are never dropped.
  const editedQueues = new Map<string, Attachment[]>();
  for (const att of edited) {
    const queue = editedQueues.get(att.id);
    if (queue) queue.push(att);
    else editedQueues.set(att.id, [att]);
  }
  const out: unknown[] = [];
  let renderableCount = 0;
  for (const item of original) {
    const valid = renderableCount < MAX_ATTACHMENTS ? toValidAttachment(item) : null;
    if (!valid) {
      out.push(item);
      continue;
    }
    renderableCount += 1;
    const replacement = editedQueues.get(valid.id)?.shift();
    if (replacement) out.push(replacement);
  }
  for (const queue of editedQueues.values()) {
    out.push(...queue);
  }
  return out;
}

/**
 * Book meta keys the default book editors (EditBookModal, bookmark undo, restore)
 * legitimately set or delete. Keys added here are only for UIs that edit them today;
 * Batch 7 passes per-call-site lists (e.g. `currentChapter` for the chapter editor).
 */
export const BOOK_EDITOR_OWNED_META_KEYS: readonly string[] = [
  'coverUrl',
  'startedAt',
  'finishedAt',
  'updatedAt',
];

/** Note meta keys the default note editors (EditNote, Deepen, Practice) set or delete. */
export const NOTE_EDITOR_OWNED_META_KEYS: readonly string[] = [
  'title',
  'attachments',
  'links',
  'isPrediction',
  'socraticQuestions',
  'lastReviewedAt',
];

/** Batch 7 per-call-site owned keys (EditBook / EditNote / Deepen edit chapters). */
export const BOOK_CHAPTER_EDITOR_OWNED_META_KEYS: readonly string[] = [
  ...BOOK_EDITOR_OWNED_META_KEYS,
  'currentChapter',
];
export const NOTE_CHAPTER_EDITOR_OWNED_META_KEYS: readonly string[] = [
  ...NOTE_EDITOR_OWNED_META_KEYS,
  'chapter',
];
/** BookDetailView inline "Now in … · Change": only the chapter (+ updatedAt). */
export const BOOK_DETAIL_CHAPTER_OWNED_META_KEYS: readonly string[] = ['currentChapter', 'updatedAt'];
/** CapstoneModal: only the capstone (+ updatedAt). */
export const CAPSTONE_OWNED_META_KEYS: readonly string[] = ['capstone', 'updatedAt'];
/** C1.1 archive / restore of a book: only archivedAt (+ updatedAt). */
export const BOOK_ARCHIVE_OWNED_META_KEYS: readonly string[] = ['archivedAt', 'updatedAt'];
/** C1.1 archive / restore of a note: archivedAt + the paused-delta memo (+ updatedAt). */
export const NOTE_ARCHIVE_OWNED_META_KEYS: readonly string[] = [
  'archivedAt',
  'archivedDeltaStatus',
  'updatedAt',
];

/** Key-order-insensitive JSON for deep-equality checks. */
function stableJson(value: unknown): string {
  const ancestors = new Set<object>();
  const sortKeys = (v: unknown): unknown => {
    if (!v || typeof v !== 'object') return v;
    if (ancestors.has(v as object)) return '[Circular]';
    ancestors.add(v as object);
    let out: unknown;
    if (Array.isArray(v)) {
      out = v.map(sortKeys);
    } else {
      const obj: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        obj[k] = sortKeys((v as Record<string, unknown>)[k]);
      }
      out = obj;
    }
    ancestors.delete(v as object);
    return out;
  };
  try {
    return JSON.stringify(sortKeys(value)) ?? 'undefined';
  } catch {
    return String(value);
  }
}

export function metaValuesEqual(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

/**
 * R2 N1: non-owned keys the EDITOR changed (edited ≠ the base snapshot it started from)
 * whose value will be discarded because it also differs from the latest loaded value
 * (the merge below lets the latest value win). A key another device changed while the
 * editor left it alone is not flagged; comparisons are deep and key-order insensitive.
 * PragyaContext warns about the result in dev mode.
 */
export function findOverriddenMetaKeys(
  edited: object,
  base: object | null | undefined,
  latest: object | null | undefined,
  editorOwnedKeys: readonly string[]
): string[] {
  if (!isPlainObject(edited) || !isPlainObject(base)) return [];
  const latestObj: Record<string, unknown> = isPlainObject(latest) ? latest : base;
  const editedObj = edited as Record<string, unknown>;
  const keys = new Set([...Object.keys(editedObj), ...Object.keys(base)]);
  const out: string[] = [];
  for (const key of keys) {
    if (editorOwnedKeys.includes(key)) continue;
    if (metaValuesEqual(editedObj[key], base[key])) continue; // editor left it alone
    if (!(key in latestObj)) continue; // merge keeps the edited value when latest lacks it
    if (!metaValuesEqual(editedObj[key], latestObj[key])) out.push(key);
  }
  return out;
}

/**
 * R2#1 / R1#3: a modal opened before a reconnect/sync holds a stale meta snapshot.
 * Editors never change keys they don't own, so for every non-editor key the LATEST
 * loaded value wins (fills keys the snapshot lacks and overrides stale values, e.g. a
 * `capstone` or `chapter` the CLI rewrote). Editor-owned keys keep the edited value,
 * so a deliberate deletion is never resurrected. Keys absent from `latest` are left
 * as edited. (If an undo flow ever needs to restore an older non-editor value, it must
 * pass that key in `editorOwnedKeys`.)
 */
export function mergeUnknownMetaKeys<T extends object>(
  edited: T,
  latest: object | null | undefined,
  editorOwnedKeys: readonly string[]
): T {
  if (!isPlainObject(latest)) return edited;
  const out: Record<string, unknown> = { ...(edited as Record<string, unknown>) };
  for (const [key, value] of Object.entries(latest)) {
    if (editorOwnedKeys.includes(key)) continue;
    out[key] = value;
  }
  return out as T;
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
