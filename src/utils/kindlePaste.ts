import type { PosUnit } from '../types/pragya';

export interface KindlePositionHint {
  pos: number;
  unitHint: PosUnit;
  label: string;
}

/**
 * Extracts Kindle/reader position hints from pasted highlight snippets, e.g.:
 * - "Your Highlight on Location 1423-1425 | Added on ..."
 * - "Your Highlight on Page 84 | ..."
 * - "62%"
 */
export function extractKindlePositionCandidates(text: string): KindlePositionHint[] {
  const raw = text || '';
  if (!raw.trim()) return [];

  const candidates: KindlePositionHint[] = [];

  const locMatch = /\bLocation\s+(\d+(?:,\d{3})*)/i.exec(raw);
  if (locMatch) {
    const pos = Number(locMatch[1].replace(/,/g, ''));
    if (Number.isFinite(pos) && pos >= 0) {
      candidates.push({
        pos,
        unitHint: 'loc',
        label: `Location ${pos}`,
      });
    }
  }

  const pageMatch = /\bPage\s+(\d+(?:,\d{3})*)/i.exec(raw);
  if (pageMatch) {
    const pos = Number(pageMatch[1].replace(/,/g, ''));
    if (Number.isFinite(pos) && pos >= 0) {
      candidates.push({
        pos,
        unitHint: 'page',
        label: `Page ${pos}`,
      });
    }
  }

  const pctMatch = /(?:^|[\s(|])(\d{1,3})%(?:$|[\s),.|])/m.exec(raw) || /(\d{1,3})%/.exec(raw);
  if (pctMatch) {
    const pos = Number(pctMatch[1]);
    if (Number.isFinite(pos) && pos >= 0 && pos <= 100) {
      candidates.push({
        pos,
        unitHint: 'percent',
        label: `${pos}%`,
      });
    }
  }

  return candidates;
}

// ---- CD C4.4 (ux_spec_cd C.4.2): citation cleanup, citation-only %, unit guard ----------

/** Lines that are Kindle/reader citation boilerplate, never highlighted text. */
const CITATION_LINE_RES: RegExp[] = [
  /^-?\s*Your\s+(?:Highlight|Note|Bookmark)\s+(?:on|at)\b.*$/i,
  /^(?:Highlight|Note|Bookmark)\s*(?:\([^)]*\))?\s*[-–—:]\s*(?:Page|Location|Loc\.?)\s+[0-9].*$/i,
  /^(?:Highlight|Note|Bookmark)\s+on\s+(?:Page|Location|Loc\.?)\s+[0-9].*$/i,
  /^Note\s+on\s+(?:Page|Location|Loc\.?)\b.*$/i,
  /^Added\s+on\b.*$/i,
  /^Notes\s+From:.*$/i,
  /^(?:Location|Loc\.?|Page)\s+[0-9][0-9,]*(?:\s*[-–]\s*[0-9][0-9,]*)?\s*(?:[|·].*)?$/i,
  /^[0-9]{1,3}%\s*(?:[|·].*)?$/,
  /^={5,}$/,
];
/** Trailing attribution: `— Donella Meadows, Thinking in Systems (Kindle Edition)`. */
const ATTRIBUTION_RE = /\s*[—–-]{1,2}\s*[^\n—–]*\(Kindle Edition\)\s*$/i;
/** QA-34: matching outer pairs that may be unwrapped (open, close). */
const QUOTE_PAIRS: Array<[string, string]> = [
  ['"', '"'],
  ['“', '”'],
  ["'", "'"],
  ['‘', '’'],
];

/**
 * Unwrap ONE matching outer quote pair, and only when neither quote character occurs
 * inside — so dialogue (`“Run,” she said. “Now.”`), `'Tis`, and `He said “stop.”` keep
 * every mark that belongs to the highlight.
 */
export function unwrapOuterQuotes(text: string): string {
  const t = text.trim();
  for (const [open, close] of QUOTE_PAIRS) {
    if (t.length >= 2 && t.startsWith(open) && t.endsWith(close)) {
      const inner = t.slice(open.length, t.length - close.length);
      if (!inner.includes(open) && !inner.includes(close) && inner.trim()) return inner.trim();
      return t;
    }
  }
  return t;
}

/** A segment that looks like a real Kindle citation (keyword + number). */
const KINDLE_SEGMENT_RE = /\b(?:Highlight|Note|Bookmark|Location|Loc\.?|Page|Added on)\b/i;

