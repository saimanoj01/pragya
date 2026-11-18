import { test, expect, type Page } from '@playwright/test';

/**
 * Tier 10 (Dev, CD Batch 3) — knowledge graph, search and book surfaces, Demo mode.
 * C3.1 inline [[wikilink]] chips (shield-safe hrefs, missing → capture-for-slug), C3.2
 * alias-only slug rename, C3.3 capture at the exact slug, C3.4 tokenized search + tag pills
 * + book filter + sort + URL state + Back restore, C3.5 touch autocomplete, C2.2 activity,
 * C2.3 sessions trail + session notes, C2.5 link chips, C2.6 https cover + Read Again.
 */

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

async function editState(page: Page, fn: string) {
  await page.evaluate(body => {
    const s = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
    new Function('s', body)(s);
    localStorage.setItem('pragya_demo_state_v1', JSON.stringify(s));
  }, fn);
  await page.reload();
  await expect(page.locator('[data-testid$="-view"]').first()).toBeVisible();
}

const toast = (page: Page, text: string) => page.locator('[data-sonner-toast]').filter({ hasText: text }).last();

test.describe('Tier 10 — CD Batch 3 graph, search & book surfaces (Dev)', () => {
  test('inline [[chips]]: live link navigates; shielded target uses its uuid route (no title); missing → capture at that exact slug', async ({ page }) => {
    await demo(page);
    await editState(
      page,
      `const n = s.notes.find(x => x.id === 'note-delays-feedback');
       n.contextMechanism = 'Also see [[effective-dreaming-ethics]] and [[feedback-loops-101]].';`
    );
    await go(page, '#/note/delays-in-feedback-loops');
    const live = page.getByTestId('inline-wikilink-playing-with-boundaries');
    await expect(live).toHaveText('[[playing-with-boundaries]]');
    await expect(live).toHaveAttribute('href', '#/note/playing-with-boundaries');

    const shielded = page.getByTestId('inline-wikilink-effective-dreaming-ethics');
    await expect(shielded).toHaveAttribute('href', '#/note/note-effective-dreaming');
    await expect(page.locator('body')).not.toContainText('Burden of Effective Dreaming');

    const missing = page.getByTestId('inline-wikilink-feedback-loops-101');
    await expect(missing).toContainText('(missing note)');
    await missing.click();
    await expect(page.getByTestId('note-detail-view')).toContainText('not found');
    await page.getByTestId('capture-for-slug-btn').click();
    await expect(page.getByTestId('capture-title-input')).toHaveValue('Feedback loops 101');
    await expect(page.getByTestId('capture-slug-hint')).toHaveText('This note will become [[feedback-loops-101]].');
    await page.getByTestId('capture-title-input').fill('Loop basics');
    await page.getByTestId('capture-takeaway-input').fill('Every loop has a delay.');
    await page.getByTestId('capture-submit-btn').click();
    await expect(page.getByTestId('note-detail-title')).toHaveText('Loop basics');
    const created = (await demoState(page)).notes.find(n => n.takeaway === 'Every loop has a delay.');
    expect(created?.slug).toBe('feedback-loops-101');
    // The original link is now a live chip.
    await go(page, '#/note/delays-in-feedback-loops');
    await expect(page.getByTestId('inline-wikilink-feedback-loops-101')).not.toContainText('(missing note)');
  });

  test('slug rename keeps the old slug as an alias: old route opens, old [[links]] count as backlinks', async ({ page }) => {
    await demo(page);
    await go(page, '#/note/playing-with-boundaries');
    await page.getByTestId('edit-note-btn').click();
    await page.getByTestId('edit-note-slug-input').fill('frame-the-game');
    await page.getByTestId('edit-note-submit-btn').click();
    await expect(toast(page, 'Renamed to [[frame-the-game]]. [[playing-with-boundaries]] still works.')).toBeVisible();
    const renamed = (await demoState(page)).notes.find(n => n.id === 'note-playing-boundaries') as Row & {
      slug: string;
      meta: { aliases?: string[] };
    };
    expect(renamed.slug).toBe('frame-the-game');
    expect(renamed.meta.aliases).toEqual(['playing-with-boundaries']);

    await go(page, '#/shelf');
    await go(page, '#/note/playing-with-boundaries');
    await expect(page.getByTestId('note-detail-title')).toBeVisible();
    await expect(page.getByTestId('backlinks-section')).toContainText('Referenced By (3)');
    await go(page, '#/note/delays-in-feedback-loops');
    await expect(page.getByTestId('inline-wikilink-playing-with-boundaries')).not.toContainText('(missing note)');
  });

  test('Notes: tokenized AND search, tag pills, book filter, sort, Filtered by + Clear all, URL sync, deep link, Back restores focus', async ({ page }) => {
    await demo(page);
    await page.getByTestId('nav-item-notes').click();
    const search = page.getByTestId('notes-search-input');
    // AND across Layer 2 fields (contextMechanism) + takeaway.
    await search.fill('lag outdated');
    await expect(page.getByTestId('note-card-delays-in-feedback-loops')).toBeVisible();
    await expect(page.locator('[data-testid^="note-card-"]')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/notes?q=lag+outdated');
    await search.fill('lag nothingmatches');
    await expect(page.getByText('No notes match these filters.')).toBeVisible();
    await search.fill('');

    // Tag pill toggles a filter shown in "Filtered by".
    await page.getByTestId('note-card-delays-in-feedback-loops').getByTestId('tag-pill-systems').click();
    await expect(page.getByTestId('notes-active-filters')).toContainText('#systems');
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/notes?tag=systems');
    const systemsCount = await page.locator('[data-testid^="note-card-"]').count();
    expect(systemsCount).toBeGreaterThan(0);
    await expect(page.getByTestId('notes-result-count')).toHaveText(`${systemsCount} ${systemsCount === 1 ? 'note' : 'notes'}`);

    // Book filter + sort.
    await page.getByTestId('notes-book-filter').selectOption('book-finite');
    await expect(page.locator('[data-testid^="note-card-"]')).toHaveCount(0);
    await page.getByTestId('notes-clear-filters-btn').click();
    await expect(page.getByTestId('notes-active-filters')).toHaveCount(0);
    await page.getByTestId('notes-book-filter').selectOption('book-finite');
    await page.getByTestId('notes-sort-select').selectOption('reading');
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/notes?book=book-finite&sort=reading');
    const order = await page.locator('[data-testid^="note-card-"]').evaluateAll(els => els.map(e => e.getAttribute('data-testid')));
    expect(order).toEqual(['note-card-playing-with-boundaries', 'note-card-rules-of-infinite-play']); // by position

    // Back restores the focused card.
    await page.keyboard.press('j');
    await page.locator('[data-testid="note-card-rules-of-infinite-play"] [data-view-note="true"]').click();
    await expect(page.getByTestId('note-detail-view')).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('notes-view')).toBeVisible();
    await expect(page.getByTestId('notes-sort-select')).toHaveValue('reading');
    await expect(page.locator('[data-testid="note-card-rules-of-infinite-play"] [data-view-note="true"]')).toBeFocused();
    await expect(page.getByTestId('note-card-rules-of-infinite-play')).toHaveAttribute('data-focused', 'true');

    // Deep link hydrates the controls.
    await go(page, '#/shelf');
    await go(page, '#/notes?tag=%23systems&q=loop');
    await expect(page.getByTestId('notes-search-input')).toHaveValue('loop');
    await expect(page.getByTestId('notes-active-filters')).toContainText('#systems');
  });

  test('Concepts includes hub notes; spoiler-safe search never matches hidden Layer 2 fields', async ({ page }) => {
    await demo(page);
    await editState(
      page,
      `const n = s.notes.find(x => x.id === 'note-effective-dreaming'); n.deltaTrigger = 'zebrafinch'; n.tags = ['#fiction'];
       const hub = s.notes.find(x => x.id === 'note-memory-prism'); hub.takeaway = 'Plain takeaway.';
       s.notes.find(x => x.id === 'note-thermal-equilibrium').takeaway = 'Builds on [[memory-prism-digital-remembrance]].';`
    );
    await page.getByTestId('nav-item-notes').click();
    await page.getByTestId('notes-filter-concepts').click();
    // memory-prism links nowhere itself, but is linked TO → hub.
    await expect(page.getByTestId('note-card-memory-prism-digital-remembrance')).toBeVisible();
    await page.getByTestId('notes-filter-all').click();
    await page.getByTestId('notes-search-input').fill('zebrafinch');
    await expect(page.locator('[data-testid^="note-card-"]')).toHaveCount(0);
    await expect(page.getByTestId('notes-spoiler-search-footnote')).toBeVisible();
  });

  test('Shelf: 30-day counter + weighted dots; sessions trail note; post-advance session note; link chips; https cover; Read Again', async ({ page }) => {
    await demo(page);
    await expect(page.getByTestId('activity-count')).toHaveText('11 sessions in the last 30 days');
    await expect(page.getByTestId('activity-dot-29')).toHaveAttribute('data-level', /[0-3]/);

    await editState(
      page,
      `const b = s.books.find(x => x.id === 'book-systems'); b.meta.coverUrl = 'https://example.invalid/cover.jpg';
       s.books.find(x => x.id === 'book-finite').meta.coverUrl = 'http://insecure.dev/c.jpg';
       const n = s.notes.find(x => x.id === 'note-self-organization'); n.meta.links = [...(n.meta.links || []), 'https://www.fs.blog/mental-models/'];`
    );
    // Cover: https URL renders an <img> (which then disappears on load error, never a broken icon).
    await go(page, '#/book/book-finite');
    await expect(page.getByTestId('book-cover-img')).toHaveCount(0); // http is never rendered

    // Sessions trail: collapsed, newest first, add a note.
    await go(page, '#/book/book-systems');
    const trail = page.getByTestId('sessions-trail');
    await expect(trail).not.toHaveAttribute('open', '');
    await trail.locator('summary').click();
    const firstRow = trail.locator('[data-testid^="session-row-"]').first();
    const rowId = ((await firstRow.getAttribute('data-testid')) || '').replace('session-row-', '');
    const add = page.getByTestId(`session-note-add-btn-${rowId}`);
    if (await add.count()) {
      await add.click();
    } else {
      await page.getByTestId(`session-note-edit-btn-${rowId}`).click();
    }
    await page.getByTestId(`session-note-input-${rowId}`).fill('Delays explain the oscillation.');
    await page.getByTestId(`session-note-input-${rowId}`).press('Enter');
    await expect(toast(page, 'Session note saved.')).toBeVisible();
    await expect(firstRow).toContainText('Delays explain the oscillation.');
    const sess = (await demoState(page)).sessions.find(x => x.id === rowId)!;
    expect(sess.note).toBe('Delays explain the oscillation.');

    // Post-advance: one tertiary button, bound to the session just written.
    await page.getByTestId('advance-10p-btn-book-systems').click();
    await page.getByTestId('post-advance-session-note-btn').click();
    const input = page.locator('[data-testid^="session-note-input-"]').last();
    await input.fill('Hit the stocks-and-flows chapter.');
    await input.press('Enter');
    await expect(page.getByTestId('post-advance-session-note-btn')).toHaveCount(0);
    const latest = (await demoState(page)).sessions.filter(x => x.bookId === 'book-systems' && x.note === 'Hit the stocks-and-flows chapter.');
    expect(latest).toHaveLength(1);

    // Link chips on NoteDetail (deduped, labelled host+path).
    await go(page, '#/note/self-organization-over-control');
    await expect(page.getByText('Attachments & Links')).toBeVisible();
    await expect(page.locator('[data-testid^="note-link-chip-"]').filter({ hasText: 'fs.blog/mental-models/' })).toHaveAttribute(
      'aria-label',
      'Open link https://www.fs.blog/mental-models/'
    );

    // Read Again on a finished book: confirm → reading at 0, Re-reading badge, capstone kept.
    await go(page, '#/book/book-finite');
    await page.getByTestId('read-again-btn').click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('Start "Finite and Infinite Games" again?');
    await page.getByTestId('confirm-dialog-confirm-btn').click();
    await expect(page.getByTestId('rereading-badge')).toBeVisible();
    const b = (await demoState(page)).books.find(x => x.id === 'book-finite')! as Row & {
      status: string;
      currentPos: number;
      meta: { everFinished?: boolean; finishedAt?: string };
    };
    expect(b.status).toBe('reading');
    expect(b.currentPos).toBe(0);
    expect(b.meta.everFinished).toBe(true);
    expect(b.meta.finishedAt).toBeTruthy();
    // Shields off on a re-read: notes past the (reset) bookmark stay readable.
    await expect(page.locator('[data-testid^="spoiler-shield-"]')).toHaveCount(0);
  });
});

