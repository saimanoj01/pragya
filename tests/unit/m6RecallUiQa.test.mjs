import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import module from 'node:module';
import { spawnSync } from 'node:child_process';
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

// QA (Batch 7) probes for the PWA capstone prompt / paste parser / chapter helpers.
// QA-22/23/24 were `todo` findings; fixed in the Batch 7 fix-up and now run as regular tests.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = rel => import(pathToFileURL(path.join(repoRoot, rel)).href);

const {
  buildCapstonePrompt,
  selectCapstoneNotes,
  truncateCapstoneText,
  parseCapstoneReply,
  parseLearningsInput,
} = await load('src/utils/capstonePrompt.ts');
const { formatChapterBadge, formatChapterPos, formatChapterLabel } = await load('src/utils/chapterFormat.ts');

const book = (o = {}) => ({
  id: 'b1', title: 'Dune', author: 'Frank Herbert', format: 'physical', kind: 'fiction', status: 'finished',
  currentPos: 400, totalPos: 400, posUnit: 'page', normalizedPos: 1, docUrl: '', meta: { updatedAt: 'x' }, ...o,
});
const note = (id, pos, o = {}) => ({
  id, slug: id, bookId: 'b1', createdAt: `2026-01-01T00:00:${String(pos % 60).padStart(2, '0')}Z`, updatedAt: 'x',
  pos, normalizedPos: 0, status: 'saved', source: 'app', tags: [], quote: '', takeaway: `t${id}`,
  contextMechanism: '', critique: '', deltaTrigger: '', deltaAction: '', deltaStatus: 'none',
  meta: { attachments: [], links: [] }, ...o,
});

const pythonAvailable = spawnSync('python3', ['--version']).status === 0;

function pyNotesSummary(bookObj, notes) {
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(repoRoot, 'scripts'))})
import pragya_cli as c
p = json.load(sys.stdin)
entries, omitted = c.build_notes_summary(p["book"], p["notes"])
print(json.dumps({"ids": [e["id"] for e in entries], "omitted": omitted,
                  "takeaways": [e["takeaway"] for e in entries],
                  "badges": [c.format_chapter_badge((n.get("meta") or {}).get("chapter"), n["pos"], p["book"]["posUnit"]) for n in p["notes"]]}, ensure_ascii=False))
`;
  const res = spawnSync('python3', ['-c', script], { input: JSON.stringify({ book: bookObj, notes }), encoding: 'utf8' });
  if (res.status !== 0) throw new Error(res.stderr);
  return JSON.parse(res.stdout);
}

test('QA: PWA prompt selection == CLI notesSummary (order, 60 cap atomic-first, omitted, ASCII truncation)', { skip: !pythonAvailable }, () => {
  const notes = [];
  for (let i = 0; i < 70; i += 1) notes.push(note(`s${String(i).padStart(2, '0')}`, i + 1, { createdAt: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:${String(i % 60).padStart(2, '0')}Z` }));
  for (let i = 0; i < 8; i += 1) notes.push(note(`a${i}`, 200 + i, { status: 'atomic', createdAt: '2025-01-01T00:00:00Z' }));
  notes.push(note('long', 300, { takeaway: 'x'.repeat(400) }));
  notes.push(note('inbox', 5, { status: 'inbox' }));
  notes.push(note('other', 5, { bookId: 'b2' }));
  const b = book();
  const ts = selectCapstoneNotes(b, notes);
  const py = pyNotesSummary(b, notes);
  assert.deepEqual(ts.notes.map(n => n.id), py.ids);
  assert.equal(ts.omitted, py.omitted);
  assert.ok(py.ids.includes('a0') && py.ids.includes('a7'));
  const longTs = truncateCapstoneText('x'.repeat(400));
  assert.equal(longTs, py.takeaways[py.ids.indexOf('long')] ?? longTs);
  assert.equal(longTs.length, 280);
});

