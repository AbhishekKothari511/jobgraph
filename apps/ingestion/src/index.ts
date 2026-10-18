import pino from 'pino';
import { env } from './config/env.js';
import { createAdapters } from './adapters/index.js';

// ─── Phase 1 entrypoint ───────────────────────────────────────────────────────
// Runs all enabled adapters, collects raw postings, and logs a summary.
// In Phase 2 this becomes the queue producer (postings go into BullMQ instead
// of being counted here). Keeping Phase 1 minimal makes it easy to verify
// the adapter interface before adding queue complexity.

const logger = pino({
  level: env.LOG_LEVEL,
  transport: process.stdout.isTTY
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

async function main(): Promise<void> {
  logger.info('JobGraph ingestion starting (Phase 1 — adapter smoke test)');

  const adapters = createAdapters(logger);

  if (adapters.length === 0) {
    logger.warn('No adapters enabled. Set at least one adapter env var and retry.');
    return;
  }

  for (const adapter of adapters) {
    logger.info({ adapter: adapter.name, type: adapter.type }, 'Running adapter health check');
    try {
      const healthy = await adapter.healthCheck();
      if (!healthy) {
        logger.warn({ adapter: adapter.name }, 'Adapter health check returned false — skipping');
        continue;
      }
    } catch (err) {
      logger.error({ adapter: adapter.name, err }, 'Adapter health check threw — skipping');
      continue;
    }

    logger.info({ adapter: adapter.name }, 'Fetching postings (limit=5 for smoke test)');
    let count = 0;
    try {
      for await (const posting of adapter.fetch({ limit: 5 })) {
        logger.info({
          adapter: adapter.name,
          externalId: posting.externalId,
          title: posting.title,
          company: posting.company,
        }, 'Got posting');
        count++;
      }
    } catch (err) {
      logger.error({ adapter: adapter.name, err }, 'Adapter fetch error');
    }

    logger.info({ adapter: adapter.name, count }, 'Adapter fetch complete');
  }

  logger.info('Phase 1 smoke test complete');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
