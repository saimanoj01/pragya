// Type declarations for scripts/swPrecache.mjs (imported by vite.config.ts).
export const PRECACHE_PLACEHOLDER: string;
export const BUILD_ID_PLACEHOLDER: string;
export const SHELL_FILES: string[];
export function buildPrecacheList(files: string[]): string[];
export function computeBuildId(list: string[], contents?: Record<string, string | Uint8Array>): string;
export function injectSwManifest(source: string, list: string[], buildId: string): string;
export function injectIntoDist(
  outDir: string,
  options?: { templatePath?: string }
): { buildId: string; list: string[] } | null;
