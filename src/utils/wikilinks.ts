import type { Note } from '../types/pragya';

/**
 * QA-36: Unicode-aware slug — NFKD, combining marks dropped, lower-case, apostrophes
 * dropped, every run of non letter/number characters → `-`. `Über` → `uber`, `日本` →
 * `日本`. Returns null when no letter or number is left (`🔥`, `!!!`). Python mirror:
 * `slugify_or_none`. Stored slugs are never rewritten by this change.
 */
export function slugifyOrNull(input: string): string | null {
  const cleaned = (input || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || null;
}

export function slugify(input: string): string {
  return slugifyOrNull(input) || 'note';
}

/**
 * R2-a: the pre-QA-36 ASCII-only slug rule (`Café culture` → `caf-culture`). Never used to
 * mint slugs — only as a resolution fallback so notes slugged under the old rule keep
 * resolving from links typed with accents. Python mirror: `legacy_slugify`.
 */
export function legacySlugify(input: string): string | null {
  const cleaned = (input || '')
    .toLowerCase()
    .trim()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || null;
}

/**
 * Resolution keys for one link text, in priority order: exact text, new slug, legacy slug
 * (de-duplicated, nulls dropped).
 */
export function wikilinkKeys(text: string): string[] {
  const out: string[] = [];
  for (const k of [(text || '').trim(), slugifyOrNull(text), legacySlugify(text)]) {
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

/**
 * QA-37: the ONE `[[link]]` shape (chips, backlinks, Concepts, Python WIKILINK_RE): no `[`,
 * `]` or newline inside the brackets.
 */
export const WIKILINK_SOURCE = '\\[\\[([^[\\]\\n]+)\\]\\]';

export function generateUniqueSlug(
  titleOrText: string,
  existingSlugs: Iterable<string>,
  excludeSelfSlug?: string
): string {
  const base = slugify(titleOrText);
  const taken = new Set<string>();
  for (const s of existingSlugs) {
    if (s && s !== excludeSelfSlug) {
      taken.add(s);
    }
  }
  if (!taken.has(base)) {
    return base;
  }
  let counter = 2;
  while (taken.has(`${base}-${counter}`)) {
    counter += 1;
  }
  return `${base}-${counter}`;
}

export function extractWikilinks(text: string): string[] {
  if (!text) return [];
  const regex = new RegExp(WIKILINK_SOURCE, 'g');
  const seen = new Set<string>();
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    const normalized = slugifyOrNull(raw);
    if (!normalized) continue; // QA-36: symbol-only text is not a link
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

export function extractNoteWikilinks(note: Note): string[] {
  const combined = [
    note.takeaway || '',
    note.contextMechanism || '',
    note.critique || '',
    note.quote || '',
  ].join('\n');
  const out = extractWikilinks(combined);
  const seen = new Set(out);
  for (const rel of noteRelatedSlugs(note)) {
    if (!seen.has(rel)) {
      seen.add(rel);
      out.push(rel);
    }
  }
  return out;
}

/**
 * R2-a: every inline `[[link]]` in note prose (`takeaway`, `contextMechanism`, `critique`,
 * `quote`) as `{ slug, text }` (slug = new rule, text = inner text as typed), de-duplicated
 * by slug. Does not include `meta.relatedSlugs` (rendered separately with `bridgeNotes`).
 */
export function extractNoteWikilinkTexts(note: Note): { slug: string; text: string }[] {
  const combined = [
    note.takeaway || '',
    note.contextMechanism || '',
    note.critique || '',
    note.quote || '',
  ].join('\n');
  const regex = new RegExp(WIKILINK_SOURCE, 'g');
  const out: { slug: string; text: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(combined)) !== null) {
    const text = match[1]?.trim();
    if (!text) continue;
    const slug = slugifyOrNull(text);
    if (!slug || out.some(l => l.slug === slug)) continue;
    out.push({ slug, text });
  }
  return out;
}

/** R2-a + v2: all resolution keys (exact, new slug, legacy slug) of every inline link and `meta.relatedSlugs`. */
export function extractNoteWikilinkKeys(note: Note): Set<string> {
  const keys = new Set<string>();
  for (const { text } of extractNoteWikilinkTexts(note)) {
    for (const k of wikilinkKeys(text)) keys.add(k);
  }
  const rawRelated = (note.meta as { relatedSlugs?: unknown } | undefined)?.relatedSlugs;
  if (Array.isArray(rawRelated)) {
    let count = 0;
    for (const item of rawRelated) {
      if (typeof item !== 'string' || !item.trim()) continue;
      if (!slugifyOrNull(item)) continue;
      for (const k of wikilinkKeys(item)) keys.add(k);
      count += 1;
      if (count >= NOTE_RELATED_SLUGS_CAP) break;
    }
  }
  return keys;
}

export function computeBacklinks(targetSlug: string, allNotes: Note[]): Note[] {
  const normalizedTarget = slugify(targetSlug);
  return allNotes.filter(
    n => n.slug !== normalizedTarget && extractNoteWikilinks(n).includes(normalizedTarget)
  );
}

// ---- CD Batch 3 (C3.1–C3.3): inline chips, slug aliases, capture-from-missing ------------

export const NOTE_ALIAS_CAP = 10;
export const NOTE_RELATED_SLUGS_CAP = 20;

/** v2: `meta.relatedSlugs` (approved cross-note bridges), slugified + deduped, <= 20. */
export function noteRelatedSlugs(note: Pick<Note, 'meta'>): string[] {
  const raw = (note.meta as { relatedSlugs?: unknown } | undefined)?.relatedSlugs;
  const out: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'string' || !item.trim()) continue;
      const s = slugifyOrNull(item);
      if (s && !out.includes(s)) {
        out.push(s);
        if (out.length >= NOTE_RELATED_SLUGS_CAP) break;
      }
    }
  }
  return out;
}