function isCitationLine(line: string): boolean {
  const t = line.trim();
  return t !== '' && CITATION_LINE_RES.some(re => re.test(t));
}

export interface KindleCleanResult {
  /** Highlighted text only (citation lines + attribution removed, wrapping quotes trimmed). */
  text: string;
  /** True when something was actually stripped (show the `Cleaned Kindle citation` chip). */
  cleaned: boolean;
}

/**
 * Removes Kindle citation boilerplate (`Your Highlight on page 84 | Location 1423-1425 |
 * Added on …`, `Note on Location …`, `Highlight (yellow) - Page 12 · Location 180`,
 * `Notes From: …`, `— Author, Title (Kindle Edition)`, `==========`). Returns the text
 * untouched (`cleaned: false`) when nothing matched, or when stripping would leave nothing.
 */
export function stripKindleBoilerplate(text: string): KindleCleanResult {
  const raw = text || '';
  const lines = raw.split(/\r?\n/);
  const kept = lines.filter(line => !isCitationLine(line));
  let body = kept.join('\n');
  const removedLines = kept.length !== lines.length;
  const withoutAttribution = body.replace(ATTRIBUTION_RE, '');
  const removedAttribution = withoutAttribution !== body;
  body = withoutAttribution;
  if (!removedLines && !removedAttribution) return { text: raw, cleaned: false };
  const cleanedText = unwrapOuterQuotes(body);
  if (!cleanedText) return { text: raw, cleaned: false };
  return { text: cleanedText, cleaned: true };
}

/**
 * Like `extractKindlePositionCandidates`, but a percent counts only inside a citation
 * line — at the start of a line or as its own `|`/`·`-delimited segment — never in prose
 * ("grew 40% faster").
 */
export function extractCitationPositionCandidates(text: string): KindlePositionHint[] {
  const raw = text || '';
  if (!raw.trim()) return [];
  const out = extractKindlePositionCandidates(raw).filter(c => c.unitHint !== 'percent');
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    // QA info: a `|` alone isn't a citation ("Revenue | 40% margin") — the line must be a
    // citation line, or have a `|`/`·` segment with a Kindle keyword.
    const citation =
      isCitationLine(t) || (/[|·]/.test(t) && t.split(/[|·]/).some(seg => KINDLE_SEGMENT_RE.test(seg)));
    if (!citation) continue;
    const segments = t.split(/[|·]/).map(seg => seg.trim());
    const hit = segments
      .map(seg => /^(?:[A-Za-z ]*?\s)?([0-9]{1,3})%$/.exec(seg) || /^([0-9]{1,3})%/.exec(seg))
      .find(Boolean);
    if (hit) {
      const pos = Number(hit[1]);
      if (Number.isFinite(pos) && pos >= 0 && pos <= 100) {
        out.push({ pos, unitHint: 'percent', label: `${pos}%` });
        break;
      }
    }
  }
  return out;
}

export type KindleHintResult =
  | { kind: 'match'; hint: KindlePositionHint }
  | { kind: 'mismatch'; hint: KindlePositionHint }
  | null;

const UNIT_NAMES: Record<PosUnit, string> = {
  page: 'pages',
  percent: 'percent',
  loc: 'Kindle locations',
};

/** `Detected Location 1423 — this book tracks pages.` */
export function kindleUnitMismatchCopy(hint: KindlePositionHint, bookUnit: PosUnit): string {
  return `Detected ${hint.label} — this book tracks ${UNIT_NAMES[bookUnit] || bookUnit}.`;
}

/**
 * Unit guard: a hint in the book's own unit → `match` (Apply offered). Otherwise the first
 * detected hint → `mismatch` (no Apply; there's no safe conversion between pages, Kindle
 * locations and percent). Nothing detected → null.
 */
export function pickCitationHint(text: string, bookUnit: PosUnit): KindleHintResult {
  const candidates = extractCitationPositionCandidates(text);
  if (candidates.length === 0) return null;
  const same = candidates.find(c => c.unitHint === bookUnit);
  if (same) return { kind: 'match', hint: same };
  return { kind: 'mismatch', hint: candidates[0] };
}

export function pickKindlePositionHint(
  text: string,
  preferredUnit?: PosUnit
): KindlePositionHint | null {
  const candidates = extractKindlePositionCandidates(text);
  if (candidates.length === 0) return null;
  if (preferredUnit) {
    const preferred = candidates.find(c => c.unitHint === preferredUnit);
    if (preferred) return preferred;
  }
  return candidates[0];
}
