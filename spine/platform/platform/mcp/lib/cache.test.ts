import { describe, it, expect } from 'vitest';
import { createFileCache } from './cache.js';

describe('createFileCache path traversal guard (M4)', () => {
  it('throws on cacheKey containing forward slash', () => {
    const cache = createFileCache('/tmp/test-cache-guard');
    expect(() => cache.isValid('subdir/file')).toThrow(/invalid cache key/i);
    expect(() => cache.get('subdir/file')).toThrow(/invalid cache key/i);
    expect(() => cache.set('subdir/file', 'data')).toThrow(/invalid cache key/i);
  });

  it('throws on cacheKey containing double-dot traversal', () => {
    const cache = createFileCache('/tmp/test-cache-guard');
    expect(() => cache.isValid('../etc/passwd')).toThrow(/invalid cache key/i);
    expect(() => cache.get('../etc/passwd')).toThrow(/invalid cache key/i);
    expect(() => cache.set('../etc/passwd', 'data')).toThrow(/invalid cache key/i);
  });

  it('throws on cacheKey that is only dots', () => {
    const cache = createFileCache('/tmp/test-cache-guard');
    expect(() => cache.isValid('..')).toThrow(/invalid cache key/i);
  });

  it('throws on nested path traversal disguised with URL encoding equivalent', () => {
    const cache = createFileCache('/tmp/test-cache-guard');
    // key with both slash and dots
    expect(() => cache.isValid('a/../b')).toThrow(/invalid cache key/i);
  });

  it('allows safe flat cacheKey names without touching the filesystem', () => {
    // A non-existent dir + valid key → isValid returns false (file not present)
    const cache = createFileCache('/tmp/does-not-exist-test-cache-guard');
    // Should NOT throw — safe flat key
    const result = cache.isValid('sitemap-2024-01_xml');
    expect(result).toBe(false);
  });

  it('allows single dot in filename extension', () => {
    const cache = createFileCache('/tmp/does-not-exist-test-cache-guard');
    // sitemap.xml contains a single dot — allowed as long as no ".."
    const result = cache.isValid('sitemap.xml');
    expect(result).toBe(false);
  });

  it('blocks traversal when double-dot appears later in the key', () => {
    const cache = createFileCache('/tmp/test-cache-guard');
    expect(() => cache.isValid('../../etc/shadow')).toThrow(/invalid cache key/i);
  });
});
