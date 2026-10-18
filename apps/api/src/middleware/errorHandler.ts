import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : 'Internal server error';
    const status  = (err as { status?: number }).status ?? 500;
    logger.error({ err, status }, 'Request error');
    res.status(status).json({ error: message });
  };
}
