import OpenAI from 'openai';
import { env } from '../config/env.js';
import type { Logger } from 'pino';

let openaiClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (!openaiClient) {
    if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
    openaiClient = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return openaiClient;
}

/**
 * Generate a unit-normalized embedding vector.
 * Embeddings are L2-normalized so cosine similarity = dot product.
 * Unit normalization is done here so pgvector cosine distance queries
 * produce correct results regardless of whether the stored vector is normalized.
 */
export async function generateEmbedding(
  text: string,
  logger: Logger,
): Promise<number[]> {
  const model = env.EMBEDDING_MODEL;
  const dims  = env.EMBEDDING_DIMENSIONS;

  if (!env.OPENAI_API_KEY) {
    // Offline fallback: deterministic unit vector based on text hash
    logger.warn({ model }, 'OPENAI_API_KEY not set — using deterministic fallback embedding');
    return deterministicUnitVector(text, dims);
  }

  const client = getClient();
  logger.debug({ model, textLength: text.length }, 'Generating embedding');

  const response = await client.embeddings.create({
    model,
    input: text.slice(0, 8191),  // OpenAI hard limit
    dimensions: dims,
  });

  const raw = response.data[0]?.embedding;
  if (!raw) throw new Error('OpenAI returned empty embedding');

  return normalizeL2(raw);
}

function normalizeL2(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

// Deterministic fallback: seeded pseudo-random unit vector
function deterministicUnitVector(seed: string, dims: number): number[] {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  const vec = Array.from({ length: dims }, (_, i) => {
    const x = Math.sin(hash + i) * 43758.5453123;
    return x - Math.floor(x) - 0.5;
  });
  return normalizeL2(vec);
}
