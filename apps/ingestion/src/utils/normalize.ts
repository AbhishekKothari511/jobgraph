import crypto from 'node:crypto';

// ─── Text normalization utilities ──────────────────────────────────────────────
// Normalization ensures that "Senior Software Engineer" and "senior software engineer  "
// produce the same hash, and that near-identical postings are caught by exact dedup.

/**
 * Normalize a job title for deduplication comparison:
 *   1. Lowercase
 *   2. Collapse whitespace
 *   3. Remove common seniority prefixes so "Sr. Engineer" ≈ "Senior Engineer" in exact hash
 *      (near-duplicate detection handles the rest via embeddings)
 *   4. Strip punctuation that varies across sources
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\bsr\.?\b/g, 'senior')
    .replace(/\bjr\.?\b/g, 'junior')
    .replace(/[^\w\s]/g, ' ')  // strip punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize a company name for deduplication:
 *   - Lowercase
 *   - Remove legal suffixes (Inc, LLC, Ltd, GmbH, etc.)
 *   - Collapse whitespace
 */
export function normalizeCompany(company: string): string {
  return company
    .toLowerCase()
    .replace(/\b(inc\.?|llc\.?|ltd\.?|gmbh|corp\.?|co\.?|plc\.?|sa|ag|bv)\b/gi, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize a location string:
 *   - Lowercase
 *   - Collapse whitespace
 *   - Empty string for null/undefined (so it contributes the same to a hash)
 */
export function normalizeLocation(location?: string): string {
  if (!location) return '';
  return location.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Normalize job description text for:
 *   - Categorization cache key (content_hash)
 *   - Near-duplicate embedding comparison
 * Strips HTML, collapses whitespace, truncates to first 2000 chars
 * (LLMs have context limits; embedding quality doesn't improve much beyond ~2k chars)
 */
export function normalizeDescription(description: string): string {
  return description
    .replace(/<[^>]+>/g, ' ')          // strip HTML tags
    .replace(/&[a-z]+;/gi, ' ')        // decode common HTML entities roughly
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

// ─── Hash utilities ────────────────────────────────────────────────────────────

/**
 * Compute the exact dedup hash: SHA-256 of (normalizedTitle|normalizedCompany|normalizedLocation).
 * Two postings with identical normalized title + company + location are considered exact duplicates
 * regardless of source. The "|" separator prevents hash collisions across concatenated fields.
 */
export function computeExactHash(
  title: string,
  company: string,
  location?: string,
): string {
  const normalized = [
    normalizeTitle(title),
    normalizeCompany(company),
    normalizeLocation(location),
  ].join('|');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Compute the content hash for categorization caching:
 * SHA-256 of normalized description. Same description from two sources
 * shares a categorization_cache entry → saves one LLM call.
 */
export function computeContentHash(description: string): string {
  const normalized = normalizeDescription(description);
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}
