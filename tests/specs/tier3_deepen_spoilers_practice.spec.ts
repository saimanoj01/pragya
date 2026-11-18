import fs from 'node:fs';
import { test, expect } from '@playwright/test';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4nGP4z8DwHwwZGP6DAQBJyAn3FGMynQAAAABJRU5ErkJggg==';

test.describe('Tier 3 — BookDetail, Deepen/Edit, Lightbox, Practice & Snapshot Import', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('demo-login-btn').click();
    await expect(page.getByTestId('shelf-view')).toBeVisible();
  });

  test('BookDetailView: monotonic override guard, spoiler shield Space reveal, and Mark Finished unlocks fiction prediction', async ({
    page,
  }) => {
    // Open Thinking in Systems detail
    await page.getByText('Thinking in Systems: A Primer').click();
    await expect(page.getByTestId('book-detail-view')).toBeVisible();

    // Note at p. 210 (index 2, after p. 78 and p. 142) is shielded while bookmark is at p. 142
    await expect(page.getByTestId('spoiler-shield-paradigm-shifts-outrank-parameters')).toBeVisible();

    // J/K + Space reveals shielded note at index 2
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    await page.keyboard.press('Space');
    await expect(page.getByTestId('spoiler-shield-paradigm-shifts-outrank-parameters')).toBeHidden();
    await expect(page.getByTestId('note-card-paradigm-shifts-outrank-parameters')).toContainText(
      'shifting the unstated paradigm'
    );

    // Attempt backward bookmark move (100 < 142) without override -> rejected
    await page.getByTestId('book-detail-advance-input').fill('100');
    await page.getByTestId('book-detail-advance-btn').click();
    await expect(page.getByTestId('book-detail-view')).toContainText('p. 142 / 218');

    // Check manual override and reset to 90 -> accepted, shielding p. 142 note
    await page.getByTestId('manual-pos-override-checkbox').check();
    await page.getByTestId('book-detail-advance-input').fill('90');
    await page.getByTestId('book-detail-advance-btn').click();
    await expect(page.getByTestId('book-detail-view')).toContainText('p. 90 / 218');
    await expect(page.getByTestId('spoiler-shield-delays-in-feedback-loops')).toBeVisible();

    // Mark Thinking in Systems finished -> clears all spoiler shields on the book
    await page.getByTestId('mark-finished-btn').click();
    await expect(page.getByTestId('spoiler-shield-delays-in-feedback-loops')).toBeHidden();
    await expect(page.getByTestId('note-card-delays-in-feedback-loops')).toContainText(
      'Wait out the lag'
    );

    // Navigate back to Shelf and open Exhalation: Stories
    await page.getByTestId('back-to-shelf-btn').click();
    await page.getByText('Exhalation: Stories').click();
    await expect(page.getByTestId('book-detail-view')).toBeVisible();

    // Sealed prediction badge initially shown
    await expect(
      page.getByTestId('note-card-consciousness-and-thermal-equilibrium')
    ).toContainText('Sealed Prediction');

    // Mark Finished unlocks predictions and appears in Practice -> Unlocked Fiction Predictions
    await page.getByTestId('mark-finished-btn').click();
    await expect(
      page.getByTestId('note-card-consciousness-and-thermal-equilibrium')
    ).toContainText('Unlocked Prediction');

    await page.getByTestId('nav-item-practice').click();
    await expect(page.getByTestId('unlocked-predictions-section')).toContainText(
      'thermal equilibrium'
    );
  });

  test('NoteDetailView: Socratic Recovery Banner, Deepen with [[ autocomplete, Backlinks, Lightbox & Focus Guard', async ({
    page,
  }) => {
    // Capture a note with an image first to test ImageLightbox & EditNoteModal focus guard
    await page.keyboard.press('n');
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    await page.getByTestId('capture-takeaway-input').fill('Visual model for lightbox test.');
    await page.getByTestId('capture-photo-input').setInputFiles({
      name: 'diagram.png',
      mimeType: 'image/png',
      buffer: Buffer.from(TINY_PNG_BASE64, 'base64'),
    });
    await expect(page.getByTestId('capture-attachment-list').locator('img')).toHaveAttribute(
      'src',
      /^blob:/
    );
    await page.getByTestId('capture-submit-btn').click();
    await expect(page.getByTestId('quick-capture-modal')).toBeHidden();

    // Open that captured note to test click / Space / Escape lightbox
    await page.getByTestId('nav-item-notes').click();
    await page
      .getByTestId('note-card-visual-model-for-lightbox-test')
      .getByRole('button', { name: /VIEW NOTE/i })
      .click();
    await expect(page.getByTestId('note-detail-view')).toBeVisible();

    await page.locator('[data-testid^="attachment-image-"]').first().click();
    await expect(page.getByTestId('image-lightbox')).toBeVisible();
    // Escape closes ONLY lightbox (remains on NoteDetailView)
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('image-lightbox')).toBeHidden();
    await expect(page.getByTestId('note-detail-view')).toBeVisible();

    // Space toggles lightbox on NoteDetailView
    await page.keyboard.press('Space');
    await expect(page.getByTestId('image-lightbox')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('image-lightbox')).toBeHidden();

    // EditNoteModal focus guard: typing "ndeg123r" inside EditNoteModal input does not trigger shortcuts
    await page.getByTestId('edit-note-btn').click();
    await expect(page.getByTestId('edit-note-modal')).toBeVisible();
    await page.getByTestId('edit-note-title-input').fill('');
    await page.getByTestId('edit-note-title-input').pressSequentially('Lightbox ndeg123r');
    await expect(page.getByTestId('edit-note-modal')).toBeVisible();
    await expect(page.getByTestId('quick-capture-modal')).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toContain(
      '#/note/visual-model-for-lightbox-test'
    );
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('edit-note-modal')).toBeHidden();

    // Go to Socratic in-reflection note (#/note/memory-prism-digital-remembrance)
    await page.getByTestId('back-to-notes-btn').click();
    await page
      .getByTestId('note-card-memory-prism-digital-remembrance')
      .getByRole('button', { name: /VIEW NOTE/i })
      .click();
    await expect(page.getByTestId('socratic-recovery-banner')).toBeVisible();
    await expect(page.getByTestId('socratic-recovery-banner')).toContainText(
      'forgiving reinterpretation'
    );

    // Open DeepenNoteModal via 'D' shortcut
    await page.keyboard.press('d');
    await expect(page.getByTestId('deepen-note-modal')).toBeVisible();

    // Focus guard: typing "ndeg123r" inside Deepen input does NOT open Capture or navigate
    await page.getByTestId('deepen-title-input').fill('');
    await page.getByTestId('deepen-title-input').pressSequentially('Memory Prism ndeg123r');
    await expect(page.getByTestId('deepen-note-modal')).toBeVisible();
    await expect(page.getByTestId('quick-capture-modal')).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(
      '#/note/memory-prism-digital-remembrance'
    );

    // Test [[wikilink]] autocomplete inside deepen-context-input, including Escape dismiss without closing modal
    const contextInput = page.getByTestId('deepen-context-input');
    await contextInput.click();
    await contextInput.pressSequentially('Contrast archival memory with [[');
    await expect(page.getByTestId('wikilink-autocomplete')).toBeVisible();
    await expect(
      page.getByTestId('wikilink-option-memory-prism-digital-remembrance')
    ).toHaveCount(0);

    // Escape closes ONLY autocomplete popover, keeping DeepenNoteModal open
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('wikilink-autocomplete')).toBeHidden();
    await expect(page.getByTestId('deepen-note-modal')).toBeVisible();

    // Start a fresh [[ token and select delays-in-feedback-loops
    await contextInput.fill('Contrast archival memory with ');
    await contextInput.pressSequentially('[[delays');
    await expect(page.getByTestId('wikilink-autocomplete')).toBeVisible();
    await page.getByTestId('wikilink-option-delays-in-feedback-loops').click();
    await expect(contextInput).toHaveValue(/\[\[delays-in-feedback-loops\]\]/);

    // Enter WHEN/DO with accidental duplicate prefixes & include a self-link in critique to verify self-exclusion
    // CD Batch 2 (C4.5): on a fiction note with no delta yet, the Behavioral Delta section
    // starts collapsed — open it first (same fields, same assertions).
    await page.getByTestId('deepen-delta-details').locator('summary').click();
    await page.getByTestId('deepen-trigger-input').fill('WHEN WHEN reviewing an old conflict');
    await page.getByTestId('deepen-action-input').fill('DO DO separate intent from transcript');
    await page.getByTestId('deepen-delta-status-select').selectOption('active');
    await page
      .getByTestId('deepen-critique-input')
      .fill('Fails in legal/audit compliance. Compare [[memory-prism-digital-remembrance]].');
    await page.getByTestId('deepen-submit-btn').click();

    await expect(page.getByTestId('deepen-note-modal')).toBeHidden();
    await expect(page.getByTestId('note-detail-view')).toContainText('atomic');
    const detailText = await page.getByTestId('note-detail-view').innerText();
    expect(detailText).not.toContain('WHEN WHEN');
    expect(detailText).not.toContain('DO DO');
    // Self-link must not produce a self-backlink on the current note
    await expect(
      page.getByTestId('backlink-item-memory-prism-digital-remembrance')
    ).toHaveCount(0);

    // Click wikilink chip -> target note shows Backlink (and excludes self-links)
    await page.getByTestId('wikilink-chip-delays-in-feedback-loops').click();
    await expect(page.getByTestId('backlinks-section')).toBeVisible();
    await expect(page.getByTestId('backlink-item-memory-prism-digital-remembrance')).toBeVisible();
    await expect(
      page.getByTestId('backlink-item-delays-in-feedback-loops')
    ).toHaveCount(0);
  });

  test('PracticeView: 1/2/3 check-ins, Missed Trigger edit, <=5 Active Delta cap, Takeaway Shuffle & JSON Snapshot Import', async ({
    page,
  }) => {
    await page.getByTestId('nav-item-practice').click();
    await expect(page.getByTestId('practice-view')).toBeVisible();
    await expect(page.getByTestId('active-deltas-count')).toHaveText('2/5');

    // Focus guard inside QuickCaptureModal triggered from PracticeView
    await page.keyboard.press('n');
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    await page.getByTestId('capture-takeaway-input').pressSequentially('ndeg123r');
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/practice');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('quick-capture-modal')).toBeHidden();

    // Keyboard '1' logs Applied on first active delta; button logs Applied on second delta
    await page.keyboard.press('1');
    await expect(page.getByTestId('delta-card-note-delays-feedback')).toContainText('2 applied');
    await page.getByTestId('delta-apply-btn-note-playing-boundaries').click();
    await expect(page.getByTestId('delta-card-note-playing-boundaries')).toContainText('2 applied');

    // Keyboard '2' opens Missed Trigger inline editor on first delta; check focus guard in trigger input
    await page.keyboard.press('2');
    const trigInput = page.getByTestId('delta-trigger-edit-input-note-delays-feedback');
    await expect(trigInput).toBeVisible();
    await trigInput.fill('');
    await trigInput.pressSequentially('ndeg123r');
    await expect(page.getByTestId('quick-capture-modal')).toBeHidden();
    await expect(trigInput).toHaveValue('ndeg123r');

    // Click Missed Trigger (2) button as well and save normalized WHEN trigger
    await page.getByTestId('delta-missed-btn-note-delays-feedback').click();
    await trigInput.fill('WHEN WHEN deploy graphs dip unexpectedly');
    await page.getByTestId('delta-trigger-save-btn-note-delays-feedback').click();
    await expect(trigInput).toBeHidden();
    const cardText = await page.getByTestId('delta-card-note-delays-feedback').innerText();
    expect(cardText).toContain('deploy graphs dip unexpectedly');
    expect(cardText).not.toContain('WHEN WHEN');

    // Keyboard '3' and button log Didn't Come Up (no-trigger)
    const beforeNoTriggerCount = await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
      return (raw.deltaLogs || []).filter(
        (l: { outcome?: string }) => l.outcome === 'no-trigger'
      ).length;
    });
    await page.keyboard.press('3');
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
          return (raw.deltaLogs || []).filter(
            (l: { outcome?: string }) => l.outcome === 'no-trigger'
          ).length;
        })
      )
      .toBe(beforeNoTriggerCount + 1);
    // CD Batch 2 (decisions OQ-5, replaces the old "two same-day check-ins append two rows"
    // contract): check-ins coalesce per note per local day. Pressing the already-pressed
    // Didn't Come Up (3) is a no-op — still one no-trigger row, and exactly ONE row today
    // for this note after Applied → Missed → Didn't Come Up.
    const notrigger = page.getByTestId('delta-notrigger-btn-note-delays-feedback');
    await expect(notrigger).toHaveAttribute('aria-pressed', 'true');
    await notrigger.click();
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
      const d = new Date();
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const logs = (raw.deltaLogs || []) as { outcome?: string; noteId?: string; date?: string }[];
      return {
        noTrigger: logs.filter(l => l.outcome === 'no-trigger').length,
        todayForNote: logs.filter(l => l.noteId === 'note-delays-feedback' && l.date === today).length,
      };
    });
    expect(after.noTrigger).toBe(beforeNoTriggerCount + 1);
    expect(after.todayForNote).toBe(1);

    // Export current snapshot via Practice Export JSON button & verify valid JSON schema
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('export-json-btn').click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const exportedJson = JSON.parse(fs.readFileSync(downloadPath!, 'utf-8')) as {
      version: number;
      books: unknown[];
      notes: unknown[];
    };
    expect(exportedJson.version).toBe(1);
    expect(exportedJson.books.length).toBeGreaterThanOrEqual(4);

    // Corrupted / invalid JSON import must be rejected without opening ImportConfirmModal
    await page.getByTestId('import-json-input').setInputFiles({
      name: 'corrupt.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{not valid json', 'utf-8'),
    });
    await expect(page.getByTestId('import-confirm-modal')).toBeHidden();
    await expect(page.getByText(/Invalid snapshot JSON/i)).toBeVisible();

    // Test Takeaway Shuffle Mark Reviewed removes card for today AND persists across reload
    const firstShuffle = page.locator('[data-testid^="shuffle-card-"]').first();
    const firstShuffleTestId = await firstShuffle.getAttribute('data-testid');
    const slug = firstShuffleTestId!.replace('shuffle-card-', '');
    await page.getByTestId(`shuffle-review-btn-${slug}`).click();
    await expect(page.getByTestId(`shuffle-card-${slug}`)).toBeHidden();
    await page.reload();
    await expect(page.getByTestId('practice-view')).toBeVisible();
    await expect(page.getByTestId(`shuffle-card-${slug}`)).toBeHidden();

    // Pause -> Reactivate, and Graduate -> Reactivate lifecycle
    await page.getByTestId('delta-pause-btn-note-playing-boundaries').click();
    await expect(page.getByTestId('active-deltas-count')).toHaveText('1/5');
    await page.getByTestId('delta-reactivate-btn-note-playing-boundaries').click();
    await expect(page.getByTestId('active-deltas-count')).toHaveText('2/5');

    await page.getByTestId('delta-graduate-btn-note-playing-boundaries').click();
    await expect(page.getByTestId('active-deltas-count')).toHaveText('1/5');
    await page.getByTestId('delta-reactivate-btn-note-playing-boundaries').click();
    await expect(page.getByTestId('active-deltas-count')).toHaveText('2/5');

    // Seed 5 active deltas via snapshot import and verify 6th reactivation is blocked!
    const snapshotWithFiveActive = await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
      const notes = raw.notes || [];
      const updatedNotes = notes.map((n: Record<string, unknown>, idx: number) => {
        if (idx < 5) {
          return {
            ...n,
            deltaStatus: 'active',
            deltaTrigger: `trigger ${idx + 1}`,
            deltaAction: `action ${idx + 1}`,
          };
        }
        if (idx === 5) {
          return {
            ...n,
            deltaStatus: 'paused',
            deltaTrigger: 'paused trigger 6',
            deltaAction: 'paused action 6',
          };
        }
        return { ...n, deltaStatus: 'none' };
      });
      return JSON.stringify({
        version: 1,
        exportedAt: new Date().toISOString(),
        books: raw.books || [],
        notes: updatedNotes,
        sessions: raw.sessions || [],
        deltaLogs: raw.deltaLogs || [],
      });
    });

    await page.getByTestId('import-json-input').setInputFiles({
      name: 'five-active-snapshot.json',
      mimeType: 'application/json',
      buffer: Buffer.from(snapshotWithFiveActive, 'utf-8'),
    });
    await expect(page.getByTestId('import-confirm-modal')).toBeVisible();
    await page.getByTestId('import-confirm-btn').click();
    await expect(page.getByTestId('import-confirm-modal')).toBeHidden();

    await expect(page.getByTestId('active-deltas-count')).toHaveText('5/5');

    // Attempt to reactivate the 6th paused delta -> blocked with cap warning!
    await page.locator('[data-testid^="delta-reactivate-btn-"]').first().click();
    await expect(page.getByTestId('deepen-delta-cap-warning')).toBeVisible();
    await expect(page.getByTestId('active-deltas-count')).toHaveText('5/5');

    // Also verify DeepenNoteModal enforces the 5/5 cap warning
    await page.getByTestId('nav-item-notes').click();
    await page
      .getByTestId('note-card-rules-of-infinite-play')
      .getByRole('button', { name: /VIEW NOTE/i })
      .click();
    await page.getByTestId('deepen-note-btn').click();
    await expect(page.getByTestId('deepen-note-modal')).toBeVisible();
    await page.getByTestId('deepen-delta-status-select').selectOption('active');
    await expect(page.getByTestId('deepen-delta-cap-warning')).toBeVisible();
    await page.getByTestId('deepen-submit-btn').click();
    await expect(page.getByTestId('deepen-note-modal')).toBeVisible();
  });

  test('Mobile 390x844 layout: BookDetailView, NoteDetailView & PracticeView have zero horizontal overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    // BookDetailView on mobile
    await page.getByText('Thinking in Systems: A Primer').click();
    await expect(page.getByTestId('book-detail-view')).toBeVisible();
    const bookOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(bookOverflow.scrollWidth).toBeLessThanOrEqual(bookOverflow.innerWidth);

    // NoteDetailView (atomic note with wikilinks, attachments & backlinks) on mobile
    await page
      .getByTestId('note-card-delays-in-feedback-loops')
      .getByRole('button', { name: /View Note/i })
      .click();
    await expect(page.getByTestId('note-detail-view')).toBeVisible();
    const noteOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(noteOverflow.scrollWidth).toBeLessThanOrEqual(noteOverflow.innerWidth);

    // NoteDetailView (in-reflection with Socratic Recovery Banner) on mobile
    await page.evaluate(() => {
      window.location.hash = '#/note/memory-prism-digital-remembrance';
    });
    await expect(page.getByTestId('socratic-recovery-banner')).toBeVisible();
    const socraticOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(socraticOverflow.scrollWidth).toBeLessThanOrEqual(socraticOverflow.innerWidth);

    // PracticeView on mobile
    await page.getByTestId('bottom-nav-practice').click();
    await expect(page.getByTestId('practice-view')).toBeVisible();
    const practiceOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(practiceOverflow.scrollWidth).toBeLessThanOrEqual(practiceOverflow.innerWidth);
  });
});
