/**
 * k6 Benchmark — Baseline (no indexes, no cache)
 * Usage: k6 run bench/k6/baseline.js --env BASE_URL=http://localhost:8080
 *
 * To run without indexes:
 *   1. DROP INDEX idx_jobs_search_vector;
 *   2. DROP INDEX idx_job_embeddings_hnsw;
 *   3. DROP INDEX idx_jobs_filters;
 *   4. Run this script
 *   5. Recreate indexes before next phase
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const latency = new Trend('request_latency_ms');
const errors  = new Counter('request_errors');

export const options = {
  stages: [
    { duration: '30s', target: 10 },   // ramp up to 10 VUs
    { duration: '60s', target: 10 },   // hold
    { duration: '15s', target: 0  },   // ramp down
  ],
  thresholds: {
    'request_latency_ms': ['p(95)<5000'],  // baseline: lenient threshold
    'http_req_failed': ['rate<0.05'],
  },
};

const BASE_URL = __ENV.BASE_URL ?? 'http://localhost:8080';

const QUERIES = [
  { q: 'software engineer', limit: 20 },
  { q: 'python developer', role: 'Software Engineer', limit: 20 },
  { q: 'data scientist', seniority: 'senior', limit: 10 },
  { remote: 'true', limit: 20 },
  { q: 'product manager', seniority: 'mid', limit: 20 },
];

export default function () {
  const query = QUERIES[Math.floor(Math.random() * QUERIES.length)];
  const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  const url = `${BASE_URL}/api/v1/jobs?${params.toString()}`;

  const start = Date.now();
  const res = http.get(url, { headers: { 'Accept': 'application/json' } });
  const elapsed = Date.now() - start;

  latency.add(elapsed);

  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    'has jobs array': (r) => {
      try { return Array.isArray(JSON.parse(r.body).jobs); } catch { return false; }
    },
  });

  if (!ok) errors.add(1);
  sleep(0.5);
}
