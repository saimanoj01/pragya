import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import module from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (typeof module.registerHooks === 'function') {
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        (specifier.startsWith('./') || specifier.startsWith('../')) &&
        !path.extname(specifier) &&
        context.parentURL
      ) {
        const parentPath = fileURLToPath(context.parentURL);
        const parentDir = path.dirname(parentPath);
        for (const ext of ['.ts', '.tsx', '.mjs', '.js']) {
          const candidate = path.resolve(parentDir, `${specifier}${ext}`);
          if (fs.existsSync(candidate)) {
            return nextResolve(pathToFileURL(candidate).href, context);
          }
        }
      }
      return nextResolve(specifier, context);
    },
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const load = rel => import(pathToFileURL(path.join(repoRoot, rel)).href);

const al = await load('src/utils/attachmentLimits.ts');
const md = await load('src/utils/modalDraft.ts');
const ds = await load('src/utils/draftStorage.ts');
const wl = await load('src/utils/wikilinks.ts');
const df = await load('src/utils/deltaFormat.ts');

test('CD5 QA attachmentLimits: scheme hardening, port/query/hash URLs, and interleaved raw merge', () => {
  for (const unsafe of [
    'data:text/html,<script>alert(1)</script>',
    'blob:https://example.com/uuid-1',
    'file:///etc/passwd',
    '//evil.example.com/phish',
    'vbscript:msgbox(1)',
    'mailto:reader@example.com',
  ]) {
    const parsed = al.parseUrlAttachmentInput(unsafe);
    assert.equal(parsed.ok, false, `must reject non-http(s) URL: ${unsafe}`);
  }

  const localUrl = al.parseUrlAttachmentInput('  http://localhost:5173/notes?q=loop#top  ');
  assert.deepEqual(localUrl, {
    ok: true,
    kind: 'link',
    url: 'http://localhost:5173/notes?q=loop#top',
    title: 'localhost',
    needsTitleResolve: false,
  });

  const docViewUrl = al.parseUrlAttachmentInput(
    'https://docs.google.com/document/d/1AbC-def_90/view#heading=h.123',
    '   '
  );
  assert.deepEqual(docViewUrl, {
    ok: true,
    kind: 'doc',
    docId: '1AbC-def_90',
    url: 'https://docs.google.com/document/d/1AbC-def_90/view#heading=h.123',
    title: 'Google Doc',
    needsTitleResolve: true,
  });

  // Non-array inputs degrade gracefully without throwing
  for (const nonArr of [null, undefined, 'corrupt', 42, { id: 'x' }]) {
    const split = al.openEditableAttachments(nonArr);
    assert.deepEqual(split, { originalRaw: [], renderable: [] });
  }

  // Interleaved unknown attachments at indices 0, 2, 6 + 4 valid attachments -> cap 3 editable, verbatim preservation
  const unk0 = { id: 'unk-0', type: 'voice-memo', durationSec: 19 };
  const unk2 = { type: 'corrupt-missing-id', raw: true };
  const unk6 = { id: 'unk-6', type: 'pdf-annot', page: 44 };
  const v1 = { id: 'v1', type: 'link', title: 'Valid 1', url: 'https://example.com/1' };
  const v2 = { id: 'v2', type: 'doc', docId: 'd2', title: 'Doc 2', url: 'https://docs.google.com/document/d/d2/edit' };
  const v3 = { id: 'v3', type: 'image', driveFileId: 'drv-3', mimeType: 'image/png', fileName: 'p3.png' };
  const v4 = { id: 'v4', type: 'link', title: 'Fourth Beyond Cap', url: 'https://example.com/4' };

  const rawInput = [unk0, v1, unk2, v2, v3, v4, unk6];
  const rawSnapshot = structuredClone(rawInput);

  const opened = al.openEditableAttachments(rawInput);
  assert.deepEqual(
    opened.renderable.map(a => a.id),
    ['v1', 'v2', 'v3']
  );

  // User deletes v2, updates v1, keeps v3, and adds v5 into the freed slot (3/3)
  const v5 = { id: 'v5', type: 'link', title: 'New Fifth', url: 'https://example.com/5' };
  const merged = al.saveEditedAttachments(opened.originalRaw, [
    { ...v1, title: 'Valid 1 Edited' },
    v3,
    v5,
  ]);

  assert.deepEqual(merged, [
    unk0,
    { ...v1, title: 'Valid 1 Edited' },
    unk2,
    v3,
    v4,
    unk6,
    v5,
  ]);
  // Input array was never mutated
  assert.deepEqual(rawInput, rawSnapshot);

  // Case-insensitive tag/type handling in isTextPasteTarget
  assert.equal(al.isTextPasteTarget('textarea', null, false), true);
  assert.equal(al.isTextPasteTarget('input', 'SEARCH', false), true);
  assert.equal(al.isTextPasteTarget('input', 'Email', false), true);
  assert.equal(al.isTextPasteTarget('input', 'radio', false), false);
  assert.equal(al.isTextPasteTarget('input', 'submit', false), false);
});

