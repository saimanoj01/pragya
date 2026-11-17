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
