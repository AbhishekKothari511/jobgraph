import type { RawPosting, FetchOptions, JobType } from '@jobgraph/shared';
import { adzunaResponseSchema, type AdzunaConfig } from '@jobgraph/shared';
import type { JobAdapter } from './interface.js';
import { AdapterError } from './interface.js';
import type { Logger } from 'pino';

// ─── Adzuna API adapter ────────────────────────────────────────────────────────
// Source: https://developer.adzuna.com/
// Free tier: 250 req/day, 50 results/page.
// Endpoint: GET /v1/api/jobs/{country}/search/{page}
//
// Design: We paginate through pages until the API returns 0 results or we hit
// the `limit` option. Each page is a separate HTTP request (Adzuna is not
// cursor-based). We yield results from each page before fetching the next
// (streaming pattern) so the caller can begin queuing immediately.
export class AdzunaAdapter implements JobAdapter {
  readonly name = 'adzuna';
  readonly type = 'api' as const;

  private readonly baseUrl = 'https://api.adzuna.com/v1/api/jobs';

  constructor(
    private readonly config: AdzunaConfig,
    private readonly logger: Logger,
  ) {}

  async *fetch(options?: FetchOptions): AsyncGenerator<RawPosting> {
    const { appId, appKey, country, keyword, resultsPerPage } = this.config;
    const effectiveKeyword = options?.keyword ?? keyword;
    const limit = options?.limit ?? Infinity;
    let page = 1;
    let totalYielded = 0;

    this.logger.info({ source: this.name, keyword: effectiveKeyword }, 'Starting Adzuna fetch');

    while (totalYielded < limit) {
      // Build request URL — content-type=application/json is required by Adzuna
      const url = new URL(`${this.baseUrl}/${country}/search/${page}`);
      url.searchParams.set('app_id', appId);
      url.searchParams.set('app_key', appKey);
      url.searchParams.set('results_per_page', String(resultsPerPage));
      url.searchParams.set('what', effectiveKeyword);
      url.searchParams.set('content-type', 'application/json');
      if (options?.since) {
        // Adzuna supports 'max_days_old' but not a specific date; approximate with days
        const daysDiff = Math.ceil(
          (Date.now() - options.since.getTime()) / (1000 * 60 * 60 * 24)
        );
        url.searchParams.set('max_days_old', String(daysDiff));
      }

      let data: unknown;
      try {
        const response = await fetch(url.toString());
        if (!response.ok) {
          throw new AdapterError(
            `Adzuna API returned ${response.status}: ${response.statusText}`,
            this.name, this.type,
          );
        }
        data = await response.json();
      } catch (err) {
        if (err instanceof AdapterError) throw err;
        throw new AdapterError(
          `Adzuna HTTP request failed: ${String(err)}`,
          this.name, this.type, err,
        );
      }

      // Validate API response with Zod — catches schema changes or unexpected payloads
      const parsed = adzunaResponseSchema.safeParse(data);
      if (!parsed.success) {
        throw new AdapterError(
          `Adzuna response failed schema validation: ${parsed.error.message}`,
          this.name, this.type,
        );
      }

      const { results } = parsed.data;

      if (results.length === 0) {
        this.logger.info({ source: this.name, page, totalYielded }, 'No more Adzuna results');
        break;
      }

      for (const job of results) {
        if (totalYielded >= limit) break;

        // Map Adzuna contract_type to our canonical JobType
        const jobType = mapAdzunaContractType(job.contract_type);

        yield {
          externalId: job.id,
          sourceName: this.name,
          title: job.title.trim(),
          company: job.company.display_name.trim(),
          location: job.location?.display_name?.trim(),
          description: job.description.trim(),
          salaryMin: job.salary_min !== undefined ? Math.round(job.salary_min) : undefined,
          salaryMax: job.salary_max !== undefined ? Math.round(job.salary_max) : undefined,
          salaryCurrency: 'GBP', // Adzuna GB endpoint always reports GBP
          jobType,
          url: job.redirect_url,
          postedAt: job.created ? new Date(job.created) : undefined,
          rawData: job,
        };

        totalYielded++;
      }

      this.logger.debug({ source: this.name, page, resultCount: results.length, totalYielded }, 'Adzuna page fetched');
      page++;
    }

    this.logger.info({ source: this.name, totalYielded }, 'Adzuna fetch complete');
  }

  async healthCheck(): Promise<boolean> {
    const url = new URL(`${this.baseUrl}/${this.config.country}/search/1`);
    url.searchParams.set('app_id', this.config.appId);
    url.searchParams.set('app_key', this.config.appKey);
    url.searchParams.set('results_per_page', '1');
    url.searchParams.set('what', 'test');
    url.searchParams.set('content-type', 'application/json');

    try {
      const response = await fetch(url.toString());
      if (response.ok) {
        this.logger.info({ source: this.name }, 'Adzuna health check passed');
        return true;
      }
      this.logger.warn({ source: this.name, status: response.status }, 'Adzuna health check degraded');
      return false;
    } catch (err) {
      this.logger.error({ source: this.name, err }, 'Adzuna health check failed');
      throw new AdapterError('Adzuna health check failed', this.name, this.type, err);
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function mapAdzunaContractType(contractType?: string): JobType | undefined {
  if (!contractType) return undefined;
  const lower = contractType.toLowerCase();
  if (lower === 'permanent') return 'full_time';
  if (lower === 'contract') return 'contract';
  if (lower === 'part_time') return 'part_time';
  return 'unknown';
}
