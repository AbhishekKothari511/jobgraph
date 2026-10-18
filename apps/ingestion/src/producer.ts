import IORedis from 'ioredis';
import pino from 'pino';
import { createIngestionQueue, defaultJobOptions } from '../../worker/src/queues/ingestionQueue.js';
import { createAdapters } from './adapters/index.js';
import { createSupabaseService } from './services/supabaseService.js';
import { env } from './config/env.js';
import type { RawPosting } from '@jobgraph/shared';

/**
 * Phase 2 Queue Producer
 *
 * Runs all enabled adapters and enqueues each RawPosting into BullMQ.
 * Idempotency is enforced at two levels:
 *   1. DB level: raw_postings UNIQUE(source_name, external_id) — insert is skipped if exists
 *   2. Queue level: jobId = source:external_id — BullMQ deduplicates by jobId
 *
 * This means re-running the producer is safe — no double processing.
 */
const logger = pino({ level: env.LOG_LEVEL });

// maxRetriesPerRequest: null required by BullMQ
const redis = new IORedis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const queue = createIngestionQueue(redis);
const db = createSupabaseService(logger);
const adapters = createAdapters(logger);

async function run(): Promise<void> {
  logger.info('JobGraph queue producer starting');
  let totalEnqueued = 0;
  let totalSkipped = 0;

  for (const adapter of adapters) {
    logger.info({ adapter: adapter.name }, 'Running adapter');
    try {
      for await (const posting of adapter.fetch({ limit: 50 })) {
        // Step 1: Persist raw_posting (idempotency check)
        const { inserted, id: rawPostingId } = await db.insertRawPosting(posting);

        if (!inserted || !rawPostingId) {
          totalSkipped++;
          continue;
        }

        // Step 2: Enqueue in BullMQ
        // jobId = source:externalId ensures BullMQ deduplicates at the queue level
        const jobId = `${posting.sourceName}:${posting.externalId}`;
        await queue.add(
          'process-posting',
          { rawPostingId, posting },
          { ...defaultJobOptions, jobId },
        );

        totalEnqueued++;
        logger.info({ jobId, source: posting.sourceName }, 'Posting enqueued');
      }
    } catch (err) {
      logger.error({ adapter: adapter.name, err }, 'Adapter failed — continuing with next');
    }
  }

  logger.info({ totalEnqueued, totalSkipped }, 'Producer run complete');
  await queue.close();
  redis.disconnect();
}

run().catch((err) => {
  logger.error({ err }, 'Producer fatal error');
  process.exit(1);
});
