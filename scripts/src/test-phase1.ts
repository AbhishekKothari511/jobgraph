/**
 * Phase 1 Test Suite
 * Tests: schema validation, normalization, hash consistency, adapter interface shape
 * Does NOT require Supabase or API credentials — all tests run offline.
 *
 * Run: npm run test:phase1 --workspace=scripts
 *
 * Real metrics printed:
 *   - Zod parse time (μs) per schema
 *   - Hash computation throughput (hashes/sec)
 *   - Normalization correctness assertions
 */

import crypto from 'node:crypto';
import { z } from 'zod';

// ─── Inline the schemas and utils we want to test ────────────────────────────
// We test the logic directly here to avoid needing compiled dist files.
// Phase 2+ tests will import from built packages.

// ── Copied from packages/shared/src/schemas/job.ts ──
const jobTypeSchema = z.enum(['full_time', 'part_time', 'contract', 'internship', 'unknown']);
const experienceLevelSchema = z.enum(['entry', 'mid', 'senior', 'executive', 'unknown']);
const jobStatusSchema = z.enum(['active', 'expired', 'duplicate']);

const rawPostingSchema = z.object({
  externalId: z.string().min(1, 'externalId cannot be empty'),
  sourceName: z.string().min(1),
  title: z.string().min(1, 'title is required'),
  company: z.string().min(1, 'company is required'),
  location: z.string().optional(),
  description: z.string().min(10, 'description must be at least 10 characters'),
  requirements: z.string().optional(),
  salaryMin: z.number().int().nonnegative().optional(),
  salaryMax: z.number().int().nonnegative().optional(),
  salaryCurrency: z.string().length(3).optional(),
  jobType: jobTypeSchema.optional(),
  url: z.string().url().optional(),
  postedAt: z.date().optional(),
  expiresAt: z.date().optional(),
  remote: z.boolean().optional(),
  rawData: z.unknown(),
});

const jobInsertSchema = z.object({
  title: z.string().min(1),
  company: z.string().min(1),
  location: z.string().optional(),
  description: z.string().min(10),
  requirements: z.string().optional(),
  salaryMin: z.number().int().nonnegative().optional(),
  salaryMax: z.number().int().nonnegative().optional(),
  salaryCurrency: z.string().length(3).optional(),
  jobType: jobTypeSchema.optional(),
  experienceLevel: experienceLevelSchema.optional(),
  role: z.string().optional(),
  skills: z.array(z.string()).optional(),
  remote: z.boolean().default(false),
  url: z.string().url().optional(),
  postedAt: z.date().optional(),
  expiresAt: z.date().optional(),
  status: jobStatusSchema.default('active'),
  exactHash: z.string().optional(),
});

const categorizationOutputSchema = z.object({
  role: z.string().min(1),
  skills: z.array(z.string()),
  seniority: experienceLevelSchema,
  remote: z.boolean(),
});

