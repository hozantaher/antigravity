import { execFile } from 'child_process';
import { accessSync, constants } from 'fs';
import { writeFile, readFile, stat, unlink, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { promisify } from 'util';

const exec = promisify(execFile);

/** Detect LibreOffice binary and temp dir that works with it.
 *  Snap LO can only access files under ~/snap/libreoffice/common/. */
const detectLibreOffice = (): { binary: string; tmpDir: string } => {
  try {
    accessSync('/snap/bin/libreoffice', constants.X_OK);
    return {
      binary: '/snap/bin/libreoffice',
      tmpDir: join(process.env.HOME || tmpdir(), 'snap', 'libreoffice', 'common', 'rozporuj-tmp'),
    };
  } catch { /* no snap — use system LO (Docker, CI) */ }
  return { binary: 'libreoffice', tmpDir: tmpdir() };
};

const LO = detectLibreOffice();

// Exec timeout for LibreOffice. Exposed so tests can verify the timeout +
// SIGKILL path without waiting the real 30s.
export const DOCX_TO_PDF_TIMEOUT_MS = 30_000;

export const docxToPdf = async (docxBuffer: Buffer): Promise<Buffer> => {
  const { binary, tmpDir: baseTmp } = LO;
  const id = randomUUID();
  // H4 fix: per-invocation tmp subdir. Previously all jobs shared /tmp (or
  // the snap dir), relying on UUID-prefixed filenames to avoid collision.
  // A dedicated subdir makes cleanup atomic (single rm) and eliminates any
  // chance that a stray collision leaks across concurrent jobs.
  const tmp = join(baseTmp, `rozporuj-${id}`);
  const docxPath = join(tmp, `${id}.docx`);
  const pdfPath = join(tmp, `${id}.pdf`);
  const profileDir = join(tmp, `lo-${id}`);

  try {
    await mkdir(tmp, { recursive: true });
    await writeFile(docxPath, docxBuffer);

    // Unique UserInstallation per invocation — LibreOffice is not safe for
    // concurrent execution sharing the same profile directory.
    //
    // H4 fix: explicit killSignal: 'SIGKILL' on timeout. Default SIGTERM can be
    // ignored by a stuck soffice (Java/GTK can mask it), leaving a zombie
    // occupying the worker slot forever. SIGKILL guarantees the child dies.
    await exec(
      binary,
      [
        '--headless', '--norestore',
        `-env:UserInstallation=file://${profileDir}`,
        '--convert-to', 'pdf', '--outdir', tmp, docxPath,
      ],
      { timeout: DOCX_TO_PDF_TIMEOUT_MS, killSignal: 'SIGKILL' },
    );

    const pdfStat = await stat(pdfPath).catch(() => null);
    if (!pdfStat || pdfStat.size === 0) {
      throw new Error('LibreOffice failed to generate PDF');
    }

    return await readFile(pdfPath);
  } finally {
    // Single rm of the whole per-job tmp covers docx, pdf, and profile.
    // Individual unlinks kept for backward-compatible visibility in tests,
    // but the authoritative cleanup is the rm of the parent dir.
    await Promise.all([
      unlink(docxPath).catch(() => {}),
      unlink(pdfPath).catch(() => {}),
      rm(profileDir, { recursive: true, force: true }).catch(() => {}),
      rm(tmp, { recursive: true, force: true }).catch(() => {}),
    ]);
  }
};