test('QA: formatChapterBadge/Pos parity with Python on an extended table', { skip: !pythonAvailable }, () => {
  const chapters = ['3', '03', 3, '3.5', 'Chapter 3', 'Run', '  ', undefined, true, '३', '３', '  12  ', 'Part II: The Fall'];
  const notes = chapters.map((ch, i) => note(`c${i}`, i * 7.5, { meta: { attachments: [], links: [], ...(ch === undefined ? {} : { chapter: ch }) } }));
  for (const unit of ['page', 'percent', 'loc']) {
    const py = pyNotesSummary(book({ posUnit: unit }), notes);
    chapters.forEach((ch, i) => {
      assert.equal(formatChapterBadge(ch, notes[i].pos, unit), py.badges[i], `${unit} ${JSON.stringify(ch)}`);
    });
  }
  assert.equal(formatChapterLabel('३'), '३');
  assert.equal(formatChapterPos('7', 42, 'page'), 'Ch. 7 · p. 42');
});

test('QA-22: prompt for an unfinished book with a capstone must not include notes ahead of the bookmark', () => {
  const b = book({ status: 'reading', currentPos: 100, normalizedPos: 0.25, meta: { updatedAt: 'x', capstone: { arcOrThesis: 'A', keyLearnings: [], perspectiveShift: '' } } });
  const prompt = buildCapstonePrompt(b, [note('early', 50), note('ahead', 300, { takeaway: 'SECRET_ENDING' })]);
  assert.ok(!prompt.includes('SECRET_ENDING'));
});

test('QA-23: truncation never splits a surrogate pair and counts code points like the CLI', () => {
  const t = truncateCapstoneText('📚'.repeat(300));
  assert.ok(!/[\uD800-\uDBFF]…$/.test(t), 'lone high surrogate before the ellipsis');
  assert.equal([...t].length, 280);
});

test('QA: paste parser edge cases', () => {
  const crlf = 'THESIS: Structure drives behaviour.\r\nKEY LEARNINGS:\r\n- one\r\n\r\n- two\r\n* three\r\n1) four\r\nHOW MY THINKING SHIFTED: I look for loops.\r\n\r\nWould you like me to add anything?';
  assert.deepEqual(parseCapstoneReply(crlf), {
    arcOrThesis: 'Structure drives behaviour.',
    keyLearnings: ['one', 'two', 'three', 'four'],
    perspectiveShift: 'I look for loops.',
  });
  // Markdown-decorated headers and lower case.
  assert.deepEqual(parseCapstoneReply('**Arc:** a story\n## key learnings:\n• x\n> how my thinking shifted: changed'), {
    arcOrThesis: 'a story', keyLearnings: ['x'], perspectiveShift: 'changed',
  });
  // Missing sections → only found fields; garbage → {}.
  assert.deepEqual(parseCapstoneReply('KEY LEARNINGS:\n- only this'), { keyLearnings: ['only this'] });
  assert.deepEqual(parseCapstoneReply('Hello! Here is your draft.'), {});
  assert.deepEqual(parseCapstoneReply(''), {});
  // Multi-line value without a blank line joins into one line.
  assert.equal(parseCapstoneReply('ARC: line one\nline two').arcOrThesis, 'line one line two');
  assert.deepEqual(parseLearningsInput('  - a\n\n2. b\n•c\n   '), ['a', 'b', 'c']);
});

test('QA-24: closing question on the line right after HOW MY THINKING SHIFTED is not absorbed', () => {
  const out = parseCapstoneReply('THESIS: t\nKEY LEARNINGS:\n- l\nHOW MY THINKING SHIFTED: s\nIs there anything you want me to change?');
  assert.equal(out.perspectiveShift, 's');
});

// --- QA re-verify (Batch 7 fix-up): full per-note parity of the Copy prompt vs the CLI ------

const { capstoneNoteLabel, capstoneEligibleNotes, formatOmittedLine } = await load('src/utils/capstonePrompt.ts');

function pyFull(bookObj, notes) {
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(repoRoot, 'scripts'))})
import pragya_cli as c
p = json.load(sys.stdin)
entries, omitted = c.build_notes_summary(p["book"], p["notes"])
by_id = {n["id"]: n for n in p["notes"]}
out = []
for e in entries:
    title, _ = c._saved_title_info(by_id[e["id"]])
    out.append({"id": e["id"], "label": e["label"], "title": title, "quote": e["quote"], "takeaway": e["takeaway"], "delta": e["delta"]})
