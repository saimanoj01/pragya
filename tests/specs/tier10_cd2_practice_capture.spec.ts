import { test, expect, type Page } from '@playwright/test';

/**
 * Tier 10 (Dev, CD Batch 2) — Practice & capture ergonomics, Demo mode.
 * C2.1 check-in coalescing + Undo + reflection + Refine WHEN/DO + History; C4.1 Socratic
 * prompts on atomic notes + Copy Sparring Prompt (clipboard + fallback, shield); C4.2
 * Reflect on Outcome; C4.3 QuickCapture title / wikilinks / ⌘↵ / attachments in drafts /
 * route preselect; C4.4 Kindle cleanup + Undo; C4.5 Deepen fiction collapse, tags, Save & Next.
 */

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4nGP4z8DwHwwZGP6DAQBJyAn3FGMynQAAAABJRU5ErkJggg==';

type Row = Record<string, unknown> & { id: string };
type DemoState = { books: Row[]; notes: Row[]; sessions: Row[]; deltaLogs: Row[] };

async function demo(page: Page) {
  await page.goto('/');
  await page.getByTestId('demo-login-btn').click();
  await expect(page.getByTestId('shelf-view')).toBeVisible();
}

async function go(page: Page, hash: string) {
  await page.evaluate(h => {
    window.location.hash = h;
  }, hash);
}

const demoState = (page: Page): Promise<DemoState> =>
  page.evaluate(() => JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}'));

async function editState(page: Page, fn: string, arg: unknown = null) {
  await page.evaluate(
    ({ fn, arg }) => {
      const s = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
      new Function('s', 'arg', fn)(s, arg);
      localStorage.setItem('pragya_demo_state_v1', JSON.stringify(s));
    },
    { fn, arg }
  );
  await page.reload();
  await expect(page.locator('[data-testid$="-view"]').first()).toBeVisible();
}

async function stubClipboard(page: Page, mode: 'ok' | 'fail') {
  await page.evaluate(m => {
    const w = window as unknown as { __copied?: string };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          if (m === 'fail') return Promise.reject(new Error('denied'));
          w.__copied = text;
          return Promise.resolve();
        },
      },
    });
  }, mode);
}

const localToday = (page: Page) =>
  page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });

const toast = (page: Page, text: string) =>
  page.locator('[data-sonner-toast]').filter({ hasText: text }).last();

