import { test, expect, type Page } from '@playwright/test';

/**
 * Tier 11 (QA, CD Batch 2) — adversarial probes: check-in date is the BROWSER-LOCAL day at
 * extreme offsets, ⌘/Ctrl+Enter with the wikilink autocomplete OPEN submits without
 * picking a suggestion, an IME-composing ⌘/Ctrl+Enter never submits, and a reflection
 * survives an outcome update + Undo.
 */

async function demo(page: Page) {
  await page.goto('/');
  await page.getByTestId('demo-login-btn').click();
  await expect(page.getByTestId('shelf-view')).toBeVisible();
}

type Log = { id: string; noteId: string; date: string; outcome: string; reflection: string };
type State = { deltaLogs: Log[]; notes: Array<{ id: string; takeaway: string; meta: Record<string, unknown> }> };
const demoState = (page: Page): Promise<State> =>
  page.evaluate(() => JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}'));
const localToday = (page: Page) =>
  page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
const toast = (page: Page, text: string) => page.locator('[data-sonner-toast]').filter({ hasText: text }).last();

for (const tz of ['Pacific/Kiritimati', 'Etc/GMT+12']) {
  test.describe(`Tier 11 — CD2 check-in local day @ ${tz}`, () => {
    test.use({ timezoneId: tz });
    test(`check-in row date is the browser-local day; second outcome updates the same row (${tz})`, async ({ page }) => {
      await demo(page);
      await page.getByTestId('nav-item-practice').click();
      const id = 'note-delays-feedback';
      const today = await localToday(page);
      const utcDay = await page.evaluate(() => new Date().toISOString().slice(0, 10));
      await page.getByTestId(`delta-apply-btn-${id}`).click();
      await expect(toast(page, 'Logged: Applied.')).toBeVisible();
      await page.getByTestId(`delta-missed-btn-${id}`).click();
      await expect(toast(page, "Updated today's check-in to Missed trigger.")).toBeVisible();
      const rows = (await demoState(page)).deltaLogs.filter(l => l.noteId === id && l.date === today);
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe('missed');
      // Sanity: at these offsets local and UTC days usually differ; the row must use local.
      if (utcDay !== today) {
        expect((await demoState(page)).deltaLogs.filter(l => l.noteId === id && l.date === utcDay && l.id === rows[0].id)).toHaveLength(0);
      }
    });
  });
}

test.describe('Tier 11 — CD Batch 2 QA probes', () => {
  test('reflection kept through an outcome update and its Undo', async ({ page }) => {
    await demo(page);
    await page.getByTestId('nav-item-practice').click();
    const id = 'note-delays-feedback';
    const today = await localToday(page);
    await page.getByTestId(`delta-apply-btn-${id}`).click();
    await page.getByTestId(`delta-reflection-input-${id}`).fill('kept text');
    await page.getByTestId(`delta-reflection-input-${id}`).press('Enter');
    await expect(toast(page, 'Reflection saved.')).toBeVisible();
    await page.getByTestId(`delta-notrigger-btn-${id}`).click();
    await toast(page, "Updated today's check-in to Didn't come up.").getByTestId('toast-undo-btn').click();
    await expect(toast(page, 'Check-in undone.')).toBeVisible();
    const rows = (await demoState(page)).deltaLogs.filter(l => l.noteId === id && l.date === today);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'applied', reflection: 'kept text' });
  });

  test('⌘/Ctrl+Enter with the [[ autocomplete OPEN submits the text as typed (no suggestion picked)', async ({ page }) => {
    await demo(page);
    await page.getByTestId('sidebar-capture-btn').click();
    await page.getByTestId('capture-book-select').selectOption('book-systems');
    const takeaway = page.getByTestId('capture-takeaway-input');
    await takeaway.click();
    await takeaway.pressSequentially('QA open-autocomplete [[self-org');
    await expect(page.getByTestId('wikilink-autocomplete')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.getByTestId('quick-capture-modal')).toBeHidden();
    const created = (await demoState(page)).notes.find(n => n.takeaway.startsWith('QA open-autocomplete'));
    expect(created?.takeaway).toBe('QA open-autocomplete [[self-org');
  });

  test('IME-composing ⌘/Ctrl+Enter never submits QuickCapture', async ({ page }) => {
    await demo(page);
    await page.getByTestId('sidebar-capture-btn').click();
    await page.getByTestId('capture-book-select').selectOption('book-systems');
    const takeaway = page.getByTestId('capture-takeaway-input');
    await takeaway.fill('QA ime 日本');
    const before = (await demoState(page)).notes.length;
    for (const init of [
      { key: 'Enter', metaKey: true, ctrlKey: true, isComposing: true },
      { key: 'Enter', metaKey: true, ctrlKey: true, keyCode: 229 },
    ]) {
      await takeaway.evaluate((el, i) => {
        const ev = new KeyboardEvent('keydown', { ...i, bubbles: true, cancelable: true });
        if ('keyCode' in i) Object.defineProperty(ev, 'keyCode', { get: () => (i as { keyCode: number }).keyCode });
        el.dispatchEvent(ev);
      }, init);
    }
    await page.waitForTimeout(300);
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    expect((await demoState(page)).notes.length).toBe(before);
  });
});

