import { createApp } from './app.js';
import { env } from './config/env.js';
import { disconnectRedis } from './services/cacheService.js';

const { app, logger } = createApp();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'JobGraph API started');
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down');
  server.close(() => {
    disconnectRedis();
    logger.info('Server closed');
    process.exit(0);
  });
});
