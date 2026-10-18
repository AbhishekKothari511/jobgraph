import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  PORT: z.coerce.number().int().positive().default(3001),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  CACHE_TTL_SECONDS: z.coerce.number().default(300),
  LOG_LEVEL: z.enum(['trace','debug','info','warn','error','fatal']).default('info'),
  QUEUE_NAME: z.string().default('job-ingestion'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ API env config invalid:', parsed.error.format());
  process.exit(1);
}
export const env = Object.freeze(parsed.data);
