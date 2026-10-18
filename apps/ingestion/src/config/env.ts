import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });

// ─── Environment schema ────────────────────────────────────────────────────────
// Validated at startup; any missing required variable throws an error with a clear message.
const envSchema = z.object({
  // Supabase
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Adzuna adapter
  ADZUNA_APP_ID: z.string().min(1).optional(),
  ADZUNA_APP_KEY: z.string().min(1).optional(),
  ADZUNA_COUNTRY: z.string().default('gb'),
  ADZUNA_KEYWORD: z.string().default('software engineer'),

  // RSS adapter
  RSS_FEED_URL: z.string().url().optional(),
  RSS_FEED_NAME: z.string().default('rss'),

  // CSV adapter
  CSV_DROP_FOLDER: z.string().default('./drop'),
  CSV_ARCHIVE_FOLDER: z.string().default('./drop/archive'),

  // Deduplication
  DEDUP_EMBEDDING_THRESHOLD: z.coerce.number().min(0).max(1).default(0.92),

  // Embedding model
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),

  // Logging
  LOG_LEVEL: z.enum(['trace','debug','info','warn','error','fatal']).default('info'),
});

// Parse and freeze — if this throws, the process should not start.
const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = Object.freeze(parsed.data);
export type Env = typeof env;
