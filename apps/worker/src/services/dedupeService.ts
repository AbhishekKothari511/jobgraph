import type { Logger } from 'pino';
import { computeExactHash } from '../../../packages/shared/src/utils/normalize.js';
import * as db from './supabaseService.js';
import { generateEmbedding } from './embeddingService.js';
import { env } from '../config/env.js';
import type { RawPosting } from '@jobgraph/shared';

export interface DedupeResult {
  decision: 'merge' | 'new';
  existingJobId?: string;
  method: 'exact_hash' | 'embedding_similarity' | 'unique';
  similarityScore?: number;
  embedding?: number[];
}

/**
 * Two-stage deduplication pipeline:
 *
 * Stage 1 — Exact hash (O(1) B-tree lookup):
 *   SHA-256 of normalize(title|company|location)
 *   Deterministic: catches same job from multiple sources
 *
 * Stage 2 — Embedding similarity (HNSW ANN search):
 *   Generate embedding for description, query pgvector HNSW index
 *   Catches near-duplicates (rephrased descriptions, minor edits)
 *   Only runs if Stage 1 finds no match (cost optimisation)
 *
 * Every decision is recorded in dedupe_log for audit.
 */
export async function deduplicate(
  rawPostingId: string,
  posting: RawPosting,
  logger: Logger,
): Promise<DedupeResult> {
  // ── Stage 1: Exact hash ─────────────────────────────────────────────────────
  const exactHash = computeExactHash(posting.title, posting.company, posting.location);
  const existingByHash = await db.findJobByExactHash(exactHash);

  if (existingByHash) {
    logger.info(
      { rawPostingId, method: 'exact_hash', existingJobId: existingByHash },
      'Exact duplicate found',
    );
    await db.insertDedupeLog({
      raw_posting_id: rawPostingId,
      duplicate_of_job_id: existingByHash,
      method: 'exact_hash',
      decision: 'merge',
    });
    return { decision: 'merge', existingJobId: existingByHash, method: 'exact_hash' };
  }

  // ── Stage 2: Embedding similarity ──────────────────────────────────────────
  const text = `${posting.title} ${posting.company} ${posting.description}`.slice(0, 2000);
  let embedding: number[];
  try {
    embedding = await generateEmbedding(text, logger);
  } catch (err) {
    logger.warn({ err }, 'Embedding failed — treating as unique (no dedup)');
    await db.insertDedupeLog({
      raw_posting_id: rawPostingId,
      method: 'unique',
      decision: 'new',
      metadata: { embeddingError: String(err) },
    });
    return { decision: 'new', method: 'unique' };
  }

  const nearDuplicates = await db.findNearDuplicates(embedding, env.DEDUP_EMBEDDING_THRESHOLD);

  if (nearDuplicates.length > 0) {
    const best = nearDuplicates[0]!;
    logger.info(
      { rawPostingId, method: 'embedding_similarity', existingJobId: best.job_id, similarity: best.similarity },
      'Near-duplicate found via embedding',
    );
    await db.insertDedupeLog({
      raw_posting_id: rawPostingId,
      duplicate_of_job_id: best.job_id,
      method: 'embedding_similarity',
      similarity_score: best.similarity,
      decision: 'merge',
      metadata: { candidates: nearDuplicates },
    });
    return { decision: 'merge', existingJobId: best.job_id, method: 'embedding_similarity', similarityScore: best.similarity, embedding };
  }

  // ── Unique: no duplicate found ──────────────────────────────────────────────
  await db.insertDedupeLog({
    raw_posting_id: rawPostingId,
    method: 'unique',
    decision: 'new',
    metadata: { exactHash },
  });
  return { decision: 'new', method: 'unique', embedding };
}
