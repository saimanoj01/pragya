import { test, expect, type Page } from '@playwright/test';

/**
 * Tier 7 (QA, M6 Batch 4) — Spoiler Shield end-to-end (Demo seed).
 * `effective-dreaming-ethics` (The Lathe of Heaven, p. 15 > bookmark p. 0) is a spoiler.
 * Words that exist only in it: title "Burden of Effective Dreaming", quote "omniscience",
 * takeaway "reality-warping". Its tags (#ethics, #dreams) are searchable by design.
 */

const SPOILER_SLUG = 'effective-dreaming-ethics';
// QA-14 (Batch 7): NoteDetailView shield test IDs are keyed by note id (the slug derives from
// the note's text); list cards keep the slug.
const SPOILER_NOTE_ID = 'note-effective-dreaming';
const SECRET_TEXT = ['Burden of Effective Dreaming', 'omniscience', 'reality-warping'];

async function demo(page: Page) {
  await page.goto('/');
  await page.getByTestId('demo-login-btn').click();
  await expect(page.getByTestId('shelf-view')).toBeVisible();
}

async function goNote(page: Page, slug: string) {
  await page.evaluate(s => {
    window.location.hash = `#/note/${encodeURIComponent(s)}`;
  }, slug);
  await expect(page.getByTestId('note-detail-view')).toBeVisible();
}

async function expectNoSecrets(page: Page, where: string) {
  const html = await page.content();
  const text = await page.evaluate(() => document.body.innerText);
  const title = await page.title();
  for (const s of SECRET_TEXT) {
    expect(html.includes(s), `${where}: "${s}" in DOM`).toBe(false);
    expect(text.includes(s), `${where}: "${s}" in text`).toBe(false);
    expect(title.includes(s), `${where}: "${s}" in document.title`).toBe(false);
  }
}

