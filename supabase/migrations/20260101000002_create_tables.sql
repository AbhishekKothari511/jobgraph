-- Migration 002: Create all JobGraph tables
-- Design: raw_postings captures every ingested record (audit trail).
--         jobs is the canonical deduplicated record.
--         job_embeddings is decoupled (compatible with HireMatch schema).
--         dedupe_log is the per-decision audit trail.
--         categorization_cache avoids duplicate LLM calls.

-- ─── raw_postings ─────────────────────────────────────────────────────────────
-- One row per ingest event. The composite UNIQUE(source_name, external_id) is the
-- idempotency key: re-ingesting the same posting from the same source is a no-op.
CREATE TABLE IF NOT EXISTS raw_postings (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name     TEXT        NOT NULL,
  external_id     TEXT        NOT NULL,
  raw_data        JSONB       NOT NULL,
  content_hash    TEXT        NOT NULL,   -- SHA-256 of normalized title+company+description
  status          TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','processing','processed','failed','duplicate')),
  error           TEXT,
  ingested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMPTZ,
  job_id          UUID        REFERENCES jobs(id) ON DELETE SET NULL,

  -- Idempotency: source_name + external_id must be globally unique
  CONSTRAINT uq_raw_posting_source UNIQUE (source_name, external_id)
);

-- ─── jobs ─────────────────────────────────────────────────────────────────────
-- Canonical deduplicated job records. Compatible with HireMatch jobs table.
-- search_vector is a GENERATED column so it is always consistent with the text
-- columns and never needs manual update triggers.
CREATE TABLE IF NOT EXISTS jobs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title            TEXT        NOT NULL,
  company          TEXT        NOT NULL,
  location         TEXT,
  description      TEXT        NOT NULL,
  requirements     TEXT,
  salary_min       INTEGER     CHECK (salary_min >= 0),
  salary_max       INTEGER     CHECK (salary_max >= 0),
  salary_currency  TEXT        DEFAULT 'USD',
  job_type         TEXT        CHECK (job_type IN ('full_time','part_time','contract','internship','unknown')),
  experience_level TEXT        CHECK (experience_level IN ('entry','mid','senior','executive','unknown')),
  role             TEXT,          -- LLM-assigned category
  skills           TEXT[],        -- LLM-extracted skills array
  remote           BOOLEAN     NOT NULL DEFAULT FALSE,
  url              TEXT,
  posted_at        TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,
  status           TEXT        NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active','expired','duplicate')),
  exact_hash       TEXT,          -- SHA-256 of normalize(title+company+location) for fast exact dedup
  -- GENERATED ALWAYS AS: Postgres computes this automatically on insert/update.
  -- We coalesce NULL fields to empty string so the vector is never NULL.
  -- 'english' stemmer handles common English stop words and morphology.
  search_vector    TSVECTOR    GENERATED ALWAYS AS (
                      to_tsvector('english',
                        coalesce(title,'') || ' ' ||
                        coalesce(company,'') || ' ' ||
                        coalesce(location,'') || ' ' ||
                        coalesce(description,'') || ' ' ||
                        coalesce(requirements,'') || ' ' ||
                        coalesce(array_to_string(skills, ' '),'')
                      )
                   ) STORED,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── job_embeddings ───────────────────────────────────────────────────────────
-- Decoupled from jobs: keeps the jobs table narrow for OLTP queries.
-- UNIQUE(job_id, model) allows storing embeddings from multiple models
-- (e.g., comparing text-embedding-3-small vs text-embedding-3-large).
-- Dimension is NOT hardcoded here; the vector dimension comes from env config
-- and is enforced at the application layer. This is a deliberate design choice:
-- changing embedding models does not require a schema migration — only a new row.
CREATE TABLE IF NOT EXISTS job_embeddings (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id     UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  embedding  vector(1536),  -- dimension matches EMBEDDING_DIMENSIONS env var
  model      TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_job_embedding_model UNIQUE (job_id, model)
);

-- ─── dedupe_log ───────────────────────────────────────────────────────────────
-- Immutable audit trail. Every deduplication decision is recorded here so
-- merges can be reviewed and corrected without data loss.
-- method: 'exact_hash' (deterministic) | 'embedding_similarity' (probabilistic) | 'unique' (no match)
-- decision: 'merge' (this raw posting maps to an existing job) | 'new' (creates a new canonical job)
CREATE TABLE IF NOT EXISTS dedupe_log (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_posting_id    UUID        NOT NULL REFERENCES raw_postings(id) ON DELETE CASCADE,
  duplicate_of_job_id UUID      REFERENCES jobs(id) ON DELETE SET NULL,
  method            TEXT        NOT NULL CHECK (method IN ('exact_hash','embedding_similarity','unique')),
  similarity_score  FLOAT,      -- NULL for exact_hash and unique; cosine sim for embedding_similarity
  decision          TEXT        NOT NULL CHECK (decision IN ('merge','new')),
  metadata          JSONB,      -- extra context: top-3 candidates, threshold used, etc.
  decided_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── categorization_cache ─────────────────────────────────────────────────────
-- Keyed by SHA-256 of the normalized job description+requirements text.
-- If the same text appears from two different sources, we reuse the cached
-- categorization result and skip the LLM call (cost reduction).
CREATE TABLE IF NOT EXISTS categorization_cache (
  content_hash TEXT        PRIMARY KEY,   -- SHA-256 hex of normalized description text
  role         TEXT        NOT NULL,
  skills       TEXT[]      NOT NULL,
  seniority    TEXT        NOT NULL CHECK (seniority IN ('entry','mid','senior','executive','unknown')),
  remote       BOOLEAN     NOT NULL,
  raw_response JSONB,                     -- full LLM JSON for debugging
  cached_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── updated_at trigger ───────────────────────────────────────────────────────
-- Automatically updates the updated_at column on jobs whenever a row changes.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER jobs_updated_at
  BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
