import { test, expect } from '@playwright/test';

// 2x2 valid RGBA PNG
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4nGP4z8DwHwwZGP6DAQBJyAn3FGMynQAAAABJRU5ErkJggg==';

test.describe('Tier 1 — Foundation, Shelf, Quick Capture & Notes', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('Demo login, Shelf hydration, activity dots, sidebar collapse persistence, and primary navigation', async ({
    page,
  }) => {
    await expect(page.getByTestId('login-view')).toBeVisible();
    await page.getByTestId('demo-login-btn').click();

    await expect(page.getByTestId('shelf-view')).toBeVisible();
    await expect(page.getByTestId('demo-badge')).toHaveText('Demo');
    await expect(page.getByTestId('now-reading-section')).toBeVisible();
    await expect(page.getByTestId('activity-count')).toContainText('11 recorded sessions');
    await expect(page.getByTestId('activity-dot-0')).toBeVisible();
    await expect(page.getByTestId('activity-dot-29')).toBeVisible();

    // Sidebar collapse & reload persistence
    const expandedBox = await page.getByTestId('sidebar').boundingBox();
    expect(expandedBox).not.toBeNull();
    expect(expandedBox!.width).toBeGreaterThanOrEqual(230);

    await page.getByTestId('sidebar-toggle-btn').click();
    await expect(page.getByTestId('sidebar-expand-btn')).toBeVisible();
    await expect
      .poll(async () => (await page.getByTestId('sidebar').boundingBox())?.width ?? 999)
      .toBeLessThanOrEqual(72);

    await page.reload();
    await expect(page.getByTestId('sidebar-expand-btn')).toBeVisible();
    await expect
      .poll(async () => (await page.getByTestId('sidebar').boundingBox())?.width ?? 999)
      .toBeLessThanOrEqual(72);

    await page.getByTestId('sidebar-expand-btn').click();
    await expect(page.getByTestId('sidebar-toggle-btn')).toBeVisible();
    await expect
      .poll(async () => (await page.getByTestId('sidebar').boundingBox())?.width ?? 0)
      .toBeGreaterThanOrEqual(230);

    await page.getByTestId('nav-item-notes').click();
    await expect(page.getByTestId('notes-view')).toBeVisible();

    await page.getByTestId('nav-item-practice').click();
    await expect(page.getByTestId('practice-view')).toBeVisible();
    await expect(page.getByTestId('active-deltas-count')).toContainText('2/5');
    // Verify no double WHEN WHEN or DO DO prefix in practice view
    const practiceText = await page.getByTestId('practice-view').innerText();
    expect(practiceText).not.toContain('WHEN WHEN');
    expect(practiceText).not.toContain('DO DO');

    await page.getByTestId('nav-item-settings').click();
    await expect(page.getByTestId('settings-view')).toBeVisible();

    await page.getByTestId('nav-item-shelf').click();
    await expect(page.getByTestId('shelf-view')).toBeVisible();
  });

  test('Add Book persists across reload and Queued book can Start Reading', async ({ page }) => {
    await page.getByTestId('demo-login-btn').click();
    await expect(page.getByTestId('shelf-view')).toBeVisible();

    await page.getByTestId('add-book-btn').click();
    await expect(page.getByTestId('add-book-modal')).toBeVisible();

    await page.getByTestId('book-title-input').fill('Deep Work');
    await page.getByTestId('book-author-input').fill('Cal Newport');
    await page.getByTestId('book-pos-input').fill('24');
    await page.getByTestId('book-total-input').fill('296');
    await page.getByTestId('book-submit-btn').click();

    await expect(page.getByTestId('add-book-modal')).toBeHidden();
    await expect(page.getByTestId('now-reading-section')).toContainText('Deep Work');

    // Start Reading on queued book
    await page.getByTestId('book-start-btn-book-lathe').click();
    await expect(page.getByTestId('now-reading-section')).toContainText('The Lathe of Heaven');

    // Verify localStorage persistence after reload
    await page.reload();
    await expect(page.getByTestId('now-reading-section')).toContainText('Deep Work');
    await expect(page.getByTestId('now-reading-section')).toContainText('The Lathe of Heaven');
  });

  test('Monotonic bookmark Math.max ceiling and 30-min session coalescing', async ({ page }) => {
    await page.getByTestId('demo-login-btn').click();
    await expect(page.getByTestId('shelf-view')).toBeVisible();

    await expect(page.getByTestId('activity-count')).toContainText('11 recorded sessions');

    // Advance +10p from 142 -> 152 (creates new session #12 for book-systems today)
    await page.getByTestId('advance-10p-btn-book-systems').click();
    await expect(page.getByTestId('book-card-book-systems')).toContainText('p. 152 / 218');
    await expect(page.getByTestId('activity-count')).toContainText('12 recorded sessions');

    // Immediate exact advance 152 -> 160 coalesces into session #12 (count stays 12)
    await page.getByTestId('advance-exact-input-book-systems').fill('160');
    await page.getByTestId('advance-exact-btn-book-systems').click();
    await expect(page.getByTestId('book-card-book-systems')).toContainText('p. 160 / 218');
    await expect(page.getByTestId('activity-count')).toContainText('12 recorded sessions');

    // Attempt backward advance 120 (< 160) -> rejected monotonically
    await page.getByTestId('advance-exact-input-book-systems').fill('120');
    await page.getByTestId('advance-exact-btn-book-systems').click();
    await expect(page.getByTestId('book-card-book-systems')).toContainText('p. 160 / 218');

    // Rapid concurrent +10p and exact advance (160 -> 170 & 180 queued in same tick) coalesce cleanly into 1 session
    await page.getByTestId('advance-exact-input-book-systems').fill('180');
    await page.evaluate(() => {
      const btn10 = document.querySelector(
        '[data-testid="advance-10p-btn-book-systems"]'
      ) as HTMLButtonElement | null;
      const btnExact = document.querySelector(
        '[data-testid="advance-exact-btn-book-systems"]'
      ) as HTMLButtonElement | null;
      btn10?.click();
      btnExact?.click();
    });
    await expect(page.getByTestId('book-card-book-systems')).toContainText('p. 180 / 218');
    await expect(page.getByTestId('activity-count')).toContainText('12 recorded sessions');

    // Persists across reload
    await page.reload();
    await expect(page.getByTestId('book-card-book-systems')).toContainText('p. 180 / 218');
    await expect(page.getByTestId('activity-count')).toContainText('12 recorded sessions');
  });

  test('Quick Capture (N shortcut), Sparring Inbox, Fiction Prediction, paste/upload & max 3 attachments cap', async ({
    page,
  }) => {
    await page.getByTestId('demo-login-btn').click();
    await expect(page.getByTestId('shelf-view')).toBeVisible();

    // Open via 'n' shortcut
    await page.keyboard.press('n');
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();

    // Non-fiction book hides Fiction Prediction checkbox
    await page.getByTestId('capture-book-select').selectOption('book-systems');
    await expect(page.getByTestId('capture-prediction-checkbox')).toBeHidden();

    await page.getByTestId('capture-pos-input').fill('165');
    await page.getByTestId('capture-quote-input').fill('Structure shapes behavior.');
    await page
      .getByTestId('capture-takeaway-input')
      .fill('Redesign incentives before blaming individuals.');
    await page.getByTestId('capture-tags-input').fill('systems, incentives');
    await page.getByTestId('capture-spar-checkbox').check();

    // Attachment #1: Paste Google Doc URL directly into modal (focus on non-prose element)
    await page.getByTestId('capture-book-select').focus();
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'https://docs.google.com/document/d/doc-paste-001/edit');
      window.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      );
    });
    await expect(page.getByTestId('quick-capture-modal')).toContainText('ATTACHMENTS (1/3)', {
      ignoreCase: true,
    });
    await expect(page.getByTestId('capture-attachment-list')).toContainText('Google Doc');

    // Attachment #2: Paste PNG image -> compressed & saved in IndexedDB
    await page.evaluate(b64 => {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const file = new File([bytes], 'pasted-diagram.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      window.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      );
    }, TINY_PNG_BASE64);
    await expect(page.getByTestId('capture-attachment-list').locator('img')).toHaveAttribute(
      'src',
      /^blob:/
    );
    await expect(page.getByTestId('quick-capture-modal')).toContainText('ATTACHMENTS (2/3)', {
      ignoreCase: true,
    });

    // Attachment #3: Upload via file input -> hits 3/3 limit
    await page.getByTestId('capture-photo-input').setInputFiles({
      name: 'diagram.png',
      mimeType: 'image/png',
      buffer: Buffer.from(TINY_PNG_BASE64, 'base64'),
    });
    await expect(page.getByTestId('quick-capture-modal')).toContainText('ATTACHMENTS (3/3)', {
      ignoreCase: true,
    });

    // Max 3 attachments cap disables all 3 attach buttons
    await expect(page.getByTestId('capture-attach-photo-btn')).toBeDisabled();
    await expect(page.getByTestId('capture-attach-doc-btn')).toBeDisabled();
    await expect(page.getByTestId('capture-attach-link-btn')).toBeDisabled();

    // Pasting a 4th URL at 3/3 is blocked
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'https://example.com/fourth-attachment');
      window.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      );
    });
    await expect(page.getByTestId('quick-capture-modal')).toContainText('ATTACHMENTS (3/3)', {
      ignoreCase: true,
    });
    await expect(page.getByTestId('notification-toast')).toContainText('Maximum 3 attachments');

    // Remove 1 attachment -> re-enables buttons -> attach reference Link to verify all 3 types
    await page
      .getByTestId('capture-attachment-list')
      .getByRole('button', { name: 'Remove attachment' })
      .last()
      .click();
    await expect(page.getByTestId('quick-capture-modal')).toContainText('ATTACHMENTS (2/3)', {
      ignoreCase: true,
    });
    await expect(page.getByTestId('capture-attach-link-btn')).toBeEnabled();

    await page.getByTestId('capture-attach-link-btn').click();
    const urlInput = page.getByTestId('capture-attachment-url-input');
    await urlInput.focus();
    // Pasting while focused in capture-attachment-url-input must NOT hijack/auto-close attach mode
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'https://donellameadows.org/systems-thinking-resources/');
      window.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      );
    });
    await expect(urlInput).toBeVisible();
    await urlInput.fill('https://donellameadows.org/systems-thinking-resources/');
    await page.getByTestId('capture-attachment-title-input').fill('Meadows Archive');
    await page.getByTestId('capture-attachment-confirm-btn').click();
    await expect(page.getByTestId('capture-attachment-list')).toContainText('Meadows Archive');
    await expect(page.getByTestId('quick-capture-modal')).toContainText('ATTACHMENTS (3/3)', {
      ignoreCase: true,
    });

    await page.getByTestId('capture-submit-btn').click();
    await expect(page.getByTestId('quick-capture-modal')).toBeHidden();

    // Capture a Fiction Prediction on fiction book (book-exhalation)
    await page.keyboard.press('n');
    await expect(page.getByTestId('quick-capture-modal')).toBeVisible();
    await page.getByTestId('capture-book-select').selectOption('book-exhalation');
    await expect(page.getByTestId('capture-prediction-checkbox')).toBeVisible();
    await page.getByTestId('capture-prediction-checkbox').check();
    await page
      .getByTestId('capture-takeaway-input')
      .fill('Prediction: The narrator discovers the prism alters past emotions.');
    await page.getByTestId('capture-submit-btn').click();
    await expect(page.getByTestId('quick-capture-modal')).toBeHidden();

    // Verify both notes appear in NotesView with image blob, Sealed Prediction badge, and reload persistence
    await page.getByTestId('nav-item-notes').click();
    await expect(page.getByTestId('notes-view')).toContainText(
      'Redesign incentives before blaming individuals.'
    );
    await expect(page.getByTestId('notes-view')).toContainText(
      'Prediction: The narrator discovers the prism alters past emotions.'
    );
    await expect(page.getByTestId('notes-view')).toContainText('Sealed Prediction');

    await page.getByTestId('notes-filter-to-spar').click();
    await expect(page.getByTestId('notes-view')).toContainText(
      'Redesign incentives before blaming individuals.'
    );

    await page.reload();
    await page.getByTestId('nav-item-notes').click();
    await page.getByTestId('notes-filter-media').click();
    await expect(
      page.getByTestId('notes-view').locator('img[src^="blob:"]').first()
    ).toBeVisible();
  });

  test('Notes filters (all 5 pills), Spoiler Shield reveal, focus guard, Command Palette, Theme & Demo Reset', async ({
    page,
  }) => {
    await page.getByTestId('demo-login-btn').click();
    await page.getByTestId('nav-item-notes').click();

    // Hidden spoiler quote/takeaway must NOT leak through search before reveal
    const notesSearch = page.getByTestId('notes-search-input');
    await notesSearch.fill('omniscience');
    await expect(page.getByTestId('note-card-effective-dreaming-ethics')).toBeHidden();
    await notesSearch.fill('');

    // Spoiler shield hides future note until revealed
    const shield = page.getByTestId('spoiler-shield-effective-dreaming-ethics');
    await expect(shield).toBeVisible();
    await expect(
      page.getByTestId('note-card-effective-dreaming-ethics')
    ).not.toContainText('assume omniscience');

    await page.getByTestId('spoiler-reveal-btn-effective-dreaming-ethics').click();
    await expect(page.getByTestId('note-card-effective-dreaming-ethics')).toContainText(
      'assume omniscience'
    );

    // Once revealed, search finds the revealed quote
    await notesSearch.fill('omniscience');
    await expect(page.getByTestId('note-card-effective-dreaming-ethics')).toBeVisible();
    await notesSearch.fill('');

    // Non-spoiler Sealed Prediction shows badge without spoiler blur
    await expect(
      page.getByTestId('note-card-consciousness-and-thermal-equilibrium')
    ).toContainText('Sealed Prediction');
    await expect(
      page.getByTestId('spoiler-shield-consciousness-and-thermal-equilibrium')
    ).toBeHidden();

    // All 5 filter pills: All, To Spar, Atomic, Has Media, [[Concepts]]
    await page.getByTestId('notes-filter-to-spar').click();
    await expect(page.getByTestId('note-card-memory-prism-digital-remembrance')).toBeVisible();
    await expect(page.getByTestId('note-card-delays-in-feedback-loops')).toBeHidden();

    await page.getByTestId('notes-filter-atomic').click();
    await expect(page.getByTestId('note-card-delays-in-feedback-loops')).toBeVisible();
    await expect(page.getByTestId('note-card-memory-prism-digital-remembrance')).toBeHidden();

    await page.getByTestId('notes-filter-media').click();
    await expect(page.getByTestId('note-card-delays-in-feedback-loops')).toBeVisible();
    await expect(page.getByTestId('note-card-playing-with-boundaries')).toBeHidden();

    await page.getByTestId('notes-filter-concepts').click();
    await expect(page.getByTestId('note-card-delays-in-feedback-loops')).toBeVisible();
    await expect(page.getByTestId('note-card-playing-with-boundaries')).toBeVisible();
    await expect(page.getByTestId('note-card-memory-prism-digital-remembrance')).toBeHidden();

    await page.getByTestId('notes-filter-all').click();
    await expect(page.getByTestId('note-card-memory-prism-digital-remembrance')).toBeVisible();

    // Input focus guard: typing 'n' in search input must NOT open QuickCaptureModal
    const searchInput = page.getByTestId('notes-search-input');
    await searchInput.click();
    await searchInput.type('n');
    await expect(page.getByTestId('quick-capture-modal')).toBeHidden();
    await searchInput.fill('thermal equilibrium');
    await expect(
      page.getByTestId('note-card-consciousness-and-thermal-equilibrium')
    ).toBeVisible();
    await searchInput.fill('');

    // Command Palette Ctrl+K jump to book + Escape back to shelf
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await page.getByTestId('command-palette-input').fill('Finite');
    await page.getByTestId('command-palette-item-book-book-finite').click();
    await expect(page.getByTestId('book-detail-view')).toContainText('Finite and Infinite Games');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('shelf-view')).toBeVisible();

    // Theme toggle dark -> light -> dark persists across reload
    await page.getByTestId('theme-toggle-btn').click();
    await expect(page.locator('html')).toHaveClass(/light/);
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/light/);
    await page.getByTestId('theme-toggle-btn').click();
    await expect(page.locator('html')).toHaveClass(/dark/);

    // Reset Demo Data restores original seed
    await page.getByTestId('nav-item-settings').click();
    await page.getByTestId('reset-demo-btn').click();
    await page.getByTestId('nav-item-shelf').click();
    await expect(page.getByTestId('activity-count')).toContainText('11 recorded sessions');
  });
});
