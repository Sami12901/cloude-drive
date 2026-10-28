import { randomUUID } from 'node:crypto';
import { ERROR_CODES, makeError } from '../../shared/ipc.js';
import type { BridgeEvent } from '../../shared/ipc.js';
import type { AppError, TransferJob, TransferKind, TransferState } from '../../shared/types.js';
import type { Logger } from './logging.js';
import type { ConfigService } from './config-service.js';
import type { RcloneEngine } from './rclone/engine.js';
import { backoffDelay } from './context.js';
import { classifyRemoteError } from './provider-service.js';

export interface TransferManagerDeps {
  config: ConfigService;
  engine: RcloneEngine;
  logger: Logger;
  emit(event: BridgeEvent): void;
  clock(): Date;
  sleep(ms: number): Promise<void>;
  /** Asks the application controller to publish a fresh snapshot. */
  requestSnapshotRefresh(): void;
  /** Called when a pinned (offline) copy finished successfully. */
  onOfflineCopyFinished?: (job: TransferJob) => Promise<void>;
  /** Called when a pin copy failed permanently, so the entry can show the error. */
  onOfflineCopyFailed?: (job: TransferJob) => Promise<void>;
}

interface RunningJob {
  job: TransferJob;
  controller: AbortController;
}

interface JsonStats {
  bytes: number;
  totalBytes: number;
  speed: number;
  eta: number | null;
  transfers: number;
  errors: number;
}

/**
 * Explicit, queued transfers (download / upload / copy / offline pinning).
 *
 * This queue is deliberately separate from ordinary file operations performed
 * through the mounted drive: those are handled by the filesystem driver. Jobs
 * here are restarted from the beginning with bounded exponential backoff, and
 * partial data is written with `--partial-suffix` so a failed job never leaves
 * a file that looks complete.
 */
export class TransferManager {
  private readonly queued: TransferJob[] = [];
  private readonly running = new Map<string, RunningJob>();

  constructor(private readonly deps: TransferManagerDeps) {}

  list(): { running: TransferJob[]; queued: TransferJob[]; history: TransferJob[] } {
    return {
      running: [...this.running.values()].map((entry) => ({ ...entry.job })),
      queued: this.queued.map((job) => ({ ...job })),
      history: this.deps.config.history(),
    };
  }

  speedBps(): number | null {
    const speeds = [...this.running.values()]
      .map((entry) => entry.job.speedBps)
      .filter((value): value is number => typeof value === 'number' && value > 0);
    if (speeds.length === 0) return null;
    return speeds.reduce((sum, value) => sum + value, 0);
  }

  enqueue(input: {
    kind: TransferKind;
    remoteId: string | null;
    srcUri: string;
    dstUri: string;
    mode?: 'copy' | 'copyto';
  }): TransferJob {
    const settings = this.deps.config.get();
    const job: TransferJob = {
      id: randomUUID(),
      kind: input.kind,
      remoteId: input.remoteId,
      srcUri: input.srcUri,
      dstUri: input.dstUri,
      ...(input.mode ? { mode: input.mode } : {}),
      state: 'queued',
      attempt: 0,
      maxAttempts: settings.transfers.retries + 1,
      bytes: 0,
      totalBytes: null,
      speedBps: null,
      etaSeconds: null,
      createdAt: this.deps.clock().toISOString(),
    };
    this.queued.push(job);
    this.deps.logger.info('Queued transfer.', { id: job.id, kind: job.kind, src: job.srcUri, dst: job.dstUri });
    this.pump();
    this.refresh();
    return { ...job };
  }

  async cancel(id: string): Promise<{ cancelled: boolean }> {
    const running = this.running.get(id);
    if (running) {
      running.controller.abort();
      running.job.state = 'cancelled';
      running.job.finishedAt = this.deps.clock().toISOString();
      this.finish(running.job);
      this.running.delete(id);
      this.pump();
      this.refresh();
      return { cancelled: true };
    }
    const index = this.queued.findIndex((job) => job.id === id);
    if (index >= 0) {
      const [job] = this.queued.splice(index, 1);
      if (job) {
        job.state = 'cancelled';
        job.finishedAt = this.deps.clock().toISOString();
        this.finish(job);
      }
      this.refresh();
      return { cancelled: true };
    }
    return { cancelled: false };
  }

