# HireMatch — Architectural Decision Records (ADR)

This document records every architectural and system design decision made for **JobGraph**, a scalable job ingestion, deduplication, categorization, and search platform.

Each entry follows the standard ADR format:
- **Context**: The problem and constraints.
- **Options Considered**: Evaluated alternatives.
- **Decision**: The chosen path and rationale.
- **Consequences**: Tradeoffs, operational implications.
- **When I'd Switch**: Concrete criteria for revisiting this decision.

---

## ADR 001: Monorepo Structure — npm Workspaces

- **Context**: JobGraph has distinct runtime components (ingestion workers, search API, scripts) that must share TypeScript types and Zod schemas without publishing to an npm registry. The project must be buildable in Docker without additional tooling.
- **Options Considered**:
  1. *Polyrepo*: Separate repositories per service. Maximum independence, but type sharing requires a private registry or manual copying.
  2. *Turborepo / Nx*: High-performance monorepo with remote caching and distributed builds.
  3. *npm Workspaces*: Built-in Node.js monorepo support — zero extra dependencies, symlinks packages locally.
- **Decision**: **npm Workspaces**. It satisfies the sharing requirement with zero tooling overhead. Every standard Docker multi-stage build supports `npm ci --workspace=apps/api` natively.
- **Consequences**:
  - *Pros*: No CI setup for build caching; works in any Node.js 16+ environment; Docker COPY is straightforward.
  - *Cons*: No distributed task caching (slower CI as the repo grows beyond ~10 packages).
- **When I'd Switch**: CI build time exceeds 10 minutes or more than 5 independent teams contribute simultaneously → migrate to Turborepo with remote caching.

---

## ADR 002: Adapter Interface Design — AsyncGenerator vs Callback vs EventEmitter

