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

function walkFiles(dir, exts) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, exts));
    } else if (exts.some(ext => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

test('CD5 D3.1 attachmentLimits: URL classification, 3-cap, and paste target guard', () => {
  const docAuto = al.parseUrlAttachmentInput(
    '  https://docs.google.com/document/d/doc-abc_123/edit?usp=sharing  '
  );
  assert.deepEqual(docAuto, {
    ok: true,
    kind: 'doc',
    docId: 'doc-abc_123',
    url: 'https://docs.google.com/document/d/doc-abc_123/edit?usp=sharing',
    title: 'Google Doc',
    needsTitleResolve: true,
  });

  const docNamed = al.parseUrlAttachmentInput(
    'https://docs.google.com/document/d/doc-xyz/edit',
    '  Book Companion  '
  );
  assert.equal(docNamed.ok, true);
  assert.equal(docNamed.title, 'Book Companion');
  assert.equal(docNamed.needsTitleResolve, false);

  const linkAuto = al.parseUrlAttachmentInput('https://architecture.example.org/notes/1');
  assert.deepEqual(linkAuto, {
    ok: true,
    kind: 'link',
    url: 'https://architecture.example.org/notes/1',
    title: 'architecture.example.org',
    needsTitleResolve: false,
  });

  for (const bad of ['', '   ', 'javascript:alert(1)', 'ftp://files.example.com/a', 'https://bad url']) {
    const res = al.parseUrlAttachmentInput(bad);
    assert.equal(res.ok, false, `expected invalid URL for ${JSON.stringify(bad)}`);
  }

  let list = [];
  for (let i = 1; i <= 4; i += 1) {
    const res = al.appendAttachmentUnderCap(list, {
      id: `att-${i}`,
      type: 'link',
      title: `Link ${i}`,
      url: `https://example.com/${i}`,
    });
    assert.equal(res.added, i <= 3);
    list = res.attachments;
  }
  assert.equal(list.length, 3);
  assert.equal(al.isAtAttachmentLimit(list), true);

  // Paste target guard: text/url inputs & textareas keep native paste; select/checkbox/number/file/button intercept.
  assert.equal(al.isTextPasteTarget('TEXTAREA', null, false), true);
  assert.equal(al.isTextPasteTarget('INPUT', 'text', false), true);
  assert.equal(al.isTextPasteTarget('INPUT', 'url', false), true);
  assert.equal(al.isTextPasteTarget('INPUT', '', false), true);
  assert.equal(al.isTextPasteTarget('DIV', null, true), true);

  assert.equal(al.isTextPasteTarget('SELECT', null, false), false);
  assert.equal(al.isTextPasteTarget('INPUT', 'checkbox', false), false);
  assert.equal(al.isTextPasteTarget('INPUT', 'number', false), false);
  assert.equal(al.isTextPasteTarget('INPUT', 'file', false), false);
  assert.equal(al.isTextPasteTarget('BUTTON', null, false), false);
  assert.equal(al.isTextPasteTarget(undefined, undefined, false), false);
});

test('CD5 D3.1 attachmentLimits: openEditableAttachments + saveEditedAttachments preserve unknown & >3 entries', () => {
  const futureAudio = { id: 'aud-1', type: 'audio-v2', blobKey: 'xyz' };
  const fourthValid = { id: 'l4', type: 'link', title: 'Fourth', url: 'https://example.com/4' };
  const rawStored = [
    { id: 'l1', type: 'link', title: 'One', url: 'https://example.com/1' },
    futureAudio,
    { id: 'l2', type: 'link', title: 'Two', url: 'https://example.com/2' },
    { id: 'l3', type: 'link', title: 'Three', url: 'https://example.com/3' },
    fourthValid,
  ];

  const opened = al.openEditableAttachments(rawStored);
  assert.equal(opened.renderable.length, 3);
  assert.deepEqual(
    opened.renderable.map(a => a.id),
    ['l1', 'l2', 'l3']
  );

  // Remove l2, rename l1, add l5 -> futureAudio and fourthValid stay in exact stored positions.
  const edited = [
    { ...opened.renderable[0], title: 'One Updated' },
    opened.renderable[2],
    { id: 'l5', type: 'link', title: 'Five', url: 'https://example.com/5' },
  ];
  const merged = al.saveEditedAttachments(opened.originalRaw, edited);
  assert.deepEqual(merged, [
    { id: 'l1', type: 'link', title: 'One Updated', url: 'https://example.com/1' },
    futureAudio,
    { id: 'l3', type: 'link', title: 'Three', url: 'https://example.com/3' },
    fourthValid,
    { id: 'l5', type: 'link', title: 'Five', url: 'https://example.com/5' },
  ]);
});

test('CD5 D3.1 modalDraft: scoped draft resolution, stale auto-clear, and disabled [[slug]] isolation', () => {
  localStorage.clear();
  try {
    // Sign in as Demo -> physical key is `pragya_draft:demo:...`
    localStorage.setItem('pragya_mock_mode', 'true');
    localStorage.setItem('pragya_mock_session', '1');

    const editKey = ds.getEditNoteDraftKey('note-42');
    md.flushModalDraft(editKey, true, {
      baseUpdatedAt: '2026-11-10T00:00:00.000Z',
      title: 'Draft Title',
    });
    assert.ok(localStorage.getItem('pragya_draft:demo:pragya_draft_edit_note-42'));

    // Disabled session (e.g. C3.3 capture-for-[[slug]]) never reads or clears the saved draft.
    const skipped = md.resolveModalDraftOnOpen({
      key: editKey,
      disabled: true,
      currentUpdatedAt: '2099-01-01T00:00:00.000Z',
      getBaseUpdatedAt: d => d.baseUpdatedAt,
      canRestore: () => true,
    });
    assert.equal(skipped.kind, 'canonical');
    assert.ok(localStorage.getItem('pragya_draft:demo:pragya_draft_edit_note-42'));

    // Fresh draft restores when edits differ from canonical.
    const restored = md.resolveModalDraftOnOpen({
      key: editKey,
      currentUpdatedAt: '2026-11-10T00:00:00.000Z',
      getBaseUpdatedAt: d => d.baseUpdatedAt,
      canRestore: d => d.title !== 'Canonical Title',
    });
    assert.equal(restored.kind, 'restored');
    assert.equal(restored.draft.title, 'Draft Title');

    // Another Google account never sees Demo's draft.
    localStorage.removeItem('pragya_mock_mode');
    localStorage.setItem('pragya_google_user', JSON.stringify({ email: 'reader@example.com' }));
    const otherScope = md.resolveModalDraftOnOpen({
      key: editKey,
      currentUpdatedAt: '2026-11-10T00:00:00.000Z',
      getBaseUpdatedAt: d => d.baseUpdatedAt,
      canRestore: () => true,
    });
    assert.equal(otherScope.kind, 'canonical');

    // Switch back to Demo and advance remote updatedAt -> stale draft is auto-cleared.
    localStorage.removeItem('pragya_google_user');
    localStorage.setItem('pragya_mock_mode', 'true');
    const stale = md.resolveModalDraftOnOpen({
      key: editKey,
      currentUpdatedAt: '2026-11-12T00:00:00.000Z',
      getBaseUpdatedAt: d => d.baseUpdatedAt,
      canRestore: () => true,
    });
    assert.equal(stale.kind, 'canonical');
    assert.equal(localStorage.getItem('pragya_draft:demo:pragya_draft_edit_note-42'), null);

    assert.equal(md.captureDraftRestoredMessage(0), 'Restored your unsaved draft.');
    assert.equal(
      md.captureDraftRestoredMessage(1),
      'Restored your unsaved draft (with 1 attachment).'
    );
    assert.equal(
      md.captureDraftRestoredMessage(2),
      'Restored your unsaved draft (with 2 attachments).'
    );

    // R1#2 / R2-1: untouched canonical session (`!isDirty && !dirtiedOrRestored`) is a strict no-op,
    // preserving a foreign-book QuickCapture draft in CAPTURE_DRAFT_KEY.
    const capKey = ds.CAPTURE_DRAFT_KEY;
    md.flushSessionModalDraft(capKey, true, true, {
      bookId: 'book-a',
      takeaway: 'Keep Book A draft',
    });
    assert.ok(localStorage.getItem('pragya_draft:demo:pragya_draft_capture_v1'));

    const untouchedBookB = md.flushSessionModalDraft(capKey, false, false, {
      bookId: 'book-b',
      takeaway: '',
    });
    assert.equal(untouchedBookB, 'noop');
    assert.equal(
      JSON.parse(localStorage.getItem('pragya_draft:demo:pragya_draft_capture_v1')).bookId,
      'book-a'
    );

    // Once dirtied or restored, returning to !isDirty clears the draft cleanly.
    const clearedAfterEdit = md.flushSessionModalDraft(capKey, false, true, {
      bookId: 'book-b',
      takeaway: '',
    });
    assert.equal(clearedAfterEdit, 'cleared');
    assert.equal(localStorage.getItem('pragya_draft:demo:pragya_draft_capture_v1'), null);

    // QA-43: unmodified Enter confirms attachment subform; IME and Cmd/Ctrl+Enter pass through.
    assert.equal(al.isAttachmentSubformEnter({ key: 'Enter' }), true);
    assert.equal(al.isAttachmentSubformEnter({ key: 'Enter', isComposing: true }), false);
    assert.equal(al.isAttachmentSubformEnter({ key: 'Enter', keyCode: 229 }), false);
    assert.equal(al.isAttachmentSubformEnter({ key: 'Enter', metaKey: true }), false);
    assert.equal(al.isAttachmentSubformEnter({ key: 'Enter', ctrlKey: true }), false);
    assert.equal(al.isAttachmentSubformEnter({ key: 'Escape' }), false);
  } finally {
    localStorage.clear();
  }
});

test('CD5 D3.1 wikilinks: getActiveWikilinkMatch and applyWikilinkSelection', () => {
  const text = 'Link to [[feedba';
  const match = wl.getActiveWikilinkMatch(text, text.length);
  assert.deepEqual(match, { query: 'feedba', startIndex: 8, endIndex: 16 });

  const applied = wl.applyWikilinkSelection(text, match, 'feedback-loops');
  assert.deepEqual(applied, {
    nextValue: 'Link to [[feedback-loops]]',
    nextCursor: 26,
  });

  // Completing inside pre-closed brackets `[[feed|]]` does not leave `]]]]`.
  const bracketed = 'See [[feed]] next';
  const midMatch = wl.getActiveWikilinkMatch(bracketed, 10);
  assert.deepEqual(midMatch, { query: 'feed', startIndex: 4, endIndex: 10 });
  const midApplied = wl.applyWikilinkSelection(bracketed, midMatch, 'feedback-loops');
  assert.deepEqual(midApplied, {
    nextValue: 'See [[feedback-loops]] next',
    nextCursor: 22,
  });

  assert.equal(wl.getActiveWikilinkMatch('Closed [[slug]] ', 16), null);
  assert.equal(wl.getActiveWikilinkMatch('Multiline [[foo\nbar', 19), null);
  // R1#1: single `[` or `]` inside `between` terminates matching (parity with `/\[\[([^[\]\n]*)$/`).
  assert.equal(wl.getActiveWikilinkMatch('See [[note] and more prose', 26), null);
  assert.equal(wl.getActiveWikilinkMatch('Broken [[foo [bar', 17), null);
  assert.deepEqual(wl.getActiveWikilinkMatch('[[[foo', 6), {
    query: 'foo',
    startIndex: 1,
    endIndex: 6,
  });
});

test('CD5 D3.1 deltaFormat: shouldDefaultOpenDeltaDetails & validateDeltaForSave', () => {
  assert.equal(
    df.shouldDefaultOpenDeltaDetails({
      bookKind: 'fiction',
      triggerBody: '',
      actionBody: '',
      deltaStatus: 'none',
    }),
    false
  );
  assert.equal(
    df.shouldDefaultOpenDeltaDetails({
      bookKind: 'fiction',
      triggerBody: 'rushing dialogue',
      actionBody: '',
      deltaStatus: 'none',
    }),
    true
  );
  assert.equal(
    df.shouldDefaultOpenDeltaDetails({
      bookKind: 'nonfiction',
      triggerBody: '',
      actionBody: '',
      deltaStatus: 'none',
    }),
    true
  );

  // 5-cap violation only when status === 'active'
  const capBlocked = df.validateDeltaForSave({
    deltaTrigger: 'WHEN metric spikes',
    deltaAction: 'DO wait',
    deltaStatus: 'active',
    otherActiveCount: 5,
    emptyActiveMessage: 'empty',
  });
  assert.equal(capBlocked.ok, false);

  const pausedAtCap = df.validateDeltaForSave({
    deltaTrigger: 'WHEN metric spikes',
    deltaAction: 'Do not panic',
    deltaStatus: 'paused',
    otherActiveCount: 5,
    emptyActiveMessage: 'empty',
  });
  assert.deepEqual(pausedAtCap, {
    ok: true,
    normalizedTrigger: 'metric spikes',
    normalizedAction: 'Do not panic',
  });

  const emptyActive = df.validateDeltaForSave({
    deltaTrigger: '   ',
    deltaAction: '',
    deltaStatus: 'active',
    otherActiveCount: 2,
    emptyActiveMessage: 'Need trigger or action',
  });
  assert.deepEqual(emptyActive, { ok: false, error: 'Need trigger or action' });
});

test('CD5 D3.1 invariants: BTN_* only in uiClasses.ts, shared PromptFallbackModal, and LOC targets', () => {
  const srcFiles = walkFiles(path.join(repoRoot, 'src'), ['.ts', '.tsx']);
  const btnDeclFiles = srcFiles
    .filter(f => /\bconst\s+BTN_/.test(fs.readFileSync(f, 'utf8')))
    .map(f => path.relative(repoRoot, f));
  assert.deepEqual(btnDeclFiles, ['src/components/common/uiClasses.ts']);

  const legacyFallbackRefs = srcFiles.filter(f =>
    fs.readFileSync(f, 'utf8').includes('CapstonePromptFallbackModal')
  );
  assert.deepEqual(legacyFallbackRefs, []);

  const lineCount = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8').split('\n').length - 1;
  assert.ok(
    lineCount('src/components/modals/EditNoteModal.tsx') <= Math.floor(1235 * 0.7),
    'EditNoteModal shrunk by >= 30%'
  );
  assert.ok(
    lineCount('src/components/modals/QuickCaptureModal.tsx') <= Math.floor(1185 * 0.7),
    'QuickCaptureModal shrunk by >= 30%'
  );
  assert.ok(
    lineCount('src/components/modals/DeepenNoteModal.tsx') <= Math.floor(1063 * 0.7),
    'DeepenNoteModal shrunk by >= 30%'
  );
  assert.ok(
    lineCount('src/components/views/BookDetailView.tsx') <= 600,
    'BookDetailView <= 600 LOC'
  );
});
