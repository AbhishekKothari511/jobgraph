import { Router } from 'express';
import { searchJobs, searchQuerySchema } from '../services/searchService.js';
import { cacheGet, cacheSet, buildSearchCacheKey } from '../services/cacheService.js';
import type { Logger } from 'pino';
import { recordRequest } from './metrics.js';

export function createJobsRouter(logger: Logger): Router {
  const router = Router();

  /**
   * GET /jobs — Search and list jobs
   * Query params: q, role, seniority, remote, location, job_type, limit, cursor
   *
   * Flow:
   *   1. Validate query params with Zod
   *   2. Check Redis cache (key = stable JSON of sorted params)
   *   3. On miss: execute Postgres search (FTS + filters + keyset pagination)
   *   4. Store result in Redis with TTL
   *   5. Return { jobs, nextCursor, count }
   */
  router.get('/jobs', async (req, res, next) => {
    const start = Date.now();
    try {
      const parsed = searchQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid query params', details: parsed.error.flatten() });
        return;
      }

      const query = parsed.data;
      const cacheKey = buildSearchCacheKey(query as Record<string, unknown>);

      // Cache check
      const cached = await cacheGet(cacheKey, logger);
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        res.json(cached);
        recordRequest(Date.now() - start, false);
        return;
      }

      // DB search
      const result = await searchJobs(query);
      res.setHeader('X-Cache', 'MISS');
      res.json(result);

      // Cache async (don't await — don't delay response)
      void cacheSet(cacheKey, result, logger);
      recordRequest(Date.now() - start, false);
    } catch (err) {
      recordRequest(Date.now() - start, true);
      next(err);
    }
  });

  /**
   * GET /jobs/:id — Get a single job by ID
   */
  router.get('/jobs/:id', async (req, res, next) => {
    const start = Date.now();
    try {
      const { id } = req.params;
      const cacheKey = `jg:job:${id}`;
      const cached = await cacheGet(cacheKey, logger);
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        res.json(cached);
        recordRequest(Date.now() - start, false);
        return;
      }

      const { supabase } = await import('../services/supabaseService.js');
      const { data, error } = await supabase.from('jobs').select('*').eq('id', id).eq('status','active').single();
      if (error || !data) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }

      void cacheSet(cacheKey, data, logger, 600);  // cache single job for 10 min
      res.setHeader('X-Cache', 'MISS');
      res.json(data);
      recordRequest(Date.now() - start, false);
    } catch (err) {
      recordRequest(Date.now() - start, true);
      next(err);
    }
  });

  return router;
}
