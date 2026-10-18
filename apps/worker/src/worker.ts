import { Worker, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import pino from 'pino';
import { env } from './config/env.js';
import { QUEUE_NAME, DLQ_NAME, createDLQ } from './queues/ingestionQueue.js';
import { createIngestionProcessor } from './processors/ingestionProcessor.js';
import * as db from './services/supabaseService.js';

const logger = pino({ level: env.LOG_LEVEL });

// ─── Redis connection ──────────────────────────────────────────────────────────
// maxRetriesPerRequest: null is REQUIRED by BullMQ — it handles its own retry logic
// and does not want ioredis to throw on connection drops.
const redis = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const dlq = createDLQ(redis);

// ─── Worker ───────────────────────────────────────────────────────────────────
const worker = new Worker(
  QUEUE_NAME,
  createIngestionProcessor(logger),
  {
    connection: redis,
    concurrency: env.WORKER_CONCURRENCY,
    // BullMQ lock duration: how long a job can be 'active' before being re-queued
    // Set to 5 minutes to accommodate slow LLM + embedding calls
    lockDuration: 300_000,
  },
);

worker.on('completed', (job, result) => {
  logger.info({ jobId: job.id, result }, 'Job completed');
});

worker.on('failed', async (job, err) => {
  logger.error({ jobId: job?.id, err: err.message, attemptsMade: job?.attemptsMade }, 'Job failed');

  // Move to DLQ after max retries
  if (job && job.attemptsMade >= env.MAX_RETRIES) {
    logger.warn({ jobId: job.id }, 'Moving to DLQ after max retries');
    await dlq.add('dlq-item', job.data, { removeOnComplete: false, removeOnFail: false });

    // Mark the raw_posting as failed in DB
    try {
      await db.updateRawPostingStatus(job.data.rawPostingId, 'failed', {
        error: err.message.slice(0, 500),
      });
    } catch (dbErr) {
      logger.error({ dbErr }, 'Failed to mark raw_posting as failed');
    }
  }
});

worker.on('error', (err) => {
  logger.error({ err }, 'Worker error');
});

// ─── Queue events (for metrics, Phase 6) ──────────────────────────────────────
const queueEvents = new QueueEvents(QUEUE_NAME, { connection: redis });
queueEvents.on('waiting', ({ jobId }) => logger.debug({ jobId }, 'Job waiting'));

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutdown signal received — draining worker...');
  await worker.close();
  await queueEvents.close();
  redis.disconnect();
  logger.info('Worker shut down cleanly');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT',  () => void shutdown('SIGINT'));

logger.info({
  queue: QUEUE_NAME,
  concurrency: env.WORKER_CONCURRENCY,
  redis: env.REDIS_URL,
}, 'JobGraph worker started');
