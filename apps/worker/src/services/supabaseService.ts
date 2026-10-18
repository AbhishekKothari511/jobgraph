import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

// Service-role client — bypasses RLS, used only in the worker (never in the browser)
export const supabase = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

export async function getRawPosting(id: string) {
  const { data, error } = await supabase
    .from('raw_postings')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw new Error(`getRawPosting failed: ${error.message}`);
  return data;
}

export async function updateRawPostingStatus(
  id: string,
  status: 'processing' | 'processed' | 'failed' | 'duplicate',
  extra?: { job_id?: string; error?: string; processed_at?: string },
) {
  const { error } = await supabase
    .from('raw_postings')
    .update({ status, ...extra })
    .eq('id', id);
  if (error) throw new Error(`updateRawPostingStatus failed: ${error.message}`);
}

export async function insertJob(jobData: Record<string, unknown>): Promise<string> {
  const { data, error } = await supabase
    .from('jobs')
    .insert(jobData)
    .select('id')
    .single();
  if (error) throw new Error(`insertJob failed: ${error.message}`);
  return (data as { id: string }).id;
}

export async function findJobByExactHash(exactHash: string): Promise<string | null> {
  const { data } = await supabase
    .from('jobs')
    .select('id')
    .eq('exact_hash', exactHash)
    .eq('status', 'active')
    .limit(1)
    .single();
  return data ? (data as { id: string }).id : null;
}

export async function insertJobEmbedding(jobId: string, embedding: number[], model: string) {
  const { error } = await supabase
    .from('job_embeddings')
    .upsert({ job_id: jobId, embedding: `[${embedding.join(',')}]`, model }, { onConflict: 'job_id,model' });
  if (error) throw new Error(`insertJobEmbedding failed: ${error.message}`);
}

export async function findNearDuplicates(embedding: number[], threshold: number) {
  // Uses the HNSW index via pgvector cosine distance operator
  const { data, error } = await supabase.rpc('find_near_duplicates', {
    query_embedding: `[${embedding.join(',')}]`,
    similarity_threshold: threshold,
    match_count: 3,
  });
  if (error) throw new Error(`findNearDuplicates failed: ${error.message}`);
  return (data ?? []) as Array<{ job_id: string; similarity: number }>;
}

export async function insertDedupeLog(entry: {
  raw_posting_id: string;
  duplicate_of_job_id?: string;
  method: 'exact_hash' | 'embedding_similarity' | 'unique';
  similarity_score?: number;
  decision: 'merge' | 'new';
  metadata?: Record<string, unknown>;
}) {
  const { error } = await supabase.from('dedupe_log').insert(entry);
  if (error) throw new Error(`insertDedupeLog failed: ${error.message}`);
}

export async function getCategorizationCache(contentHash: string) {
  const { data } = await supabase
    .from('categorization_cache')
    .select('*')
    .eq('content_hash', contentHash)
    .single();
  return data;
}

export async function insertCategorizationCache(entry: {
  content_hash: string;
  role: string;
  skills: string[];
  seniority: string;
  remote: boolean;
  raw_response: unknown;
}) {
  const { error } = await supabase
    .from('categorization_cache')
    .upsert(entry, { onConflict: 'content_hash' });
  if (error) throw new Error(`insertCategorizationCache failed: ${error.message}`);
}
