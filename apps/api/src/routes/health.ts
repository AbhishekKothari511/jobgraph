import { Router } from 'express';
import { supabase } from '../services/supabaseService.js';

const router = Router();

router.get('/health', async (_req, res) => {
  const start = Date.now();
  let dbOk = false;
  try {
    const { error } = await supabase.from('jobs').select('id').limit(1);
    dbOk = !error;
  } catch { dbOk = false; }

  const status = dbOk ? 200 : 503;
  res.status(status).json({
    status: dbOk ? 'ok' : 'degraded',
    db: dbOk ? 'ok' : 'error',
    latencyMs: Date.now() - start,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

export default router;