test('CD5 QA modalDraft: identical-to-canonical skip, CaptureDraft timeless restore, and disabled clean-close isolation', () => {
  localStorage.clear();
  try {
    localStorage.setItem('pragya_mock_mode', 'true');
    localStorage.setItem('pragya_mock_session', '1');

    // 1. CaptureDraft has no baseUpdatedAt -> getBaseUpdatedAt returns undefined -> never treated as stale
    const captureKey = ds.CAPTURE_DRAFT_KEY;
    md.flushModalDraft(captureKey, true, {
      bookId: 'book-systems',
      takeaway: 'Keep stocks visible',
      attachments: [{ id: 'a1', type: 'link', title: 'Ex', url: 'https://example.com' }],
    });
    const captureRestored = md.resolveModalDraftOnOpen({
      key: captureKey,
      currentUpdatedAt: '2099-12-31T23:59:59.999Z',
      getBaseUpdatedAt: () => undefined,
      canRestore: d => Boolean(d.takeaway || d.attachments?.length),
    });
    assert.equal(captureRestored.kind, 'restored');

    // 2. Closing an initialSlug capture (`draftKey === ''`) with isDirty=false or true MUST NOT touch existing capture draft
    md.flushModalDraft('', false, { takeaway: '' });
    md.flushModalDraft('', true, { takeaway: 'new slug note' });
    assert.ok(
      localStorage.getItem('pragya_draft:demo:pragya_draft_capture_v1'),
      'empty-key flushModalDraft (initialSlug session) must preserve normal capture draft'
    );

    // 3. Draft present with equal timestamp, but canRestore returns false (identical to canonical) -> canonical
    const deepenKey = ds.getDeepenDraftKey('note-99');
    md.flushModalDraft(deepenKey, true, {
      baseUpdatedAt: '2026-11-18T12:00:00.000Z',
      takeaway: 'Same as canonical',
    });
    const unchanged = md.resolveModalDraftOnOpen({
      key: deepenKey,
      currentUpdatedAt: '2026-11-18T12:00:00.000Z',
      getBaseUpdatedAt: d => d.baseUpdatedAt,
      canRestore: d => d.takeaway !== 'Same as canonical',
    });
    assert.equal(unchanged.kind, 'canonical');

    // 4. Non-disabled flush with isDirty=false clears stored draft
    md.flushModalDraft(deepenKey, false, { takeaway: 'Same as canonical' });
    assert.equal(localStorage.getItem('pragya_draft:demo:pragya_draft_deepen_note-99'), null);
  } finally {
    localStorage.clear();
  }
});

test('CD5 QA wikilinks: multi-link prose, cursor boundary clamping, and mid-sentence insertion', () => {
  assert.equal(wl.getActiveWikilinkMatch('[[abc', null), null);
  assert.equal(wl.getActiveWikilinkMatch('[[abc', 0), null);
  assert.equal(wl.getActiveWikilinkMatch('[[abc', 1), null);
  assert.equal(wl.getActiveWikilinkMatch('[[abc', 99), null);

  // Immediately after opening `[[` at index 0
  const atStart = wl.getActiveWikilinkMatch('[[ trailing words', 2);
  assert.deepEqual(atStart, { query: '', startIndex: 0, endIndex: 2 });
  assert.deepEqual(wl.applyWikilinkSelection('[[ trailing words', atStart, 'first-slug'), {
    nextValue: '[[first-slug]] trailing words',
    nextCursor: 14,
  });

  // Multiple wikilinks in the same textarea: editing a second open `[[` after a closed `[[alpha]]`
  const multi = 'Compare [[alpha]] with [[sec and [[later]]';
  const secondCursor = 'Compare [[alpha]] with [[sec'.length;
  const secondMatch = wl.getActiveWikilinkMatch(multi, secondCursor);
  assert.deepEqual(secondMatch, {
    query: 'sec',
    startIndex: 'Compare [[alpha]] with '.length,
    endIndex: secondCursor,
  });
  const appliedSecond = wl.applyWikilinkSelection(multi, secondMatch, 'second-concept');
  assert.deepEqual(appliedSecond, {
    nextValue: 'Compare [[alpha]] with [[second-concept]] and [[later]]',
    nextCursor: 'Compare [[alpha]] with [[second-concept]]'.length,
  });

  // Closed brackets before cursor (`[[foo]]bar`) and carriage/newline inside `[[` are rejected
  assert.equal(wl.getActiveWikilinkMatch('Closed [[foo]]bar', 17), null);
  assert.equal(wl.getActiveWikilinkMatch('Linebreak [[foo\nbar', 19), null);
});

