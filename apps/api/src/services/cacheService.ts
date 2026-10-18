import IORedis from 'ioredis';
import { env } from '../config/env.js';
import type { Logger } from 'pino';

let redisClient: IORedis | null = null;

function getRedis(): IORedis {
  if (!redisClient) {
    redisClient = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
  }
  return redisClient;
}

/**
 * Get a cached value by key.
 * Returns null if not found or Redis is unavailable (graceful degradation).
 */
export async function cacheGet(key: string, logger: Logger): Promise<unknown | null> {
  try {
    const raw = await getRedis().get(key);
    if (!raw) return null;
    logger.debug({ key }, 'Cache hit');
    return JSON.parse(raw) as unknown;
  } catch (err) {
    logger.warn({ key, err }, 'Cache get failed — bypassing cache');
    return null;
  }
}

/**
 * Set a cached value with TTL.
 * Fire-and-forget: cache failures do not fail the request.
 */
export async function cacheSet(key: string, value: unknown, logger: Logger, ttlSeconds = env.CACHE_TTL_SECONDS): Promise<void> {
  try {
    await getRedis().setex(key, ttlSeconds, JSON.stringify(value));
    logger.debug({ key, ttlSeconds }, 'Cache set');
  } catch (err) {
    logger.warn({ key, err }, 'Cache set failed — ignoring');
  }
}

/**
 * Invalidate all keys matching a pattern.
 * Called after a new job batch is ingested to bust stale search results.
 * Uses SCAN instead of KEYS to avoid blocking Redis.
 */
export async function cacheInvalidatePattern(pattern: string, logger: Logger): Promise<number> {
  const redis = getRedis();
  let cursor = '0';
  let deleted = 0;
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;
    if (keys.length > 0) {
      await redis.del(...keys);
      deleted += keys.length;
    }
  } while (cursor !== '0');
  logger.info({ pattern, deleted }, 'Cache invalidated');
  return deleted;
}

export function buildSearchCacheKey(query: Record<string, unknown>): string {
  // Stable key: sort query params alphabetically so different orderings hit the same cache entry
  const sorted = Object.fromEntries(
    Object.entries(query).filter(([, v]) => v !== undefined && v !== '').sort(),
  );
  return `jg:search:${JSON.stringify(sorted)}`;
}

export async function getQueueDepth(queueName: string): Promise<number> {
  try {
    const redis = getRedis();
    // BullMQ stores waiting jobs in a Redis list named bull:{queueName}:wait
    return await redis.llen(`bull:${queueName}:wait`);
  } catch {
    return -1;
  }
}

export function disconnectRedis(): void {
  redisClient?.disconnect();
}
