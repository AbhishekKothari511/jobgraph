import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

/**
 * Per-IP rate limiter.
 * Standard headers (X-RateLimit-*) are enabled so clients can self-throttle.
 * Uses in-memory store (MemoryStore) — for multi-instance (Phase 6 Nginx),
 * upgrade to RedisStore so limits are shared across all 3 API replicas.
 */
export const apiRateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down', retryAfterMs: env.RATE_LIMIT_WINDOW_MS },
  skip: (req) => req.path === '/health',  // never rate-limit health checks
});
