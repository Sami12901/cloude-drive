import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CacheManager } from '../../src/main/services/cache-manager.js';
import { ConfigService } from '../../src/main/services/config-service.js';
import { MemoryLogger } from '../../src/main/services/logging.js';
import { resolvePaths } from '../../src/main/services/context.js';
import { PosixPlatform } from '../../src/main/platform/posix.js';
import type { VfsStats } from '../../src/main/services/rclone/remote-control.js';

let dir: string;
let cacheDir: string;
let config: ConfigService;
let vfs: VfsStats | null;
let calls: string[];
let mount: {
  rc: unknown;
  current: { status: string; remoteId: string | null; pid: number | null; target: string | null };
  unmount: () => Promise<{ unmounted: boolean }>;
  mount: () => Promise<{ pid: number | null; target: string }>;
};

function stats(over: Partial<VfsStats['diskCache']> = {}): VfsStats {
  return {
    diskCache: {
      bytesUsed: 1024,
      files: 1,
      erroredFiles: 0,
      uploadsInProgress: 0,
      uploadsQueued: 0,
      outOfSpace: false,
      path: cacheDir,
      ...over,
    },
    inUse: 0,
    fs: 'gdrive:',
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloudssd-cache-'));
  cacheDir = join(dir, 'vfs-cache');
  mkdirSync(cacheDir, { recursive: true });
  config = new ConfigService(resolvePaths({ dataDir: dir, homeDir: dir, platform: process.platform }), new MemoryLogger());
  config.update({ cache: { ...config.get().cache, dir: cacheDir } });
  vfs = stats();
  calls = [];
  mount = {
    get rc() {
      return vfs
        ? ({
            vfsStats: async () => vfs as VfsStats,
            unmount: async () => undefined,
          } as never)
        : null;
    },
    current: { status: 'mounted', remoteId: 'remote-1', pid: 1, target: '/tmp/mnt' },
    unmount: async () => {
      calls.push('unmount');
      vfs = null;
      mount.current = { status: 'unmounted', remoteId: null, pid: null, target: null };
      return { unmounted: true };
    },
    mount: async () => {
      calls.push('mount');
      vfs = stats();
      mount.current = { status: 'mounted', remoteId: 'remote-1', pid: 2, target: '/tmp/mnt' };
      return { pid: 2, target: '/tmp/mnt' };
    },
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function manager(): CacheManager {
  return new CacheManager({
    config,
    mount: mount as never,
    platform: new PosixPlatform({ mountRoot: join(dir, 'mounts'), openPath: async () => false }),
    logger: new MemoryLogger('cache'),
  });
}

describe('CacheManager', () => {
  it('reports live engine statistics when the drive is mounted', async () => {
    const result = await manager().stats();
    expect(result.available).toBe(true);
    expect(result.usedBytes).toBe(1024);
    expect(result.pendingUploads).toBe(0);
    expect(result.note).toBeUndefined();
  });

  it('flags a cache that reached its configured limit instead of hiding it', async () => {
    vfs = stats({ outOfSpace: true });
    const result = await manager().stats();
    expect(result.note).toMatch(/reached its configured limit/);
  });

  it('measures the cache directory and says so when the drive is unmounted', async () => {
    vfs = null;
    writeFileSync(join(cacheDir, 'file.bin'), Buffer.alloc(4096));
    const result = await manager().stats();
    expect(result.usedBytes).toBe(4096);
    expect(result.note).toMatch(/unmounted/);
  });

  it('refuses to clear the cache while uploads are pending', async () => {
    vfs = stats({ uploadsQueued: 2 });
    await expect(manager().clear()).rejects.toMatchObject({ code: 'conflict' });
    await expect(manager().clear()).rejects.toMatchObject({
      message: expect.stringContaining('waiting to upload'),
    });
  });

  it('unmounts, deletes only removable data and remounts when clearing', async () => {
    writeFileSync(join(cacheDir, 'file.bin'), Buffer.alloc(2048));
    const result = await manager().clear();
    expect(calls).toEqual(['unmount', 'mount']);
    expect(result.removedBytes).toBeGreaterThanOrEqual(0);
    expect(result.remounted).toBe(true);
  });

  it('refuses to move the cache directory while the drive is mounted', async () => {
    await expect(manager().setDir(join(dir, 'other'))).rejects.toMatchObject({ code: 'conflict' });
  });

  it('warns when the limit exceeds the free space on the cache volume', async () => {
    const huge = Number.MAX_SAFE_INTEGER;
    const logs = new MemoryLogger('cache');
    const cache = new CacheManager({
      config,
      mount: mount as never,
      platform: new PosixPlatform({ mountRoot: join(dir, 'mounts'), openPath: async () => false }),
      logger: logs,
    });
    await cache.setLimit(Math.min(huge, 8 * 1024 ** 4));
    expect(logs.entries.some((entry) => entry.message.includes('exceeds the free space'))).toBe(true);
  });
});