// ── Copied from apps/ingestion/src/utils/normalize.ts ──
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\bsr\.?\b/g, 'senior')
    .replace(/\bjr\.?\b/g, 'junior')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCompany(company: string): string {
  return company
    .toLowerCase()
    .replace(/\b(inc\.?|llc\.?|ltd\.?|gmbh|corp\.?|co\.?|plc\.?|sa|ag|bv)\b/gi, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLocation(location?: string): string {
  if (!location) return '';
  return location.toLowerCase().replace(/\s+/g, ' ').trim();
}

function computeExactHash(title: string, company: string, location?: string): string {
  const normalized = [normalizeTitle(title), normalizeCompany(company), normalizeLocation(location)].join('|');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function computeContentHash(description: string): string {
  const normalized = description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

// ─── Test runner ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function time<T>(label: string, fn: () => T): T {
  const start = process.hrtime.bigint();
  const result = fn();
  const elapsed = Number(process.hrtime.bigint() - start) / 1_000;
  console.log(`  ⏱  ${label}: ${elapsed.toFixed(1)} μs`);
  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
console.log('  JobGraph Phase 1 — Test Suite (offline, no credentials)');
console.log('═══════════════════════════════════════════════════════════\n');

// ── Section 1: Zod schema validation ──────────────────────────────────────────
console.log('── 1. Zod schema validation ──────────────────────────────────');

const validRawPosting = {
  externalId: 'abc-123',
  sourceName: 'adzuna',
  title: 'Senior Software Engineer',
  company: 'Acme Corp',
  location: 'London, UK',
  description: 'We are looking for a senior software engineer with 5+ years experience.',
  url: 'https://example.com/job/123',
  salaryMin: 80000,
  salaryMax: 120000,
  salaryCurrency: 'GBP',
  jobType: 'full_time' as const,
  postedAt: new Date(),
  remote: false,
  rawData: { original: 'payload' },
};

time('rawPostingSchema parse (valid)', () => {
  const r = rawPostingSchema.safeParse(validRawPosting);
  assert(r.success, 'Valid raw posting parses successfully');
});

time('rawPostingSchema (empty title rejected)', () => {
  const r = rawPostingSchema.safeParse({ ...validRawPosting, title: '' });
  assert(!r.success, 'Empty title rejected');
  const onTitleField = !r.success && r.error.errors.some((e) => e.path.includes('title'));
  assert(onTitleField, 'Error path is "title"');
});

time('rawPostingSchema (bad URL rejected)', () => {
  const r = rawPostingSchema.safeParse({ ...validRawPosting, url: 'not-a-url' });
  assert(!r.success, 'Invalid URL rejected');
});

time('rawPostingSchema (4-char currency rejected)', () => {
  const r = rawPostingSchema.safeParse({ ...validRawPosting, salaryCurrency: 'USDX' });
  assert(!r.success, 'Currency code longer than 3 chars rejected');
});

time('rawPostingSchema (short description rejected)', () => {
  const r = rawPostingSchema.safeParse({ ...validRawPosting, description: 'Short' });
  assert(!r.success, 'Description < 10 chars rejected');
});

time('jobInsertSchema (defaults applied)', () => {
  const r = jobInsertSchema.safeParse({
    title: 'Backend Developer',
    company: 'TechCo',
    description: 'Build scalable backend services with Node.js.',
  });
  assert(r.success, 'Minimal job insert parses successfully');
  assert(r.success && r.data.remote === false, 'remote defaults to false');
  assert(r.success && r.data.status === 'active', 'status defaults to active');
});

time('categorizationOutputSchema (valid)', () => {
  const r = categorizationOutputSchema.safeParse({
    role: 'Software Engineer', skills: ['TypeScript', 'Node.js'], seniority: 'senior', remote: true,
  });
  assert(r.success, 'Valid categorization output parses');
});

time('categorizationOutputSchema (invalid seniority)', () => {
  const r = categorizationOutputSchema.safeParse({
    role: 'Engineer', skills: [], seniority: 'wizard', remote: false,
  });
  assert(!r.success, 'Invalid seniority enum rejected');
});

// ── Section 2: Normalization correctness ──────────────────────────────────────
console.log('\n── 2. Normalization correctness ──────────────────────────────');

assert(
  normalizeTitle('Senior Software Engineer') === normalizeTitle('Sr. Software Engineer'),
  'Sr. → Senior normalization matches',
  `Got: "${normalizeTitle('Sr. Software Engineer')}"`,
);

assert(
  normalizeTitle('  BACKEND   DEVELOPER  ') === 'backend developer',
  'Whitespace collapse + lowercase',
);

assert(
  normalizeTitle('Jr. Frontend Dev') === 'junior frontend dev',
  'Jr. → Junior normalization',
);

assert(
  normalizeCompany('Acme Inc.') === normalizeCompany('Acme'),
  'Inc. suffix stripped',
  `Got: "${normalizeCompany('Acme Inc.')}" vs "${normalizeCompany('Acme')}"`,
);

assert(
  normalizeCompany('Google LLC') === normalizeCompany('Google'),
  'LLC suffix stripped',
);

assert(
  normalizeLocation(undefined) === '',
  'undefined location → empty string',
);

// ── Section 3: Hash correctness ────────────────────────────────────────────────
console.log('\n── 3. Hash correctness ───────────────────────────────────────');

const h1 = computeExactHash('Senior Software Engineer', 'Acme Inc.', 'London, UK');
const h2 = computeExactHash('Sr. Software Engineer', 'Acme', 'London, UK');
const h3 = computeExactHash('Backend Developer', 'Acme Inc.', 'London, UK');
const h4 = computeExactHash('Senior Software Engineer', 'Acme Inc.', 'London, UK');

assert(h1 === h2, 'Normalized variants → same exact hash (true cross-source duplicate)');
assert(h1 !== h3, 'Different title → different hash (not a duplicate)');
assert(h1 === h4, 'Identical inputs → identical hash (deterministic)');
assert(h1.length === 64, `SHA-256 exact hash is 64 hex chars (got ${h1.length})`);

const ch1 = computeContentHash('We are looking for a senior software engineer.');
const ch2 = computeContentHash('We are looking for a senior software engineer.');
const ch3 = computeContentHash('<p>We are looking for a senior software engineer.</p>');
assert(ch1 === ch2, 'Same content → same content hash (cache hit)');
assert(ch1 === ch3, 'HTML-stripped description matches plain text hash');
assert(ch1.length === 64, 'Content hash is 64 hex chars');

// ── Section 4: Hash throughput benchmark ──────────────────────────────────────
console.log('\n── 4. Hash throughput benchmark ──────────────────────────────');

const N = 10_000;
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) {
  computeExactHash(`Software Engineer Level ${i}`, 'Acme Corp', 'New York NY');
}
const tMs = Number(process.hrtime.bigint() - t0) / 1_000_000;
const rate = Math.round(N / (tMs / 1000));
console.log(`  ⏱  ${N.toLocaleString()} exact hashes in ${tMs.toFixed(1)} ms`);
console.log(`  📊 Throughput: ${rate.toLocaleString()} hashes/sec`);
assert(rate > 50_000, `Hash throughput > 50,000/sec (measured: ${rate.toLocaleString()}/sec)`);

// ── Section 5: Adapter interface structure ─────────────────────────────────────
console.log('\n── 5. Adapter interface structural verification ───────────────');
// Check that the interface contract (as TypeScript types) is sound
// We verify the expected method names exist at runtime via duck-typing stubs.

interface JobAdapterLike {
  name: string;
  type: string;
  fetch: (opts?: unknown) => AsyncGenerator<unknown>;
  healthCheck: () => Promise<boolean>;
}

function isValidAdapter(obj: unknown): obj is JobAdapterLike {
  if (typeof obj !== 'object' || obj === null) return false;
  const a = obj as Record<string, unknown>;
  return (
    typeof a['name'] === 'string' &&
    typeof a['type'] === 'string' &&
    typeof a['fetch'] === 'function' &&
    typeof a['healthCheck'] === 'function'
  );
}

// Stub adapters to verify structural shape without network calls
const stubAdzuna = {
  name: 'adzuna', type: 'api',
  async *fetch() { yield {}; },
  async healthCheck() { return true; },
};
const stubRss = {
  name: 'remotive', type: 'rss',
  async *fetch() { yield {}; },
  async healthCheck() { return true; },
};
const stubCsv = {
  name: 'csv', type: 'csv',
  async *fetch() { yield {}; },
  async healthCheck() { return true; },
};

assert(isValidAdapter(stubAdzuna), 'AdzunaAdapter stub satisfies JobAdapter interface');
assert(isValidAdapter(stubRss), 'RssAdapter stub satisfies JobAdapter interface');
assert(isValidAdapter(stubCsv), 'CsvAdapter stub satisfies JobAdapter interface');

// Verify fetch() returns an AsyncGenerator (has Symbol.asyncIterator)
const gen = stubAdzuna.fetch();
assert(
  Symbol.asyncIterator in gen,
  'fetch() returns AsyncGenerator (has Symbol.asyncIterator)',
);

// ── Summary ────────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
console.log(`  Results: ${passed} passed  |  ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════\n');
if (failed > 0) process.exit(1);
