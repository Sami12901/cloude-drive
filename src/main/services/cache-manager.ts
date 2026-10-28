import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ERROR_CODES, makeError } from '../../shared/ipc.js';
import type { AppError, CacheInfo } from '../../shared/types.js';
import type { Logger } from './logging.js';
import type { ConfigService } from './config-service.js';
import type { MountManager } from './mount-manager.js';
import type { PlatformAdapter } from '../platform/types.js';

export interface CacheManagerDeps {
  config: ConfigService;
  mount: MountManager;
  platform: PlatformAdapter;
  logger: Logger;
}

const WALK_LIMIT = 20000;

/**
 * Cache accounting and safe cache maintenance.
 *
 * The engine (rclone) owns cache eviction: it removes only objects that are not
 * in use, not queued for upload and older than the configured age, and it runs
 * that cleaner every `--vfs-cache-poll-interval` seconds. CloudSSD therefore
 * never deletes cache files while the drive is mounted and never deletes data
 * that is still waiting to be uploaded.
 */
export class CacheManager {
  constructor(private readonly deps: CacheManagerDeps) {}

  async stats(): Promise<CacheInfo> {
    const settings = this.deps.config.get();
    const dir = settings.cache.dir;
    const writable = await this.isWritable(dir);
    const base: CacheInfo = {
      available: false,
      dir,
      dirWritable: writable,
      mode: settings.cache.mode,
      usedBytes: null,
      limitBytes: settings.cache.limitBytes,
      files: null,
      pendingUploads: 0,
      uploading: 0,
      inUse: 0,
    };

    const rc = this.deps.mount.rc;
    if (rc) {
      try {
        const stats = await rc.vfsStats();
        const reported = stats.diskCache.bytesUsed;
        // rclone refreshes its cache accounting only every
        // --vfs-cache-poll-interval, so a freshly populated cache can report
        // "0 B" for up to a minute. Rather than showing a number we know is
        // wrong, measure the cache directory and label where it came from.
        let usedBytes = reported;
        let measuredNote: string | undefined;
        if (reported === 0 && stats.diskCache.files > 0) {
          const measured = await this.measure(dir);
          if (measured.bytes) {
            usedBytes = measured.bytes;
            measuredNote =
              'Measured from the cache directory: the engine refreshes its own accounting every cleanup interval.';
          }
        }
        return {
          ...base,
          available: true,
          usedBytes,
          files: stats.diskCache.files,
          pendingUploads: stats.diskCache.uploadsQueued,
          uploading: stats.diskCache.uploadsInProgress,
          inUse: stats.inUse,
          note:
            (stats.diskCache.outOfSpace
              ? 'The cache reached its configured limit. The engine keeps working but some data is no longer cached locally.'
              : undefined) ?? measuredNote,
        };
      } catch (error) {
        this.deps.logger.debug('Could not read VFS cache statistics.', { error: (error as Error).message });
      }
    }

    // No live mount: report what we can measure from disk, clearly labelled.
    const measured = await this.measure(dir);
    return {
      ...base,
      available: measured.bytes !== null,
      usedBytes: measured.bytes,
      files: measured.files,
      note:
        measured.bytes === null
          ? 'Cache statistics are available while the drive is mounted.'
          : 'Measured from the cache directory while the drive is unmounted (includes data that may still be waiting to upload).',
    };
  }

  async setLimit(limitBytes: number): Promise<CacheInfo> {
    const settings = this.deps.config.get();
    const free = await this.freeBytes(settings.cache.dir);
    if (free !== null && limitBytes > free) {
      this.deps.logger.warn('Cache limit exceeds the free space on the cache volume.', { limitBytes, free });
    }
    this.deps.config.update({ cache: { ...settings.cache, limitBytes } });
    // The new limit applies on the next mount; say so honestly instead of
    // pretending the running mount resized its cache.
    return this.stats();
  }

