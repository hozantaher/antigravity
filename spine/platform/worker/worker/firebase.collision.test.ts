/**
 * D-2 — Sprint D worker M3: Firebase upload collision guard.
 *
 * Two parallel jobs writing the same storage path (campaign step 1 +
 * step 2 firing concurrently for one contact) used to silently
 * overwrite each other. The new uploadFileExclusive helper sets the
 * Firebase precondition `ifGenerationMatch: 0` (only write if the
 * file doesn't exist yet) and throws FirebaseCollisionError when the
 * second writer loses the race.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

const { mockSave, mockGetSignedUrl, mockGetFiles } = vi.hoisted(() => ({
  mockSave: vi.fn(),
  mockGetSignedUrl: vi.fn(),
  mockGetFiles: vi.fn(),
}));

vi.mock('firebase-admin/storage', () => ({
  getStorage: () => ({
    bucket: () => ({
      file: () => ({
        save: mockSave,
        getSignedUrl: mockGetSignedUrl,
        exists: vi.fn().mockResolvedValue([false]),
        download: vi.fn().mockResolvedValue([Buffer.from('x')]),
      }),
      getFiles: mockGetFiles,
    }),
  }),
}));
vi.mock('firebase-admin/app', () => ({
  initializeApp: vi.fn(),
  cert: vi.fn(),
  getApps: () => [{}], // pretend app already initialized so ensureApp is no-op
}));

beforeEach(() => {
  mockSave.mockReset();
  mockGetSignedUrl.mockReset();
  mockGetSignedUrl.mockResolvedValue(['https://signed.url/file']);
})

import { uploadFileExclusive, FirebaseCollisionError } from './firebase.js';

describe('uploadFileExclusive — D-2', () => {
  it('happy path: file did not exist → save succeeds, returns signed URL', async () => {
    mockSave.mockResolvedValue(undefined);
    const url = await uploadFileExclusive('results/abc/odpor.pdf', Buffer.from('pdf'), 'application/pdf');
    expect(url).toBe('https://signed.url/file');
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it('passes ifGenerationMatch: 0 precondition to bucket.file().save()', async () => {
    mockSave.mockResolvedValue(undefined);
    await uploadFileExclusive('results/abc/odpor.pdf', Buffer.from('pdf'), 'application/pdf');
    const opts = mockSave.mock.calls[0][1];
    expect(opts).toBeDefined();
    expect(opts.preconditionOpts?.ifGenerationMatch).toBe(0);
  });

  it('throws FirebaseCollisionError on Firebase 412 Precondition Failed', async () => {
    const e: Error & { code?: number } = new Error('precondition failed');
    e.code = 412;
    mockSave.mockRejectedValue(e);
    await expect(
      uploadFileExclusive('results/abc/odpor.pdf', Buffer.from('pdf'), 'application/pdf')
    ).rejects.toBeInstanceOf(FirebaseCollisionError);
  });

  it('FirebaseCollisionError carries the storage path so callers can log/retry', async () => {
    const e: Error & { code?: number } = new Error('precondition failed');
    e.code = 412;
    mockSave.mockRejectedValue(e);
    try {
      await uploadFileExclusive('results/abc/odpor.pdf', Buffer.from('pdf'), 'application/pdf');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(FirebaseCollisionError);
      expect((err as FirebaseCollisionError).storagePath).toBe('results/abc/odpor.pdf');
    }
  });

  it('non-collision Firebase errors propagate as-is (not wrapped)', async () => {
    const e = new Error('network down');
    mockSave.mockRejectedValue(e);
    await expect(
      uploadFileExclusive('results/abc/odpor.pdf', Buffer.from('pdf'), 'application/pdf')
    ).rejects.toBe(e);
  });
});
