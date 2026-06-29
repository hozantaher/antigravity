import { startEmailWorker, stopEmailQueue } from '../utils/emailQueue'

// Starts the BullMQ email worker when REDIS_URL is set (no-op otherwise). A clean
// close releases the in-flight job's lock so another instance can pick it up.
export default defineNitroPlugin(nitro => {
  startEmailWorker()
  nitro.hooks.hook('close', () => stopEmailQueue())
})
