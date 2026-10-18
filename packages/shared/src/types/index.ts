// ─── Core domain types for JobGraph ───────────────────────────────────────────
// These types are intentionally compatible with the HireMatch schema so JobGraph
// can feed directly into the HireMatch Supabase instance without a transformation layer.

export type JobType = 'full_time' | 'part_time' | 'contract' | 'internship' | 'unknown';
export type ExperienceLevel = 'entry' | 'mid' | 'senior' | 'executive' | 'unknown';
export type JobStatus = 'active' | 'expired' | 'duplicate';
export type RawPostingStatus = 'pending' | 'processing' | 'processed' | 'failed' | 'duplicate';
export type AdapterType = 'api' | 'rss' | 'csv';
export type DedupeMethod = 'exact_hash' | 'embedding_similarity' | 'unique';
export type DedupeDecision = 'merge' | 'new';

// ─── Raw posting (one per source record before dedup/categorization) ──────────
export interface RawPosting {
  externalId: string;       // Source's own identifier
  sourceName: string;       // Adapter name, e.g. 'adzuna', 'remotive', 'csv'
  title: string;
  company: string;
  location?: string;
  description: string;
  requirements?: string;
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  jobType?: JobType;
  url?: string;
  postedAt?: Date;
  expiresAt?: Date;
  remote?: boolean;
  rawData: unknown;          // Original payload — stored as JSONB for audit
}

// ─── Canonical job record (after dedup + categorization) ──────────────────────
export interface Job {
  id: string;
  title: string;
  company: string;
  location?: string;
  description: string;
  requirements?: string;
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  jobType?: JobType;
  experienceLevel?: ExperienceLevel;
  role?: string;             // LLM-assigned role category e.g. "Software Engineer"
  skills?: string[];         // LLM-extracted skills
  remote: boolean;
  url?: string;
  postedAt?: Date;
  expiresAt?: Date;
  status: JobStatus;
  exactHash?: string;        // SHA-256 of normalized title+company+location
  createdAt: Date;
  updatedAt: Date;
}

// ─── Dedupe audit log entry ────────────────────────────────────────────────────
export interface DedupeLogEntry {
  id: string;
  rawPostingId: string;
  duplicateOfJobId?: string;
  method: DedupeMethod;
  similarityScore?: number;
  decision: DedupeDecision;
  metadata?: Record<string, unknown>;
  decidedAt: Date;
}

// ─── LLM categorization result ────────────────────────────────────────────────
export interface CategorizationResult {
  role: string;
  skills: string[];
  seniority: ExperienceLevel;
  remote: boolean;
}

// ─── Fetch options passed to an adapter ────────────────────────────────────────
export interface FetchOptions {
  since?: Date;       // Only fetch postings newer than this timestamp
  limit?: number;     // Max number of postings to yield
  keyword?: string;   // Optional keyword filter at the source level
}
