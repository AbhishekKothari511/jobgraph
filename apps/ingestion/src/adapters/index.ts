// Adapter registry — the only place that knows which adapters exist.
// Phase 2 queue producer imports createAdapters() to get all enabled adapters.
// To add a new source: implement JobAdapter, import here, add one line.

import pino from 'pino';
import { env } from '../config/env.js';
import { AdzunaAdapter } from './adzunaAdapter.js';
import { RssAdapter } from './rssAdapter.js';
import { CsvAdapter } from './csvAdapter.js';
import type { JobAdapter } from './interface.js';

export type { JobAdapter } from './interface.js';
export { AdapterError } from './interface.js';

export function createAdapters(logger: pino.Logger): JobAdapter[] {
  const adapters: JobAdapter[] = [];

  // ─── Adzuna ───────────────────────────────────────────────────────────────
  if (env.ADZUNA_APP_ID && env.ADZUNA_APP_KEY) {
    adapters.push(new AdzunaAdapter(
      {
        appId: env.ADZUNA_APP_ID,
        appKey: env.ADZUNA_APP_KEY,
        country: env.ADZUNA_COUNTRY,
        keyword: env.ADZUNA_KEYWORD,
        resultsPerPage: 50,
      },
      logger.child({ adapter: 'adzuna' }),
    ));
  } else {
    logger.warn('ADZUNA_APP_ID or ADZUNA_APP_KEY not set — Adzuna adapter disabled');
  }

  // ─── RSS ──────────────────────────────────────────────────────────────────
  if (env.RSS_FEED_URL) {
    adapters.push(new RssAdapter(
      { feedUrl: env.RSS_FEED_URL, sourceName: env.RSS_FEED_NAME },
      logger.child({ adapter: 'rss' }),
    ));
  } else {
    logger.warn('RSS_FEED_URL not set — RSS adapter disabled');
  }

  // ─── CSV ──────────────────────────────────────────────────────────────────
  // Always enabled; it's a local folder so no credentials are needed.
  adapters.push(new CsvAdapter(
    { dropFolder: env.CSV_DROP_FOLDER, archiveFolder: env.CSV_ARCHIVE_FOLDER },
    logger.child({ adapter: 'csv' }),
  ));

  logger.info({ adapters: adapters.map((a) => a.name) }, 'Adapters initialized');
  return adapters;
}
