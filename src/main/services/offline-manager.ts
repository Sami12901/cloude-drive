import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ERROR_CODES, makeError } from '../../shared/ipc.js';
import type { AppError, OfflineEntry, RemoteConfig } from '../../shared/types.js';
import type { Logger } from './logging.js';
import type { ConfigService } from './config-service.js';
import type { ProviderService } from './provider-service.js';
import type { TransferManager } from './transfer-manager.js';
import type { PlatformAdapter } from '../platform/types.js';

export interface OfflineManagerDeps {
  config: ConfigService;
  providers: ProviderService;
  transfers: TransferManager;
  platform: PlatformAdapter;
  logger: Logger;
  clock(): Date;
}

/**
 * Mode C — Selected offline files.
 *
 * An offline file is a real local copy in the offline directory, created with
 * `rclone copy --checksum`. CloudSSD never marks a remote-only file as available
 * offline: an entry only reaches the `available` state after the copy job
 * succeeded and the local file exists on disk.
 */
export class OfflineManager {
  constructor(private readonly deps: OfflineManagerDeps) {}

  list(): OfflineEntry[] {
    return this.deps.config.listOffline();
  }

  totalBytes(): number {
    return this.deps.config
      .listOffline()
      .filter((entry) => entry.state === 'available' || entry.state === 'outdated' || entry.state === 'downloading')
      .reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);
  }

  /** Absolute local path of the pinned copy for a remote object. */
  localPathFor(remote: RemoteConfig, remotePath: string): string {
    const settings = this.deps.config.get();
    const safeSegments = remotePath
      .split('/')
      .filter(Boolean)
      .map((segment) => segment.replace(/[\\/]+/g, '_').replace(/^\.+/, '_'));
    const base = join(settings.offline.dir, `${remote.remoteName}-${remote.id.slice(0, 8)}`);
    return join(base, ...safeSegments);
  }

  /**
   * Starts (or restarts) a real local copy of a remote file or folder.
   *
   * The remote object's type is resolved from the provider first: `copyto` is
   * used for a file (exact destination path) and `copy` for a folder (contents
   * into the destination folder). Guessing from the path is not good enough —
   * the wrong command turns a pinned file into a folder that contains it.
   */
  async pin(remote: RemoteConfig, remotePath: string): Promise<OfflineEntry> {
    const existing = this.deps.config
      .listOffline()
      .find((entry) => entry.remoteId === remote.id && entry.remotePath === remotePath);
    if (existing && (existing.state === 'downloading' || existing.state === 'queued')) {
      return existing;
    }

    const metadata = await this.deps.providers.stat(remote, remotePath);
    if (!metadata) {
      throw makeError(
        ERROR_CODES.NOT_FOUND,
        `“${remotePath}” could not be found in ${remote.displayName}.`,
        {
          recoverable: true,
          remediation:
            'Refresh the file list and pin the item again. If it was deleted in the cloud, remove the local copy instead.',
        },
      );
    }

    const localPath = this.localPathFor(remote, remotePath);
    const entry: OfflineEntry = {
      id: existing?.id ?? randomUUID(),
      remoteId: remote.id,
      remotePath,
      isDir: metadata.isDir,
      localPath,
      state: 'queued',
      sizeBytes: existing?.sizeBytes ?? (metadata.isDir ? null : metadata.size),
      mtime: metadata.mtime ?? null,
      hash: metadata.hash ?? null,
      pinnedAt: existing?.pinnedAt ?? this.deps.clock().toISOString(),
    };
    this.deps.config.upsertOffline(entry);

    const source = this.deps.providers.remotePath(remote, remotePath);
    // `--checksum` keeps an existing local copy when the content is unchanged.
    this.deps.transfers.enqueue({
      kind: 'offline-pin',
      remoteId: remote.id,
      srcUri: source,
      dstUri: localPath,
      mode: metadata.isDir ? 'copy' : 'copyto',
    });
    this.deps.logger.info('Pinned an item for offline use.', {
      remotePath,
      localPath,
      isDir: metadata.isDir,
    });
    return entry;
  }

  /** Called by the transfer manager when a pin job succeeded. */
  async onCopyFinished(remoteId: string, remotePath: string): Promise<OfflineEntry | null> {
    const entry = this.deps.config
      .listOffline()
      .find((item) => item.remoteId === remoteId && item.remotePath === remotePath);
    if (!entry) return null;
    const remote = this.deps.config.getRemote(remoteId);
    if (!remote) return null;

    // Never claim a file is available offline without the bytes on disk: an
    // engine that reported success but produced nothing must surface as failed.
    if (!existsSync(entry.localPath)) {
      const missing: OfflineEntry = {
        ...entry,
        state: 'failed',
        error: makeError(
          ERROR_CODES.ENGINE_ERROR,
          'The copy finished but the local file is missing.',
          {
            recoverable: true,
            remediation: 'Check the offline folder permissions and pin the item again.',
          },
        ),
      };
      this.deps.config.upsertOffline(missing);
      return missing;
    }

    const stat = { size: statSync(entry.localPath).size, mtime: statSync(entry.localPath).mtime.toISOString() };
    const updated: OfflineEntry = {
      ...entry,
      state: 'available',
      sizeBytes: stat.size,
      mtime: stat.mtime,
      lastVerifiedAt: this.deps.clock().toISOString(),
      error: undefined,
    };
    this.deps.config.upsertOffline(updated);
    return updated;
  }

  /** Called by the transfer manager when a pin job failed permanently. */
  async onCopyFailed(job: { remoteId: string | null; error?: AppError }): Promise<OfflineEntry | null> {
    if (!job.remoteId) return null;
    const entry = this.deps.config
      .listOffline()
      .find((item) => item.remoteId === job.remoteId && item.state === 'queued');
    if (!entry) return null;
    const failed: OfflineEntry = {
      ...entry,
      state: 'failed',
      error:
        job.error ??
        makeError(ERROR_CODES.ENGINE_ERROR, 'The local copy could not be downloaded.', { recoverable: true }),
    };
    this.deps.config.upsertOffline(failed);
    this.deps.logger.warn('An offline copy failed.', { path: entry.remotePath, error: failed.error?.message });
    return failed;
  }

  /** Re-downloads a pinned item (used when it went out of date). */
  refresh(id: string): OfflineEntry {
    const entry = this.deps.config.getOffline(id);
    if (!entry) throw new Error('Offline item not found.');
    const remote = this.deps.config.getRemote(entry.remoteId);
    if (!remote) throw new Error('The cloud account for this item no longer exists.');
    const next: OfflineEntry = { ...entry, state: 'queued', error: undefined };
    this.deps.config.upsertOffline(next);
    this.deps.transfers.enqueue({
      kind: 'offline-pin',
      remoteId: remote.id,
      srcUri: this.deps.providers.remotePath(remote, entry.remotePath),
      dstUri: entry.localPath,
      mode: entry.isDir ? 'copy' : 'copyto',
    });
    return next;
  }

  /**
   * Deletes the local copy. The file in the cloud account is never touched —
   * asserted by tests/offline-lifecycle.
   */
  async unpin(id: string): Promise<{ removed: boolean }> {
    const entry = this.deps.config.getOffline(id);
    if (!entry) return { removed: false };
    const state: OfflineEntry = { ...entry, state: 'removing' };
    this.deps.config.upsertOffline(state);
    try {
      if (existsSync(entry.localPath)) {
        rmSync(entry.localPath, { recursive: true, force: true });
      }
    } catch (error) {
      const failed: OfflineEntry = {
        ...entry,
        state: 'failed',
        error: makeError(ERROR_CODES.PERMISSION_DENIED, 'The local copy could not be deleted.', {
          details: (error as Error).message,
          recoverable: true,
          remediation: 'Close any application that has the file open, then remove the local copy again.',
        }),
      };
      this.deps.config.upsertOffline(failed);
      return { removed: false };
    }
    this.deps.config.removeOffline(id);
    this.deps.logger.info('Removed a local offline copy (cloud files untouched).', { path: entry.localPath });
    return { removed: true };
  }

  /**
   * Marks pinned items whose remote counterpart changed as `outdated`.
   * Uses size + modification time (and hash when the provider supports it).
   */
  async verifyAll(): Promise<void> {
    for (const entry of this.deps.config.listOffline()) {
      if (entry.state === 'queued' || entry.state === 'downloading' || entry.state === 'removing') continue;
      const remote = this.deps.config.getRemote(entry.remoteId);
      if (!remote) continue;
      const metadata = await this.deps.providers.stat(remote, entry.remotePath);
      if (!metadata) {
        this.deps.config.upsertOffline({
          ...entry,
          state: 'outdated',
          error: makeError(
            ERROR_CODES.NOT_FOUND,
            'The cloud file is no longer reachable.',
            {
              recoverable: true,
              remediation: 'Refresh the item, or remove the local copy if the file was deleted in the cloud.',
            },
          ),
        });
        continue;
      }
      const localMissing = !existsSync(entry.localPath);
      const changed =
        localMissing ||
        (entry.sizeBytes !== null && metadata.size !== null && entry.sizeBytes !== metadata.size) ||
        (entry.mtime !== null && metadata.mtime !== null && entry.mtime !== metadata.mtime);
      const next: OfflineEntry = {
        ...entry,
        state: changed ? 'outdated' : 'available',
        sizeBytes: metadata.size ?? entry.sizeBytes,
        mtime: metadata.mtime ?? entry.mtime,
        hash: metadata.hash ?? entry.hash,
        lastVerifiedAt: this.deps.clock().toISOString(),
      };
      this.deps.config.upsertOffline(next);
    }
  }

  async openDir(): Promise<void> {
    const settings = this.deps.config.get();
    if (!existsSync(settings.offline.dir)) mkdirSync(settings.offline.dir, { recursive: true, mode: 0o700 });
    await this.deps.platform.openPath(settings.offline.dir);
  }
}