test('CD5 QA deltaFormat: lone WHEN/DO prefix rejection and status-driven details default', () => {
  // Fiction note with paused/graduated status (even if body empty) defaults open
  assert.equal(
    df.shouldDefaultOpenDeltaDetails({
      bookKind: 'fiction',
      triggerBody: '',
      actionBody: '',
      deltaStatus: 'paused',
    }),
    true
  );
  assert.equal(
    df.shouldDefaultOpenDeltaDetails({
      bookKind: 'fiction',
      triggerBody: '',
      actionBody: 'write scene beats',
      deltaStatus: 'none',
    }),
    true
  );

  // Lone "WHEN" / "DO" prefixes normalize to empty and are rejected when active
  const lonePrefixes = df.validateDeltaForSave({
    deltaTrigger: 'WHEN:   ',
    deltaAction: 'DO   ',
    deltaStatus: 'active',
    otherActiveCount: 0,
    emptyActiveMessage: 'Add WHEN or DO',
  });
  assert.deepEqual(lonePrefixes, { ok: false, error: 'Add WHEN or DO' });

  // Repeated DO DO + negation preservation ("DO: Do not check phone")
  const negationPreserved = df.validateDeltaForSave({
    deltaTrigger: 'WHEN: when waking up',
    deltaAction: 'DO: Do not check phone',
    deltaStatus: 'active',
    otherActiveCount: 4, // 4 other active + this 1 = 5/5 allowed!
    emptyActiveMessage: 'Add WHEN or DO',
  });
  assert.deepEqual(negationPreserved, {
    ok: true,
    normalizedTrigger: 'waking up',
    normalizedAction: 'Do not check phone',
  });
});

test('CD5 QA static invariants: conflict guards, 7 WikilinkTextarea sites, and 4 useCopyPrompt sites', () => {
  const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

  // Conflict-guard invariants across all 4 note/book editors touched by Batch 5
  for (const [rel, fnName, ownedExpr] of [
    [
      'src/components/modals/EditNoteModal.tsx',
      'updateNote',
      'wordNote ? NOTE_LEXICON_OWNED_META_KEYS : NOTE_CHAPTER_EDITOR_OWNED_META_KEYS',
    ],
    ['src/components/modals/DeepenNoteModal.tsx', 'updateNote', 'NOTE_CHAPTER_EDITOR_OWNED_META_KEYS'],
    ['src/components/modals/CapstoneModal.tsx', 'updateBook', 'CAPSTONE_OWNED_META_KEYS'],
    ['src/components/common/BookChapterLine.tsx', 'updateBook', 'BOOK_DETAIL_CHAPTER_OWNED_META_KEYS'],
  ]) {
    const src = read(rel);
    assert.ok(src.includes(fnName), `${rel} calls ${fnName}`);
    assert.ok(src.includes('expectedBaseUpdatedAt:'), `${rel} passes expectedBaseUpdatedAt`);
    assert.ok(src.includes(`ownedMetaKeys: ${ownedExpr}`), `${rel} passes ${ownedExpr}`);
    assert.ok(src.includes('baseMeta:'), `${rel} passes baseMeta`);
  }

  // All 7 WikilinkTextarea call sites (1 QuickCapture + 3 EditNote + 3 DeepenNote)
  const countOccurrences = (str, needle) => str.split(needle).length - 1;
  assert.equal(countOccurrences(read('src/components/modals/QuickCaptureModal.tsx'), '<WikilinkTextarea'), 1);
  assert.equal(countOccurrences(read('src/components/modals/EditNoteModal.tsx'), '<WikilinkTextarea'), 3);
  assert.equal(countOccurrences(read('src/components/modals/DeepenNoteModal.tsx'), '<WikilinkTextarea'), 3);

  // All 4 useCopyPrompt + PromptFallbackModal sites
  for (const rel of [
    'src/components/common/CapstoneSection.tsx',
    'src/components/modals/CapstoneModal.tsx',
    'src/components/views/NoteDetailView.tsx',
    'src/components/views/PracticeView.tsx',
  ]) {
    const src = read(rel);
    assert.ok(src.includes('useCopyPrompt('), `${rel} uses useCopyPrompt`);
    assert.ok(src.includes('<PromptFallbackModal'), `${rel} renders PromptFallbackModal`);
  }
});

