import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHarness, hasRclone, rcloneBinary, sleep, waitFor, type TestHarness } from '../helpers/controller.js';
import type { RemoteConfig } from '@shared/types.js';

/**
 * Mount lifecycle tests against the real rclone engine.
 *
 * On Linux the mount target is a directory served by FUSE; on Windows it would
 * be a drive letter. Everything else — argument construction, process
 * supervision, readiness detection, reconnection, cache accounting — is the
 * production code path, so a pass here means the engine integration works.
 */
const canMount = hasRclone && process.platform !== 'win32';
const describeMount = canMount ? describe : describe.skip;

let harness: TestHarness;
let remoteDir: string;
let mountPoint: string;

async function addTestRemote(remoteRoot?: string): Promise<RemoteConfig> {
  const dir = remoteRoot ?? remoteDir;
  await harness.controller.auth.submitCredentials({
    providerId: 'local',
    remoteName: 'cloudssdtest',
    url: dir,
  });
  return harness.controller.createRemote({
    providerId: 'local',
    remoteName: 'cloudssdtest',
    remoteRoot: dir,
    displayName: 'Engine test target',
    mountPoint,
  });
}

beforeEach(async () => {
  harness = createHarness();
  remoteDir = mkdtempSync(join(tmpdir(), 'cloudssd-remote-'));
  writeFileSync(join(remoteDir, 'seed.txt'), 'seed content');
  mountPoint = join(harness.tempDir, 'mounts', 'Z');
  mkdirSync(mountPoint, { recursive: true });
  await harness.controller.initialize();
  // Short write-back and fast reconnection keep the test suite quick.
  const cache = harness.controller.config.get().cache;
  harness.controller.config.update({
    cache: { ...cache, writeBackSeconds: 2, cleanupIntervalSeconds: 30 },
    mount: { ...harness.controller.config.get().mount, reconnectBackoffMs: 500, maxReconnectAttempts: 3 },
  });
});

afterEach(async () => {
  await harness.cleanup();
  rmSync(remoteDir, { recursive: true, force: true });
});