print(json.dumps({"entries": out, "omitted": omitted}, ensure_ascii=False))
`;
  const res = spawnSync('python3', ['-c', script], { input: JSON.stringify({ book: bookObj, notes }), encoding: 'utf8' });
  if (res.status !== 0) throw new Error(res.stderr);
  return JSON.parse(res.stdout);
}

const oneLine = s => String(s || '').replace(/\s*[\r\n]+\s*/g, ' ').trim();

test('QA re-verify: Copy-prompt blocks == CLI notesSummary per note (label, 8-word title, raw-text truncation, delta rule)', { skip: !pythonAvailable }, () => {
  const b = book({ kind: 'nonfiction' });
  const notes = [
    note('titled', 10, { meta: { attachments: [], links: [], title: 'Explicit Title', chapter: '3' } }),
    note('short', 20, { takeaway: 'Exactly five words here.' }),
    note('long8', 30, { takeaway: 'one two three four five six seven eight nine ten.' }),
    note('nlcount', 40, { takeaway: 'a\n'.repeat(150) + 'tail' }), // newlines count toward 280 (raw)
    note('emoji', 50, { quote: '📚'.repeat(300), takeaway: '' }),
    note('atomic', 60, { status: 'atomic', deltaTrigger: 'WHEN it rains', deltaAction: 'DO read', meta: { attachments: [], links: [], chapter: 'Part II' } }),
    note('savedDelta', 70, { deltaStatus: 'paused', deltaTrigger: 'WHEN x', deltaAction: '' }),
    note('savedNoDelta', 80, { deltaTrigger: 'WHEN orphan' }),
    note('blank', 90, { takeaway: '', quote: 'q only' }),
  ];
  const py = pyFull(b, notes);
  const { notes: picked, omitted } = (() => {
    const r = selectCapstoneNotes(b, notes);
    return { notes: r.notes, omitted: r.omitted };
  })();
  assert.deepEqual(picked.map(n => n.id), py.entries.map(e => e.id));
  assert.equal(omitted, py.omitted);
  const prompt = buildCapstonePrompt(b, notes);
  for (const e of py.entries) {
    const n = notes.find(x => x.id === e.id);
    assert.equal(formatChapterPos(n.meta?.chapter, n.pos, b.posUnit), e.label, `label ${e.id}`);
    assert.equal(capstoneNoteLabel(n), e.title, `title ${e.id}`);
    assert.equal(truncateCapstoneText(n.takeaway), e.takeaway, `takeaway ${e.id}`);
    assert.equal(truncateCapstoneText(n.quote), e.quote, `quote ${e.id}`);
    assert.ok(prompt.includes(`[${e.label}] ${e.title}`), `heading ${e.id}`);
    if (e.takeaway) assert.ok(prompt.includes(`Takeaway: ${oneLine(e.takeaway)}`), `takeaway line ${e.id}`);
    const hasDeltaLine = new RegExp(`\\[${e.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\] [^\\n]*\\n(?:[^\\n]+\\n)*?Delta: `).test(prompt.split('\n\n').find(bl => bl.startsWith(`[${e.label}] `)) + '\n');
    assert.equal(hasDeltaLine, e.delta !== null, `delta ${e.id}`);
  }
});

test('QA re-verify: 60 cap + omitted wording parity; unfinished-book eligibility excludes spoilers & sealed predictions', { skip: !pythonAvailable }, () => {
  const many = Array.from({ length: 63 }, (_, i) => note(`n${String(i).padStart(2, '0')}`, i + 1, { createdAt: `2026-02-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z` }));
  const py = pyFull(book(), many);
  const r = selectCapstoneNotes(book(), many);
  assert.deepEqual(r.notes.map(n => n.id), py.entries.map(e => e.id));
  assert.equal(r.omitted, 3);
  assert.equal(formatOmittedLine(3), '(+3 more notes left out for length)');
  assert.equal(formatOmittedLine(1), '(+1 more note left out for length)');
  const reading = book({ status: 'reading', kind: 'fiction', currentPos: 100, normalizedPos: 0.25 });
  const eligible = capstoneEligibleNotes(reading, [
    note('at', 100),
    note('ahead', 101),
    note('pred', 50, { meta: { attachments: [], links: [], isPrediction: true } }),
  ]).map(n => n.id);
  assert.deepEqual(eligible, ['at']);
  assert.deepEqual(capstoneEligibleNotes(book({ kind: 'fiction' }), [note('ahead', 300), note('pred', 50, { meta: { attachments: [], links: [], isPrediction: true } })]).map(n => n.id).sort(), ['ahead', 'pred']);
});