test.describe('Tier 10 — CD Batch 3 fix-up', () => {
  test('R2#1: explicit slug collision / bad format blocks Save with an inline error; blur normalizes', async ({ page }) => {
    await demo(page);
    await go(page, '#/note/playing-with-boundaries');
    await page.getByTestId('edit-note-btn').click();
    const input = page.getByTestId('edit-note-slug-input');
    await input.fill('delays-in-feedback-loops');
    await page.getByTestId('edit-note-submit-btn').click();
    await expect(page.getByTestId('edit-note-slug-error')).toHaveText('Another note already uses [[delays-in-feedback-loops]].');
    await expect(page.getByTestId('edit-note-modal')).toBeVisible();
    expect((await demoState(page)).notes.find(n => n.id === 'note-playing-boundaries')?.slug).toBe('playing-with-boundaries');
    await input.fill('🔥');
    await page.getByTestId('edit-note-submit-btn').click();
    await expect(page.getByTestId('edit-note-slug-error')).toHaveText('Use lowercase letters, numbers, and hyphens.');
    await input.fill('Frame The Game');
    await input.blur();
    await expect(input).toHaveValue('frame-the-game');
    await expect(page.getByTestId('edit-note-slug-error')).toHaveCount(0);
  });

  test('R1#2: EditBook status finished → reading marks everFinished; R1#1: a session note keeps a fresher endPos written elsewhere', async ({ page }) => {
    await demo(page);
    await go(page, '#/book/book-finite');
    await page.getByTestId('book-detail-view').getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByTestId('edit-book-modal').locator('select').filter({ has: page.locator('option[value="reading"]') }).first().selectOption('reading');
    await page.getByTestId('edit-book-submit-btn').click();
    await expect(page.getByTestId('edit-book-modal')).toBeHidden();
    const b = (await demoState(page)).books.find(x => x.id === 'book-finite') as Row & { meta: { everFinished?: boolean } };
    expect(b.meta.everFinished).toBe(true);
    await expect(page.getByTestId('rereading-badge')).toBeVisible();

    await go(page, '#/book/book-systems');
    await page.getByTestId('sessions-trail').locator('summary').click();
    const row = page.getByTestId('sessions-trail').locator('[data-testid^="session-row-"]').first();
    const id = ((await row.getAttribute('data-testid')) || '').replace('session-row-', '');
    // Another device advances this session's endPos without this tab knowing.
    await page.evaluate(sid => {
      const st = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
      const se = st.sessions.find((x: { id: string }) => x.id === sid);
      se.endPos = 999;
      se.updatedAt = '2099-01-01T00:00:00.000Z';
      localStorage.setItem('pragya_demo_state_v1', JSON.stringify(st));
    }, id);
    const add = page.getByTestId(`session-note-add-btn-${id}`);
    if (await add.count()) await add.click();
    else await page.getByTestId(`session-note-edit-btn-${id}`).click();
    await page.getByTestId(`session-note-input-${id}`).fill('Only the note changes.');
    await page.getByTestId(`session-note-input-${id}`).press('Enter');
    await expect(toast(page, 'Session note saved.')).toBeVisible();
    const se = (await demoState(page)).sessions.find(x => x.id === id)!;
    expect(se).toMatchObject({ note: 'Only the note changes.', endPos: 999, updatedAt: '2099-01-01T00:00:00.000Z' });
  });
});

