-- Migration 005: near_duplicate search function
-- Used by the dedup service (Phase 3) to find semantically similar jobs
-- Returns top-N jobs with cosine similarity above threshold

CREATE OR REPLACE FUNCTION find_near_duplicates(
  query_embedding vector(1536),
  similarity_threshold float DEFAULT 0.92,
  match_count int DEFAULT 3
)
RETURNS TABLE (
  job_id UUID,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    je.job_id,
    1 - (je.embedding <=> query_embedding) AS similarity
  FROM job_embeddings je
  INNER JOIN jobs j ON j.id = je.job_id
  WHERE j.status = 'active'
    AND 1 - (je.embedding <=> query_embedding) >= similarity_threshold
  ORDER BY je.embedding <=> query_embedding ASC
  LIMIT match_count;
$$;
