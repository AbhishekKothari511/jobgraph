import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  OPENAI_API_KEY: z.string().min(1).optional(),
  LLM_MODEL: z.string().default('gpt-4o-mini'),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),
  QUEUE_NAME: z.string().default('job-ingestion'),
  DLQ_NAME: z.string().default('job-ingestion-dlq'),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  MAX_RETRIES: z.coerce.number().int().positive().default(3),
  DEDUP_EMBEDDING_THRESHOLD: z.coerce.number().min(0).max(1).default(0.92),
  LOG_LEVEL: z.enum(['trace','debug','info','warn','error','fatal']).default('info'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Worker env config invalid:', parsed.error.format());
  process.exit(1);
}
export const env = Object.freeze(parsed.data);