test.describe('Tier 10 — CD Batch 3 touch autocomplete', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test('C3.5: tapping a [[ suggestion selects it before the textarea blurs', async ({ page }) => {
    await demo(page);
    await page.getByTestId('bottom-nav-capture').tap();
    await page.getByTestId('capture-book-select').selectOption('book-systems');
    const takeaway = page.getByTestId('capture-takeaway-input');
    await takeaway.tap();
    await takeaway.pressSequentially('See [[self-org');
    await page.getByTestId('wikilink-option-self-organization-over-control').tap();
    await expect(takeaway).toHaveValue('See [[self-organization-over-control]]');
  });
});

test.describe('Tier 10 — CD Batch 3 follow-up R2-a (legacy slugs)', () => {
  test('a note slugged under the old ASCII rule (caf-culture) still resolves from [[Café culture]]', async ({ page }) => {
    await demo(page);
    await editState(
      page,
      `s.notes.find(x => x.id === 'note-playing-boundaries').slug = 'caf-culture';
       s.notes.find(x => x.id === 'note-delays-feedback').contextMechanism = 'See [[Café culture]].';`
    );
    await go(page, '#/note/delays-in-feedback-loops');
    const chip = page.getByTestId('inline-wikilink-cafe-culture');
    await expect(chip).toHaveText('[[Café culture]]');
    await expect(chip).toHaveAttribute('href', '#/note/caf-culture');
    const related = page.getByTestId('wikilink-chip-cafe-culture');
    await expect(related).not.toContainText('(missing)');
    await related.click();
    await expect(page).toHaveURL(/#\/note\/caf-culture$/);
    await expect(page.getByTestId('backlink-item-delays-in-feedback-loops')).toBeVisible();
  });
});
