import crypto from 'node:crypto';

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\bsr\.?\b/g, 'senior')
    .replace(/\bjr\.?\b/g, 'junior')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeCompany(company: string): string {
  return company
    .toLowerCase()
    .replace(/\b(inc\.?|llc\.?|ltd\.?|gmbh|corp\.?|co\.?|plc\.?|sa|ag|bv)\b/gi, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeLocation(location?: string): string {
  if (!location) return '';
  return location.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function normalizeDescription(description: string): string {
  return description
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

export function computeExactHash(title: string, company: string, location?: string): string {
  const normalized = [normalizeTitle(title), normalizeCompany(company), normalizeLocation(location)].join('|');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function computeContentHash(description: string): string {
  const normalized = normalizeDescription(description);
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}
