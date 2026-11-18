import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4nGP4z8DwHwwZGP6DAQBJyAn3FGMynQAAAABJRU5ErkJggg==';

test.describe('Tier 6 — M5 Daily Flow, Mobile Ergonomics, Undo & Command Palette', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('demo-login-btn').click();
    await expect(page.getByTestId('shelf-view')).toBeVisible();
  });

  test('M5.1 & M5.2 & M5.6 Mobile (390x844): touch targets >=44px, bottom-sheet capture, Kindle paste chip, empty-shelf CTA & mobile Command Palette', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    // 1. Mobile ShelfView touch targets >= 44px and zero horizontal overflow
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);

    const targets = await page.evaluate(() => {
      const selectors = [
        '[data-testid="advance-10p-btn-book-systems"]',
        '[data-testid="advance-exact-input-book-systems"]',
        '[data-testid="advance-exact-btn-book-systems"]',
        '[data-testid="book-capture-btn-book-systems"]',
        ...Array.from(document.querySelectorAll('button[aria-label^="Edit "]')).map(
          el => `button[aria-label="${el.getAttribute('aria-label')}"]`
        ),
      ];
      return selectors.map(sel => {
        const el = document.querySelector(sel);
        if (!el) return { sel, width: 0, height: 0 };
        const rect = el.getBoundingClientRect();
        return { sel, width: rect.width, height: rect.height };
      });
    });
    expect(targets.length).toBeGreaterThanOrEqual(6);
    for (const t of targets) {
      expect(t.height, `${t.sel} height >= 44px on mobile`).toBeGreaterThanOrEqual(44);
      expect(t.width, `${t.sel} width >= 44px on mobile`).toBeGreaterThanOrEqual(44);
    }
    await expect(page.getByText('Reading Activity (Last 30 Days)')).toBeVisible();

    // Select-on-focus: focusing advance-exact-input selects "142" so typing "150" replaces instead of appending "142150"
    const exactInput = page.getByTestId('advance-exact-input-book-systems');
    await exactInput.focus();
    await page.keyboard.type('150');
    await expect(exactInput).toHaveValue('150');
    await exactInput.fill('142');

    // 2. Context-aware focus: clicking book card Capture focuses takeaway textarea;
    //    mobile QuickCapture renders as bottom-docked sheet with sticky footer
    await page.getByTestId('book-capture-btn-book-systems').click();
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    await expect(page.getByTestId('capture-takeaway-input')).toBeFocused();
    await expect(page.getByTestId('capture-sticky-footer')).toBeVisible();

    const sheetBox = await page.evaluate(() => {
      const dlg = document.querySelector('[data-testid="quick-capture-modal"]');
      const panel = dlg?.firstElementChild;
      const rect = panel?.getBoundingClientRect();
      return rect ? { bottom: rect.bottom, innerHeight: window.innerHeight, width: rect.width } : null;
    });
    expect(sheetBox).not.toBeNull();
    expect(sheetBox!.bottom).toBeGreaterThanOrEqual(sheetBox!.innerHeight - 4);
    expect(sheetBox!.width).toBeGreaterThanOrEqual(385);

    // 3. Kindle paste smart position extraction chip fills Position on 1-tap apply,
    //    and editing quote to match current pos clears any stale chip cleanly.
    //    CD Batch 2 (C4.4 unit guard): this book tracks PAGES, so a Location hint now shows
    //    the mismatch chip (no Apply) instead of offering to put 1423 into a page field; the
    //    Apply path is exercised with a Page hint.
    await page
      .getByTestId('capture-quote-input')
      .fill('Your Highlight on Location 1423-1425 | Added on Nov 16');
    await expect(page.getByTestId('kindle-unit-mismatch-chip')).toContainText(
      'Detected Location 1423 — this book tracks pages.'
    );
    await expect(page.getByTestId('kindle-pos-apply-btn')).toHaveCount(0);
    await page
      .getByTestId('capture-quote-input')
      .fill('Your Highlight on Page 142 | Added on Nov 16');
    await expect(page.getByTestId('kindle-pos-chip')).toHaveCount(0);
    await expect(page.getByTestId('kindle-unit-mismatch-chip')).toHaveCount(0);
    await page
      .getByTestId('capture-quote-input')
      .fill('Your Highlight on Page 150 | Added on Nov 16');
    await expect(page.getByTestId('kindle-pos-chip')).toBeVisible();
    await page.getByTestId('kindle-pos-apply-btn').click();
    await expect(page.getByTestId('capture-pos-input')).toHaveValue('150');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('quick-capture-modal')).toBeHidden();

    // 4. Mobile BottomNav More drawer -> Search & Commands opens CommandPalette
    await page.getByTestId('bottom-nav-more').click();
    await expect(page.getByTestId('mobile-more-drawer')).toBeVisible();
    await page.getByTestId('drawer-search-btn').click();
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await expect(page.getByTestId('command-palette-group-actions')).toBeVisible();
    await expect(page.getByTestId('command-palette-group-views')).toBeVisible();
    await expect(page.getByTestId('command-palette-group-books')).toBeVisible();
    await expect(page.getByTestId('command-palette-group-notes')).toBeVisible();
    await page.getByTestId('command-palette-input').fill('Exhalation');
    await expect(page.getByTestId('command-palette-group-books')).toBeVisible();
    await expect(page.getByTestId('command-palette-group-actions')).toHaveCount(0);
    await expect(page.getByTestId('command-palette-group-views')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('command-palette')).toBeHidden();

    // 5. Empty shelf: import 0-book snapshot -> Shelf shows actionable empty CTA,
    //    and QuickCapture shows inline Add Your First Book CTA
    await page.getByTestId('bottom-nav-more').click();
    await page.getByTestId('drawer-nav-settings').click();
    await expect(page.getByTestId('settings-view')).toBeVisible();

    await page.locator('input[type="file"]').setInputFiles({
      name: 'empty-shelf.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          version: 1,
          exportedAt: '2026-11-16T00:00:00Z',
          books: [],
          notes: [],
          sessions: [],
          deltaLogs: [],
        })
      ),
    });
    await expect(page.getByTestId('import-confirm-modal')).toBeVisible();
    await page.getByTestId('import-confirm-btn').click();

    await page.getByTestId('bottom-nav-shelf').click();
    await expect(page.getByTestId('empty-now-reading-cta')).toBeVisible();
    await expect(page.getByTestId('empty-shelf-add-book-btn')).toBeVisible();

    await page.getByTestId('bottom-nav-capture').click();
    await expect(page.getByTestId('capture-empty-shelf')).toBeVisible();
    await page.getByTestId('capture-empty-add-book-btn').click();
    await expect(page.getByTestId('add-book-modal')).toBeVisible();
  });

  test('M5.2: Unit-aware +5% / +50 loc quick advance & paused->reading transition', async ({
    page,
  }) => {
    // Seed a percent book (reading) and a loc book (paused) via snapshot import
    await page.getByTestId('nav-item-settings').click();
    await page.locator('input[type="file"]').setInputFiles({
      name: 'unit-books.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          version: 1,
          exportedAt: '2026-11-16T00:00:00Z',
          books: [
            {
              id: 'book-pct',
              title: 'Percent Audio Book',
              author: 'Reader',
              format: 'audiobook',
              kind: 'nonfiction',
              status: 'reading',
              currentPos: 20,
              totalPos: 100,
              posUnit: 'percent',
              normalizedPos: 0.2,
              docUrl: '',
              meta: { startedAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-15T00:00:00Z' },
            },
            {
              id: 'book-loc-paused',
              title: 'Paused Kindle Book',
              author: 'Author',
              format: 'kindle',
              kind: 'fiction',
              status: 'paused',
              currentPos: 100,
              totalPos: 2000,
              posUnit: 'loc',
              normalizedPos: 0.05,
              docUrl: '',
              meta: { updatedAt: '2026-11-14T00:00:00Z' },
            },
          ],
          notes: [],
          sessions: [],
          deltaLogs: [],
        })
      ),
    });
    await page.getByTestId('import-confirm-btn').click();
    await page.getByTestId('nav-item-shelf').click();

    await expect(page.getByTestId('advance-10p-btn-book-pct')).toHaveText('+5%');
    await page.getByTestId('advance-10p-btn-book-pct').click();
    await expect(page.getByTestId('book-card-book-pct')).toContainText('25%');

    // Open Paused Kindle Book -> verify +50 loc label & advancing transitions paused -> reading
    await page.getByText('Paused Kindle Book').click();
    await expect(page.getByTestId('book-detail-view')).toBeVisible();
    await expect(page.getByTestId('advance-10p-btn-book-loc-paused')).toHaveText('+50 loc');
    await page.getByTestId('advance-10p-btn-book-loc-paused').click();
    await expect(page.getByTestId('book-detail-view')).toContainText('loc 150 / 2000');
    await expect(page.getByTestId('book-detail-view')).toContainText('reading');

    // When Now Reading is empty while a Queued book exists, Shelf shows quick-start empty-shelf-start-{id}
    await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
      raw.books = raw.books.map((b: Record<string, unknown>) =>
        b.status === 'reading' ? { ...b, status: 'queued' } : b
      );
      localStorage.setItem('pragya_demo_state_v1', JSON.stringify(raw));
    });
    await page.reload();
    await page.getByTestId('nav-item-shelf').click();
    await expect(page.getByTestId('empty-now-reading-cta')).toBeVisible();
    await expect(page.getByTestId('empty-shelf-start-book-pct')).toBeVisible();
    await page.getByTestId('empty-shelf-start-book-pct').click();
    await expect(page.getByTestId('book-card-book-pct')).toBeVisible();
  });

  test('M5.3: DeepenNoteModal collapsible source reference with lightbox & Save Draft preserving status', async ({
    page,
  }) => {
    // Capture a fresh inbox note with quote + image
    await page.keyboard.press('n');
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    // Global N shortcut keeps capture-book-select default focus
    await expect(page.getByTestId('capture-book-select')).toBeFocused();
    await page.getByTestId('capture-quote-input').fill('Original source quote for deepening');
    await page.getByTestId('capture-takeaway-input').fill('Draft takeaway waiting for reflection');
    await page.getByTestId('capture-spar-checkbox').check();
    await page.getByTestId('capture-photo-input').setInputFiles({
      name: 'source-page.png',
      mimeType: 'image/png',
      buffer: Buffer.from(TINY_PNG_BASE64, 'base64'),
    });
    await expect(page.getByTestId('capture-attachment-list').locator('img')).toHaveAttribute(
      'src',
      /^blob:/
    );
    await page.getByTestId('capture-submit-btn').click();
    await expect(page.getByTestId('quick-capture-modal')).toBeHidden();

    // Open that note and open DeepenNoteModal
    await page.getByTestId('nav-item-notes').click();
    await page
      .locator('[data-testid^="note-card-"]', { hasText: 'Draft takeaway waiting for reflection' })
      .getByRole('button', { name: 'VIEW NOTE' })
      .click();
    await expect(page.getByTestId('note-detail-view')).toBeVisible();
    await page.getByTestId('deepen-note-btn').click();
    await expect(page.getByTestId('deepen-note-modal')).toBeVisible();

    // Source reference shows quote & clickable image thumbnail -> lightbox opens & Escape leaves DeepenNoteModal open
    await expect(page.getByTestId('deepen-source-reference')).toBeVisible();
    await expect(page.getByTestId('deepen-source-quote')).toContainText(
      'Original source quote for deepening'
    );
    await page.locator('[data-testid^="deepen-attachment-image-"]').click();
    await expect(page.getByTestId('image-lightbox')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('image-lightbox')).toBeHidden();
    await expect(page.getByTestId('deepen-note-modal')).toBeVisible();

    // Toggle source reference collapsed/expanded
    await page.getByTestId('deepen-source-toggle').click();
    await expect(page.getByTestId('deepen-source-quote')).toBeHidden();
    await page.getByTestId('deepen-source-toggle').click();
    await expect(page.getByTestId('deepen-source-quote')).toBeVisible();

    // Save Draft persists mechanism edits while keeping status = inbox (not forcing atomic)
    await page.getByTestId('deepen-context-input').fill('Half-baked mechanism draft');
    await page.getByTestId('deepen-save-draft-btn').click();
    await expect(page.getByTestId('deepen-note-modal')).toBeHidden();
    await expect(page.getByTestId('note-detail-view')).toContainText('Half-baked mechanism draft');
    await expect(page.getByTestId('note-detail-view')).toContainText('inbox');

    // Deepen again and click Save Atomic Note -> promotes to atomic
    await page.getByTestId('deepen-note-btn').click();
    await page.getByTestId('deepen-submit-btn').click();
    await expect(page.getByTestId('note-detail-view')).toContainText('atomic');

    // Save Draft on an in-reflection note preserves in-reflection status & socraticQuestions
    await page.evaluate(() => {
      window.location.hash = '#/note/memory-prism-digital-remembrance';
    });
    await expect(page.getByTestId('socratic-recovery-banner')).toBeVisible();
    await page.getByTestId('deepen-note-btn').click();
    await page.getByTestId('deepen-context-input').fill('Partial Socratic reflection draft');
    await page.getByTestId('deepen-save-draft-btn').click();
    await expect(page.getByTestId('deepen-note-modal')).toBeHidden();
    await expect(page.getByTestId('note-detail-view')).toContainText(/in-reflection/i);
    await expect(page.getByTestId('socratic-recovery-banner')).toBeVisible();
  });

  test('M5.4 & M5.5: PracticeView Checked-in-today badge, honest empty shuffle copy & compensating ToastAction Undo across flows', async ({
    page,
  }) => {
    // 1. ShelfView +10p Undo reverts both book position and created session count
    await expect(page.getByTestId('activity-count')).toContainText('11 sessions in the last 30 days');
    await page.getByTestId('advance-10p-btn-book-systems').click();
    await expect(page.getByTestId('book-card-book-systems')).toContainText('p. 152 / 218');
    await expect(page.getByTestId('activity-count')).toContainText('12 sessions in the last 30 days');
    await page
      .getByRole('status')
      .filter({ hasText: 'Updated "Thinking in Systems' })
      .getByTestId('toast-undo-btn')
      .click();
    await expect(page.getByTestId('book-card-book-systems')).toContainText('p. 142 / 218');
    await expect(page.getByTestId('activity-count')).toContainText('11 sessions in the last 30 days');

    // 1b. Coalesced ('updated' mode) Bookmark Undo supersedes stale per-book toast and reverts position without deleting session
    await page.getByTestId('advance-10p-btn-book-systems').click();
    await expect(page.getByTestId('activity-count')).toContainText('12 sessions in the last 30 days');
    await page.getByTestId('advance-exact-input-book-systems').fill('165');
    await page.getByTestId('advance-exact-btn-book-systems').click();
    await expect(page.getByTestId('book-card-book-systems')).toContainText('p. 165 / 218');
    await expect(page.getByRole('status').filter({ hasText: 'p. 152' })).toHaveCount(0);
    await page
      .getByRole('status')
      .filter({ hasText: 'p. 165' })
      .getByTestId('toast-undo-btn')
      .click();
    await expect(page.getByTestId('book-card-book-systems')).toContainText('p. 152 / 218');
    await expect(page.getByTestId('activity-count')).toContainText('12 sessions in the last 30 days');
    const latestSessionEndPos = await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
      const sysSessions = (raw.sessions || []).filter(
        (s: { bookId: string }) => s.bookId === 'book-systems'
      );
      return sysSessions[sysSessions.length - 1]?.endPos;
    });
    expect(latestSessionEndPos).toBe(152);

    // 2. BookDetailView Mark Finished Undo restores reading status & re-seals fiction prediction
    await page.getByText('Exhalation: Stories').click();
    await expect(page.getByTestId('book-detail-view')).toBeVisible();
    await expect(
      page.getByTestId('note-card-consciousness-and-thermal-equilibrium')
    ).toContainText('Sealed Prediction');
    await page.getByTestId('mark-finished-btn').click();
    await expect(
      page.getByTestId('note-card-consciousness-and-thermal-equilibrium')
    ).toContainText('Unlocked Prediction');
    await page
      .getByRole('status')
      .filter({ hasText: 'marked finished' })
      .getByTestId('toast-undo-btn')
      .click();
    await expect(
      page.getByTestId('note-card-consciousness-and-thermal-equilibrium')
    ).toContainText('Sealed Prediction');

    // 3. PracticeView: 1/2/3 check-ins (button & keyboard) add the Checked in today badge and
    //    keep 1/2/3 clickable. CD Batch 2 (decisions OQ-5 supersedes ENGINEERING_SPEC D3):
    //    check-in toasts now carry an Undo, and a second same-day check-in updates the row.
    await page.getByTestId('nav-item-practice').click();
    await expect(page.getByTestId('practice-view')).toBeVisible();

    await page.getByTestId('delta-apply-btn-note-delays-feedback').click();
    await expect(page.getByTestId('delta-checked-today-note-delays-feedback')).toBeVisible();
    const appliedToast = page.getByRole('status').filter({ hasText: 'Logged: Applied.' }).last();
    await expect(appliedToast).toBeVisible();
    await expect(appliedToast.getByTestId('toast-undo-btn')).toHaveCount(1);
    await expect(page.getByTestId('delta-apply-btn-note-delays-feedback')).toBeEnabled();

    await page.keyboard.press('3');
    const noTriggerToast = page
      .getByRole('status')
      .filter({ hasText: "Updated today's check-in to Didn't come up." })
      .last();
    await expect(noTriggerToast).toBeVisible();
    await expect(noTriggerToast.getByTestId('toast-undo-btn')).toHaveCount(1);

    // 4a. Pause delta -> Undo restores active delta
    await page.getByTestId('delta-pause-btn-note-delays-feedback').click();
    await expect(page.getByTestId('delta-card-note-delays-feedback')).toBeHidden();
    await page
      .getByRole('status')
      .filter({ hasText: 'Behavioral Delta paused' })
      .getByTestId('toast-undo-btn')
      .click();
    await expect(page.getByTestId('delta-card-note-delays-feedback')).toBeVisible();

    // 4b. Graduate delta -> Undo restores active delta (2/5)
    await page.getByTestId('delta-graduate-btn-note-playing-boundaries').click();
    await expect(page.getByTestId('active-deltas-count')).toHaveText('1/5');
    await page
      .getByRole('status')
      .filter({ hasText: 'Behavioral Delta graduated!' })
      .getByTestId('toast-undo-btn')
      .click();
    await expect(page.getByTestId('active-deltas-count')).toHaveText('2/5');

    // 5. Mark Reviewed on Shuffle -> Undo restores candidate; reviewing all shows "All eligible takeaways reviewed for today!"
    const shuffleReviewBtns = page.locator('[data-testid^="shuffle-review-btn-"]');
    await expect(shuffleReviewBtns.first()).toBeVisible();
    const firstBtnTestId = await shuffleReviewBtns.first().getAttribute('data-testid');
    expect(firstBtnTestId).toBeTruthy();
    await page.getByTestId(firstBtnTestId!).click();
    await expect(page.getByTestId(firstBtnTestId!)).toHaveCount(0);
    await page
      .getByRole('status')
      .filter({ hasText: 'Marked reviewed for today' })
      .getByTestId('toast-undo-btn')
      .click();
    await expect(page.getByTestId(firstBtnTestId!)).toBeVisible();

    // Review all eligible shuffle cards until empty -> honest "All eligible takeaways reviewed for today!" copy
    while ((await shuffleReviewBtns.count()) > 0) {
      await shuffleReviewBtns.first().click();
    }
    await expect(page.getByTestId('shuffle-empty-state')).toContainText(
      'All eligible takeaways reviewed for today!'
    );

    // 6. Import workspace with 0 eligible notes -> honest "No eligible notes yet" copy
    await page.getByTestId('nav-item-settings').click();
    await expect(page.getByTestId('settings-view')).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({
      name: 'no-shuffle-notes.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          version: 1,
          exportedAt: '2026-11-16T00:00:00Z',
          books: [
            {
              id: 'b-new',
              title: 'Fresh Book',
              author: 'Author',
              format: 'physical',
              kind: 'nonfiction',
              status: 'reading',
              currentPos: 20,
              totalPos: 100,
              posUnit: 'page',
              normalizedPos: 0.2,
              docUrl: '',
              meta: {},
            },
          ],
          notes: [
            {
              id: 'n-fresh',
              slug: 'fresh-note',
              bookId: 'b-new',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              pos: 10,
              normalizedPos: 0.1,
              status: 'saved',
              source: 'app',
              tags: [],
              quote: '',
              takeaway: 'Brand new note',
              contextMechanism: '',
              critique: '',
              deltaTrigger: '',
              deltaAction: '',
              deltaStatus: 'none',
              meta: {},
            },
          ],
          sessions: [],
          deltaLogs: [],
        })
      ),
    });
    await page.getByTestId('import-confirm-btn').click();
    await page.getByTestId('nav-item-practice').click();
    await expect(page.getByTestId('shuffle-empty-state')).toContainText(
      'No eligible notes yet'
    );
  });

  test('M5.7: CLI book-add -> progress -> capture --atomic snapshot imports and renders cleanly in Pragya PWA', async ({
    page,
  }) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pragya-m57-e2e-'));
    const snapPath = path.join(tmpDir, 'snapshot.json');
    const skillCli = path.resolve(
      process.cwd(),
      '.agents/skills/pragya-companion/scripts/pragya_cli.py'
    );

    try {
      fs.writeFileSync(
        snapPath,
        JSON.stringify({
          version: 1,
          exportedAt: '2026-11-16T00:00:00.000Z',
          books: [],
          notes: [],
          sessions: [],
          deltaLogs: [],
        }),
        'utf-8'
      );

      execFileSync(
        'python3',
        [
          skillCli,
          '--state-file',
          snapPath,
          'book-add',
          '--title',
          'The Art of Doing Science and Engineering',
          '--author',
          'Richard Hamming',
          '--total-pos',
          '360',
          '--pos-unit',
          'page',
        ],
        { encoding: 'utf-8' }
      );

      execFileSync(
        'python3',
        [
          skillCli,
          '--state-file',
          snapPath,
          'progress',
          '--book',
          'The Art of Doing Science',
          '--delta',
          '72',
          '--session-note',
          'First chapter style & courage',
        ],
        { encoding: 'utf-8' }
      );

      execFileSync(
        'python3',
        [
          skillCli,
          '--state-file',
          snapPath,
          'capture',
          '--book',
          'The Art of Doing Science',
          '--title',
          'First-Class Problems Over Busywork',
          '--takeaway',
          'Spend regular time thinking about the major problems of your field.',
          '--context',
          'Hamming contrasts career-defining open problems with incremental tinkering.',
          '--critique',
          'Requires honest discernment between truly important and merely prestigious.',
          '--trigger',
          'WHEN planning a new Monday sprint',
          '--action',
          'DO block 90 minutes for the hardest open problem first',
          '--delta-status',
          'active',
          '--tags',
          '#craft, #focus',
          '--atomic',
        ],
        { encoding: 'utf-8' }
      );

      const cliSnapshot = fs.readFileSync(snapPath, 'utf-8');
      await page.getByTestId('nav-item-settings').click();
      await expect(page.getByTestId('settings-view')).toBeVisible();
      await page.locator('input[type="file"]').setInputFiles({
        name: 'm57-cli-roundtrip.json',
        mimeType: 'application/json',
        buffer: Buffer.from(cliSnapshot, 'utf-8'),
      });
      await expect(page.getByTestId('import-confirm-modal')).toBeVisible();
      await page.getByTestId('import-confirm-btn').click();

      // Shelf reflects new book at p. 72 / 360 and 1 recorded session
      await page.getByTestId('nav-item-shelf').click();
      await expect(page.getByTestId('shelf-view')).toContainText(
        'The Art of Doing Science and Engineering'
      );
      await expect(page.getByTestId('shelf-view')).toContainText('p. 72 / 360');
      await expect(page.getByTestId('activity-count')).toContainText('1 session in the last 30 days');

      // NoteDetailView & PracticeView render clean single WHEN/DO without duplicate prefixes
      await page.getByTestId('nav-item-notes').click();
      await expect(
        page.getByTestId('note-card-first-class-problems-over-busywork')
      ).toContainText(/atomic/i);
      await page
        .getByTestId('note-card-first-class-problems-over-busywork')
        .getByRole('button', { name: 'VIEW NOTE' })
        .click();
      await expect(page.getByTestId('note-detail-view')).toContainText(
        'WHEN planning a new Monday sprint'
      );
      await expect(page.getByTestId('note-detail-view')).not.toContainText('WHEN WHEN');
      await expect(page.getByTestId('note-detail-view')).not.toContainText('DO DO');

      await page.getByTestId('nav-item-practice').click();
      await expect(page.getByTestId('active-deltas-count')).toContainText('1/5');
      await expect(page.getByTestId('practice-view')).toContainText(
        'DO block 90 minutes for the hardest open problem first'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
