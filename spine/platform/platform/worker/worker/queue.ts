import IORedis from 'ioredis';

export const QUEUE_NAME = 'rozporuj-pdf';

export interface PdfJobData {
  sessionId: string;
  email: string;
  firstName: string;
  lastName: string;
  fileUrls: string[];
  stripeSessionId: string;
  prompt?: string;
  userNotes?: string;
}

export interface PdfJobResult {
  downloadUrl: string;
  docxUrl: string;
  conversationUrl: string;
  outputPath: string;
}

export const createRedisConnection = () => {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is required');
  return new IORedis(url, { maxRetriesPerRequest: null });
};
