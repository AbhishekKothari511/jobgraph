import express from 'express';
import pinoHttp from 'pino-http';
import pino from 'pino';
import { env } from './config/env.js';
import { apiRateLimiter } from './middleware/rateLimiter.js';
import { createErrorHandler } from './middleware/errorHandler.js';
import healthRouter from './routes/health.js';
import metricsRouter from './routes/metrics.js';
import { createJobsRouter } from './routes/jobs.js';

export function createApp() {
  const logger = pino({ level: env.LOG_LEVEL });
  const app = express();

  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger }));
  app.use(apiRateLimiter);

  // Trust reverse proxy (Nginx) headers for correct IP-based rate limiting
  app.set('trust proxy', 1);

  app.use(healthRouter);
  app.use(metricsRouter);
  app.use('/api/v1', createJobsRouter(logger));

  app.use(createErrorHandler(logger));

  return { app, logger };
}
