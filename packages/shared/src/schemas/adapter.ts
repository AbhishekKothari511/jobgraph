import { z } from 'zod';
import { jobTypeSchema } from './job.js';

// ─── Adapter configuration schemas ────────────────────────────────────────────
// Each adapter reads its config from env vars; these schemas validate the config
// object so misconfigured adapters fail loudly at startup, not silently at runtime.

export const adzunaConfigSchema = z.object({
  appId: z.string().min(1, 'ADZUNA_APP_ID is required'),
  appKey: z.string().min(1, 'ADZUNA_APP_KEY is required'),
  country: z.string().default('gb'),
  keyword: z.string().default('software engineer'),
  resultsPerPage: z.number().int().min(1).max(50).default(50),
});

export const rssConfigSchema = z.object({
  feedUrl: z.string().url('RSS_FEED_URL must be a valid URL'),
  sourceName: z.string().min(1).default('rss'),
});

export const csvConfigSchema = z.object({
  dropFolder: z.string().min(1),
  archiveFolder: z.string().min(1),
});

export type AdzunaConfig = z.infer<typeof adzunaConfigSchema>;
export type RssConfig = z.infer<typeof rssConfigSchema>;
export type CsvConfig = z.infer<typeof csvConfigSchema>;

// ─── Adzuna API response schema ────────────────────────────────────────────────
// Only the fields we actually use; extra fields are stripped by z.object (not passthrough).
const adzunaJobSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  company: z.object({ display_name: z.string() }),
  location: z.object({ display_name: z.string() }).optional(),
  salary_min: z.number().optional(),
  salary_max: z.number().optional(),
  contract_type: z.string().optional(),  // "permanent" | "contract"
  redirect_url: z.string().url().optional(),
  created: z.string().optional(),        // ISO 8601 string
});

export const adzunaResponseSchema = z.object({
  results: z.array(adzunaJobSchema),
  count: z.number(),
});

export type AdzunaJob = z.infer<typeof adzunaJobSchema>;
export type AdzunaResponse = z.infer<typeof adzunaResponseSchema>;

// ─── RSS item schema (rss-parser output) ──────────────────────────────────────
export const rssItemSchema = z.object({
  title: z.string(),
  link: z.string().url().optional(),
  contentSnippet: z.string().optional(),
  content: z.string().optional(),
  isoDate: z.string().optional(),
  guid: z.string().optional(),
});

export type RssItem = z.infer<typeof rssItemSchema>;

// ─── CSV row schema ────────────────────────────────────────────────────────────
// Expected CSV headers (case-insensitive after normalization):
//   title, company, location, description, url, salary_min, salary_max, remote, job_type, posted_at
export const csvRowSchema = z.object({
  title: z.string().min(1),
  company: z.string().min(1),
  location: z.string().optional(),
  description: z.string().min(1),
  url: z.string().url().optional(),
  salary_min: z.coerce.number().int().nonnegative().optional(),
  salary_max: z.coerce.number().int().nonnegative().optional(),
  remote: z.coerce.boolean().optional(),
  job_type: jobTypeSchema.optional(),
  posted_at: z.string().optional(),
});

export type CsvRow = z.infer<typeof csvRowSchema>;
