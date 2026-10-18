import { z } from 'zod';
import { experienceLevelSchema } from './job.js';

// ─── LLM categorization output schema ────────────────────────────────────────
// The LLM is prompted to return ONLY this JSON. We validate it here with Zod.
// If validation fails, we retry once (Phase 4 implements the retry logic).
export const categorizationOutputSchema = z.object({
  role: z.string().min(1, 'role is required'),
  skills: z.array(z.string()).min(0),
  seniority: experienceLevelSchema,
  remote: z.boolean(),
});

export type CategorizationOutput = z.infer<typeof categorizationOutputSchema>;

// ─── Categorization cache row ─────────────────────────────────────────────────
export const categorizationCacheSchema = z.object({
  contentHash: z.string().length(64),   // SHA-256 hex
  role: z.string(),
  skills: z.array(z.string()),
  seniority: experienceLevelSchema,
  remote: z.boolean(),
  cachedAt: z.date(),
});

export type CategorizationCache = z.infer<typeof categorizationCacheSchema>;
