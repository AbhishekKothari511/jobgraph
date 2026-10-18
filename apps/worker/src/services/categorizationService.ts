import OpenAI from 'openai';
import { z } from 'zod';
import { env } from '../config/env.js';
import { categorizationOutputSchema, type CategorizationOutput } from '@jobgraph/shared';
import * as db from './supabaseService.js';
import { computeContentHash, normalizeDescription } from '../../../packages/shared/src/utils/normalize.js';
import type { Logger } from 'pino';

let client: OpenAI | null = null;
function getClient() {
  if (!client) {
    if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
    client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return client;
}

const SYSTEM_PROMPT = `You are a job classification expert. Given a job description, return a JSON object with EXACTLY these fields:
{
  "role": "<broad role category e.g. Software Engineer, Data Scientist, Product Manager>",
  "skills": ["<skill1>", "<skill2>", ...],
  "seniority": "<one of: entry | mid | senior | executive>",
  "remote": <true | false>
}
Return ONLY valid JSON. No markdown fences. No explanation.`;

/**
 * Categorize a job posting using an LLM.
 *
 * Cache strategy: content_hash → categorization_cache table.
 * Same description from two different sources reuses the cached result.
 *
 * Retry strategy: validate LLM output with Zod. If invalid JSON or
 * schema mismatch, retry once with a stricter prompt. On second failure,
 * return a safe default rather than failing the entire pipeline.
 */
export async function categorize(
  description: string,
  logger: Logger,
): Promise<CategorizationOutput> {
  const contentHash = computeContentHash(description);

  // ── Cache lookup ────────────────────────────────────────────────────────────
  const cached = await db.getCategorizationCache(contentHash);
  if (cached) {
    logger.debug({ contentHash }, 'Categorization cache hit');
    const parsed = categorizationOutputSchema.safeParse(cached);
    if (parsed.success) return parsed.data;
  }

  // ── LLM call ────────────────────────────────────────────────────────────────
  if (!env.OPENAI_API_KEY) {
    logger.warn('OPENAI_API_KEY not set — returning default categorization');
    return defaultCategorization();
  }

  const normalizedDesc = normalizeDescription(description);
  let result = await callLLM(normalizedDesc, logger);

  // ── Cache the result ────────────────────────────────────────────────────────
  await db.insertCategorizationCache({
    content_hash: contentHash,
    role: result.role,
    skills: result.skills,
    seniority: result.seniority,
    remote: result.remote,
    raw_response: result,
  });

  return result;
}

async function callLLM(description: string, logger: Logger, attempt = 1): Promise<CategorizationOutput> {
  const llm = getClient();
  logger.debug({ model: env.LLM_MODEL, attempt }, 'Calling LLM for categorization');

  try {
    const completion = await llm.chat.completions.create({
      model: env.LLM_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: description.slice(0, 3000) },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    });

    const raw = completion.choices[0]?.message.content ?? '{}';
    const json: unknown = JSON.parse(raw.replace(/```json\n?|```/g, '').trim());
    const validated = categorizationOutputSchema.safeParse(json);

    if (!validated.success) {
      if (attempt < 2) {
        logger.warn({ attempt, errors: validated.error.flatten() }, 'LLM output failed Zod — retrying');
        return callLLM(description, logger, attempt + 1);
      }
      logger.error({ raw }, 'LLM output invalid after retry — using default');
      return defaultCategorization();
    }

    return validated.data;
  } catch (err) {
    if (attempt < 2) return callLLM(description, logger, attempt + 1);
    logger.error({ err }, 'LLM call failed after retry — using default');
    return defaultCategorization();
  }
}

function defaultCategorization(): CategorizationOutput {
  return { role: 'Unknown', skills: [], seniority: 'unknown', remote: false };
}