describeMount('mount lifecycle (real rclone + FUSE)', () => {
  it('mounts a remote and reports a live engine process', async () => {
    await addTestRemote();
    const result = await harness.controller.mountDrive();
    expect(result.pid).toBeGreaterThan(0);
    const snapshot = await harness.controller.snapshot();
    expect(snapshot.status.mount).toBe('mounted');
    expect(snapshot.status.connection).toBe('connected');
    expect(snapshot.engine.rcConnected).toBe(true);
    expect(readdirSync(mountPoint)).toContain('seed.txt');
  });

  it('creates, renames and deletes files through the mounted drive', async () => {
    await addTestRemote();
    await harness.controller.mountDrive();

    // New file
    writeFileSync(join(mountPoint, 'created.txt'), 'created through the mount');
    // New folder with a nested file (spaces + Unicode)
    mkdirSync(join(mountPoint, 'folder with spaces'), { recursive: true });
    writeFileSync(join(mountPoint, 'folder with spaces', 'ünïcödé 文件.txt'), 'nested');

    await waitFor(() => existsSync(join(remoteDir, 'created.txt')), 40_000);
    expect(readFileSync(join(remoteDir, 'created.txt'), 'utf8')).toBe('created through the mount');
    await waitFor(() => existsSync(join(remoteDir, 'folder with spaces', 'ünïcödé 文件.txt')), 40_000);

    // Rename
    const renamed = join(mountPoint, 'renamed.txt');
    require('node:fs').renameSync(join(mountPoint, 'created.txt'), renamed);
    await waitFor(() => existsSync(join(remoteDir, 'renamed.txt')) && !existsSync(join(remoteDir, 'created.txt')), 40_000);

    // Delete
    rmSync(renamed, { force: true });
    await waitFor(() => !existsSync(join(remoteDir, 'renamed.txt')), 40_000);
    expect(existsSync(join(remoteDir, 'seed.txt'))).toBe(true);
  });

  it('refuses a duplicate mount of the same account', async () => {
    const remote = await addTestRemote();
    await harness.controller.mountDrive();
    await expect(harness.controller.mountDrive(remote.id)).rejects.toMatchObject({ code: 'mount_conflict' });
  });

  it('refuses to mount onto a target that is already in use, and recovers it', async () => {
    await addTestRemote();
    // Occupy the mount point with an external (unmanaged) rclone mount.
    const external = spawn(rcloneBinary, ['mount', remoteDir, mountPoint, '--vfs-cache-mode', 'writes'], {
      stdio: 'ignore',
    });
    await waitFor(() => existsSync(join(mountPoint, 'seed.txt')), 30_000);

    await expect(harness.controller.mountDrive()).rejects.toMatchObject({ code: 'mount_conflict' });

    // Automatic recovery must not touch it; only an explicit user decision
    // (the Recover button) can detach a mount that still answers.
    const automatic = await harness.controller.mount.recoverStaleTarget(
      harness.controller.config.getActiveRemote() as RemoteConfig,
      mountPoint,
    );
    expect(automatic.ok).toBe(false);
    const recovered = await harness.controller.mount.recoverStaleTarget(
      harness.controller.config.getActiveRemote() as RemoteConfig,
      mountPoint,
      { force: true },
    );
    expect(recovered.ok).toBe(true);
    await waitFor(() => !existsSync(join(mountPoint, 'seed.txt')), 20_000);

    external.kill('SIGTERM');
    await sleep(1000);

    const result = await harness.controller.mountDrive();
    expect(result.pid).toBeGreaterThan(0);
  });

  it('reconnects automatically after the engine process is killed', async () => {
    await addTestRemote();
    const first = await harness.controller.mountDrive();
    expect(first.pid).toBeGreaterThan(0);

    process.kill(first.pid as number, 'SIGKILL');
    const reconnected = await waitFor(async () => {
      const snapshot = await harness.controller.snapshot();
      return snapshot.status.mount === 'mounted' && (snapshot.engine.mountPid ?? 0) > 0 && snapshot.engine.mountPid !== first.pid;
    }, 60_000);
    expect(reconnected).toBe(true);

    const snapshot = await harness.controller.snapshot();
    expect(snapshot.engine.restartCount).toBeGreaterThan(0);
    expect(readdirSync(mountPoint)).toContain('seed.txt');
  });

  it('reports live cache statistics from the engine while mounted', async () => {
    await addTestRemote();
    await harness.controller.mountDrive();
    writeFileSync(join(mountPoint, 'cached.bin'), Buffer.alloc(64 * 1024));
    // While the engine's accounting is still stale, CloudSSD reports the size
    // measured on disk and says so instead of showing "0 B used".
    const initial = await harness.controller.cache.stats();
    expect(initial.available).toBe(true);
    expect(initial.usedBytes ?? 0).toBeGreaterThan(0);
    expect(initial.note).toMatch(/measured from the cache directory/i);

    // Once the engine refreshes its own accounting the note disappears and the
    // reported size matches the file we wrote (a real 64 KiB cache object).
    const refreshed = await waitFor(async () => (await harness.controller.cache.stats()).note === undefined, 60_000);
    expect(refreshed).toBe(true);
    const stats = await harness.controller.cache.stats();
    expect(stats.usedBytes).toBeGreaterThanOrEqual(64 * 1024);
    expect(stats.files).toBeGreaterThanOrEqual(1);
  });

  it('unmounts cleanly and releases the mount target', async () => {
    await addTestRemote();
    await harness.controller.mountDrive();
    const result = await harness.controller.unmountDrive();
    expect(result.unmounted).toBe(true);
    const snapshot = await harness.controller.snapshot();
    expect(snapshot.status.mount).toBe('unmounted');
    expect(await harness.platform.isMountTargetInUse(mountPoint)).toBe(false);
  });

  it('does not delete cloud data when the account configuration is removed', async () => {
    const remote = await addTestRemote();
    await harness.controller.mountDrive();
    await harness.controller.removeRemote(remote.id);
    expect(existsSync(join(remoteDir, 'seed.txt'))).toBe(true);
    expect(harness.controller.config.listRemotes()).toHaveLength(0);
  });

  it('keeps a lock file so a second instance cannot mount the same target', async () => {
    await addTestRemote();
    await harness.controller.mountDrive();
    expect(existsSync(join(harness.paths.dataDir, 'mount.lock'))).toBe(true);
    const lock = JSON.parse(readFileSync(join(harness.paths.dataDir, 'mount.lock'), 'utf8')) as {
      pid: number;
      target: string;
    };
    expect(lock.pid).toBe(process.pid);
    expect(lock.target).toBe(mountPoint);
  });
});

describe('mount lifecycle availability', () => {
  it('documents when engine-level mounting could not be exercised', () => {
    if (!canMount) {
      // eslint-disable-next-line no-console
      console.warn(
        'SKIPPED: mount lifecycle tests need a real rclone binary and FUSE. Run `npm run deps:fetch-rclone` and re-run `npm run test:mount` on a host with FUSE (see docs/testing.md).',
      );
    }
    expect(typeof canMount).toBe('boolean');
  });
});
