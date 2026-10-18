-- Migration 004: Row-Level Security policies
-- RLS ensures API consumers can only read active, public job data.
-- Internal services use the service_role key which bypasses RLS entirely.

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_postings ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE dedupe_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE categorization_cache ENABLE ROW LEVEL SECURITY;

-- ─── jobs: public read, no public write ───────────────────────────────────────
-- The anonymous (unauthenticated) role can read active jobs only.
-- No INSERT/UPDATE/DELETE: only the service_role (backend API) can mutate.
CREATE POLICY "jobs_public_read"
  ON jobs FOR SELECT
  TO anon, authenticated
  USING (status = 'active');

-- ─── job_embeddings: no public access ─────────────────────────────────────────
-- Embeddings are internal-only. Exposed only via the hybrid_search_jobs() function
-- (which runs as SECURITY DEFINER with service_role privileges).
-- There is no direct anonymous access to this table.
CREATE POLICY "job_embeddings_no_public_access"
  ON job_embeddings FOR ALL
  TO anon
  USING (FALSE);  -- always false → no rows visible to anon

-- ─── raw_postings: internal only ──────────────────────────────────────────────
CREATE POLICY "raw_postings_no_public_access"
  ON raw_postings FOR ALL
  TO anon
  USING (FALSE);

-- ─── dedupe_log: internal only ────────────────────────────────────────────────
CREATE POLICY "dedupe_log_no_public_access"
  ON dedupe_log FOR ALL
  TO anon
  USING (FALSE);

-- ─── categorization_cache: internal only ──────────────────────────────────────
CREATE POLICY "categorization_cache_no_public_access"
  ON categorization_cache FOR ALL
  TO anon
  USING (FALSE);