/** `meta.aliases` (old slugs), slugified + de-duplicated. Python mirror: `note_aliases`. */
export function noteAliases(note: Pick<Note, 'meta'>): string[] {
  const raw = (note.meta as { aliases?: unknown } | undefined)?.aliases;
  const out: string[] = [];
  if (Array.isArray(raw)) {
    for (const a of raw) {
      if (typeof a !== 'string' || !a.trim()) continue;
      const s = slugifyOrNull(a);
      if (s && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

/** Append the old slug (de-duplicated, never the current slug, newest last, ≤ 10). */
export function addSlugAlias(aliases: unknown, oldSlug: string, newSlug: string): string[] {
  const base = noteAliases({ meta: { aliases } as Note['meta'] });
  const oldS = oldSlug ? slugify(oldSlug) : '';
  const newS = newSlug ? slugify(newSlug) : '';
  const out = base.filter(a => a !== oldS && a !== newS);
  if (oldS && oldS !== newS) out.push(oldS);
  return out.slice(-NOTE_ALIAS_CAP);
}

/** Slugs AND aliases of every other note — a new/renamed slug may not shadow either. */
export function takenSlugs(notes: Note[], excludeNoteId?: string): string[] {
  const out: string[] = [];
  for (const n of notes) {
    if (excludeNoteId && n.id === excludeNoteId) continue;
    out.push(n.slug);
    out.push(...noteAliases(n));
  }
  return out;
}

/**
 * The note a `[[text]]` points at (pass the inner text as typed, or a slug). Order (R2-a):
 * exact slug → new slugify → legacy ASCII slugify → aliases (new or legacy key).
 */
export function resolveWikilinkTarget(notes: Note[], text: string): Note | undefined {
  const s = slugifyOrNull(text);
  if (!s) return undefined;
  const exact = (text || '').trim();
  const legacy = legacySlugify(text);
  return (
    notes.find(n => n.slug === exact) ||
    notes.find(n => n.slug === s) ||
    (legacy ? notes.find(n => n.slug === legacy) : undefined) ||
    notes.find(n => {
      const aliases = noteAliases(n);
      return aliases.includes(s) || (legacy !== null && aliases.includes(legacy));
    })
  );
}

/**
 * Backlinks to a note, counting links to its current slug or any alias (C3.2), matched by a
 * link's exact, new-slug or legacy-slug key (R2-a).
 */
export function computeNoteBacklinks(target: Note, allNotes: Note[]): Note[] {
  const names = new Set([target.slug, slugify(target.slug), ...noteAliases(target)]);
  return allNotes.filter(n => {
    if (n.id === target.id) return false;
    for (const k of extractNoteWikilinkKeys(n)) if (names.has(k)) return true;
    return false;
  });
}

export type WikiToken = { type: 'text'; value: string } | { type: 'link'; raw: string; slug: string };

/**
 * Splits prose into text and `[[link]]` tokens. A link is `[[…]]` with no `[`, `]` or
 * newline inside; anything else (unclosed `[[a`, `[[]]`, `[[a]b]]`) stays plain text.
 */
export function tokenizeWikiText(text: string): WikiToken[] {
  const src = text || '';
  const out: WikiToken[] = [];
  const re = new RegExp(WIKILINK_SOURCE, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const inner = m[1];
    // QA-36: symbol-only text (`[[🔥]]`, `[[!!!]]`) stays plain text — never a generic slug.
    if (!inner.trim() || !slugifyOrNull(inner)) continue;
    if (m.index > last) out.push({ type: 'text', value: src.slice(last, m.index) });
    out.push({ type: 'link', raw: m[0], slug: slugifyOrNull(inner) as string });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ type: 'text', value: src.slice(last) });
  return out;
}

/** `feedback-loops` → `Feedback loops` (C3.3 capture title). */
export function deslugify(slug: string): string {
  const words = (slug || '').replace(/[-_]+/g, ' ').trim().replace(/\s+/g, ' ');
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

// ---- CD 3 fix-up R2#1 (ux_spec_cd C.3.2): slug field validation -------------------------

export const SLUG_FORMAT_ERROR = 'Use lowercase letters, numbers, and hyphens.';
export function slugCollisionError(slug: string): string {
  return `Another note already uses [[${slug}]].`;
}

/** A canonical slug: already in `slugifyOrNull` form (lowercase letters/numbers + hyphens). */
export function isValidSlug(value: string): boolean {
  return Boolean(value) && slugifyOrNull(value) === value;
}

/** On blur: spaces/caps auto-normalize; symbol-only input is left for the format error. */
export function normalizeSlugInput(value: string): string {
  const v = (value || '').trim();
  return v ? slugifyOrNull(v) ?? v : '';
}

/**
 * The slug a note editor saves. An EXPLICIT edit (field changed from the original) is
 * validated — bad format or a collision with another note's slug/alias blocks the save. An
 * unchanged field keeps the slug; an emptied field derives from the title and only then is
 * auto-suffixed (`-2`, `-3`, …) to stay unique.
 */
export function resolveSlugEdit(input: {
  rawSlug: string;
  title: string;
  originalSlug: string;
  taken: string[];
}): { slug: string; error: string | null } {
  const raw = (input.rawSlug || '').trim();
  if (raw === input.originalSlug) return { slug: input.originalSlug, error: null };
  if (!raw) {
    return { slug: generateUniqueSlug(input.title.trim() || input.originalSlug, input.taken), error: null };
  }
  if (!isValidSlug(raw)) return { slug: raw, error: SLUG_FORMAT_ERROR };
  if (input.taken.includes(raw)) return { slug: raw, error: slugCollisionError(raw) };
  return { slug: raw, error: null };
}

// ---- CD Batch 5: pure wikilink autocomplete cursor matching & replacement -----------------

export interface ActiveWikilinkMatch {
  query: string;
  startIndex: number;
  endIndex: number;
}

export function getActiveWikilinkMatch(
  value: string,
  cursorPos: number | null
): ActiveWikilinkMatch | null {
  if (cursorPos === null || cursorPos < 2 || cursorPos > value.length) {
    return null;
  }

  const beforeCursor = value.slice(0, cursorPos);
  const openIdx = beforeCursor.lastIndexOf('[[');
  if (openIdx === -1) return null;

  const between = beforeCursor.slice(openIdx + 2);
  if (between.includes('[') || between.includes(']') || between.includes('\n')) {
    return null;
  }

  return {
    query: between,
    startIndex: openIdx,
    endIndex: cursorPos,
  };
}

export function applyWikilinkSelection(
  value: string,
  match: ActiveWikilinkMatch,
  targetSlug: string
): { nextValue: string; nextCursor: number } {
  const before = value.slice(0, match.startIndex);
  const rawAfter = value.slice(match.endIndex);
  const after = rawAfter.startsWith(']]') ? rawAfter.slice(2) : rawAfter;
  const token = `[[${targetSlug}]]`;
  return {
    nextValue: `${before}${token}${after}`,
    nextCursor: before.length + token.length,
  };
}
