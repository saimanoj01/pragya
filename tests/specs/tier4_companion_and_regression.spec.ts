import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';

const REPO_ROOT = path.resolve(process.cwd());
const CLI_PATH = path.join(REPO_ROOT, 'scripts', 'pragya_cli.py');

function runCli(args: string[]): Record<string, unknown> {
  const out = execFileSync('python3', [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  return JSON.parse(out) as Record<string, unknown>;
}

async function assertCleanPragyaPage(
  page: Page,
  expectedSelector: string,
  checkMobileOverflow: boolean
) {
  await expect(page.locator(expectedSelector)).toBeVisible();

  const audit = await page.evaluate(() => {
    const legacyPattern = new RegExp('ath' + 'ena', 'i');
    const bodyText = document.body.innerText || '';
    const title = document.title || '';
    const storageDump = Object.keys(localStorage)
      .map(k => `${k}:${localStorage.getItem(k) || ''}`)
      .join('\n');

    return {
      title,
      hasLegacyInBody: legacyPattern.test(bodyText),
      hasLegacyInTitle: legacyPattern.test(title),
      hasLegacyInStorage: legacyPattern.test(storageDump),
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });

  expect(audit.title).toContain('Pragya');
  expect(audit.hasLegacyInBody).toBe(false);
  expect(audit.hasLegacyInTitle).toBe(false);
  expect(audit.hasLegacyInStorage).toBe(false);
  if (checkMobileOverflow) {
    expect(audit.scrollWidth).toBeLessThanOrEqual(audit.innerWidth);
  }
}

test.describe('Tier 4 — Companion CLI-PWA Interoperability & Full Regression Sweep', () => {
  test.beforeEach(async ({ page }) => {
    await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route =>
      route.fulfill({ status: 200, contentType: 'text/css', body: '' })
    );
  });

  test('CLI capture -> reflect -> ocr-backfill -> PWA JSON import -> NoteDetail & Practice single WHEN/DO -> export roundtrip', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => pageErrors.push(err.message));

    await page.goto('/');
    await page.getByTestId('demo-login-btn').click();
    await expect(page.getByTestId('shelf-view')).toBeVisible();

    // 1. Export live PWA snapshot from PracticeView
    await page.getByTestId('nav-item-practice').click();
    await expect(page.getByTestId('practice-view')).toBeVisible();
    const dlPromise = page.waitForEvent('download');
    await page.getByTestId('export-json-btn').click();
    const dl = await dlPromise;
    const dlPath = await dl.path();
    expect(dlPath).toBeTruthy();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pragya-tier4-'));
    try {
      const stateFile = path.join(tmpDir, 'workspace.json');
      fs.copyFileSync(dlPath!, stateFile);
      const dummyImg = path.join(tmpDir, 'page164.webp');
      fs.writeFileSync(dummyImg, Buffer.from('RIFF\x00\x00\x00\x00WEBP'));

      // 2. Execute real Python companion CLI workflow against exported stateFile
      const capRes = runCli([
        '--state-file',
        stateFile,
        'capture',
        '--book',
        'book-systems',
        '--pos',
        '164',
        '--takeaway',
        'CLI captured takeaway for Socratic sync',
        '--image',
        dummyImg,
        '--spar',
      ]);
      const capNote = capRes.note as { slug: string };
      expect(capNote.slug).toBeTruthy();

      const st1Res = runCli([
        '--state-file',
        stateFile,
        'reflect',
        '--note',
        capNote.slug,
        '--stage',
        '1',
      ]);
      expect(st1Res.status).toBe('awaiting_user_reply');
      expect((st1Res.socraticQuestions as string[]).length).toBe(2);

      const commitRes = runCli([
        '--state-file',
        stateFile,
        'reflect',
        '--note',
        capNote.slug,
        '--stage',
        'commit',
        '--title',
        'CLI Atomic Synthesis',
        '--slug',
        'cli-atomic-synthesis',
        '--takeaway',
        'Synthesized atomic takeaway linked to [[delays-in-feedback-loops]].',
        '--context',
        'Demonstrates roundtrip between companion CLI and PWA.',
        '--critique',
        'Requires periodic review.',
        '--trigger',
        'WHEN WHEN cli state diverges',
        '--action',
        'DO DO run snapshot sync check',
        '--delta-status',
        'active',
      ]);
      const committedNote = commitRes.note as { status: string; slug: string };
      expect(committedNote.status).toBe('atomic');
      expect(committedNote.slug).toBe('cli-atomic-synthesis');

      const ocrRes = runCli([
        '--state-file',
        stateFile,
        'ocr-backfill',
        '--note',
        'cli-atomic-synthesis',
        '--ocr-text',
        'OCR quote from page 164 diagram.',
      ]);
      expect(ocrRes.updatedCount).toBe(1);

      // 3. Import CLI-mutated snapshot back into Pragya PWA
      await page.getByTestId('import-json-input').setInputFiles(stateFile);
      await expect(page.getByTestId('import-confirm-modal')).toBeVisible();
      await page.getByTestId('import-confirm-btn').click();
      await expect(page.getByTestId('import-confirm-modal')).toBeHidden();

      // 4. Verify PracticeView renders single WHEN / DO and zero WHEN WHEN / DO DO
      await expect(page.getByTestId('active-deltas-count')).toHaveText('3/5');
      await expect(page.getByTestId('practice-view')).toContainText('CLI Atomic Synthesis');
      await expect(page.getByTestId('practice-view')).toContainText('WHEN cli state diverges');
      await expect(page.getByTestId('practice-view')).toContainText('DO run snapshot sync check');
      const practiceText = await page.getByTestId('practice-view').innerText();
      expect(practiceText).not.toContain('WHEN WHEN');
      expect(practiceText).not.toContain('DO DO');

      // 5. Verify NotesView and NoteDetailView render OCR quote, agent badge, atomic badge, and wikilinks
      await page.getByTestId('nav-item-notes').click();
      const noteCard = page.getByTestId('note-card-cli-atomic-synthesis');
      await expect(noteCard).toBeVisible();
      await expect(noteCard).toContainText('CLI Atomic Synthesis');
      await expect(noteCard).toContainText(/atomic/i);

      await noteCard.getByRole('button', { name: /VIEW NOTE/i }).click();
      await expect(page.getByTestId('note-detail-view')).toBeVisible();
      const detailText = await page.getByTestId('note-detail-view').innerText();
      expect(detailText).toContain('OCR quote from page 164 diagram.');
      expect(detailText).toContain('WHEN cli state diverges');
      expect(detailText).toContain('DO run snapshot sync check');
      expect(detailText).not.toContain('WHEN WHEN');
      expect(detailText).not.toContain('DO DO');
      await expect(page.getByTestId('note-detail-view')).toContainText(/via agent/i);

      // Follow wikilink to delays-in-feedback-loops and verify automatic backlink
      await page.getByTestId('wikilink-chip-delays-in-feedback-loops').click();
      await expect(page.getByTestId('backlinks-section')).toBeVisible();
      await expect(page.getByTestId('backlink-item-cli-atomic-synthesis')).toBeVisible();

      // 6. Export JSON back out of PWA and verify schema v1 contains cli-atomic-synthesis
      await page.getByTestId('nav-item-practice').click();
      const roundtripDlPromise = page.waitForEvent('download');
      await page.getByTestId('export-json-btn').click();
      const roundtripDl = await roundtripDlPromise;
      const roundtripPath = await roundtripDl.path();
      const exportedBack = JSON.parse(fs.readFileSync(roundtripPath!, 'utf-8')) as {
        version: number;
        notes: Array<{ slug: string; deltaTrigger: string; deltaAction: string }>;
      };
      expect(exportedBack.version).toBe(1);
      const synced = exportedBack.notes.find(n => n.slug === 'cli-atomic-synthesis');
      expect(synced).toBeTruthy();
      expect(synced!.deltaTrigger).toBe('cli state diverges');
      expect(synced!.deltaAction).toBe('run snapshot sync check');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test('Full regression sweep across all routes in Dark & Light mode on Desktop (1440x900) and Mobile (390x844)', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => pageErrors.push(err.message));

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.getByTestId('demo-login-btn').click();
    await expect(page.getByTestId('shelf-view')).toBeVisible();

    const routes: Array<{ hash: string; testId: string }> = [
      { hash: '#/shelf', testId: '[data-testid="shelf-view"]' },
      { hash: '#/notes', testId: '[data-testid="notes-view"]' },
      { hash: '#/practice', testId: '[data-testid="practice-view"]' },
      { hash: '#/settings', testId: '[data-testid="settings-view"]' },
      { hash: '#/book/book-systems', testId: '[data-testid="book-detail-view"]' },
      { hash: '#/note/delays-in-feedback-loops', testId: '[data-testid="note-detail-view"]' },
    ];

    // Desktop Dark Mode (1440x900)
    await expect(page.locator('html')).not.toHaveClass(/light/);
    for (const r of routes) {
      await page.evaluate(h => {
        window.location.hash = h;
      }, r.hash);
      await assertCleanPragyaPage(page, r.testId, false);
    }

    // Toggle to Light Mode on Desktop (1440x900)
    await page.getByTestId('theme-toggle-btn').click();
    await expect(page.locator('html')).toHaveClass(/light/);
    for (const r of routes) {
      await page.evaluate(h => {
        window.location.hash = h;
      }, r.hash);
      await assertCleanPragyaPage(page, r.testId, false);
    }

    // Mobile Light Mode (390x844) + activity-dots container check
    await page.setViewportSize({ width: 390, height: 844 });
    for (const r of routes) {
      await page.evaluate(h => {
        window.location.hash = h;
      }, r.hash);
      await assertCleanPragyaPage(page, r.testId, true);
      if (r.hash === '#/shelf') {
        const dotsFits = await page.evaluate(() => {
          const dots = document.querySelector('[data-testid="activity-dots"]') as HTMLElement | null;
          const parent = dots?.parentElement as HTMLElement | null;
          if (!dots || !parent) return false;
          const dRect = dots.getBoundingClientRect();
          const pRect = parent.getBoundingClientRect();
          return dRect.right <= pRect.right + 1 && dRect.left >= pRect.left - 1;
        });
        expect(dotsFits).toBe(true);
      }
    }

    // Toggle back to Dark Mode on Mobile via More drawer & verify zero overflow
    await page.getByTestId('bottom-nav-more').click();
    await expect(page.getByTestId('mobile-more-drawer')).toBeVisible();
    await page.getByTestId('drawer-theme-toggle').click();
    await expect(page.locator('html')).not.toHaveClass(/light/);
    await page.keyboard.press('Escape');

    for (const r of routes) {
      await page.evaluate(h => {
        window.location.hash = h;
      }, r.hash);
      await assertCleanPragyaPage(page, r.testId, true);
    }

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
