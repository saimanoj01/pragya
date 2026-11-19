import { test, expect, type Page } from '@playwright/test';

/**
 * Tier 11 (QA, CD Batch 5 — Refactor A: Modal Dedup & Component Extraction)
 * Adversarial end-to-end verification across extracted shared hooks/components:
 * - `useModalDraft`: instant Escape synchronous flush, attachment ref persistence,
 *   C3.3 `initialSlug` missing-wikilink draft isolation, `Save & Next` swap handoff,
 *   `isNoteDraftStale` auto-clear, and `Discard` reset.
 * - `AttachmentManager`: 3/3 cap, `isTextPasteTarget` URL paste guard (text input vs modal
 *   control), and verbatim preservation of interleaved unknown + >3rd attachments on edit.
 * - `DeltaFieldsSection`: fiction collapsed vs auto-expanded on existing delta, 5-active-delta
 *   cap ignoring archived notes, and WHEN/DO prefix normalization (`Do not` preserved).
 * - `WikilinkTextarea`: all 7 textarea sites across 3 modals, mid-sentence caret restoration,
 *   and `⌘/Ctrl+Enter` form submit while popup is open.
 * - `PromptFallbackModal` + `useCopyPrompt`: all 4 copy sites + nested `Escape` layering when
 *   `PromptFallbackModal` opens on top of `CapstoneModal`.
 * - Regression checks for QA-42, QA-43, and R1#2 / R2-1 foreign-book capture draft safety.
 */

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

async function patch(page: Page, fn: string) {
  await page.evaluate(src => {
    const s = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
    new Function('s', src)(s);
    localStorage.setItem('pragya_demo_state_v1', JSON.stringify(s));
  }, fn);
  await page.reload();
  await expect(page.locator('[data-testid$="-view"]').first()).toBeVisible();
}