  retry(id: string): TransferJob {
    const history = this.deps.config.history();
    const previous = history.find((job) => job.id === id);
    if (!previous) throw new Error('Transfer not found.');
    const job: TransferJob = {
      ...previous,
      state: 'queued',
      attempt: 0,
      bytes: 0,
      error: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      createdAt: this.deps.clock().toISOString(),
    };
    this.queued.push(job);
    this.pump();
    this.refresh();
    return { ...job };
  }

  clearHistory(): number {
    return this.deps.config.clearHistory();
  }

  /* ------------------------------------------------------------- internals */

  private pump(): void {
    const settings = this.deps.config.get();
    while (this.running.size < settings.transfers.concurrency && this.queued.length > 0) {
      const job = this.queued.shift();
      if (!job) break;
      void this.start(job);
    }
  }

  private async start(job: TransferJob): Promise<void> {
    const controller = new AbortController();
    const entry: RunningJob = { job, controller };
    this.running.set(job.id, entry);

    job.attempt += 1;
    job.state = 'running';
    job.startedAt = this.deps.clock().toISOString();
    job.error = undefined;
    this.refresh();

    try {
      const cli = await this.deps.engine.cli();
      const settings = this.deps.config.get();
      const command = commandForJob(job);
      const args = [
        command,
        job.srcUri,
        job.dstUri,
        '--use-json-log',
        '--log-level',
        'INFO',
        '--stats',
        '500ms',
        '--transfers',
        `${Math.max(1, Math.min(4, settings.transfers.concurrency))}`,
        '--retries',
        `${settings.transfers.retries}`,
        '--low-level-retries',
        '10',
        // Partial files never appear under the final name, so an interrupted job
        // cannot leave a file that looks complete.
        '--partial-suffix',
        '.cspartial',
        '--checkers',
        '4',
      ];
      if (job.kind === 'offline-pin') {
        // `--checksum` keeps an existing local copy when the content is unchanged.
        args.push('--checksum');
        // Only `copy` understands this flag; `copyto` fails with "unknown flag".
        if (command === 'copy') args.push('--create-empty-src-dirs');
      }
      if (settings.transfers.bandwidthLimit) args.push('--bwlimit', settings.transfers.bandwidthLimit);

      let buffer = '';
      const result = await cli.run(args, {
        timeoutMs: 24 * 3600 * 1000,
        signal: controller.signal,
        maxOutputBytes: 32 * 1024 * 1024,
        onStdout: (chunk) => {
          buffer += chunk;
          let newline = buffer.indexOf('\n');
          while (newline >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            this.consumeLogLine(job, line);
            newline = buffer.indexOf('\n');
          }
        },
        onStderr: (chunk) => {
          buffer += chunk;
          const newline = buffer.lastIndexOf('\n');
          if (newline >= 0) {
            this.consumeLogLine(job, buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
          }
        },
      });

      if ((job.state as TransferState) === 'cancelled') return;

      if (result.code === 0) {
        job.state = 'succeeded';
        job.finishedAt = this.deps.clock().toISOString();
        job.speedBps = null;
        job.etaSeconds = null;
        if (job.kind === 'offline-pin' && this.deps.onOfflineCopyFinished) {
          await this.deps.onOfflineCopyFinished(job);
        }
        this.deps.logger.info('Transfer finished.', { id: job.id, bytes: job.bytes });
        this.notify(job);
      } else if (result.aborted || (job.state as TransferState) === 'cancelled') {
        job.state = 'cancelled';
        job.finishedAt = this.deps.clock().toISOString();
      } else {
        const output = `${result.stderr}\n${result.stdout}`;
        const classified = classifyRemoteError(output);
        job.error = classified;
        if (job.attempt < job.maxAttempts) {
          const delay = backoffDelay(job.attempt, this.deps.config.get().transfers.backoffBaseMs, this.deps.config.get().transfers.maxBackoffMs);
          this.deps.logger.warn('Transfer failed; scheduling a retry.', {
            id: job.id,
            attempt: job.attempt,
            delayMs: delay,
            error: classified.message,
          });
          job.state = 'queued';
          this.running.delete(job.id);
          this.queued.push(job);
          setTimeout(() => this.pump(), delay).unref?.();
          this.refresh();
          return;
        }
        job.state = 'failed';
        job.finishedAt = this.deps.clock().toISOString();
        this.deps.logger.error('Transfer failed permanently.', { id: job.id, error: classified.message });
        if (job.kind === 'offline-pin' && this.deps.onOfflineCopyFailed) {
          await this.deps.onOfflineCopyFailed(job).catch((error) =>
            this.deps.logger.error('Could not record the failed offline copy.', { error: (error as Error).message }),
          );
        }
        this.notify(job);
      }
    } catch (error) {
      job.state = 'failed';
      job.finishedAt = this.deps.clock().toISOString();
      job.error = makeError(ERROR_CODES.ENGINE_ERROR, (error as Error).message, { recoverable: true });
      if (job.kind === 'offline-pin' && this.deps.onOfflineCopyFailed) {
        await this.deps.onOfflineCopyFailed(job).catch(() => undefined);
      }
    } finally {
      const finalState: TransferState = job.state;
      if (this.running.get(job.id)?.job === job && finalState !== 'queued') {
        this.running.delete(job.id);
        if (finalState !== 'running') this.finish(job);
      }
      this.pump();
      this.refresh();
    }
  }

  private consumeLogLine(job: TransferJob, line: string): void {
    if (!line.includes('"stats"')) return;
    try {
      const parsed = JSON.parse(line) as { stats?: JsonStats };
      const stats = parsed.stats;
      if (!stats) return;
      job.bytes = stats.bytes ?? job.bytes;
      job.totalBytes = stats.totalBytes ?? job.totalBytes;
      job.speedBps = typeof stats.speed === 'number' ? stats.speed : null;
      job.etaSeconds = stats.eta ?? null;
    } catch {
      /* not a complete JSON line yet */
    }
  }

  private finish(job: TransferJob): void {
    const state: TransferState = job.state;
    if (state === 'running' || state === 'queued') return;
    this.deps.config.appendHistory({ ...job });
  }

  private refresh(): void {
    this.deps.requestSnapshotRefresh();
  }

  /** Notifies the user only about completed or failed jobs. */
  private notify(job: TransferJob): void {
    const settings = this.deps.config.get();
    if (!settings.notifications.enabled) return;
    if (job.state === 'succeeded' && settings.notifications.transferCompletion) {
      this.deps.emit({
        type: 'notification',
        level: 'info',
        title: 'Transfer finished',
        body: `${job.kind === 'offline-pin' ? 'Offline copy' : 'Transfer'} complete: ${basename(job.dstUri)}`,
      });
    }
    if (job.state === 'failed' && settings.notifications.errors) {
      this.deps.emit({
        type: 'notification',
        level: 'error',
        title: 'Transfer failed',
        body: job.error?.message ?? 'The transfer could not be completed.',
      });
    }
  }

  /** Cancels everything (used on shutdown). */
  async shutdown(): Promise<void> {

    for (const { controller } of this.running.values()) controller.abort();
    this.running.clear();
    this.queued.length = 0;
  }

  /** Classifies a failure for the diagnostics screen. */
  static classify(output: string): AppError {
    return classifyRemoteError(output);
  }
}

/**
 * rclone subcommand for a job. `copy` copies the contents of a source folder
 * into the destination folder; `copyto` copies one object to an exact path.
 * Choosing wrong turns a pinned or uploaded file into a folder that contains it.
 */
export function commandForJob(
  job: Pick<TransferJob, 'kind' | 'mode'>,
): 'copy' | 'copyto' | 'download' | 'upload' {
  if (job.kind === 'offline-pin') return job.mode === 'copyto' ? 'copyto' : 'copy';
  if (job.kind === 'copy') return job.mode === 'copyto' ? 'copyto' : 'copy';
  return job.kind;
}

function basename(uri: string): string {
  const cleaned = uri.replace(/[\\/]+$/, '');
  return cleaned.split(/[\\/]/).pop() ?? uri;
}
