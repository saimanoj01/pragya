// B3.1: build-time precache manifest + versioned cache key for public/sw.js.
// Pure helpers (buildPrecacheList / computeBuildId / injectSwManifest) are unit-tested;
// injectIntoDist() is called from the `pragyaSwPrecache()` Vite plugin in closeBundle.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const PRECACHE_PLACEHOLDER = 'self.__PRAGYA_PRECACHE__ || []';
export const BUILD_ID_PLACEHOLDER = "'__PRAGYA_BUILD_ID__'";

/** App-shell files (relative to the SW scope) that are precached when present in dist. */
export const SHELL_FILES = [
  'index.html',
  'manifest.webmanifest',
  'lotus.svg',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
];

function normalizePath(file) {
  return String(file).split('\\').join('/').replace(/^\.?\/+/, '');
}

/**
 * Sorted, de-duplicated list of scope-relative URLs to precache: every emitted
 * `assets/*` file (except source maps) plus the shell files that exist.
 * @param {string[]} files paths relative to the build output directory
 * @returns {string[]}
 */
export function buildPrecacheList(files) {
  const out = new Set();
  for (const raw of files || []) {
    const file = normalizePath(raw);
    if (!file) continue;
    if (/^assets\/[^/]+$/.test(file) && !file.endsWith('.map')) out.add(file);
    else if (SHELL_FILES.includes(file)) out.add(file);
  }
  return [...out].sort();
}

/**
 * 12-char hex build id: sha256 over the sorted list and, when provided, each file's
 * content (so an unhashed shell file such as index.html also rotates the cache).
 * @param {string[]} list
 * @param {Record<string, string | Uint8Array>} [contents]
 * @returns {string}
 */
export function computeBuildId(list, contents) {
  const hash = createHash('sha256');
  for (const file of [...list].sort()) {
    hash.update(file);
    hash.update('\0');
    if (contents && contents[file] != null) hash.update(contents[file]);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}

/**
 * Replace both placeholders in the sw.js source. Throws when either is missing so a
 * refactor of sw.js cannot silently ship an un-versioned worker.
 * @param {string} source
 * @param {string[]} list
 * @param {string} buildId
 * @returns {string}
 */
export function injectSwManifest(source, list, buildId) {
  if (!source.includes(PRECACHE_PLACEHOLDER) || !source.includes(BUILD_ID_PLACEHOLDER)) {
    throw new Error('sw.js is missing the precache/build-id placeholders');
  }
  if (!/^[0-9a-f]{12}$/.test(buildId)) throw new Error(`invalid build id: ${buildId}`);
  return source
    .split(PRECACHE_PLACEHOLDER)
    .join(JSON.stringify(list))
    .split(BUILD_ID_PLACEHOLDER)
    .join(JSON.stringify(buildId));
}

function listFiles(dir, root = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, root));
    else out.push(normalizePath(relative(root, full)));
  }
  return out;
}

/**
 * Rewrite `${outDir}/sw.js` with the precache list and build id.
 * R1#5: the placeholder template is read from `templatePath` (the pristine public/sw.js)
 * when given, so watch-mode rebuilds re-inject cleanly even though dist/sw.js was already
 * rewritten by the previous build.
 * @param {string} outDir
 * @param {{ templatePath?: string }} [options]
 * @returns {{ buildId: string, list: string[] } | null} null when dist has no sw.js
 */
export function injectIntoDist(outDir, options = {}) {
  const swPath = join(outDir, 'sw.js');
  if (!existsSync(swPath)) return null;
  const templatePath =
    options.templatePath && existsSync(options.templatePath) ? options.templatePath : swPath;
  const list = buildPrecacheList(listFiles(outDir));
  const contents = {};
  for (const file of list) contents[file] = readFileSync(join(outDir, file));
  const buildId = computeBuildId(list, contents);
  writeFileSync(swPath, injectSwManifest(readFileSync(templatePath, 'utf8'), list, buildId));
  return { buildId, list };
}
