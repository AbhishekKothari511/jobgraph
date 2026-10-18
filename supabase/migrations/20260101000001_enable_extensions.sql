-- Migration 001: Enable PostgreSQL extensions
-- pgvector: high-dimensional vector similarity search (HNSW index)
-- pg_trgm: trigram similarity for fuzzy text matching (used in dedup)
-- uuid-ossp: deterministic UUID generation (gen_random_uuid is built-in from pg14, kept for compatibility)

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
