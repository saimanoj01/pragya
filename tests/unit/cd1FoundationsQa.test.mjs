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

// QA (CD Batch 1a): cross-runtime TZ parity for shuffle date keys / staleness / order, and
// the DO-prefix table, TS vs Python, in many zones (UTC+14, UTC-12, DST edges, :30/:45).


const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pythonAvailable = spawnSync('python3', ['--version']).status === 0;

const ZONES = [
  'UTC', 'Pacific/Kiritimati', 'Etc/GMT+12', 'America/Los_Angeles', 'America/New_York',
  'Europe/London', 'Australia/Lord_Howe', 'Asia/Kathmandu', 'Asia/Kolkata', 'America/St_Johns',
];
const STAMPS = [
  '2026-03-08T06:59:59Z', '2026-03-08T07:00:00Z', '2026-03-08T10:30:00Z', // US DST start
  '2026-11-01T05:59:59Z', '2026-11-01T06:00:00Z', '2026-11-01T09:00:00Z', // US DST end
  '2026-03-29T00:59:59Z', '2026-03-29T01:00:00Z', // EU DST start
  '2026-04-04T14:59:59Z', '2026-04-04T15:00:00Z', // Lord Howe 30-min DST end
  '2026-12-31T10:00:00Z', '2026-12-31T23:59:59.999Z', '2027-01-01T11:59:59Z',
  '2026-06-15T12:00:00+05:45', '2026-06-15T00:15:00-12:00', '2026-06-15T23:50:00+14:00',
  '2026-06-15T12:00:00', '2026-06-15', '2026-06-15 23:00:00Z', 'garbage', '',
];

const SHUFFLE_TODAYS = ['2026-03-08', '2026-11-01', '2026-12-31', '2027-01-01'];