test.describe('Tier 11 — CD Batch 5 QA adversarial refactor probes', () => {
  test('useModalDraft capture torture: synchronous Escape flush, attachment ref restore, [[slug]] isolation & Discard', async ({
    page,
  }) => {
    await demo(page);

    // 1. Open QuickCaptureModal, enter takeaway + attach a Link, then press Escape immediately (<50ms)
    await page.keyboard.press('n');
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    await page.getByTestId('capture-takeaway-input').fill('Keep feedback delays visible');
    await page.getByTestId('capture-attach-link-btn').click();
    await page.getByTestId('capture-attachment-url-input').fill('https://architecture.example.org/delays');
    await page.getByTestId('capture-attachment-confirm-btn').click();
    await expect(page.getByTestId('capture-attachment-list')).toContainText('architecture.example.org');

    // Immediate Escape before the 250ms debounce fires proves synchronous close flush
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('quick-capture-modal')).toBeHidden();

    const rawSaved = await page.evaluate(() =>
      localStorage.getItem('pragya_draft:demo:pragya_draft_capture_v1')
    );
    expect(rawSaved).toBeTruthy();

    // 2. Navigate to a missing [[slug]] route and open Capture Note for [[missing-concept-cd5]]
    await go(page, '#/note/missing-concept-cd5');
    await expect(page.getByTestId('capture-for-slug-btn')).toBeVisible();
    await page.getByTestId('capture-for-slug-btn').click();
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();

    // Must NOT restore or display the normal QuickCapture draft
    await expect(page.getByTestId('draft-restored-banner')).toBeHidden();
    await expect(page.getByTestId('capture-takeaway-input')).toHaveValue('');
    await expect(page.getByTestId('capture-title-input')).toHaveValue('Missing concept cd5');

    // Type inside disabled initialSlug session and press Escape -> normal draft stays untouched
    await page.getByTestId('capture-takeaway-input').fill('Temporary slug thought');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('quick-capture-modal')).toBeHidden();

    // Reopen capture-for-slug, submit it -> markSubmitted while disabled MUST NOT clear normal draft
    await page.getByTestId('capture-for-slug-btn').click();
    await page.getByTestId('capture-takeaway-input').fill('Saved missing concept note');
    await page.getByTestId('capture-submit-btn').click();
    await expect(page.getByTestId('quick-capture-modal')).toBeHidden();

    const stillSavedAfterSlugSubmit = await page.evaluate(() =>
      localStorage.getItem('pragya_draft:demo:pragya_draft_capture_v1')
    );
    expect(stillSavedAfterSlugSubmit).toBeTruthy();

    // 3. Open normal QuickCaptureModal -> original draft + 1 attachment restores cleanly, then Discard clears it
    await go(page, '#/notes');
    await page.getByTestId('notes-quick-capture-btn').click();
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    await expect(page.getByTestId('draft-restored-banner')).toContainText(
      'Restored your unsaved draft (with 1 attachment).'
    );
    await expect(page.getByTestId('capture-takeaway-input')).toHaveValue(
      'Keep feedback delays visible'
    );
    await expect(page.getByTestId('capture-attachment-list')).toContainText('architecture.example.org');

    await page.getByTestId('draft-discard-btn').click();
    await expect(page.getByTestId('draft-restored-banner')).toBeHidden();
    await expect(page.getByTestId('capture-takeaway-input')).toHaveValue('');
    const afterDiscard = await page.evaluate(() =>
      localStorage.getItem('pragya_draft:demo:pragya_draft_capture_v1')
    );
    expect(afterDiscard).toBeNull();
  });

  test('useModalDraft DeepenNoteModal: Save & Next swap handoff, synchronous Escape flush, and stale draft auto-clear', async ({
    page,
  }) => {
    await demo(page);
    await patch(
      page,
      `
      // Keep only two deterministic inbox notes so Save & Next order (oldest first) is exact
      s.notes.forEach(n => { n.status = 'atomic'; });
      s.notes.push(
        {
          id: 'inbox-cd5-1',
          slug: 'inbox-cd5-first',
          bookId: 'book-systems',
          pos: 20,
          normalizedPos: 0.1,
          quote: 'First raw passage',
          takeaway: 'First raw takeaway',
          status: 'inbox',
          tags: ['systems'],
          contextMechanism: '',
          critique: '',
          deltaTrigger: '',
          deltaAction: '',
          deltaStatus: 'none',
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-01T00:00:00.000Z',
          meta: { title: 'First Inbox' },
        },
        {
          id: 'inbox-cd5-2',
          slug: 'inbox-cd5-second',
          bookId: 'book-systems',
          pos: 30,
          normalizedPos: 0.15,
          quote: 'Second raw passage',
          takeaway: 'Second raw takeaway',
          status: 'inbox',
          tags: ['systems'],
          contextMechanism: '',
          critique: '',
          deltaTrigger: '',
          deltaAction: '',
          deltaStatus: 'none',
          createdAt: '2026-11-02T00:00:00.000Z',
          updatedAt: '2026-11-02T00:00:00.000Z',
          meta: { title: 'Second Inbox' },
        }
      );
      `
    );

    // Pre-stage an unsaved Deepen draft on inbox-cd5-2 via instant Escape flush
    await go(page, '#/note/inbox-cd5-second');
    await page.getByTestId('deepen-note-btn').click();
    await expect(page.getByTestId('deepen-note-modal')).toBeVisible();
    await page.getByTestId('deepen-title-input').fill('Second Distilled Draft');
    await page.getByTestId('deepen-takeaway-input').fill('Drafted second takeaway v1');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('deepen-note-modal')).toBeHidden();

    // Now open inbox-cd5-1, edit it, and click Save & Next
    await go(page, '#/note/inbox-cd5-first');
    await page.getByTestId('deepen-note-btn').click();
    await expect(page.getByTestId('deepen-note-modal')).toBeVisible();
    await page.getByTestId('deepen-takeaway-input').fill('First distilled atomic takeaway');
    await page.getByTestId('deepen-save-next-btn').click();

    // Modal stays open, swaps to inbox-cd5-2, restores inbox-cd5-2's draft, and clears inbox-cd5-1's draft!
    await expect(page.getByTestId('deepen-note-modal')).toBeVisible();
    await expect(page.getByTestId('draft-restored-banner')).toBeVisible();
    await expect(page.getByTestId('deepen-title-input')).toHaveValue('Second Distilled Draft');
    await expect(page.getByTestId('deepen-takeaway-input')).toHaveValue('Drafted second takeaway v1');
    await expect(page.getByTestId('deepen-title-input')).toBeFocused();

    const firstDraftAfterSaveNext = await page.evaluate(() =>
      localStorage.getItem('pragya_draft:demo:pragya_draft_deepen_inbox-cd5-1')
    );
    expect(firstDraftAfterSaveNext).toBeNull();

    // Edit inbox-cd5-2 further and immediately press Escape -> synchronous flush updates draft
    await page.getByTestId('deepen-takeaway-input').fill('Drafted second takeaway v2');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('deepen-note-modal')).toBeHidden();

    // Advance inbox-cd5-2.updatedAt remotely -> reopening auto-clears the stale draft
    await patch(
      page,
      `
      const n2 = s.notes.find(n => n.id === 'inbox-cd5-2');
      n2.updatedAt = '2026-11-19T00:00:00.000Z';
      `
    );
    await go(page, '#/note/inbox-cd5-second');
    await page.getByTestId('deepen-note-btn').click();
    await expect(page.getByTestId('deepen-note-modal')).toBeVisible();
    await expect(page.getByTestId('draft-restored-banner')).toBeHidden();
    await expect(page.getByTestId('deepen-takeaway-input')).toHaveValue('Second raw takeaway');

    const clearedStaleDraft = await page.evaluate(() =>
      localStorage.getItem('pragya_draft:demo:pragya_draft_deepen_inbox-cd5-2')
    );
    expect(clearedStaleDraft).toBeNull();
  });

  test('AttachmentManager E2E: 3/3 cap, text-vs-modal URL paste guard, and verbatim preservation of unknown & >3rd attachments', async ({
    page,
  }) => {
    await demo(page);
    await patch(
      page,
      `
      const target = s.notes.find(n => n.bookId === 'book-systems');
      target.slug = 'att-torture-cd5';
      target.meta = {
        ...(target.meta || {}),
        title: 'Attachment Torture',
        attachments: [
          { id: 'unk-0', type: 'future-audio', blobId: 'aud-99' },
          { id: 'val-1', type: 'link', title: 'First Link', url: 'https://example.com/1' },
          { id: 'unk-2', type: 'future-sketch', strokes: 12 },
          { id: 'val-2', type: 'link', title: 'Second Link', url: 'https://example.com/2' },
          { id: 'val-3', type: 'doc', docId: 'doc-3', title: 'Third Doc', url: 'https://docs.google.com/document/d/doc-3/edit' },
          { id: 'val-4', type: 'link', title: 'Fourth Overflow Link', url: 'https://example.com/4' },
        ],
      };
      `
    );

    await go(page, '#/note/att-torture-cd5');
    await page.getByTestId('edit-note-btn').click();
    const modal = page.getByTestId('edit-note-modal');
    await expect(modal).toBeVisible();

    const photoBtn = modal.getByRole('button', { name: 'Photo', exact: true });
    const docBtn = modal.getByRole('button', { name: 'Doc', exact: true });
    const linkBtn = modal.getByRole('button', { name: 'Link', exact: true });

    // 3/3 cap disables all three add buttons
    await expect(photoBtn).toBeDisabled();
    await expect(docBtn).toBeDisabled();
    await expect(linkBtn).toBeDisabled();

    // Remove val-2 -> drops to 2/3 and re-enables buttons
    await modal.getByRole('button', { name: 'Remove Second Link' }).click();
    await expect(linkBtn).toBeEnabled();

    // Paste a URL while focused inside a text control -> must NOT create an attachment chip
    await page.getByTestId('edit-note-takeaway-input').focus();
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'https://text-input-paste.example.org/ignored');
      document.activeElement?.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      );
    });
    await expect(modal).not.toContainText('text-input-paste.example.org');

    // Paste a URL while focused on a non-text control inside the modal (`select`) -> creates chip!
    await page.getByTestId('edit-note-status-select').focus();
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'https://modal-paste.example.org/attached');
      document.activeElement?.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      );
    });
    await expect(modal).toContainText('modal-paste.example.org');
    await expect(linkBtn).toBeDisabled();

    // Save Changes and verify raw stored attachments kept unk-0, unk-2, and val-4 verbatim in order
    await page.getByTestId('edit-note-submit-btn').click();
    await expect(modal).toBeHidden();

    const savedAttachments = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
      return s.notes.find((n: { slug: string }) => n.slug === 'att-torture-cd5')?.meta?.attachments;
    });
    expect(savedAttachments).toHaveLength(6);
    expect(savedAttachments[0]).toEqual({ id: 'unk-0', type: 'future-audio', blobId: 'aud-99' });
    expect(savedAttachments[1]).toMatchObject({ id: 'val-1', title: 'First Link' });
    expect(savedAttachments[2]).toEqual({ id: 'unk-2', type: 'future-sketch', strokes: 12 });
    expect(savedAttachments[3]).toMatchObject({ id: 'val-3', title: 'Third Doc' });
    expect(savedAttachments[4]).toEqual({
      id: 'val-4',
      type: 'link',
      title: 'Fourth Overflow Link',
      url: 'https://example.com/4',
    });
    expect(savedAttachments[5]).toMatchObject({
      type: 'link',
      title: 'modal-paste.example.org',
      url: 'https://modal-paste.example.org/attached',
    });
  });

  test('DeltaFieldsSection E2E: fiction collapse vs auto-open, 5-active-delta cap ignoring archived notes, and WHEN/DO normalization', async ({
    page,
  }) => {
    await demo(page);
    await patch(
      page,
      `
      // Reset deltas so we have exactly 4 live active + 2 archived active deltas
      s.notes.forEach(n => { n.deltaStatus = 'none'; n.deltaTrigger = ''; n.deltaAction = ''; });
      for (let i = 1; i <= 6; i += 1) {
        const isArch = i > 4;
        s.notes.push({
          id: 'delta-seed-' + i,
          slug: 'delta-seed-' + i,
          bookId: 'book-systems',
          pos: i * 5,
          normalizedPos: 0.05,
          quote: '',
          takeaway: 'Delta seed ' + i,
          status: 'atomic',
          tags: [],
          contextMechanism: '',
          critique: '',
          deltaTrigger: 'trigger ' + i,
          deltaAction: 'action ' + i,
          deltaStatus: 'active',
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-01T00:00:00.000Z',
          meta: isArch ? { title: 'Seed ' + i, archivedAt: '2026-11-05T00:00:00.000Z' } : { title: 'Seed ' + i },
        });
      }
      // Make book-exhalation finished so no spoiler shield blocks editing
      const fic = s.books.find(b => b.id === 'book-exhalation');
      fic.status = 'finished';
      fic.currentPos = fic.totalPos;
      fic.normalizedPos = 1;
      s.notes.push(
        {
          id: 'fic-empty-delta',
          slug: 'fic-empty-delta',
          bookId: 'book-exhalation',
          pos: 10,
          normalizedPos: 0.1,
          quote: 'A quiet breath',
          takeaway: 'Notice the silence',
          status: 'inbox',
          tags: [],
          contextMechanism: '',
          critique: '',
          deltaTrigger: '',
          deltaAction: '',
          deltaStatus: 'none',
          createdAt: '2026-11-03T00:00:00.000Z',
          updatedAt: '2026-11-03T00:00:00.000Z',
          meta: { title: 'Empty Fiction Delta' },
        },
        {
          id: 'fic-has-delta',
          slug: 'fic-has-delta',
          bookId: 'book-exhalation',
          pos: 20,
          normalizedPos: 0.2,
          quote: 'Memory inscriptions',
          takeaway: 'Write immediately',
          status: 'inbox',
          tags: [],
          contextMechanism: '',
          critique: '',
          deltaTrigger: 'finishing a chapter',
          deltaAction: 'jot one line',
          deltaStatus: 'paused',
          createdAt: '2026-11-04T00:00:00.000Z',
          updatedAt: '2026-11-04T00:00:00.000Z',
          meta: { title: 'Existing Fiction Delta' },
        }
      );
      `
    );

    // 1. Fiction note without delta starts collapsed; archived active deltas are ignored (4/5 -> allowed!)
    await go(page, '#/note/fic-empty-delta');
    await page.getByTestId('deepen-note-btn').click();
    const details = page.getByTestId('deepen-delta-details');
    await expect(details).toBeVisible();
    await expect(details).not.toHaveJSProperty('open', true);

    await details.locator('summary').click();
    await expect(details).toHaveJSProperty('open', true);
    await expect(page.getByTestId('deepen-delta-cap-warning')).toBeHidden();

    await page.getByTestId('deepen-trigger-input').fill('WHEN: when drafting dialogue');
    await page.getByTestId('deepen-action-input').fill('DO: Do not explain the subtext');
    await page.getByTestId('deepen-delta-status-select').selectOption('active');
    await expect(page.getByTestId('deepen-delta-cap-warning')).toBeHidden();
    await page.getByTestId('deepen-submit-btn').click();
    await expect(page.getByTestId('deepen-note-modal')).toBeHidden();

    const normalizedSaved = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
      const n = s.notes.find((x: { id: string }) => x.id === 'fic-empty-delta');
      return { trigger: n.deltaTrigger, action: n.deltaAction, status: n.deltaStatus };
    });
    expect(normalizedSaved).toEqual({
      trigger: 'drafting dialogue',
      action: 'Do not explain the subtext',
      status: 'active',
    });

    // 2. Now live active count is 5/5! Fiction note WITH existing delta auto-expands & blocks activating a 6th
    await go(page, '#/note/fic-has-delta');
    await page.getByTestId('deepen-note-btn').click();
    await expect(page.getByTestId('deepen-delta-details')).toHaveJSProperty('open', true);
    await expect(page.getByTestId('deepen-delta-details')).toContainText(
      '5/5 active delta slots are full'
    );
    await page.getByTestId('deepen-delta-status-select').selectOption('active');
    await expect(page.getByTestId('deepen-delta-cap-warning')).toBeVisible();
  });

  test('WikilinkTextarea across all 7 sites: mid-sentence caret restoration & Cmd/Ctrl+Enter submit while popup open', async ({
    page,
  }) => {
    await demo(page);
    await patch(
      page,
      `
      s.notes.push({
        id: 'wiki-target-cd5',
        slug: 'feedback-loops-cd5',
        bookId: 'book-systems',
        pos: 12,
        normalizedPos: 0.05,
        quote: '',
        takeaway: 'Target concept',
        status: 'atomic',
        tags: [],
        contextMechanism: '',
        critique: '',
        deltaTrigger: '',
        deltaAction: '',
        deltaStatus: 'none',
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
        meta: { title: 'Feedback Loops CD5' },
      });
      const editable = s.notes.find(n => n.bookId === 'book-systems' && n.id !== 'wiki-target-cd5');
      editable.slug = 'wiki-host-cd5';
      `
    );

    // Site 1: QuickCaptureModal (`capture-takeaway-input`)
    await page.keyboard.press('n');
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    await page.getByTestId('capture-takeaway-input').click();
    await page.keyboard.type('See [[feedback-loops-cd5');
    await expect(page.getByTestId('wikilink-option-feedback-loops-cd5')).toBeVisible();
    await page.keyboard.press('Escape'); // dismiss popup
    await page.getByTestId('quick-capture-modal').getByRole('button', { name: 'Close' }).click();
    await page.evaluate(() => localStorage.removeItem('pragya_draft:demo:pragya_draft_capture_v1'));

    // Sites 2-4: DeepenNoteModal (`deepen-takeaway-input`, `deepen-context-input`, `deepen-critique-input`)
    await go(page, '#/note/wiki-host-cd5');
    await page.getByTestId('deepen-note-btn').click();
    for (const tid of ['deepen-takeaway-input', 'deepen-context-input', 'deepen-critique-input']) {
      const box = page.getByTestId(tid);
      await box.click();
      await box.fill('');
      await page.keyboard.type('[[feedback-loops-cd5');
      await expect(page.getByTestId('wikilink-option-feedback-loops-cd5')).toBeVisible();
      await page.keyboard.press('Escape');
    }
    await page.getByTestId('deepen-note-modal').getByRole('button', { name: 'Close' }).click();

    // Sites 5-7: EditNoteModal (`edit-note-takeaway-input`, `edit-note-context-input`, `edit-note-critique-input`)
    await page.getByTestId('edit-note-btn').click();
    for (const tid of ['edit-note-takeaway-input', 'edit-note-critique-input']) {
      const box = page.getByTestId(tid);
      await box.click();
      await box.fill('');
      await page.keyboard.type('[[feedback-loops-cd5');
      await expect(page.getByTestId('wikilink-option-feedback-loops-cd5')).toBeVisible();
      await page.keyboard.press('Escape');
    }

    // Mid-sentence selection caret check on `edit-note-context-input`
    const ctxBox = page.getByTestId('edit-note-context-input');
    await ctxBox.fill('Before  after');
    await ctxBox.focus();
    await ctxBox.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(7, 7));
    await page.keyboard.type('[[feedback-loops-cd5');
    await expect(page.getByTestId('wikilink-option-feedback-loops-cd5')).toBeVisible();
    await page.keyboard.press('Enter');

    await expect(ctxBox).toHaveValue('Before [[feedback-loops-cd5]] after');
    const caretAfterSelect = await ctxBox.evaluate((el: HTMLTextAreaElement) => el.selectionStart);
    expect(caretAfterSelect).toBe('Before [[feedback-loops-cd5]]'.length);

    // Open popup again at end of text, then press ControlOrMeta+Enter -> must submit form, NOT pick option!
    await ctxBox.evaluate((el: HTMLTextAreaElement) => {
      el.setSelectionRange(el.value.length, el.value.length);
    });
    await page.keyboard.type(' [[feedback-loops');
    await expect(page.getByTestId('wikilink-option-feedback-loops-cd5')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+Enter');

    await expect(page.getByTestId('edit-note-modal')).toBeHidden();
    const savedCtx = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
      return s.notes.find((n: { slug: string }) => n.slug === 'wiki-host-cd5')?.contextMechanism;
    });
    expect(savedCtx).toBe('Before [[feedback-loops-cd5]] after [[feedback-loops');
  });

  test('PromptFallbackModal + useCopyPrompt across all 4 copy sites and nested Escape layering inside CapstoneModal', async ({
    page,
  }) => {
    // Force clipboard failure on every navigation so fallback modal always opens
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: () => Promise.reject(new Error('Clipboard blocked by QA')),
        },
      });
      document.execCommand = () => false;
    });

    await demo(page);
    await patch(
      page,
      `
      const b = s.books.find(x => x.id === 'book-exhalation');
      b.status = 'finished';
      b.currentPos = b.totalPos;
      b.normalizedPos = 1;
      b.meta = { ...(b.meta || {}), finishedAt: '2026-11-10T00:00:00.000Z' };
      delete b.meta.capstone;
      const pred = s.notes.find(n => n.bookId === 'book-exhalation');
      pred.id = 'pred-cd5-1';
      pred.slug = 'pred-cd5-slug';
      pred.meta = { ...(pred.meta || {}), isPrediction: true };
      `
    );

    // Site 1: BookDetailView (`CapstoneSection` -> `capstone-prompt-fallback-modal`)
    await go(page, '#/book/book-exhalation');
    await page.getByTestId('copy-capstone-prompt-btn').click();
    await expect(page.getByTestId('capstone-prompt-fallback-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('capstone-prompt-fallback-modal')).toBeHidden();

    // Site 2: CapstoneModal (`capstone-modal-copy-prompt-btn` -> nested `capstone-prompt-fallback-modal`)
    await page.getByTestId('capstone-write-btn').click();
    await expect(page.getByTestId('capstone-modal')).toBeVisible();
    await page.getByTestId('capstone-arc-input').fill('Memory shapes identity across substrates.');
    await page.getByTestId('capstone-modal-copy-prompt-btn').click();
    await expect(page.getByTestId('capstone-prompt-fallback-modal')).toBeVisible();

    // First Escape closes ONLY the top PromptFallbackModal; CapstoneModal + its draft text remain intact
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('capstone-prompt-fallback-modal')).toBeHidden();
    await expect(page.getByTestId('capstone-modal')).toBeVisible();
    await expect(page.getByTestId('capstone-arc-input')).toHaveValue(
      'Memory shapes identity across substrates.'
    );

    // Second Escape closes CapstoneModal and synchronously flushes its draft
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('capstone-modal')).toBeHidden();
    await page.getByTestId('capstone-write-btn').click();
    await expect(page.getByTestId('draft-restored-banner')).toBeVisible();
    await expect(page.getByTestId('capstone-arc-input')).toHaveValue(
      'Memory shapes identity across substrates.'
    );
    await page.keyboard.press('Escape');

    // Site 3: NoteDetailView (`copy-sparring-prompt-btn` -> `sparring-prompt-fallback-modal`)
    await go(page, '#/note/pred-cd5-slug');
    await page.getByTestId('copy-sparring-prompt-btn').click();
    await expect(page.getByTestId('sparring-prompt-fallback-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('sparring-prompt-fallback-modal')).toBeHidden();

    // Site 4: PracticeView (`copy-prediction-prompt-btn-pred-cd5-1` -> `sparring-prompt-fallback-modal`)
    await go(page, '#/practice');
    await page.getByTestId('copy-prediction-prompt-btn-pred-cd5-1').click();
    await expect(page.getByTestId('sparring-prompt-fallback-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('sparring-prompt-fallback-modal')).toBeHidden();
  });

  test('QA-42: DeepenNoteModal draft restore on fiction note auto-expands Behavioral Delta disclosure when draft contains delta edits', async ({
    page,
  }) => {
    await demo(page);
    await patch(
      page,
      `
      const fic = s.books.find(b => b.id === 'book-exhalation');
      fic.status = 'finished';
      fic.currentPos = fic.totalPos;
      fic.normalizedPos = 1;
      const fn = s.notes.find(n => n.bookId === 'book-exhalation');
      fn.slug = 'qa42-fiction-note';
      fn.deltaTrigger = '';
      fn.deltaAction = '';
      fn.deltaStatus = 'none';
      `
    );

    await go(page, '#/note/qa42-fiction-note');
    await page.getByTestId('deepen-note-btn').click();
    const details = page.getByTestId('deepen-delta-details');
    await expect(details).toBeVisible();
    await details.locator('summary').click();
    await expect(details).toHaveJSProperty('open', true);

    await page.getByTestId('deepen-trigger-input').fill('when rushing through a twist');
    await page.getByTestId('deepen-action-input').fill('pause to note setup clues');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('deepen-note-modal')).toBeHidden();

    // Reopen DeepenNoteModal -> draft restores, and delta details MUST be open so restored edits are visible
    await page.getByTestId('deepen-note-btn').click();
    await expect(page.getByTestId('draft-restored-banner')).toBeVisible();
    const isOpenAfterRestore = await page
      .getByTestId('deepen-delta-details')
      .evaluate((el: HTMLDetailsElement) => el.open);
    expect(isOpenAfterRestore).toBe(true);

    // R2-2: Discard resets fields to canonical AND collapses fiction delta details back to canonical closed state
    await page.getByTestId('draft-discard-btn').click();
    await expect(page.getByTestId('draft-restored-banner')).toBeHidden();
    const isOpenAfterDiscard = await page
      .getByTestId('deepen-delta-details')
      .evaluate((el: HTMLDetailsElement) => el.open);
    expect(isOpenAfterDiscard).toBe(false);
  });

  test('QA-43: pressing Enter inside AttachmentManager URL or title input attaches the link instead of implicitly submitting the note modal', async ({
    page,
  }) => {
    await demo(page);
    const firstNoteSlug = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
      return s.notes.find((n: { bookId: string }) => n.bookId === 'book-systems')?.slug;
    });

    await go(page, `#/note/${firstNoteSlug}`);
    await page.getByTestId('edit-note-btn').click();
    const modal = page.getByTestId('edit-note-modal');
    await expect(modal).toBeVisible();

    await modal.getByRole('button', { name: 'Link', exact: true }).click();
    const urlInput = modal.getByLabel('Attachment URL');
    await expect(urlInput).toBeVisible();
    await urlInput.fill('https://papers.example.org/meadows');
    await urlInput.press('Enter');

    // Modal must stay open and attach the link chip rather than submitting & closing without the link
    await expect(modal).toBeVisible({ timeout: 1000 });
    await expect(modal).toContainText('papers.example.org', { timeout: 1000 });
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();

    // R1#2 / R2-1: opening another book's explicit New Note button and pressing Escape untouched keeps Book A's capture draft
    await go(page, '#/book/book-systems');
    await page.getByRole('button', { name: 'New Note' }).click();
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    await page.getByTestId('capture-takeaway-input').fill('Book A unsaved draft');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('quick-capture-modal')).toBeHidden();

    await go(page, '#/book/book-exhalation');
    await page.getByRole('button', { name: 'New Note' }).click();
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    await expect(page.getByTestId('draft-restored-banner')).toBeHidden();
    await page.waitForTimeout(300); // > 250ms debounce window
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('quick-capture-modal')).toBeHidden();

    await go(page, '#/book/book-systems');
    await page.getByRole('button', { name: 'New Note' }).click();
    await expect(page.getByTestId('draft-restored-banner')).toBeVisible();
    await expect(page.getByTestId('capture-takeaway-input')).toHaveValue('Book A unsaved draft');
  });

  test('BookDetailView extractions (BookChapterLine + BookBookmarkBar + BookNoteCard), image paste & WikilinkTextarea touch ghost-click guard', async ({
    page,
  }) => {
    await demo(page);
    await patch(
      page,
      `
      const b = s.books.find(x => x.id === 'book-systems');
      b.meta = { ...(b.meta || {}), currentChapter: 'Ch. 1: The Basics', customForeignKey: 'keep-me-cd5' };
      `
    );

    // 1. BookChapterLine inline edit: Enter saves chapter & preserves foreign book.meta keys via ownedMetaKeys
    await go(page, '#/book/book-systems');
    await expect(page.getByTestId('book-detail-view')).toBeVisible();
    await page.getByTestId('book-detail-chapter-change-btn').click();
    const chInput = page.getByTestId('book-detail-chapter-input');
    await expect(chInput).toBeVisible();
    await chInput.fill('Ch. 2: A Brief Visit to the Zoo');
    await chInput.press('Enter');
    await expect(chInput).toBeHidden();
    await expect(page.getByTestId('book-detail-view')).toContainText('Ch. 2: A Brief Visit to the Zoo');

    const bookMetaAfterChapter = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
      return s.books.find((x: { id: string }) => x.id === 'book-systems')?.meta;
    });
    expect(bookMetaAfterChapter?.currentChapter).toBe('Ch. 2: A Brief Visit to the Zoo');
    expect(bookMetaAfterChapter?.customForeignKey).toBe('keep-me-cd5');

    // 2. BookBookmarkBar +10p advance & post-advance session note disclosure
    await page.getByTestId('advance-10p-btn-book-systems').click();
    await expect(page.getByTestId('post-advance-session-note-btn')).toBeVisible();

    // 3. AttachmentManager PNG image ClipboardEvent('paste') inside QuickCaptureModal + WikilinkTextarea touch ghost-click guard
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId('bottom-nav-capture').click();
    const capModal = page.getByTestId('quick-capture-modal');
    await expect(capModal).toBeVisible();

    // Paste a 1x1 PNG File onto a non-text control in QuickCaptureModal
    await page.getByTestId('capture-book-select').focus();
    await page.evaluate(async () => {
      const b64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const file = new File([bytes], 'pasted-diagram.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      document.activeElement?.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      );
    });
    await expect(page.getByTestId('capture-attachment-list')).toContainText('image');

    // Touch pointerdown + synthesized ghost click at same coordinates on WikilinkTextarea option
    const firstSlug = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('pragya_demo_state_v1') || '{}');
      return s.notes.find((n: { bookId: string }) => n.bookId === 'book-systems')?.slug;
    });
    await page.getByTestId('capture-takeaway-input').click();
    await page.keyboard.type(`[[${firstSlug.slice(0, 6)}`);
    const opt = page.getByTestId(`wikilink-option-${firstSlug}`);
    await expect(opt).toBeVisible();

    // Register a spy button listener on document to verify the trailing synthesized click at tap coords is swallowed
    const ghostReachedBody = await opt.evaluate(el => {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      let leaked = false;
      const onBodyClick = () => {
        leaked = true;
      };
      document.body.addEventListener('click', onBodyClick);
      el.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerType: 'touch',
          clientX: cx,
          clientY: cy,
        })
      );
      document.body.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: cx,
          clientY: cy,
        })
      );
      document.body.removeEventListener('click', onBodyClick);
      return leaked;
    });
    expect(ghostReachedBody).toBe(false);
    await expect(page.getByTestId('capture-takeaway-input')).toHaveValue(`[[${firstSlug}]]`);
  });
});

