-- Migration 003: Create all indexes
-- Strategy:
--   GIN on search_vector → full-text search (fast for @@ queries)
--   HNSW on embedding → approximate nearest-neighbor vector search
--   GIN on skills array → fast containment queries (@>)
--   B-tree composites → for the common filtered list queries (Phase 5)
--   B-tree on raw_postings → for worker claiming and status checks

-- ─── Full-text search index ───────────────────────────────────────────────────
-- GIN (Generalized Inverted Index) is the standard choice for tsvector columns.
-- It stores a posting list per lexeme, so ts_rank queries run in microseconds
-- even on millions of rows. GiST would support proximity ranking but is 2-3x
-- slower for pure lookup. We use GIN.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_search_vector
  ON jobs USING GIN (search_vector);

-- ─── Vector similarity index ──────────────────────────────────────────────────
-- HNSW (Hierarchical Navigable Small World) chosen over IVFFlat because:
--   1. No training step needed (IVFFlat requires a separate CREATE INDEX ... WITH (lists=N) pass over data)
--   2. Better recall at the same ef_search value
--   3. Incremental inserts don't degrade recall (IVFFlat recall drops if data drifts from initial centroids)
-- m=16: edges per node in the graph. Higher → better recall, more memory. 16 is the pgvector default.
-- ef_construction=64: candidates explored during build. Higher → better graph quality, slower build.
-- We use vector_cosine_ops because embeddings are unit-normalized (L2 norm = 1.0).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_job_embeddings_hnsw
  ON job_embeddings USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ─── Skills array containment index ──────────────────────────────────────────
-- GIN on TEXT[] supports the @> operator efficiently:
--   WHERE skills @> ARRAY['python', 'postgres']
-- Without this index, PostgreSQL performs a sequential scan on the array for every row.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_skills_gin
  ON jobs USING GIN (skills);

-- ─── Composite indexes for common search filters ──────────────────────────────
-- Phase 5 search API will filter by (role, seniority, remote) and sort by posted_at DESC.
-- A composite index covering these columns allows index-only scans for most queries.
-- ORDER: role first (high cardinality), then experience_level, then remote, then posted_at
-- for keyset pagination. posted_at DESC matches the default sort order.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_filters
  ON jobs (role, experience_level, remote, posted_at DESC)
  WHERE status = 'active';     -- partial index: excludes expired/duplicate rows

-- Separate index for location prefix queries (ILIKE 'London%')
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_location_trgm
  ON jobs USING GIN (location gin_trgm_ops);

-- Exact hash lookup for dedup (exact string match, B-tree is optimal)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_exact_hash
  ON jobs (exact_hash)
  WHERE exact_hash IS NOT NULL;

-- ─── raw_postings indexes ──────────────────────────────────────────────────────
-- Workers query for 'pending' rows; content_hash used for exact dedup pre-check
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_raw_postings_status_ingested
  ON raw_postings (status, ingested_at ASC)
  WHERE status IN ('pending', 'failed');

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_raw_postings_content_hash
  ON raw_postings (content_hash);

-- ─── dedupe_log indexes ────────────────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dedupe_log_raw_posting
  ON dedupe_log (raw_posting_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dedupe_log_duplicate_of
  ON dedupe_log (duplicate_of_job_id)
  WHERE duplicate_of_job_id IS NOT NULL;
