import { Router } from 'express';
import { getQueueDepth } from '../services/cacheService.js';
import { env } from '../config/env.js';

const router = Router();
const requestCounts = { total: 0, errors: 0 };
const latencies: number[] = [];

export function recordRequest(latencyMs: number, isError: boolean): void {
  requestCounts.total++;
  if (isError) requestCounts.errors++;
  latencies.push(latencyMs);
  if (latencies.length > 1000) latencies.shift();  // keep last 1000
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)] ?? 0;
}

/**
 * /metrics — Prometheus-style text format (simplified).
 * In production, replace with prom-client for full Prometheus compatibility.
 */
router.get('/metrics', async (_req, res) => {
  const queueDepth = await getQueueDepth(env.QUEUE_NAME);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);

  const lines = [
    `# HELP jobgraph_requests_total Total HTTP requests`,
    `# TYPE jobgraph_requests_total counter`,
    `jobgraph_requests_total ${requestCounts.total}`,
    `# HELP jobgraph_errors_total Total HTTP errors`,
    `jobgraph_errors_total ${requestCounts.errors}`,
    `# HELP jobgraph_latency_p50_ms Request latency p50 ms`,
    `jobgraph_latency_p50_ms ${p50}`,
    `# HELP jobgraph_latency_p95_ms Request latency p95 ms`,
    `jobgraph_latency_p95_ms ${p95}`,
    `# HELP jobgraph_latency_p99_ms Request latency p99 ms`,
    `jobgraph_latency_p99_ms ${p99}`,
    `# HELP jobgraph_queue_depth Current ingestion queue depth`,
    `jobgraph_queue_depth ${queueDepth}`,
    `# HELP jobgraph_uptime_seconds Process uptime`,
    `jobgraph_uptime_seconds ${process.uptime().toFixed(2)}`,
  ];

  res.type('text/plain').send(lines.join('\n'));
});

export default router;
export { requestCounts };