test.describe('Tier 11 — CD Batch 2 fix-up re-verify', () => {
  test('reflection save after the row was deleted elsewhere → explicit error, no resurrection', async ({ page }) => {
    await demo(page);
    await page.getByTestId('nav-item-practice').click();
    const id = 'note-delays-feedback';
    const today = await localToday(page);
    await page.getByTestId(`delta-apply-btn-${id}`).click();
    await expect(toast(page, 'Logged: Applied.')).toBeVisible();
    // Another device / CLI deletes today's row (Demo's fresh read comes from localStorage).
    await page.evaluate(({ id, today }) => {
      const s = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
      s.deltaLogs = s.deltaLogs.filter((l: { noteId: string; date: string }) => !(l.noteId === id && l.date === today));
      localStorage.setItem('pragya_demo_state_v1', JSON.stringify(s));
    }, { id, today });
    await page.getByTestId(`delta-reflection-input-${id}`).fill('late reflection');
    await page.getByTestId(`delta-reflection-input-${id}`).press('Enter');
    await expect(page.getByText('That check-in was removed on another device.')).toBeVisible();
    expect((await demoState(page)).deltaLogs.filter(l => l.noteId === id && l.date === today)).toHaveLength(0);
  });

  test('external same-day row (CLI) with reflection → PWA check-in updates it, never duplicates', async ({ page }) => {
    await demo(page);
    await page.getByTestId('nav-item-practice').click();
    const id = 'note-delays-feedback';
    const today = await localToday(page);
    await page.evaluate(({ id, today }) => {
      const s = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
      s.deltaLogs.push({ id: 'cli-row', noteId: id, date: today, outcome: 'applied', reflection: 'from cli' });
      localStorage.setItem('pragya_demo_state_v1', JSON.stringify(s));
    }, { id, today });
    await page.getByTestId(`delta-missed-btn-${id}`).click();
    await expect(toast(page, "Updated today's check-in to Missed trigger.")).toBeVisible();
    const rows = (await demoState(page)).deltaLogs.filter(l => l.noteId === id && l.date === today);
    expect(rows).toEqual([{ id: 'cli-row', noteId: id, date: today, outcome: 'missed', reflection: 'from cli' }]);
  });

  test('QA-35: To Spar list order == Save & Next order (oldest createdAt first)', async ({ page }) => {
    await demo(page);
    // Three visible inbox notes with createdAt order ≠ updatedAt order.
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
      const set = (id: string, c: string, u: string) => {
        const n = s.notes.find((x: { id: string }) => x.id === id);
        Object.assign(n, { status: 'inbox', createdAt: c, updatedAt: u, pos: 1 });
      };
      for (const n of s.notes) if (n.status === 'inbox' || n.status === 'in-reflection') n.status = 'saved';
      set('note-self-organization', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'); // A: oldest, least recently updated
      set('note-leverage-paradigm', '2025-02-01T00:00:00Z', '2025-06-01T00:00:00Z'); // B: newest updated
      set('note-infinite-rules', '2025-03-01T00:00:00Z', '2025-04-01T00:00:00Z'); // C
      localStorage.setItem('pragya_demo_state_v1', JSON.stringify(s));
    });
    await page.reload();
    await expect(page.getByTestId('shelf-view')).toBeVisible();
    await page.evaluate(() => { window.location.hash = '#/notes'; });
    await page.getByTestId('notes-filter-to-spar').click();
    const cards = page.locator('[data-testid^="note-card-"]');
    await expect(cards).toHaveCount(3);
    const order = await cards.evaluateAll(els => els.map(e => e.getAttribute('data-testid')));
    expect(order).toEqual([
      'note-card-self-organization-over-control',
      'note-card-paradigm-shifts-outrank-parameters',
      'note-card-rules-of-infinite-play',
    ]);
  });
});
