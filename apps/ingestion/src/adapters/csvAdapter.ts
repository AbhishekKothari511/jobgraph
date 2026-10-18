import type { RawPosting, FetchOptions } from '@jobgraph/shared';
import { csvRowSchema, type CsvConfig } from '@jobgraph/shared';
import type { JobAdapter } from './interface.js';
import { AdapterError } from './interface.js';
import { parse as parseCsv } from 'csv-parse';
import chokidar from 'chokidar';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Logger } from 'pino';

// ─── CSV Drop Folder adapter ───────────────────────────────────────────────────
// Watches a local folder for new .csv files. When a file appears, it is parsed
// row-by-row (streaming, so large files don't OOM) and each row yields a RawPosting.
// After processing, the file is moved to the archive folder so it isn't re-ingested.
//
// Idempotency: externalId = SHA-256(filename + rowIndex). This is stable as long
// as the file content and order don't change. For truly idempotent CSV ingestion,
// include a unique ID column in your CSV (use it if present, fall back to hash).
//
// Design decision: chokidar over fs.watch
//   - fs.watch is unreliable on Windows/macOS (misses events under heavy load)
//   - chokidar debounces rename events, handles symlinks, and works on all platforms
//   - The 'awaitWriteFinish' option waits until the file is stable (no more writes)
//     before emitting the 'add' event — critical for large files written incrementally.
//
// In Phase 2 this adapter feeds directly into the BullMQ queue. In Phase 1 it
// supports a one-shot `fetch()` call that scans the folder once synchronously.
export class CsvAdapter implements JobAdapter {
  readonly name = 'csv';
  readonly type = 'csv' as const;

  constructor(
    private readonly config: CsvConfig,
    private readonly logger: Logger,
  ) {}

  async *fetch(options?: FetchOptions): AsyncGenerator<RawPosting> {
    // Ensure drop folder exists
    if (!fs.existsSync(this.config.dropFolder)) {
      this.logger.warn(
        { folder: this.config.dropFolder },
        'CSV drop folder does not exist — skipping',
      );
      return;
    }

    const csvFiles = fs
      .readdirSync(this.config.dropFolder)
      .filter((f) => f.toLowerCase().endsWith('.csv'))
      .map((f) => path.join(this.config.dropFolder, f));

    this.logger.info({ source: this.name, fileCount: csvFiles.length }, 'CSV drop folder scan');

    let totalYielded = 0;
    const limit = options?.limit ?? Infinity;

    for (const csvFile of csvFiles) {
      if (totalYielded >= limit) break;

      this.logger.info({ source: this.name, file: csvFile }, 'Processing CSV file');

      try {
        const rowsFromFile = await parseFile(csvFile, this.logger);

        for (const { row, rowIndex } of rowsFromFile) {
          if (totalYielded >= limit) break;

          const validated = csvRowSchema.safeParse(row);
          if (!validated.success) {
            this.logger.warn(
              { file: csvFile, row, rowIndex, errors: validated.error.flatten() },
              'CSV row failed validation — skipping',
            );
            continue;
          }

          const data = validated.data;

          // Stable externalId: prefer a user-supplied 'id' column, else derive from file+row
          const rowAsRecord = row as Record<string, string>;
          const externalId =
            rowAsRecord['id'] ??
            rowAsRecord['external_id'] ??
            deriveRowId(csvFile, rowIndex);

          yield {
            externalId,
            sourceName: this.name,
            title: data.title,
            company: data.company,
            location: data.location,
            description: data.description,
            url: data.url,
            salaryMin: data.salary_min,
            salaryMax: data.salary_max,
            remote: data.remote,
            jobType: data.job_type,
            postedAt: data.posted_at ? new Date(data.posted_at) : undefined,
            rawData: row,
          };

          totalYielded++;
        }

        // Archive the processed file so it isn't re-ingested on the next run
        await archiveFile(csvFile, this.config.archiveFolder, this.logger);
      } catch (err) {
        this.logger.error({ source: this.name, file: csvFile, err }, 'Failed to process CSV file');
        // Continue with next file rather than aborting the whole batch
      }
    }

    this.logger.info({ source: this.name, totalYielded }, 'CSV fetch complete');
  }

  async healthCheck(): Promise<boolean> {
    const exists = fs.existsSync(this.config.dropFolder);
    if (!exists) {
      this.logger.warn({ folder: this.config.dropFolder }, 'CSV drop folder missing');
    } else {
      this.logger.info({ folder: this.config.dropFolder }, 'CSV health check passed');
    }
    return exists;
  }

  /**
   * Start watching the drop folder for new files.
   * Returns a chokidar FSWatcher — call watcher.close() to stop.
   * Used by Phase 2 queue producer to trigger ingestion on file arrival.
   */
  watch(onFile: (filePath: string) => void): chokidar.FSWatcher {
    if (!fs.existsSync(this.config.dropFolder)) {
      fs.mkdirSync(this.config.dropFolder, { recursive: true });
    }

    const watcher = chokidar.watch(`${this.config.dropFolder}/*.csv`, {
      persistent: true,
      ignoreInitial: false,         // pick up files already in the folder on startup
      awaitWriteFinish: {
        stabilityThreshold: 2000,   // wait 2s of no file activity before firing 'add'
        pollInterval: 200,
      },
    });

    watcher.on('add', (filePath) => {
      this.logger.info({ source: this.name, file: filePath }, 'New CSV file detected');
      onFile(filePath);
    });

    watcher.on('error', (err) => {
      this.logger.error({ source: this.name, err }, 'CSV watcher error');
    });

    return watcher;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

interface ParsedRow {
  row: Record<string, unknown>;
  rowIndex: number;
}

async function parseFile(filePath: string, logger: Logger): Promise<ParsedRow[]> {
  return new Promise((resolve, reject) => {
    const rows: ParsedRow[] = [];
    const stream = fs.createReadStream(filePath);

    stream.pipe(
      parseCsv({
        columns: true,            // use first row as header keys
        skip_empty_lines: true,
        trim: true,
        cast: true,               // auto-cast numbers and booleans
        relax_quotes: true,       // tolerate slightly malformed CSV
      })
    )
    .on('data', (record: Record<string, unknown>, index: number) => {
      rows.push({ row: record, rowIndex: index });
    })
    .on('end', () => resolve(rows))
    .on('error', (err) => {
      logger.error({ file: filePath, err }, 'CSV parse error');
      reject(new AdapterError(`CSV parse failed: ${String(err)}`, 'csv', 'csv', err));
    });
  });
}

function deriveRowId(filePath: string, rowIndex: number): string {
  // Hash of (filename basename + row index) — stable per file-row pair
  return crypto
    .createHash('sha256')
    .update(`${path.basename(filePath)}:${rowIndex}`)
    .digest('hex')
    .slice(0, 16);  // truncate to 16 hex chars for readability
}

async function archiveFile(filePath: string, archiveFolder: string, logger: Logger): Promise<void> {
  if (!fs.existsSync(archiveFolder)) {
    fs.mkdirSync(archiveFolder, { recursive: true });
  }
  const dest = path.join(archiveFolder, `${Date.now()}_${path.basename(filePath)}`);
  fs.renameSync(filePath, dest);
  logger.info({ from: filePath, to: dest }, 'CSV file archived');
}