test.describe('Tier 10 — CD Batch 2 Practice & capture (Dev)', () => {
  test('Practice: check-in coalesces per day with Undo; reflection; Refine WHEN + DO; History newest first', async ({ page }) => {
    await demo(page);
    await page.getByTestId('nav-item-practice').click();
    const id = 'note-delays-feedback';
    const card = page.getByTestId(`delta-card-${id}`);
    const today = await localToday(page);
    const todayRows = async () =>
      (await demoState(page)).deltaLogs.filter(l => l.noteId === id && l.date === today);

    // First check-in → append + Undo deletes it.
    await page.getByTestId(`delta-apply-btn-${id}`).click();
    await expect(toast(page, 'Logged: Applied.')).toBeVisible();
    await expect(page.getByTestId(`delta-apply-btn-${id}`)).toHaveAttribute('aria-pressed', 'true');
    await expect(card.getByRole('group', { name: "Today's check-in" })).toBeVisible();
    expect(await todayRows()).toHaveLength(1);
    await toast(page, 'Logged: Applied.').getByTestId('toast-undo-btn').click();
    await expect(toast(page, 'Check-in undone.')).toBeVisible();
    await expect.poll(async () => (await todayRows()).length).toBe(0);
    await expect(page.getByTestId(`delta-apply-btn-${id}`)).toHaveAttribute('aria-pressed', 'false');

    // Check in again, add a reflection (Enter saves) — not auto-focused.
    await page.getByTestId(`delta-apply-btn-${id}`).click();
    const reflection = page.getByTestId(`delta-reflection-input-${id}`);
    await expect(reflection).toBeVisible();
    await expect(reflection).not.toBeFocused();
    await expect(reflection).toHaveAttribute('placeholder', 'What made it work? (optional)');
    await reflection.fill('Waited a full cycle before tuning.');
    await reflection.press('Enter');
    await expect(toast(page, 'Reflection saved.')).toBeVisible();
    await expect(page.getByTestId(`delta-reflection-saved-${id}`)).toContainText('Waited a full cycle');
    expect((await todayRows())[0].reflection).toBe('Waited a full cycle before tuning.');

    // Same outcome again → no write, no new toast.
    await page.getByTestId(`delta-apply-btn-${id}`).click();
    await page.waitForTimeout(300);
    expect(await todayRows()).toHaveLength(1);

    // Missed the same day → UPDATE (one row, reflection kept), refine panel; Undo restores Applied.
    await page.getByTestId(`delta-missed-btn-${id}`).click();
    await expect(toast(page, "Updated today's check-in to Missed trigger.")).toBeVisible();
    const rows = await todayRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('missed');
    expect(rows[0].reflection).toBe('Waited a full cycle before tuning.');
    await toast(page, "Updated today's check-in to Missed trigger.").getByTestId('toast-undo-btn').click();
    await expect.poll(async () => (await todayRows())[0]?.outcome).toBe('applied');

    // Refine WHEN and DO.
    await page.getByTestId(`delta-missed-btn-${id}`).click();
    await expect(card.getByText('Refine this delta')).toBeVisible();
    await page.getByTestId(`delta-trigger-edit-input-${id}`).fill('WHEN latency graphs wobble');
    await page.getByTestId(`delta-action-edit-input-${id}`).fill('DO: wait one full feedback cycle');
    await page.getByTestId(`delta-trigger-save-btn-${id}`).click();
    await expect(toast(page, 'Delta refined.')).toBeVisible();
    const note = (await demoState(page)).notes.find(n => n.id === id)!;
    expect(note.deltaTrigger).toBe('latency graphs wobble');
    expect(note.deltaAction).toBe('wait one full feedback cycle');

    // History: today's row first, then older seed rows; no percentages.
    const history = page.getByTestId(`delta-history-${id}`);
    // CD 2 fix-up (R2 nit): the applied/missed tally lives in the collapsed summary only.
    await expect(history.locator('summary')).toHaveText('History (3) · 1 applied · 1 missed');
    await expect(card.locator('> div').first()).not.toContainText('applied');
    await history.locator('summary').click();
    const items = history.locator('li');
    await expect(items).toHaveCount(3);
    await expect(items.first()).toContainText(today);
    await expect(items.first()).toContainText('Missed trigger');
    await expect(history).not.toContainText('%');
  });

  test('Practice fix-up: a same-day row written elsewhere (CLI/other device) is UPDATED, its reflection kept; Undo restores only the outcome', async ({ page }) => {
    await demo(page);
    await page.getByTestId('nav-item-practice').click();
    const id = 'note-delays-feedback';
    const today = await localToday(page);
    // Another writer logs today WITHOUT this tab knowing (no reload): R1#1 fresh read.
    await page.evaluate(
      ({ id, today }) => {
        const s = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
        s.deltaLogs.push({ id: 'cli-row', noteId: id, date: today, outcome: 'no-trigger', reflection: 'from the CLI' });
        localStorage.setItem('pragya_demo_state_v1', JSON.stringify(s));
      },
      { id, today }
    );
    await page.getByTestId(`delta-apply-btn-${id}`).click();
    await expect(toast(page, "Updated today's check-in to Applied.")).toBeVisible();
    const rowsFor = async () => (await demoState(page)).deltaLogs.filter(l => l.noteId === id && l.date === today);
    let rows = await rowsFor();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'cli-row', outcome: 'applied', reflection: 'from the CLI' });

    // Reflection saved in the Undo window survives the Undo (R1#3).
    await page.getByTestId(`delta-reflection-input-${id}`).fill('mine now');
    await page.getByTestId(`delta-reflection-input-${id}`).press('Enter');
    await expect(toast(page, 'Reflection saved.')).toBeVisible();
    await toast(page, "Updated today's check-in to Applied.").getByTestId('toast-undo-btn').click();
    await expect(toast(page, 'Check-in undone.')).toBeVisible();
    rows = await rowsFor();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'no-trigger', reflection: 'mine now' });

    // Re-press of the logged outcome: no write, polite sr-only status.
    await page.getByTestId(`delta-notrigger-btn-${id}`).click();
    await expect(page.getByTestId('delta-checkin-status')).toHaveText("Already logged today: Didn't come up.");
    expect(await rowsFor()).toHaveLength(1);
  });

  test('NoteDetail: Socratic prompts collapsed on atomic notes; Copy Sparring Prompt (clipboard, fallback, shield)', async ({ page }) => {
    await demo(page);
    await editState(
      page,
      `s.notes.find(n => n.id === 'note-delays-feedback').meta.socraticQuestions = ['Where would waiting be wrong?', 'What signals the lag ended?'];`
    );
    await go(page, '#/note/delays-in-feedback-loops');
    const details = page.getByTestId('socratic-prompts-details');
    await expect(details.locator('summary')).toHaveText('Socratic prompts (2)');
    await expect(details).not.toHaveAttribute('open', '');
    await expect(page.getByText('Where would waiting be wrong?')).toBeHidden();
    await details.locator('summary').click();
    await expect(page.getByText('Where would waiting be wrong?')).toBeVisible();
    await expect(page.getByTestId('copy-sparring-prompt-btn')).toHaveCount(0); // atomic → hidden

    // In-reflection fiction note: exact first lines + bookmark ceiling.
    await go(page, '#/note/memory-prism-digital-remembrance');
    await expect(page.getByTestId('note-detail-view')).toBeVisible();
    await stubClipboard(page, 'ok');
    await page.getByTestId('copy-sparring-prompt-btn').click();
    await expect(toast(page, 'Sparring prompt copied. Paste it into your assistant.')).toBeVisible();
    const copied = await page.evaluate(() => (window as unknown as { __copied?: string }).__copied || '');
    expect(copied.split('\n')[0]).toBe(
      'Help me think through a note from "Exhalation: Stories" by Ted Chiang (Fiction), from p. 120 in my reading.'
    );
    expect(copied).toContain("Questions I've already been asked: Which relationship");
    expect(copied).toContain("I'm only at p. 168. Don't mention anything that happens after that point.");
    expect(copied).not.toContain('WHEN … → DO …');

    // Clipboard denied → select-and-copy fallback with the same text.
    await stubClipboard(page, 'fail');
    await page.getByTestId('copy-sparring-prompt-btn').click();
    const fallback = page.getByTestId('sparring-prompt-fallback-modal');
    await expect(fallback).toBeVisible();
    await expect(fallback.getByRole('heading')).toHaveText('Copy Sparring Prompt');
    await expect(fallback.locator('textarea')).toHaveValue(copied);
    await page.keyboard.press('Escape');

    // Shielded inbox note (Lathe bookmark p. 0 < p. 15): button disabled until revealed.
    await go(page, '#/note/note-effective-dreaming');
    await expect(page.getByTestId('spoiler-shield-note-effective-dreaming')).toBeVisible();
    await expect(page.getByTestId('copy-sparring-prompt-btn')).toBeDisabled();
  });

  test('Reflect on Outcome: only for unlocked predictions; saves meta.predictionOutcome; NoteDetail shows How It Played Out', async ({ page }) => {
    await demo(page);
    await page.getByTestId('nav-item-practice').click();
    await expect(page.getByTestId('reflect-outcome-btn-note-thermal-equilibrium')).toHaveCount(0); // book unfinished
    await editState(page, `s.books.find(b => b.id === 'book-exhalation').status = 'finished';`);
    await page.getByTestId('nav-item-practice').click();
    const btn = page.getByTestId('reflect-outcome-btn-note-thermal-equilibrium');
    await expect(btn).toHaveText('Reflect on Outcome');
    await btn.click();
    const modal = page.getByTestId('prediction-outcome-modal');
    await expect(modal).toContainText('How did it play out?');
    await expect(modal).toContainText('Exhalation: Stories · your prediction at p. 165');
    await expect(page.getByTestId('prediction-outcome-input')).toBeFocused();
    await page.getByTestId('prediction-outcome-input').fill('Right about equilibrium, wrong about the lungs.');
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(toast(page, 'Saved your reflection.')).toBeVisible();
    await expect(btn).toHaveText('Edit Reflection');
    const n = (await demoState(page)).notes.find(x => x.id === 'note-thermal-equilibrium')! as Row & {
      meta: { predictionOutcome?: { text: string; at: string }; isPrediction?: boolean; title?: string };
    };
    expect(n.meta.predictionOutcome?.text).toBe('Right about equilibrium, wrong about the lungs.');
    expect(n.meta.isPrediction).toBe(true);
    expect(n.meta.title).toBe('Consciousness and Thermal Equilibrium');

    await go(page, '#/note/consciousness-and-thermal-equilibrium');
    await expect(page.getByTestId('prediction-outcome-section')).toContainText('How It Played Out');
    await expect(page.getByTestId('prediction-outcome-section')).toContainText('Right about equilibrium');
    await expect(page.getByTestId('reflect-outcome-btn-note-thermal-equilibrium')).toHaveText('Edit Reflection');
  });

  test('QuickCapture: route preselect, Title, [[ autocomplete, ⌘/Ctrl+Enter submit', async ({ page }) => {
    await demo(page);
    // FAB / Sidebar on a book page preselects it; on a note page, the note's book.
    await go(page, '#/book/book-finite');
    await expect(page.getByTestId('book-detail-view')).toBeVisible();
    await page.getByTestId('sidebar-capture-btn').click();
    await expect(page.getByTestId('capture-book-select')).toHaveValue('book-finite');
    await page.keyboard.press('Escape');
    await go(page, '#/note/memory-prism-digital-remembrance');
    await expect(page.getByTestId('note-detail-view')).toBeVisible();
    await page.keyboard.press('n');
    await expect(page.getByTestId('capture-book-select')).toHaveValue('book-exhalation');
    await page.keyboard.press('Escape');
    // Shelf: no preselect → book select first in focus order (tier1 contract).
    await go(page, '#/shelf');
    await page.getByTestId('sidebar-capture-btn').click();
    await expect(page.getByTestId('capture-book-select')).toBeFocused();
    await page.getByTestId('capture-book-select').selectOption('book-systems');

    await page.getByTestId('capture-title-input').fill('Stocks lag flows');
    const takeaway = page.getByTestId('capture-takeaway-input');
    await takeaway.click();
    await takeaway.pressSequentially('Linked to [[self-org');
    await expect(page.getByTestId('wikilink-autocomplete')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(takeaway).toHaveValue('Linked to [[self-organization-over-control]]');
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.getByTestId('quick-capture-modal')).toBeHidden();
    const created = (await demoState(page)).notes.find(
      n => (n.meta as { title?: string }).title === 'Stocks lag flows'
    );
    expect(created?.takeaway).toBe('Linked to [[self-organization-over-control]]');
    expect(created?.slug).toBe('stocks-lag-flows');
  });

  test('QuickCapture: an uploaded image survives Escape (draft keeps the reference); Discard clears it', async ({ page }) => {
    await demo(page);
    await page.getByTestId('sidebar-capture-btn').click();
    await page.getByTestId('capture-photo-input').setInputFiles({
      name: 'margin.png',
      mimeType: 'image/png',
      buffer: Buffer.from(TINY_PNG_BASE64, 'base64'),
    });
    await expect(page.getByTestId('capture-attachment-list')).toContainText('margin');
    await page.waitForTimeout(400); // debounced autosave
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('quick-capture-modal')).toBeHidden();
    const draftRaw = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(k => k.endsWith(':pragya_draft_capture_v1'));
      return key ? localStorage.getItem(key) : null;
    });
    expect(draftRaw).not.toBeNull();
    expect(draftRaw!).not.toContain('data:'); // refs only, never blobs
    await page.getByTestId('sidebar-capture-btn').click();
    await expect(page.getByTestId('draft-restored-banner')).toContainText(
      'Restored your unsaved draft (with 1 attachment).'
    );
    await expect(page.getByTestId('capture-attachment-list')).toContainText('margin');
    await page.getByTestId('draft-discard-btn').click();
    await expect(page.getByTestId('capture-attachment-list')).not.toContainText('margin');
  });

  test('Kindle paste: citation stripped with Undo; % in prose ignored', async ({ page }) => {
    await demo(page);
    await page.getByTestId('sidebar-capture-btn').click();
    await page.getByTestId('capture-book-select').selectOption('book-systems');
    const quote = page.getByTestId('capture-quote-input');
    const raw =
      'Your Highlight on page 150 | Location 1423-1425 | Added on Sunday, November 16, 2026\n\nDelays in feedback loops cause oscillations.';
    await quote.focus();
    await page.evaluate(text => {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      document.activeElement!.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      );
    }, raw);
    await expect(quote).toHaveValue('Delays in feedback loops cause oscillations.');
    await expect(page.getByTestId('kindle-clean-chip')).toContainText('Cleaned Kindle citation');
    await expect(page.getByTestId('kindle-pos-chip')).toContainText('Page 150');
    await page.getByTestId('kindle-clean-undo-btn').click();
    await expect(quote).toHaveValue(raw);
    await expect(page.getByTestId('kindle-clean-chip')).toHaveCount(0);

    await quote.fill('Revenue grew 40% faster than expected.');
    await expect(page.getByTestId('kindle-pos-chip')).toHaveCount(0);
    await expect(page.getByTestId('kindle-unit-mismatch-chip')).toHaveCount(0);
  });

  test('Deepen: fiction delta collapsed, inline Tags, Save & Next (skips shielded), done toast', async ({ page }) => {
    await demo(page);
    // Unshield the Lathe inbox note so both To Spar notes are eligible.
    await editState(page, `const b = s.books.find(b => b.id === 'book-lathe'); b.currentPos = 20; b.normalizedPos = 20 / 192; b.status = 'reading';`);
    await go(page, '#/note/effective-dreaming-ethics');
    await page.getByTestId('deepen-note-btn').click();
    const modal = page.getByTestId('deepen-note-modal');
    const deltaDetails = page.getByTestId('deepen-delta-details');
    await expect(deltaDetails).toContainText('Behavioral Delta (optional for fiction)');
    await expect(deltaDetails).not.toHaveAttribute('open', '');
    await expect(page.getByTestId('deepen-trigger-input')).toBeHidden();
    await expect(page.getByTestId('deepen-tags-input')).toHaveValue('#fiction, #ethics, #dreams');
    await page.getByTestId('deepen-tags-input').fill('#fiction, #ethics, #craft');
    await page.getByTestId('deepen-save-next-btn').click();
    // Next (oldest To Spar first): the Exhalation in-reflection note.
    await expect(modal).toContainText('Exhalation');
    await expect(page.getByTestId('deepen-title-input')).toHaveValue('Memory Prism: Digital Remembrance');
    await expect(page.getByTestId('deepen-title-input')).toBeFocused();
    const saved = (await demoState(page)).notes.find(n => n.id === 'note-effective-dreaming')!;
    expect(saved.status).toBe('atomic');
    expect(saved.tags).toEqual(['#fiction', '#ethics', '#craft']);
    // No other eligible note → no Save & Next; the primary still writes atomic.
    await expect(page.getByTestId('deepen-save-next-btn')).toHaveCount(0);
    await page.getByTestId('deepen-submit-btn').click();
    await expect(modal).toBeHidden();
    expect((await demoState(page)).notes.find(n => n.id === 'note-memory-prism')!.status).toBe('atomic');
  });

  test('Deepen: Save & Next hidden when the only other To Spar note is shielded; non-fiction delta stays expanded', async ({ page }) => {
    await demo(page);
    await go(page, '#/note/memory-prism-digital-remembrance');
    await page.getByTestId('deepen-note-btn').click();
    await expect(page.getByTestId('deepen-note-modal')).toBeVisible();
    await expect(page.getByTestId('deepen-save-next-btn')).toHaveCount(0); // Lathe note is shielded
    await page.keyboard.press('Escape');
    await go(page, '#/note/self-organization-over-control');
    await page.getByTestId('deepen-note-btn').click();
    await expect(page.getByTestId('deepen-delta-details')).toHaveCount(0);
    await expect(page.getByTestId('deepen-trigger-input')).toBeVisible();
  });
});
