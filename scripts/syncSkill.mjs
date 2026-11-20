import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

export const CLI_SOURCE = path.join(repoRoot, 'scripts', 'pragya_cli.py');
export const SKILL_CLI_TARGET = path.join(
  repoRoot,
  '.agents',
  'skills',
  'pragya-companion',
  'scripts',
  'pragya_cli.py'
);

export function syncSkillCli({ checkOnly = false, source = CLI_SOURCE, target = SKILL_CLI_TARGET } = {}) {
  if (!fs.existsSync(source)) {
    return { ok: false, error: `Source CLI not found: ${source}` };
  }
  const srcBuf = fs.readFileSync(source);

  if (checkOnly) {
    if (!fs.existsSync(target)) {
      return { ok: false, error: `Skill CLI copy not found: ${target}. Run \`npm run sync:skill\`.` };
    }
    const dstBuf = fs.readFileSync(target);
    if (Buffer.compare(srcBuf, dstBuf) !== 0) {
      return {
        ok: false,
        error:
          'Skill CLI copy is out of sync with scripts/pragya_cli.py. Run `npm run sync:skill` to synchronize.',
      };
    }
    return { ok: true, synced: true, bytes: srcBuf.length };
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  const verified = fs.readFileSync(target);
  if (Buffer.compare(srcBuf, verified) !== 0) {
    return { ok: false, error: 'Post-copy byte verification failed between CLI and skill copy.' };
  }
  return { ok: true, synced: true, bytes: srcBuf.length };
}

function samePath(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

const isEntrypoint = Boolean(process.argv[1]) && samePath(process.argv[1], fileURLToPath(import.meta.url));

if (isEntrypoint) {
  const checkOnly = process.argv.includes('--check');
  const res = syncSkillCli({ checkOnly });
  if (!res.ok) {
    console.error(res.error);
    process.exit(1);
  }
  console.log(
    checkOnly
      ? `Skill CLI copy is byte-identical (${res.bytes} bytes).`
      : `Synced scripts/pragya_cli.py -> .agents/skills/pragya-companion/scripts/pragya_cli.py (${res.bytes} bytes, verified).`
  );
}
