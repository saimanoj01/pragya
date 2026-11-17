export function stripDeltaPrefix(value: string, prefix: 'WHEN' | 'DO'): string {
  const trimmed = (value || '').trim();
  if (!trimmed) return '';
  if (prefix === 'WHEN') {
    return trimmed.replace(/^(?:when(?:\s+|:\s*|$))+/i, '').trim();
  }
  return trimmed.replace(/^(?:do(?:\s+|:\s*|$))+/i, '').trim();
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
