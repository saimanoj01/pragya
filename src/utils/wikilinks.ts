import type { Note } from '../types/pragya';

export function slugify(input: string): string {
  const cleaned = (input || '')
    .toLowerCase()
    .trim()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'note';
}

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
  const regex = /\[\[([^\]]+)\]\]/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    const normalized = slugify(raw);
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
  return extractWikilinks(combined);
}

export function computeBacklinks(targetSlug: string, allNotes: Note[]): Note[] {
  const normalizedTarget = slugify(targetSlug);
  return allNotes.filter(
    n => n.slug !== normalizedTarget && extractNoteWikilinks(n).includes(normalizedTarget)
  );
}
