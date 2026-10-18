import { z } from 'zod';

// ─── Job type / experience level enums ────────────────────────────────────────
export const jobTypeSchema = z.enum([
  'full_time', 'part_time', 'contract', 'internship', 'unknown',
]);

export const experienceLevelSchema = z.enum([
  'entry', 'mid', 'senior', 'executive', 'unknown',
]);

export const jobStatusSchema = z.enum(['active', 'expired', 'duplicate']);

// ─── Raw posting schema (ingestion layer input validation) ────────────────────
// Used to validate adapter output before it is queued / persisted.
export const rawPostingSchema = z.object({
  externalId: z.string().min(1, 'externalId cannot be empty'),
  sourceName: z.string().min(1),
  title: z.string().min(1, 'title is required'),
  company: z.string().min(1, 'company is required'),
  location: z.string().optional(),
  description: z.string().min(10, 'description must be at least 10 characters'),
  requirements: z.string().optional(),
  salaryMin: z.number().int().nonnegative().optional(),
  salaryMax: z.number().int().nonnegative().optional(),
  salaryCurrency: z.string().length(3).optional(),  // ISO 4217
  jobType: jobTypeSchema.optional(),
  url: z.string().url().optional(),
  postedAt: z.date().optional(),
  expiresAt: z.date().optional(),
  remote: z.boolean().optional(),
  rawData: z.unknown(),
});

export type RawPostingInput = z.infer<typeof rawPostingSchema>;

// ─── Canonical job insert schema ───────────────────────────────────────────────
export const jobInsertSchema = z.object({
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

export type JobInsert = z.infer<typeof jobInsertSchema>;
