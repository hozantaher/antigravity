import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const args = process.argv.slice(2);
const target = args[0] || 'mobile-de';
const phase = args[1] || 'all';

async function sendRemoteCommand() {
  const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
  const commandQueue = new Queue('antigravity-commands', { connection });

  console.log(`🚀 Sending Remote Command: [Target: ${target}, Phase: ${phase}]`);

  await commandQueue.add('start-scraper', {
    target,
    phase,
  });

  console.log('✅ Command queued successfully. Daemon should pick it up momentarily.');
  await commandQueue.close();
  await connection.quit();
}

sendRemoteCommand().catch((err) => {
  console.error('Failed to send command:', err);
  process.exit(1);
});