function tsOutputs(tz) {
  const fixture = path.join(repoRoot, 'tests/unit/fixtures/cd1_parity.json');
  const src = `
    import fs from 'node:fs'; import path from 'node:path'; import module from 'node:module';
    import { fileURLToPath, pathToFileURL } from 'node:url';
    module.registerHooks({ resolve(spec, ctx, next) {
      if ((spec.startsWith('./') || spec.startsWith('../')) && !path.extname(spec) && ctx.parentURL) {
        const dir = path.dirname(fileURLToPath(ctx.parentURL));
        for (const ext of ['.ts', '.mjs', '.js']) { const c = path.resolve(dir, spec + ext); if (fs.existsSync(c)) return next(pathToFileURL(c).href, ctx); }
      } return next(spec, ctx); } });
    const m = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, 'src/utils/takeawayShuffle.ts')).href)});
    const d = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, 'src/utils/deltaFormat.ts')).href)});
    const fx = JSON.parse(fs.readFileSync(${JSON.stringify(fixture)}, 'utf8'));
    const stamps = ${JSON.stringify(STAMPS)};
    const notes = stamps.filter(s => s).map((s, i) => ({ ...fx.shuffle.notes[0], id: 'q' + i, createdAt: '2025-01-01T00:00:00Z', meta: { lastReviewedAt: s } }));
    const out = {
      keys: stamps.map(s => m.toLocalDateKey(s)),
      days: stamps.map(s => m.getCalendarDaysBetween(s, '2026-12-31')),
      buckets: ${JSON.stringify(SHUFFLE_TODAYS)}.map(t => notes.map(n => m.shuffleStalenessBucket(n, t))),
      order: ${JSON.stringify(SHUFFLE_TODAYS)}.map(t => m.selectTakeawayShuffle([...fx.shuffle.notes, ...notes], fx.shuffle.books, t, 50).map(n => n.id)),
      doPrefix: ${JSON.stringify(EXTRA_DO)}.map(s => d.normalizeDeltaAction(s)),
    };
    process.stdout.write(JSON.stringify(out));
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', src], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(res.stderr);
  return JSON.parse(res.stdout);
}

function pyOutputs(tz) {
  const fixture = path.join(repoRoot, 'tests/unit/fixtures/cd1_parity.json');
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(repoRoot, 'scripts'))})
import pragya_cli as c
fx = json.load(open(${JSON.stringify(fixture)}))
stamps = json.loads(${JSON.stringify(JSON.stringify(STAMPS))})
todays = json.loads(${JSON.stringify(JSON.stringify(SHUFFLE_TODAYS))})
base = fx["shuffle"]["notes"][0]
notes = [dict(base, id="q%d" % i, createdAt="2025-01-01T00:00:00Z", meta={"lastReviewedAt": s}) for i, s in enumerate([s for s in stamps if s])]
out = {
  "keys": [c.to_local_date_key(s) for s in stamps],
  "days": [c.calendar_days_between(s, "2026-12-31") for s in stamps],
  "buckets": [[c.shuffle_staleness_bucket(n, t) for n in notes] for t in todays],
  "order": [[n["id"] for n in c.select_takeaway_shuffle(fx["shuffle"]["notes"] + notes, fx["shuffle"]["books"], t, 50)] for t in todays],
  "doPrefix": [c.normalize_delta_action(s) for s in json.loads(${JSON.stringify(JSON.stringify(EXTRA_DO))})],
}
print(json.dumps(out))
`;
  const res = spawnSync('python3', ['-c', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(res.stderr);
  return JSON.parse(res.stdout);
}

const EXTRA_DO = [
  'DO NOTHING until Monday', 'do nothing.', 'Do not.', 'Do-not disturb', "Do n't panic", 'Do never reply',
  'Do no more than 3', 'DO: Do not wait', 'do:do not', 'Do\tnot tabbed', 'DO\u00a0not nbsp', 'do  not  spaced',
  'Do nothings', 'Do notify the team', 'Do nonetheless', 'DO DO DO', 'Do: ', 'Do, then wait',
];

test('QA: TS ↔ Python shuffle date keys / days / buckets / order / DO-prefix agree in every zone', { skip: !pythonAvailable }, () => {
  for (const tz of ZONES) {
    const ts = tsOutputs(tz);
    const py = pyOutputs(tz);
    assert.deepEqual(ts.keys, py.keys, `keys ${tz}`);
    assert.deepEqual(ts.days, py.days, `days ${tz}`);
    assert.deepEqual(ts.buckets, py.buckets, `buckets ${tz}`);
    assert.deepEqual(ts.order, py.order, `order ${tz}`);
    assert.deepEqual(ts.doPrefix, py.doPrefix, `DO ${tz}`);
  }
});

test('QA: local date keys are really local (UTC+14 vs UTC-12 differ by a day for the same instant)', { skip: !pythonAvailable }, () => {
  const plus14 = tsOutputs('Pacific/Kiritimati').keys;
  const minus12 = tsOutputs('Etc/GMT+12').keys;
  const i = STAMPS.indexOf('2026-12-31T10:00:00Z');
  assert.equal(plus14[i], '2027-01-01');
  assert.equal(minus12[i], '2026-12-30');
  // Date-only and space-separated values pass through unchanged everywhere.
  assert.equal(plus14[STAMPS.indexOf('2026-06-15')], '2026-06-15');
  assert.equal(minus12[STAMPS.indexOf('2026-06-15 23:00:00Z')], '2026-06-15');
  assert.equal(plus14[STAMPS.indexOf('garbage')], null);
});

test('QA: DO-prefix decisions (documented expectations)', { skip: !pythonAvailable }, () => {
  const out = tsOutputs('UTC').doPrefix;
  const got = Object.fromEntries(EXTRA_DO.map((s, i) => [s, out[i]]));
  assert.equal(got['DO NOTHING until Monday'], 'DO NOTHING until Monday');
  assert.equal(got['Do not.'], 'Do not.');
  assert.equal(got['DO: Do not wait'], 'Do not wait');
  assert.equal(got['Do\tnot tabbed'], 'Do\tnot tabbed');
  assert.equal(got['Do notify the team'], 'notify the team');
  assert.equal(got['Do nothings'], 'nothings');
  assert.equal(got['DO DO DO'], '');
});