test.describe('Tier 7 — Spoiler Shield (QA)', () => {
  test('NoteDetailView direct link: nothing secret in DOM/aria/title; shortcuts inert; Space reveals; reveal resets on navigation', async ({ page }) => {
    await demo(page);
    await goNote(page, SPOILER_SLUG);

    await expect(page.getByTestId('note-detail-title')).toHaveText('Shielded note');
    await expect(page.getByTestId(`spoiler-shield-${SPOILER_NOTE_ID}`)).toBeVisible();
    await expectNoSecrets(page, 'shielded detail');
    const text = await page.evaluate(() => document.body.innerText);
    expect(text).not.toContain(`[[${SPOILER_SLUG}]]`);
    expect(text).not.toContain('#dreams'); // tags hidden until reveal
    expect(text).not.toContain('self-organization-over-control'); // outgoing wikilink chip hidden
    await expect(page.getByTestId('backlinks-section')).toHaveCount(0);

    // Edit / Deepen disabled with tooltip; E / D / O are no-ops while shielded.
    await expect(page.getByTestId('edit-note-btn')).toBeDisabled();
    await expect(page.getByTestId('deepen-note-btn')).toBeDisabled();
    await expect(page.getByTestId('edit-note-btn')).toHaveAttribute('title', 'Reveal the note to edit');
    const popupPromise = page.waitForEvent('popup', { timeout: 500 }).catch(() => null);
    for (const key of ['e', 'd', 'o']) await page.keyboard.press(key);
    expect(await popupPromise).toBeNull();
    await expect(page.getByTestId('edit-note-modal')).toHaveCount(0);
    await expect(page.getByTestId('deepen-note-modal')).toHaveCount(0);

    // Space reveals; focus moves to the h1; live region announces.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Space');
    await expect(page.getByTestId('note-detail-title')).toHaveText('Burden of Effective Dreaming');
    await expect(page.getByTestId('note-detail-title')).toBeFocused();
    await expect(page.getByRole('status').filter({ hasText: 'Note revealed.' })).toHaveCount(1);
    await expect(page.getByText('omniscience', { exact: false })).toBeVisible();
    await expect(page.getByTestId('edit-note-btn')).toBeEnabled();

    // Navigate away and back → shielded again.
    await goNote(page, 'self-organization-over-control');
    await expect(page.getByTestId('note-detail-title')).toHaveText('Self-Organization Over Control');
    await goNote(page, SPOILER_SLUG);
    await expect(page.getByTestId('note-detail-title')).toHaveText('Shielded note');
    await expectNoSecrets(page, 'after navigation back');
  });

  test('Backlink from a non-spoiler note is labelled "Shielded note · p. 15"', async ({ page }) => {
    await demo(page);
    await goNote(page, 'self-organization-over-control');
    const backlinks = page.getByTestId('backlinks-section');
    await expect(backlinks).toBeVisible();
    await expect(backlinks).toContainText('Shielded note · p. 15');
    await expectNoSecrets(page, 'backlinks of self-organization-over-control');
  });

  test('NotesView search: secret-only words match 0 cards with the footnote; tags still match; after reveal the word matches', async ({ page }) => {
    await demo(page);
    await page.getByTestId('nav-item-notes').click();
    const search = page.getByTestId('notes-search-input');

    for (const word of ['omniscience', 'reality-warping', 'Burden', SPOILER_SLUG]) {
      await search.fill(word);
      await expect(page.getByTestId(`spoiler-shield-${SPOILER_SLUG}`)).toHaveCount(0);
      await expect(page.getByTestId('notes-spoiler-search-footnote')).toHaveText(
        'Notes ahead of your bookmark are searched by tag and book only.'
      );
    }
    await search.fill('#dreams');
    await expect(page.getByTestId(`spoiler-shield-${SPOILER_SLUG}`)).toBeVisible();
    await expectNoSecrets(page, 'notes search by tag');

    await page.getByTestId(`spoiler-reveal-btn-${SPOILER_SLUG}`).click();
    await search.fill('omniscience');
    await expect(page.getByText('omniscience', { exact: false }).first()).toBeVisible();
  });

  test('CommandPalette: secret words find nothing; tag finds a "Shielded note · p. 15" item with no slug in its id', async ({ page }) => {
    await demo(page);
    await page.keyboard.press('Control+k');
    const palette = page.getByTestId('command-palette');
    await expect(palette).toBeVisible();
    const input = page.getByTestId('command-palette-input');
    for (const word of ['omniscience', 'reality-warping', 'Burden', 'effective-dreaming']) {
      await input.fill(word);
      await expect(palette).not.toContainText('Shielded note');
      expect(await palette.innerHTML()).not.toContain(SPOILER_SLUG);
    }
    await input.fill('dreams');
    await expect(palette).toContainText('Shielded note · p. 15');
    const html = await palette.innerHTML();
    expect(html).not.toContain(SPOILER_SLUG);
    for (const s of SECRET_TEXT) expect(html).not.toContain(s);
  });

  test('WikilinkAutocomplete in EditNoteModal never offers the shielded note; non-spoiler candidates still appear', async ({ page }) => {
    await demo(page);
    await goNote(page, 'delays-in-feedback-loops');
    await page.getByTestId('edit-note-btn').click();
    await expect(page.getByTestId('edit-note-modal')).toBeVisible();
    const takeaway = page.getByTestId('edit-note-takeaway-input');
    await takeaway.click();
    await takeaway.press('End');

    await takeaway.pressSequentially(' [[reality');
    await expect(page.getByTestId(`wikilink-option-${SPOILER_SLUG}`)).toHaveCount(0);
    for (let i = 0; i < 'reality'.length; i += 1) await takeaway.press('Backspace');
    await takeaway.pressSequentially('effective');
    await expect(page.getByTestId(`wikilink-option-${SPOILER_SLUG}`)).toHaveCount(0);

    // Control: a non-spoiler note is still offered.
    for (let i = 0; i < 'effective'.length; i += 1) await takeaway.press('Backspace');
    await takeaway.pressSequentially('self-org');
    await expect(page.getByTestId('wikilink-option-self-organization-over-control')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('uuid routing: palette opens a shielded note at #/note/<uuid>; reveal swaps to the slug via replaceState (no new history entry)', async ({ page }) => {
    await demo(page);
    await page.keyboard.press('Control+k');
    await page.getByTestId('command-palette-input').fill('dreams');
    const item = page.getByTestId('command-palette').getByText('Shielded note · p. 15');
    await item.click();
    await expect(page.getByTestId('note-detail-view')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/note/note-effective-dreaming');
    await expectNoSecrets(page, 'uuid route');
    expect(await page.evaluate(() => window.location.href)).not.toContain(SPOILER_SLUG);
    expect(await page.getByTestId('note-detail-view').innerHTML()).not.toContain(SPOILER_SLUG);

    const historyBefore = await page.evaluate(() => history.length);
    await page.getByTestId(`spoiler-reveal-btn-${SPOILER_NOTE_ID}`).click();
    await expect(page.getByTestId('note-detail-title')).toHaveText('Burden of Effective Dreaming');
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#/note/${SPOILER_SLUG}`);
    expect(await page.evaluate(() => history.length)).toBe(historyBefore);
  });

  test('PracticeView: a shielded active delta shows only "Shielded note · p. 15" — no WHEN/DO/title; check-ins inert; Reveal shows it', async ({ page }) => {
    await demo(page);
    await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
      const n = state.notes.find((x: { id: string }) => x.id === 'note-effective-dreaming');
      n.status = 'atomic';
      n.deltaStatus = 'active';
      n.deltaTrigger = 'SECRET_TRIGGER_QA7';
      n.deltaAction = 'SECRET_ACTION_QA7';
      localStorage.setItem('pragya_demo_state_v1', JSON.stringify(state));
    });
    await page.reload();
    await page.getByTestId('nav-item-practice').click();
    const card = page.getByTestId('delta-card-note-effective-dreaming');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Shielded note · p. 15');
    const html = await page.content();
    for (const s of [...SECRET_TEXT, 'SECRET_TRIGGER_QA7', 'SECRET_ACTION_QA7', SPOILER_SLUG]) {
      expect(html.includes(s), `practice leaks ${s}`).toBe(false);
    }
    await expect(page.getByTestId('delta-apply-btn-note-effective-dreaming')).toHaveCount(0);
    await expect(page.getByTestId('delta-missed-btn-note-effective-dreaming')).toHaveCount(0);

    // Keys 1/2/3 on the focused shielded row must not log a check-in.
    const logsBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}').deltaLogs.length);
    await card.click({ position: { x: 5, y: 5 } });
    for (let i = 0; i < 6; i += 1) {
      const focused = await page.locator('[data-testid^="delta-card-"][data-focused="true"]').getAttribute('data-testid').catch(() => null);
      if (focused === 'delta-card-note-effective-dreaming') break;
      await page.keyboard.press('j');
    }
    for (const key of ['1', '2', '3']) await page.keyboard.press(key);
    await page.waitForTimeout(300);
    const logsAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}').deltaLogs.length);
    const focusedId = await page.locator('[data-testid^="delta-card-"][data-focused="true"]').getAttribute('data-testid').catch(() => null);
    if (focusedId === 'delta-card-note-effective-dreaming') expect(logsAfter).toBe(logsBefore);

    await page.getByTestId('delta-reveal-btn-note-effective-dreaming').click();
    await expect(card).toContainText('SECRET_TRIGGER_QA7');
    await expect(page.getByTestId('delta-apply-btn-note-effective-dreaming')).toBeVisible();
  });
});
