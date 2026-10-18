import { Queue, type JobsOptions } from 'bullmq';
import type IORedis from 'ioredis';
import type { RawPosting } from '@jobgraph/shared';

// ─── Queue name constants ──────────────────────────────────────────────────────
export const QUEUE_NAME = 'job-ingestion';
export const DLQ_NAME   = 'job-ingestion-dlq';

// ─── Job payload type ─────────────────────────────────────────────────────────
// Each BullMQ job carries one RawPosting plus its database row ID.
export interface IngestionJobPayload {
  rawPostingId: string;  // UUID from raw_postings table
  posting: RawPosting;
}

// ─── Default job options ───────────────────────────────────────────────────────
// Exponential backoff: attempt 1 → 5s, attempt 2 → 20s, attempt 3 → 80s
// Formula: delay = 5000 * 4^(attemptsMade)
// This avoids hammering a slow external service (OpenAI, Supabase) on transient errors.
export const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 5000,   // base delay ms
  },
  removeOnComplete: { count: 1000 },  // keep last 1000 completed jobs for observability
  removeOnFail: false,                // keep all failed jobs in DLQ for inspection
};

// ─── Queue factory ─────────────────────────────────────────────────────────────
export function createIngestionQueue(connection: IORedis) {
  return new Queue<IngestionJobPayload>(QUEUE_NAME, {
    connection,
    defaultJobOptions,
  });
}

export function createDLQ(connection: IORedis) {
  return new Queue<IngestionJobPayload>(DLQ_NAME, { connection });
}
