import type { Processor } from 'bullmq';
import type { Logger } from 'pino';
import type { IngestionJobPayload } from '../queues/ingestionQueue.js';
import * as db from '../services/supabaseService.js';
import { deduplicate } from '../services/dedupeService.js';
import { categorize } from '../services/categorizationService.js';
import { computeExactHash } from '../../../packages/shared/src/utils/normalize.js';

/**
 * Main ingestion pipeline processor.
 * Each BullMQ job runs this function. Steps:
 *
 * 1. Mark raw_posting as 'processing'
 * 2. Deduplication (exact hash → embedding similarity)
 *    - If merge: update raw_posting with job_id, mark as 'duplicate', done
 *    - If new: continue to step 3
 * 3. LLM categorization (with cache)
 * 4. Insert canonical job into 'jobs' table
 * 5. Insert embedding into 'job_embeddings' table
 * 6. Mark raw_posting as 'processed'
 *
 * On any unhandled exception, BullMQ retries with exponential backoff.
 * After max attempts, the job moves to the DLQ and raw_posting is marked 'failed'.
 */
export function createIngestionProcessor(logger: Logger): Processor<IngestionJobPayload> {
  return async (job) => {
    const { rawPostingId, posting } = job.data;
    const jobLogger = logger.child({ rawPostingId, source: posting.sourceName, jobId: job.id });

    jobLogger.info('Processing ingestion job');

    // Step 1: Mark as processing
    await db.updateRawPostingStatus(rawPostingId, 'processing');

    // Step 2: Deduplicate
    const dedupeResult = await deduplicate(rawPostingId, posting, jobLogger);

    if (dedupeResult.decision === 'merge') {
      await db.updateRawPostingStatus(rawPostingId, 'duplicate', {
        job_id: dedupeResult.existingJobId,
        processed_at: new Date().toISOString(),
      });
      jobLogger.info({ existingJobId: dedupeResult.existingJobId, method: dedupeResult.method }, 'Duplicate — merged');
      return { status: 'duplicate', jobId: dedupeResult.existingJobId };
    }

    // Step 3: Categorize
    const category = await categorize(posting.description, jobLogger);
    jobLogger.info({ role: category.role, seniority: category.seniority, skills: category.skills.length }, 'Categorized');

    // Step 4: Insert canonical job
    const exactHash = computeExactHash(posting.title, posting.company, posting.location);
    const canonicalJobId = await db.insertJob({
      title: posting.title,
      company: posting.company,
      location: posting.location,
      description: posting.description,
      requirements: posting.requirements,
      salary_min: posting.salaryMin,
      salary_max: posting.salaryMax,
      salary_currency: posting.salaryCurrency ?? 'USD',
      job_type: posting.jobType,
      experience_level: category.seniority,
      role: category.role,
      skills: category.skills,
      remote: posting.remote ?? category.remote,
      url: posting.url,
      posted_at: posting.postedAt?.toISOString(),
      expires_at: posting.expiresAt?.toISOString(),
      exact_hash: exactHash,
      status: 'active',
    });

    // Step 5: Insert embedding (if available from dedup stage)
    if (dedupeResult.embedding) {
      await db.insertJobEmbedding(canonicalJobId, dedupeResult.embedding, process.env['EMBEDDING_MODEL'] ?? 'text-embedding-3-small');
    }

    // Step 6: Mark raw_posting as processed
    await db.updateRawPostingStatus(rawPostingId, 'processed', {
      job_id: canonicalJobId,
      processed_at: new Date().toISOString(),
    });

    jobLogger.info({ canonicalJobId }, 'Ingestion complete — new job created');
    return { status: 'processed', jobId: canonicalJobId };
  };
}