test('CD5 QA R1/R2 fix-up contracts: single-bracket wikilinks, foreign-draft safety, AttachmentManager async/paste guards, and sibling ConfirmDialog', () => {
  const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

  // R1#1: single `[` / `]` rejected while adjacent `[[` opens at the rightmost pair
  assert.deepEqual(wl.getActiveWikilinkMatch('[[[', 3), { query: '', startIndex: 1, endIndex: 3 });
  assert.deepEqual(wl.getActiveWikilinkMatch('[[a[[b', 6), { query: 'b', startIndex: 3, endIndex: 6 });
  assert.equal(wl.getActiveWikilinkMatch('[[a]b', 5), null);
  assert.equal(wl.getActiveWikilinkMatch('[[a[b', 5), null);

  // R1#2 / R2-1: empty-key & untouched canonical sessions never clear foreign drafts
  localStorage.clear();
  try {
    localStorage.setItem('pragya_mock_mode', 'true');
    localStorage.setItem('pragya_mock_session', '1');
    assert.equal(md.flushSessionModalDraft('', true, true, { takeaway: 'ignored' }), 'noop');
    assert.equal(
      md.flushSessionModalDraft(ds.CAPTURE_DRAFT_KEY, true, true, { bookId: 'book-a', takeaway: 'A' }),
      'written'
    );
    assert.equal(
      md.flushSessionModalDraft(ds.CAPTURE_DRAFT_KEY, false, false, { bookId: 'book-b', takeaway: '' }),
      'noop'
    );
    assert.equal(
      JSON.parse(localStorage.getItem('pragya_draft:demo:pragya_draft_capture_v1')).bookId,
      'book-a'
    );
  } finally {
    localStorage.clear();
  }
  const hookSrc = read('src/hooks/useModalDraft.ts');
  assert.ok(hookSrc.includes('dirtiedOrRestoredRef'), 'useModalDraft tracks dirtiedOrRestoredRef');
  assert.ok(
    hookSrc.includes('if (!isDirty && !dirtiedOrRestoredRef.current) return;'),
    'useModalDraft skips debounced timer on untouched canonical session'
  );
  assert.ok(hookSrc.includes('flushSessionModalDraft('), 'useModalDraft delegates to flushSessionModalDraft');

  // R1#3 / R2-3 / CD Batch 6: AttachmentManager sessionEpochRef guards + topmost open-dialog paste guard
  const attSrc = read('src/components/common/AttachmentManager.tsx');
  assert.ok(attSrc.includes('sessionEpochRef.current += 1;'), 'AttachmentManager bumps epoch on open/reset');
  assert.ok(
    attSrc.split('sessionEpochRef.current !== epoch').length - 1 >= 3,
    'AttachmentManager guards resolveDocTitle and uploadImageAttachment (try + catch) with epoch check'
  );
  assert.ok(
    attSrc.includes('fileInputRef.current?.closest(OPEN_DIALOG_SELECTOR)') &&
      attSrc.includes('!isTopmostOpenDialog(myDialog, document)'),
    'AttachmentManager ignores paste when another dialog (dialog[open]/dialog/alertdialog) sits above its modal'
  );

  // R2-3: EditNoteModal hoists <ConfirmDialog> as a sibling outside </Modal>
  const editSrc = read('src/components/modals/EditNoteModal.tsx');
  const modalCloseIdx = editSrc.lastIndexOf('</Modal>');
  const confirmIdx = editSrc.indexOf('<ConfirmDialog');
  assert.ok(modalCloseIdx !== -1 && confirmIdx > modalCloseIdx, 'EditNoteModal renders ConfirmDialog outside </Modal>');
});

