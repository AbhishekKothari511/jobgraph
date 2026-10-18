import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';
import type { RawPosting } from '@jobgraph/shared';
import { computeExactHash, computeContentHash } from '../utils/normalize.js';
import type { Logger } from 'pino';

// ─── Supabase service for Phase 1 ──────────────────────────────────────────────
// Responsibility: persist raw_postings to Supabase with idempotency.
// The service_role key bypasses RLS — only used by internal backend services.
// Public API (Phase 5) uses the anon key (enforces RLS).
export function createSupabaseService(logger: Logger) {
  // service_role: full access, bypasses RLS. Never expose to the browser.
  const client: SupabaseClient = createClient(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );

  return {
    /**
     * Insert a raw posting with idempotency.
     * Uses ON CONFLICT DO NOTHING on (source_name, external_id).
     * Returns true if inserted (new), false if skipped (duplicate).
     */
    async insertRawPosting(posting: RawPosting): Promise<{ inserted: boolean; id?: string }> {
      const exactHash = computeExactHash(posting.title, posting.company, posting.location);
      const contentHash = computeContentHash(posting.description);

      const { data, error, status } = await client
        .from('raw_postings')
        .insert({
          source_name: posting.sourceName,
          external_id: posting.externalId,
          raw_data: posting.rawData,
          content_hash: contentHash,
          status: 'pending',
        })
        .select('id')
        .single();

      // 23505 = unique_violation (PostgreSQL error code) — this is the idempotency path
      if (error) {
        if (status === 409 || error.code === '23505') {
          logger.debug(
            { source: posting.sourceName, externalId: posting.externalId },
            'Raw posting already exists — skipping (idempotent)',
          );
          return { inserted: false };
        }
        logger.error({ error, posting: posting.externalId }, 'Failed to insert raw posting');
        throw new Error(`DB insert failed: ${error.message}`);
      }

      logger.info(
        { id: data.id, source: posting.sourceName, externalId: posting.externalId, exactHash },
        'Raw posting inserted',
      );
      return { inserted: true, id: data.id };
    },

    /**
     * Batch insert raw postings. Returns counts of inserted and skipped.
     * Each posting is inserted individually so we get per-row idempotency reporting.
     * For Phase 2, the queue producer will call insertRawPosting per posting.
     */
    async batchInsertRawPostings(
      postings: RawPosting[],
    ): Promise<{ inserted: number; skipped: number }> {
      let inserted = 0;
      let skipped = 0;

      for (const posting of postings) {
        const result = await this.insertRawPosting(posting);
        if (result.inserted) inserted++;
        else skipped++;
      }

      return { inserted, skipped };
    },

    /** Health check: verify Supabase connectivity */
    async healthCheck(): Promise<boolean> {
      const { error } = await client.from('raw_postings').select('id').limit(1);
      if (error) {
        logger.error({ error }, 'Supabase health check failed');
        return false;
      }
      logger.info('Supabase health check passed');
      return true;
    },

    /** Expose client for Phase 2+ services that need direct access */
    client,
  };
}

export type SupabaseService = ReturnType<typeof createSupabaseService>;
