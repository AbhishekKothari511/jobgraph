import type { RawPosting, FetchOptions } from '@jobgraph/shared';
import { rssItemSchema, type RssConfig } from '@jobgraph/shared';
import type { JobAdapter } from './interface.js';
import { AdapterError } from './interface.js';
import Parser from 'rss-parser';
import type { Logger } from 'pino';

// ─── RSS Feed adapter ──────────────────────────────────────────────────────────
// Default source: https://remotive.com/remote-jobs/feed
// The RSS standard (RFC 4287 for Atom, RSS 2.0) is widely used for job boards.
// rss-parser handles both RSS 2.0 and Atom feeds transparently.
//
// Idempotency: We use the RSS item's <guid> (or <link> as fallback) as the
// externalId. GUIDs are typically permanent identifiers in RSS 2.0.
// If neither is available, we fall back to a hash of (title + link) — this is
// lossy but better than silently dropping the posting.
//
// Design: We fetch the entire feed in one request (RSS has no pagination standard),
// then yield items one by one. The `since` option filters by pubDate client-side.
// For large feeds (>500 items), consider switching to a scraping adapter that
// supports cursor-based pagination (e.g., Remotive REST API).
export class RssAdapter implements JobAdapter {
  readonly name: string;
  readonly type = 'rss' as const;

  private readonly parser: Parser;

  constructor(
    private readonly config: RssConfig,
    private readonly logger: Logger,
  ) {
    this.name = config.sourceName;
    // rss-parser customFields: some job boards use non-standard XML tags
    this.parser = new Parser({
      customFields: {
        item: [
          ['salary', 'salary'],
          ['job_type', 'jobType'],
          ['location', 'location'],
          ['company', 'company'],
        ],
      },
      timeout: 15000, // 15s timeout — RSS feeds can be slow
    });
  }

  async *fetch(options?: FetchOptions): AsyncGenerator<RawPosting> {
    this.logger.info({ source: this.name, feedUrl: this.config.feedUrl }, 'Starting RSS fetch');

    let feed: Parser.Output<Record<string, string>>;
    try {
      feed = await this.parser.parseURL(this.config.feedUrl) as Parser.Output<Record<string, string>>;
    } catch (err) {
      throw new AdapterError(
        `Failed to fetch RSS feed: ${String(err)}`,
        this.name, this.type, err,
      );
    }

    const items = feed.items ?? [];
    this.logger.info({ source: this.name, itemCount: items.length }, 'RSS feed loaded');

    let yielded = 0;
    const limit = options?.limit ?? Infinity;

    for (const rawItem of items) {
      if (yielded >= limit) break;

      // Validate/coerce the item with our Zod schema (strips unknown fields)
      const parsed = rssItemSchema.safeParse(rawItem);
      if (!parsed.success) {
        this.logger.warn(
          { source: this.name, item: rawItem, errors: parsed.error.flatten() },
          'RSS item failed validation — skipping',
        );
        continue;
      }

      const item = parsed.data;

      // Filter by date if `since` is provided
      if (options?.since && item.isoDate) {
        const pubDate = new Date(item.isoDate);
        if (pubDate < options.since) continue;
      }

      // Derive a stable externalId from guid → link → title-hash fallback
      const externalId = deriveExternalId(item.guid, item.link, item.title);

      // Remotive RSS puts the full job description in <description> as HTML.
      // contentSnippet is the plain-text version (rss-parser strips HTML tags).
      const description = item.contentSnippet ?? item.content ?? item.title;

      // Some job boards embed location and company in custom XML tags;
      // rss-parser surfaces them as top-level properties on the item.
      const itemAsRecord = rawItem as Record<string, string>;
      const location = itemAsRecord['location'] ?? undefined;
      const companyRaw = itemAsRecord['company'] ?? extractCompanyFromTitle(item.title);

      yield {
        externalId,
        sourceName: this.name,
        title: cleanTitle(item.title, companyRaw),
        company: companyRaw ?? 'Unknown',
        location,
        description,
        url: item.link,
        postedAt: item.isoDate ? new Date(item.isoDate) : undefined,
        remote: isRemote(item.title, description, location),
        rawData: rawItem,
      };

      yielded++;
    }

    this.logger.info({ source: this.name, yielded }, 'RSS fetch complete');
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Fetch just the feed metadata (HEAD is not always supported for RSS)
      const feed = await this.parser.parseURL(this.config.feedUrl);
      const ok = (feed.items?.length ?? 0) > 0;
      this.logger.info({ source: this.name, itemCount: feed.items?.length, ok }, 'RSS health check');
      return ok;
    } catch (err) {
      this.logger.error({ source: this.name, err }, 'RSS health check failed');
      throw new AdapterError('RSS health check failed', this.name, this.type, err);
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function deriveExternalId(
  guid: string | undefined,
  link: string | undefined,
  title: string,
): string {
  if (guid && guid.length > 0) return guid;
  if (link && link.length > 0) return link;
  // Deterministic fallback: hash of title (not truly stable if title changes, but rare)
  return `title:${Buffer.from(title).toString('base64')}`;
}

// Remotive RSS titles include " at CompanyName" suffix — extract the company
function extractCompanyFromTitle(title: string): string | undefined {
  const atMatch = / at ([^|[\]]+)$/.exec(title.trim());
  return atMatch?.[1]?.trim();
}

// Remove " at CompanyName" suffix from title if present
function cleanTitle(title: string, company: string | undefined): string {
  if (!company) return title;
  const suffix = ` at ${company}`;
  return title.endsWith(suffix) ? title.slice(0, -suffix.length).trim() : title;
}

// Heuristic: mark as remote if any of these signals are present
function isRemote(title: string, description: string, location?: string): boolean {
  const text = `${title} ${description} ${location ?? ''}`.toLowerCase();
  return (
    text.includes('remote') ||
    text.includes('work from home') ||
    text.includes('distributed team') ||
    text.includes('fully remote')
  );
}