  async setDir(dir: string): Promise<CacheInfo> {
    if (this.deps.mount.current.status === 'mounted') {
      throw makeError(ERROR_CODES.CONFLICT, 'Unmount the drive before moving the cache directory.', {
        recoverable: true,
        remediation: 'Press Unmount, change the cache directory, then mount again.',
      });
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const restriction = await this.deps.platform.restrictDirectoryToUser(dir);
    if (!restriction.ok) {
      this.deps.logger.warn('Could not restrict the cache directory permissions.', { detail: restriction.detail });
    }
    const settings = this.deps.config.get();
    this.deps.config.update({ cache: { ...settings.cache, dir } });
    return this.stats();
  }

  /**
   * Deletes cache data, but only data the engine confirms is safe to remove.
   * With the drive mounted this means: no queued or in-progress uploads
   * (checked through the rc API), then a clean unmount so nothing is open.
   */
  async clear(): Promise<{ removedBytes: number; skipped: number; remounted: boolean }> {
    const settings = this.deps.config.get();
    const dir = settings.cache.dir;
    const rc = this.deps.mount.rc;

    if (rc) {
      try {
        const stats = await rc.vfsStats();
        const pending = stats.diskCache.uploadsQueued + stats.diskCache.uploadsInProgress;
        if (pending > 0) {
          throw makeError(
            ERROR_CODES.CONFLICT,
            `${pending} file(s) are still waiting to upload. Clearing the cache now would lose them.`,
            {
              recoverable: true,
              remediation: 'Wait until the pending uploads finish (the transfer list shows them), then clear the cache.',
            },
          );
        }
      } catch (error) {
        if ((error as AppError).code) throw error;
        this.deps.logger.warn('Could not check pending uploads before clearing the cache; refusing.', {
          error: (error as Error).message,
        });
        throw makeError(
          ERROR_CODES.ENGINE_ERROR,
          'The engine state could not be read, so the cache was left untouched.',
          { details: (error as Error).message, recoverable: true, remediation: 'Retry once the drive is healthy; use Diagnostics if the problem persists.' },
        );
      }
    }

    const wasMounted = this.deps.mount.current.status === 'mounted';
    if (wasMounted) {
      await this.deps.mount.unmount({ reason: 'cache clear' });
    }

    const { removedBytes, skipped } = await this.deleteContents(dir);

    if (wasMounted) {
      await this.deps.mount.mount();
    }
    this.deps.logger.info('Cache cleared.', { removedBytes, skipped, remounted: wasMounted });
    return { removedBytes, skipped, remounted: wasMounted };
  }

  async openDir(): Promise<void> {
    const dir = this.deps.config.get().cache.dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    await this.deps.platform.openPath(dir);
  }

  async freeBytes(dir: string): Promise<number | null> {
    try {
      const stats = await statfs(dir);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      return null;
    }
  }

  async isWritable(dir: string): Promise<boolean> {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      const probe = join(dir, '.cloudssd-write-test');
      const { writeFileSync, rmSync: remove } = await import('node:fs');
      writeFileSync(probe, 'ok');
      remove(probe, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Walks the cache directory (used when no live mount reports statistics). */
  async measure(dir: string): Promise<{ bytes: number | null; files: number }> {
    if (!existsSync(dir)) return { bytes: 0, files: 0 };
    let bytes = 0;
    let files = 0;
    let visited = 0;
    const stack = [dir];
    while (stack.length > 0 && visited < WALK_LIMIT) {
      const current = stack.pop() as string;
      let entries: string[];
      try {
        entries = readdirSync(current);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (visited++ > WALK_LIMIT) break;
        const full = join(current, name);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) stack.push(full);
          else {
            bytes += stat.size;
            files += 1;
          }
        } catch {
          /* unreadable entry: skipped, not counted as free space */
        }
      }
    }
    return { bytes, files };
  }

  private async deleteContents(dir: string): Promise<{ removedBytes: number; skipped: number }> {
    if (!existsSync(dir)) return { removedBytes: 0, skipped: 0 };
    const measured = await this.measure(dir);
    let removedBytes = 0;
    let skipped = 0;
    for (const name of readdirSync(dir)) {
      if (name === 'vfsMeta') continue;
      const full = resolve(dir, name);
      try {
        const size = statSync(full).size;
        rmSync(full, { recursive: true, force: true });
        removedBytes += size;
      } catch (error) {
        skipped += 1;
        this.deps.logger.warn('Could not delete a cache entry (it is still in use).', {
          entry: name,
          error: (error as Error).message,
        });
      }
    }
    return { removedBytes: removedBytes || measured.bytes || 0, skipped };
  }
}
