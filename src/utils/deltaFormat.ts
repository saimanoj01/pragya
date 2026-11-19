export function stripDeltaPrefix(value: string, prefix: 'WHEN' | 'DO'): string {
  const trimmed = (value || '').trim();
  if (!trimmed) return '';
  if (prefix === 'WHEN') {
    return trimmed.replace(/^(?:when(?:\s+|:\s*|$))+/i, '').trim();
  }
  return stripDoPrefix(trimmed);
}

/** Words after `do` that make it part of the action (`Do not reply…`), never a prefix. */
const DO_NEGATION_RE = /^do\s+(?:not|nothing|n't|no|none)(?![\w'])/i;

/**
 * C5.3 / OQ-4: strip a DO prefix only when it is unambiguous — `do:` (any case),
 * repeated `DO DO`, or `do ` (any case) not followed by a negation word. `Do not reply
 * after 9pm` stays intact; `DO Do not refresh…` → `Do not refresh…`. A lone `do` → ''.
 * Python mirror: `strip_do_prefix` in scripts/pragya_cli.py.
 */
export function stripDoPrefix(value: string): string {
  let s = (value || '').trim();
  for (;;) {
    if (/^do\s*$/i.test(s)) return '';
    const colon = /^do\s*:\s*/i.exec(s);
    if (colon) {
      s = s.slice(colon[0].length).trim();
      continue;
    }
    if (/^do\s+/i.test(s) && !DO_NEGATION_RE.test(s)) {
      s = s.replace(/^do\s+/i, '').trim();
      continue;
    }
    return s;
  }
}

export function normalizeDeltaTrigger(value: string): string {
  return stripDeltaPrefix(value, 'WHEN');
}

export function normalizeDeltaAction(value: string): string {
  return stripDeltaPrefix(value, 'DO');
}

export function formatWhenDoDisplay(trigger: string, action: string): {
  triggerBody: string;
  actionBody: string;
  whenLine: string;
  doLine: string;
} {
  const triggerBody = normalizeDeltaTrigger(trigger);
  const actionBody = normalizeDeltaAction(action);
  return {
    triggerBody,
    actionBody,
    whenLine: triggerBody ? `WHEN ${triggerBody}` : '',
    doLine: actionBody ? `DO ${actionBody}` : '',
  };
}

export const ACTIVE_DELTA_CAP = 5;

export function shouldDefaultOpenDeltaDetails(input: {
  bookKind?: string;
  triggerBody: string;
  actionBody: string;
  deltaStatus?: string;
}): boolean {
  return (
    input.bookKind !== 'fiction' ||
    Boolean(input.triggerBody || input.actionBody) ||
    (input.deltaStatus || 'none') !== 'none'
  );
}

export type DeltaSaveValidation =
  | { ok: true; normalizedTrigger: string; normalizedAction: string }
  | { ok: false; error: string };

export function validateDeltaForSave(input: {
  deltaTrigger: string;
  deltaAction: string;
  deltaStatus: string;
  otherActiveCount: number;
  emptyActiveMessage: string;
}): DeltaSaveValidation {
  if (input.otherActiveCount >= ACTIVE_DELTA_CAP && input.deltaStatus === 'active') {
    return {
      ok: false,
      error:
        'Active Behavioral Delta cap (5/5) reached. Graduate or pause an active delta first.',
    };
  }
  const normalizedTrigger = normalizeDeltaTrigger(input.deltaTrigger);
  const normalizedAction = normalizeDeltaAction(input.deltaAction);
  if (input.deltaStatus === 'active' && !normalizedTrigger && !normalizedAction) {
    return { ok: false, error: input.emptyActiveMessage };
  }
  return { ok: true, normalizedTrigger, normalizedAction };
}
