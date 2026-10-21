import { supabase } from './supabaseService.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

function getLocalJobGraphJobs(): any[] {
  try {
    const candidates = [
      path.resolve(__dirname, '../../../../apps/ingestion/drop/sample-jobs.csv'),
      path.resolve(process.cwd(), '../ingestion/drop/sample-jobs.csv'),
      path.resolve(process.cwd(), 'apps/ingestion/drop/sample-jobs.csv'),
      'c:/Users/Abhishek Kothari/Downloads/Projects/jobgraph/apps/ingestion/drop/sample-jobs.csv'
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const text = fs.readFileSync(p, 'utf8');
        const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
        const headerLine = lines[0];
        if (lines.length > 1 && headerLine) {
          const headers = headerLine.split(',').map(h => h.trim());
          const records: any[] = [];
          for (let i = 1; i < lines.length; i++) {
            const rowLine = lines[i];
            if (!rowLine) continue;
            const cols = rowLine.split(',').map(c => c.trim());
            const item: any = {};
            headers.forEach((h, idx) => { item[h] = cols[idx]; });
            records.push({
              id: `jobgraph-${i}`,
              title: item.title,
              company: item.company,
              location: item.location,
              salary_min: parseInt(item.salary_min) || 100000,
              salary_max: parseInt(item.salary_max) || 150000,
              salary_currency: 'USD',
              job_type: item.job_type || 'full_time',
              experience_level: 'senior',
              role: item.title,
              skills: ['Distributed Systems', 'TypeScript', 'Node.js'],
              remote: item.remote === 'true',
              url: item.url,
              posted_at: item.posted_at || new Date().toISOString(),
              created_at: new Date().toISOString(),
            });
          }
          return records;
        }
      }
    }
  } catch {}
  return [];
}

// ─── Search query schema ───────────────────────────────────────────────────────
export const searchQuerySchema = z.object({
  q: z.string().optional(),
  role: z.string().optional(),
  seniority: z.enum(['entry','mid','senior','executive','unknown']).optional(),
  remote: z.preprocess((v) => v === 'true' ? true : v === 'false' ? false : v, z.boolean().optional()),
  location: z.string().optional(),
  job_type: z.enum(['full_time','part_time','contract','internship','unknown']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  // Keyset pagination cursor: encoded as "<posted_at>_<id>" (base64)
  cursor: z.string().optional(),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;

interface KeysetCursor {
  postedAt: string;
  id: string;
}

function decodeCursor(cursor: string): KeysetCursor {
  const decoded = Buffer.from(cursor, 'base64').toString('utf8');
  const [postedAt, id] = decoded.split('|');
  if (!postedAt || !id) throw new Error('Invalid cursor');
  return { postedAt, id };
}

export function encodeCursor(postedAt: string | null, id: string): string {
  return Buffer.from(`${postedAt ?? ''}|${id}`).toString('base64');
}

/**
 * Execute a search query against the jobs table.
 *
 * Strategy:
 *   - Full-text: tsvector @@ plainto_tsquery('english', q)
 *   - Filters: role, seniority, remote, location (ILIKE), job_type
 *   - Partial index (idx_jobs_filters) covers (role, experience_level, remote, posted_at)
 *     for status='active' rows — dramatically reduces scanned rows.
 *   - Keyset pagination: WHERE (posted_at, id) < (cursor.postedAt, cursor.id)
 *     O(log n) via the composite index, consistent under concurrent inserts.
 */
export async function searchJobs(query: SearchQuery) {
  let dbQuery = supabase
    .from('jobs')
    .select('id, title, company, location, salary_min, salary_max, salary_currency, job_type, experience_level, role, skills, remote, url, posted_at, created_at')
    .eq('status', 'active')
    .order('posted_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(query.limit);

  // Full-text search
  if (query.q && query.q.trim().length > 0) {
    dbQuery = dbQuery.textSearch('search_vector', query.q, { type: 'plain', config: 'english' });
  }

  // Filters
  if (query.role)       dbQuery = dbQuery.ilike('role', `%${query.role}%`);
  if (query.seniority)  dbQuery = dbQuery.eq('experience_level', query.seniority);
  if (query.remote !== undefined) dbQuery = dbQuery.eq('remote', query.remote);
  if (query.location)   dbQuery = dbQuery.ilike('location', `%${query.location}%`);
  if (query.job_type)   dbQuery = dbQuery.eq('job_type', query.job_type);

  // Keyset cursor — "give me results older than this"
  if (query.cursor) {
    const { postedAt, id } = decodeCursor(query.cursor);
    // Using OR to handle rows with identical posted_at correctly:
    // (posted_at < cursor.postedAt) OR (posted_at = cursor.postedAt AND id < cursor.id)
    dbQuery = dbQuery.or(
      `posted_at.lt.${postedAt},and(posted_at.eq.${postedAt},id.lt.${id})`,
    );
  }

  try {
    const { data, error } = await dbQuery;
    if (!error && data) {
      const jobs = data as Array<Record<string, unknown>>;
      const lastJob = jobs[jobs.length - 1];
      const nextCursor = lastJob && jobs.length === query.limit
        ? encodeCursor(lastJob['posted_at'] as string, lastJob['id'] as string)
        : null;
      return { jobs, nextCursor, count: jobs.length };
    }
  } catch {}

  // Offline / local fallback to JobGraph's sample postings
  let localJobs = getLocalJobGraphJobs();
  if (query.q && query.q.trim().length > 0) {
    const q = query.q.toLowerCase();
    localJobs = localJobs.filter(
      (j: any) =>
        (j.title && j.title.toLowerCase().includes(q)) ||
        (j.company && j.company.toLowerCase().includes(q))
    );
  }
  if (query.remote !== undefined) {
    localJobs = localJobs.filter((j: any) => j.remote === query.remote);
  }

  const paginated = localJobs.slice(0, query.limit);
  return { jobs: paginated, nextCursor: null, count: paginated.length };
}