- **Context**: Each ingestion source (API, RSS, CSV) has different pagination and streaming characteristics. The queue producer needs to iterate results and apply backpressure (don't produce faster than the consumer can process). We need a single interface that works for all adapter types without adapter authors needing to implement their own flow control.
- **Options Considered**:
  1. *Callback (`onPosting(callback)`)* : Simple, but backpressure is manual (the producer must pause the callback when the queue is full). Error propagation requires an extra `onError` callback.
  2. *EventEmitter (`adapter.on('posting', ...)`)* : Node.js idiomatic for streams, but requires error channel discipline and doesn't work cleanly with `async/await`.
  3. *`AsyncGenerator<RawPosting>`*: Works naturally with `for await...of`. Backpressure is built-in: the generator is paused between `yield` calls until the consumer requests the next value. Error propagation uses standard `throw`. Composition (e.g., `merge` across adapters) is trivial with async-iterator helpers.
- **Decision**: **`AsyncGenerator<RawPosting>`** via the `fetch(): AsyncGenerator<RawPosting>` method on the interface.
- **Consequences**:
  - *Pros*: Zero manual backpressure code. Error handling is idiomatic try/catch. Works out-of-the-box with BullMQ (Phase 2): `for await (const posting of adapter.fetch()) { await queue.add(posting) }`.
  - *Cons*: Slightly harder to parallelize across multiple adapters simultaneously (must use `Promise.all` or an async-iterator merge utility). Less familiar to engineers who primarily work with callbacks.
- **When I'd Switch**: If cross-adapter parallelism becomes critical (e.g., 20 concurrent adapters each producing 1000 postings/sec), migrate to Node.js Transform streams or a stream multiplexer with explicit backpressure.

---

## ADR 003: Idempotency Key Design — (source_name, external_id) Composite Unique

- **Context**: Ingestion runs on a schedule (or on CSV drop). The same posting may arrive multiple times from the same source (re-ingestion on retry, re-run, or source publishing the same job twice). We must never insert a duplicate `raw_posting` and we must never process a posting twice.
- **Options Considered**:
  1. *Application-layer check (`SELECT` before `INSERT`)*: Read-before-write under concurrent workers creates a TOCTOU race condition. Two workers could both SELECT "not found" and both INSERT.
  2. *Content hash dedup only*: SHA-256 of normalized description. Works for exact-text duplicates but fails if the source slightly modifies the description on republication (e.g., updates "posted 3 days ago" text in the description).
  3. *Composite DB unique constraint on (source_name, external_id)*: Enforced at the database level. `INSERT ... ON CONFLICT DO NOTHING` is atomic. Race-condition safe. Fast (unique index lookup).
- **Decision**: **Composite `UNIQUE(source_name, external_id)` constraint** on `raw_postings`. The application uses `INSERT ... ON CONFLICT DO NOTHING` and treats a 409/23505 response as "already processed — skip."
  - `source_name` is the adapter's `name` property (e.g., `'adzuna'`, `'remotive'`, `'csv'`).
  - `external_id` is the source's own ID (Adzuna job ID, RSS guid, CSV row hash).
- **Consequences**:
  - *Pros*: Atomic, race-condition-safe, zero additional queries. Fast (index lookup). Works even if two workers race to insert the same posting simultaneously.
  - *Cons*: If a source reuses external IDs across different job postings (rare but happens with some scraped feeds), we'd silently skip the new posting. Mitigated by the content hash secondary check in Phase 3 dedup.
- **When I'd Switch**: If source IDs are proven to be unstable (e.g., a CSV feed that reuses row numbers), switch to a composite key of (source_name, content_hash) instead.

---

## ADR 004: Schema Compatibility with HireMatch

- **Context**: JobGraph's primary use case is feeding jobs into the HireMatch AI matching platform. HireMatch has an existing Supabase schema with `jobs` and `job_embeddings` tables. We need to decide how JobGraph stores canonical jobs.
- **Options Considered**:
  1. *JobGraph-specific schema, separate Supabase project*: Maximum schema freedom but requires an ETL sync process to HireMatch.
  2. *JobGraph-specific schema, same Supabase project*: Avoids ETL but creates implicit coupling without a formal interface.
  3. *Use HireMatch's exact `jobs` + `job_embeddings` schema, same DB*: JobGraph becomes a native feeder; no ETL. One shared DB means one source of truth for job data.
- **Decision**: **Reuse HireMatch's `jobs` + `job_embeddings` schema** in the same Supabase project. JobGraph adds three *additional* tables (`raw_postings`, `dedupe_log`, `categorization_cache`) that HireMatch doesn't need to know about. The `jobs` and `job_embeddings` tables are byte-compatible with HireMatch.
- **Consequences**:
  - *Pros*: HireMatch queries (hybrid search, match display) work unchanged. No ETL layer. Embeddings generated by JobGraph's worker are immediately available to HireMatch's `/matches` endpoint.
  - *Cons*: The two projects share a database — a schema migration in one affects the other. Requires coordination. Mitigated by schema ownership documentation (JobGraph owns `raw_postings`, `dedupe_log`, `categorization_cache`; HireMatch owns `users`, `resumes`, `matches`, `applications`; both share `jobs` and `job_embeddings`).
- **When I'd Switch**: If JobGraph scales to a separate team or requires schema changes incompatible with HireMatch (e.g., sharding, multi-tenant), split into two Supabase projects and add an async sync via a Postgres publication/subscription.

---

## ADR 005: Source Selection — Adzuna API + Remotive RSS + CSV Drop Folder

- **Context**: We need 2–3 real job sources that are free to use (no paid tier required for a demo/MVP), cover different source types (API, feed, file), and collectively demonstrate the adapter pattern without requiring user registration for the primary source.
- **Options Considered**:
  1. *LinkedIn Jobs*: High quality but requires scraping (ToS violation). Rejected.
  2. *Indeed API*: Restricted access (publisher program, US-only for free tier). Rejected.
  3. *Adzuna API*: Free registration, 250 req/day, 50 results/page, structured JSON, covers 16 countries. Global. ✅
  4. *Remotive RSS*: No auth, 300+ remote tech jobs, standard RSS 2.0. ✅
  5. *GitHub Jobs (deprecated)*: Shut down in 2022. Rejected.
  6. *CSV drop folder*: Necessary for enterprise clients who export from ATS (Workday, Greenhouse) to CSV. No external dependency. ✅
- **Decision**: **Adzuna API + Remotive RSS + CSV drop folder.**
  - Adzuna: demonstrates API pagination, schema validation, credential management.
  - Remotive RSS: demonstrates feed parsing, date filtering, HTML stripping.
  - CSV: demonstrates local file watching, row-by-row streaming, enterprise ingest pattern.
- **Consequences**:
  - *Pros*: Three structurally different source types exercise the full adapter interface. All are free. No scraping required.
  - *Cons*: Adzuna free tier (250 req/day) limits daily ingestion volume; for production use, upgrade to a paid tier or add a second API adapter (e.g., Jooble, Arbeitnow).
- **When I'd Switch**: When volume exceeds Adzuna's free tier limit → either upgrade to Adzuna Pro or add the Jooble adapter (same interface, different config).

---

## ADR 006: Deduplication Strategy — Two-Stage (Exact Hash + Embedding Similarity)

- **Context**: The same job appears across multiple sources. "Senior TypeScript Engineer at Stripe" from Adzuna and the same posting from Remotive must not create two canonical `jobs` rows. However, we can't use a single source-ID-based dedup (different sources have different IDs). We need a cross-source dedup strategy.
- **Options Considered**:
  1. *Title + company exact string match*: Fast but misses "Sr. TS Engineer" vs "Senior TypeScript Engineer."
  2. *Embedding similarity only*: High recall, but expensive (one embedding API call per incoming posting, plus an ANN search). Misses no duplicates but costs $0.0001/1k tokens × millions of postings.
  3. *Two-stage: exact hash first, then embedding for near-duplicates*: Fast O(1) exact check avoids embedding calls for clear duplicates. Embedding only runs when exact hash finds no match. Best recall/cost tradeoff.
- **Decision**: **Two-stage dedup** (Phase 3):
  - Stage 1: `exact_hash = SHA256(normalize(title) | normalize(company) | normalize(location))`. If a job with this hash already exists → merge immediately, no embedding needed.
  - Stage 2: Generate embedding for the incoming posting's description. Query HNSW index for nearest neighbors with cosine similarity ≥ `DEDUP_EMBEDDING_THRESHOLD` (default 0.92). If found → near-duplicate merge.
  - Every decision (exact_hash/embedding/unique, merge/new) is recorded in `dedupe_log`.
- **Consequences**:
  - *Pros*: Exact hash catches >70% of cross-source duplicates at zero LLM cost. Embedding catches semantic duplicates. Audit log enables manual review and threshold tuning.
  - *Cons*: Threshold is a hyperparameter that requires calibration. Phase 6 eval script will measure precision/recall at different thresholds.
- **When I'd Switch**: If embedding cost becomes significant → fine-tune a lightweight similarity classifier trained on labeled duplicate pairs instead of using a general-purpose embedding model.

---

## ADR 007: Categorization Caching — SHA-256 of Normalized Description

- **Context**: LLM categorization ($0.0001/call) adds up at scale. Many postings have identical or near-identical descriptions (copy-paste job posts from the same employer across multiple boards). We should cache by content, not by source ID.
- **Options Considered**:
  1. *Cache by (title + company)*: Misses the same description text if the title varies slightly.
  2. *Cache by embedding similarity*: Expensive (requires embedding to look up cache).
  3. *Cache by SHA-256(normalize(description))*: O(1) cache lookup. Two identical description texts always produce the same hash. Free.
- **Decision**: **SHA-256 of `normalizeDescription(description)` as `categorization_cache` primary key.** Before calling the LLM, check the cache. On cache miss, call the LLM, validate output with Zod, store in cache. Retry once on Zod validation failure.
- **Consequences**:
  - *Pros*: Cache hit rate expected to be 20–40% for popular job descriptions. Zero additional infrastructure (no Redis needed for Phase 4 — Postgres IS the cache for categorization).
  - *Cons*: Exact text match only. Slight description edits (an extra space or punctuation) break the cache. Mitigated by normalization (strips HTML, collapses whitespace).
- **When I'd Switch**: If cache miss rate remains high even after normalization → switch to an embedding-based approximate cache with a cosine similarity threshold.

---

## ADR 008: Full-Text Index — GIN over GiST for tsvector

- **Context**: Job search queries are keyword-heavy (`WHERE search_vector @@ plainto_tsquery('python postgres')`). PostgreSQL supports two index types for `tsvector`: GIN and GiST.
- **Options Considered**:
  1. *GiST*: Balanced tree with lossy compression. Supports proximity queries but 2–3× slower lookup than GIN. Better for multi-column or combined indexes.
  2. *GIN (Generalized Inverted Index)*: Posting-list per lexeme. Fast for exact tsquery matches. Standard recommendation for `tsvector` columns in PostgreSQL docs.
- **Decision**: **GIN index on `search_vector`.**
- **Consequences**:
  - *Pros*: Order-of-magnitude faster `@@` queries vs sequential scan. GIN is the PostgreSQL official recommendation for full-text.
  - *Cons*: GIN updates are slower than GiST (must rebuild posting lists). Mitigated by the `search_vector` being `GENERATED ALWAYS AS STORED` — Postgres batches these updates internally.
- **When I'd Switch**: If proximity ranking (e.g., `ts_rank_cd` with position info) becomes important for relevance sorting → GiST supports positional data; or use Elasticsearch if full-text sophistication becomes a core product feature.

---

## ADR 009: Keyset Pagination over Offset Pagination

- **Context**: The search API (Phase 5) must paginate job results. Offset-based pagination (`LIMIT n OFFSET k`) is the simplest approach but has two critical failure modes at scale:
  1. *Performance*: `OFFSET 10000` forces Postgres to read and discard 10,000 rows on each page.
  2. *Consistency*: If a new job is inserted between page 1 and page 2, rows shift and the user sees duplicates or misses rows.
- **Options Considered**:
  1. *Offset pagination*: Simple, but O(n) cost and inconsistent under concurrent inserts.
  2. *Cursor-based (keyset) pagination*: `WHERE (posted_at, id) < (lastPostedAt, lastId) ORDER BY posted_at DESC, id DESC LIMIT n`. O(log n) with the composite index. Consistent under concurrent writes.
  3. *Page tokens (opaque cursor)*: Base64-encode the keyset values for the client. Hides implementation details.
- **Decision**: **Keyset pagination** using `(posted_at DESC, id DESC)` as the composite sort key. Clients pass `cursor=<lastPostedAt>_<lastId>` as a query param. The API decodes this and appends the `WHERE` clause.
- **Consequences**:
  - *Pros*: O(log n) even at millions of rows. Consistent results under concurrent inserts. The `idx_jobs_filters` partial index covers this sort order.
  - *Cons*: Clients cannot jump to arbitrary pages (no "go to page 500"). Acceptable for a job feed use case where infinite scroll is the expected UX.
- **When I'd Switch**: If a use case requires random page access (e.g., a paginated admin dashboard where users jump to page N) → use offset pagination for that specific endpoint with a reasonable `LIMIT`.

---
