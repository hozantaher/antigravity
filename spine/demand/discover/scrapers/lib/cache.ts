import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Create a file-system cache with TTL.
 * Used by sitemap scrapers to avoid re-downloading sitemaps.
 */
export const createFileCache = (cacheDir: string, maxAgeMs: number = DEFAULT_MAX_AGE_MS) => {
  const isValid = (cacheKey: string): boolean => {
    const cachePath = resolve(cacheDir, cacheKey);
    if (!existsSync(cachePath)) return false;
    return Date.now() - statSync(cachePath).mtimeMs < maxAgeMs;
  };

  const get = (cacheKey: string): string | null => {
    const cachePath = resolve(cacheDir, cacheKey);
    if (!isValid(cacheKey)) return null;
    return readFileSync(cachePath, 'utf-8');
  };

  const set = (cacheKey: string, content: string): void => {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(resolve(cacheDir, cacheKey), content, 'utf-8');
  };

  return { isValid, get, set };
};

export type FileCache = ReturnType<typeof createFileCache>;
