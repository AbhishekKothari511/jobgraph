/**
 * k6 Benchmark — After indexes (GIN + HNSW + composite partial index)
 * Run AFTER migrations 003 have been applied.
 * Usage: k6 run bench/k6/indexed.js --env BASE_URL=http://localhost:8080
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const latency = new Trend('request_latency_ms');
const errors  = new Counter('request_errors');

export const options = {
  stages: [
    { duration: '30s', target: 50 },
    { duration: '120s', target: 50 },
    { duration: '15s', target: 0 },
  ],
  thresholds: {
    'request_latency_ms': ['p(95)<500'],   // indexed: should be sub-500ms p95
    'http_req_failed': ['rate<0.01'],
  },
};

const BASE_URL = __ENV.BASE_URL ?? 'http://localhost:8080';

const QUERIES = [
  { q: 'software engineer', limit: 20 },
  { q: 'python developer', role: 'Software Engineer', limit: 20 },
  { q: 'data scientist', seniority: 'senior', limit: 10 },
  { remote: 'true', limit: 20 },
  { q: 'product manager', seniority: 'mid', limit: 20 },
  { role: 'Data Engineer', remote: 'true', limit: 20 },
  { q: 'backend developer', job_type: 'full_time', limit: 20 },
];

export default function () {
  const query = QUERIES[Math.floor(Math.random() * QUERIES.length)];
  const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  const url = `${BASE_URL}/api/v1/jobs?${params.toString()}`;

  const start = Date.now();
  const res = http.get(url);
  const elapsed = Date.now() - start;
  latency.add(elapsed);

  const ok = check(res, { 'status 200': (r) => r.status === 200 });
  if (!ok) errors.add(1);
  sleep(0.2);
}
