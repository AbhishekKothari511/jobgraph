/**
 * k6 Benchmark — After Redis cache (TTL=300s)
 * Same queries run repeatedly → cache hit rate should be >80%
 * Usage: k6 run bench/k6/cached.js --env BASE_URL=http://localhost:8080
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';

const latency  = new Trend('request_latency_ms');
const errors   = new Counter('request_errors');
const cacheHit = new Rate('cache_hit_rate');

export const options = {
  stages: [
    { duration: '30s', target: 100 },
    { duration: '120s', target: 100 },
    { duration: '15s', target: 0 },
  ],
  thresholds: {
    'request_latency_ms': ['p(95)<50'],    // cached: should be <50ms p95
    'cache_hit_rate':     ['rate>0.8'],    // expect >80% cache hits
    'http_req_failed':    ['rate<0.01'],
  },
};

const BASE_URL = __ENV.BASE_URL ?? 'http://localhost:8080';

// Smaller set of queries so cache warm-up happens quickly
const HOT_QUERIES = [
  { q: 'software engineer', limit: 20 },
  { q: 'data scientist', seniority: 'senior', limit: 10 },
  { remote: 'true', limit: 20 },
  { q: 'product manager', limit: 20 },
];

export default function () {
  const query = HOT_QUERIES[Math.floor(Math.random() * HOT_QUERIES.length)];
  const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  const url = `${BASE_URL}/api/v1/jobs?${params.toString()}`;

  const start = Date.now();
  const res = http.get(url);
  const elapsed = Date.now() - start;
  latency.add(elapsed);

  const ok = check(res, { 'status 200': (r) => r.status === 200 });
  if (!ok) errors.add(1);

  const isHit = res.headers['X-Cache'] === 'HIT';
  cacheHit.add(isHit ? 1 : 0);

  sleep(0.1);
}
