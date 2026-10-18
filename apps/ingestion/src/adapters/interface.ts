import type { FetchOptions, RawPosting, AdapterType } from '@jobgraph/shared';

// ─── JobAdapter interface ──────────────────────────────────────────────────────
// Every ingestion source must implement this interface. This is the core contract
// that lets us swap or add sources without touching queue, dedup, or categorization code.
//
// Design decision: AsyncIterable<RawPosting> over callback/EventEmitter
//   - AsyncIterable works naturally with for-await-of, making backpressure trivial:
//     the producer pauses between yields until the consumer is ready.
//   - EventEmitter would require manual error propagation and flow control.
//   - Streaming is important for large RSS feeds and CSV files.
//
// Design decision: no base class, pure interface
//   - Adapters often need very different constructor signatures (API keys vs file paths).
//   - An interface enforces the contract without forcing inheritance hierarchies.
//   - New adapter authors can implement the interface in any class structure they prefer.
export interface JobAdapter {
  /** Unique machine-readable name, used as idempotency key prefix (e.g. 'adzuna', 'remotive', 'csv') */
  readonly name: string;

  /** Source category — used for metrics and logging grouping */
  readonly type: AdapterType;

  /**
   * Fetch raw job postings from the source.
   * Yields one RawPosting per job. May be paginated internally.
   * The caller (queue producer) is responsible for persisting and idempotency-checking each posting.
   *
   * @throws {AdapterError} on authentication failure, network error, or invalid source data
   */
  fetch(options?: FetchOptions): AsyncGenerator<RawPosting>;

  /**
   * Verify that the adapter can reach its source (API, feed URL, folder).
   * Called on startup to give early warning of misconfiguration.
   * Returns true if healthy, false if degraded but non-fatal, throws if fatal.
   */
  healthCheck(): Promise<boolean>;
}

// ─── Typed adapter error ───────────────────────────────────────────────────────
// Carrying the sourceName and type on the error lets the queue worker log
// structured fields without parsing the message string.
export class AdapterError extends Error {
  constructor(
    message: string,
    public readonly sourceName: string,
    public readonly sourceType: AdapterType,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}
