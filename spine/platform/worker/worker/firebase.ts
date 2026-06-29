import { readFileSync } from 'fs';
import { initializeApp, cert, getApps, type ServiceAccount } from 'firebase-admin/app';
import { getStorage, type Bucket } from 'firebase-admin/storage';

let cachedBucket: Bucket | null = null;

const ensureApp = () => {
  if (getApps().length > 0) return;

  // Support base64-encoded service account JSON (for Railway env vars)
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const filePath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  let serviceAccount: ServiceAccount;
  if (b64) {
    serviceAccount = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8')) as ServiceAccount;
  } else if (filePath) {
    serviceAccount = JSON.parse(readFileSync(filePath, 'utf-8')) as ServiceAccount;
  } else {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS is required');
  }

  initializeApp({
    credential: cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
};

const getBucket = (): Bucket => {
  if (cachedBucket) return cachedBucket;
  ensureApp();
  cachedBucket = getStorage().bucket();
  return cachedBucket;
};

export interface UploadedFile {
  path: string;
  buffer: Buffer;
  contentType: string;
}

export const downloadFiles = async (sessionId: string): Promise<UploadedFile[]> => {
  const bucket = getBucket();
  const [files] = await bucket.getFiles({ prefix: `uploads/${sessionId}/` });

  return Promise.all(
    files.map(async (file) => {
      const [buffer] = await file.download();
      const contentType = file.metadata.contentType || 'application/octet-stream';
      return { path: file.name, buffer, contentType };
    }),
  );
};

export const uploadFile = async (storagePath: string, buffer: Buffer, contentType: string): Promise<string> => {
  const bucket = getBucket();
  await bucket.file(storagePath).save(buffer, { metadata: { contentType } });
  const [url] = await bucket.file(storagePath).getSignedUrl({
    action: 'read',
    expires: Date.now() + 7 * 24 * 3600 * 1000,
  });
  return url;
};

/**
 * D-2 — Sprint D worker M3: collision-guarded upload.
 *
 * Sets the GCS precondition `ifGenerationMatch: 0` ("only if file
 * doesn't exist yet"). When two parallel jobs race on the same
 * storage path, the second writer's save call returns a Firebase
 * 412 Precondition Failed and we surface it as a typed
 * FirebaseCollisionError so callers can log/retry/skip without
 * confusing it with transient network errors.
 *
 * Use this for any upload where the path is content-addressable
 * by job id and a duplicate write means a real bug (e.g. the same
 * sessionId firing twice).
 */
export class FirebaseCollisionError extends Error {
  readonly storagePath: string;
  constructor(storagePath: string, cause?: unknown) {
    super(`Firebase upload collision at ${storagePath} — file already exists`);
    this.name = 'FirebaseCollisionError';
    this.storagePath = storagePath;
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

export const uploadFileExclusive = async (
  storagePath: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> => {
  const bucket = getBucket();
  try {
    await bucket.file(storagePath).save(buffer, {
      metadata: { contentType },
      preconditionOpts: { ifGenerationMatch: 0 },
    });
  } catch (e) {
    // Firebase Admin SDK surfaces precondition failures as { code: 412 }.
    // Wrap in our typed error so callers can branch without sniffing
    // numeric codes themselves.
    const code = (e as { code?: number })?.code;
    if (code === 412) throw new FirebaseCollisionError(storagePath, e);
    throw e;
  }
  const [url] = await bucket.file(storagePath).getSignedUrl({
    action: 'read',
    expires: Date.now() + 7 * 24 * 3600 * 1000,
  });
  return url;
};

export const uploadResults = async (
  sessionId: string,
  pdfBuffer: Buffer,
  docxBuffer: Buffer,
): Promise<{ outputPath: string; downloadUrl: string; docxUrl: string }> => {
  const outputPath = `results/${sessionId}/odpor.pdf`;
  const docxPath = `results/${sessionId}/odpor.docx`;

  const [downloadUrl, docxUrl] = await Promise.all([
    uploadFile(outputPath, pdfBuffer, 'application/pdf'),
    uploadFile(docxPath, docxBuffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
  ]);

  return { outputPath, downloadUrl, docxUrl };
};

/** Check if a file exists in the storage bucket. */
export const fileExists = async (storagePath: string): Promise<boolean> => {
  const bucket = getBucket();
  const [exists] = await bucket.file(storagePath).exists();
  return exists;
};

/** Generate a fresh signed URL for an already-uploaded file. */
export const getSignedUrl = async (storagePath: string): Promise<string> => {
  const bucket = getBucket();
  const [url] = await bucket.file(storagePath).getSignedUrl({
    action: 'read',
    expires: Date.now() + 7 * 24 * 3600 * 1000,
  });
  return url;
};

/** Download a file's content from the bucket (used for idempotent email retry). */
export const downloadFileBuffer = async (storagePath: string): Promise<Buffer> => {
  const bucket = getBucket();
  const [buffer] = await bucket.file(storagePath).download();
  return buffer;
};
