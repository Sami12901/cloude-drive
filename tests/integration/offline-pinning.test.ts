import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness, hasRclone, sleep, waitFor, type TestHarness } from '../helpers/controller.js';
import type { RemoteConfig } from '@shared/types.js';

/**
 * Offline pinning is a real local copy made by rclone, not a flag on a remote
 * file. These tests prove that: after pinning, the bytes exist on local disk
 * independently of the cloud, and unpinning deletes only the local copy.
 */
const describePin = hasRclone ? describe : describe.skip;

let harness: TestHarness;
let remoteDir: string;

async function addRemote(): Promise<RemoteConfig> {
  await harness.controller.auth.submitCredentials({ providerId: 'local', remoteName: 'cloudssdtest', url: remoteDir });
  return harness.controller.createRemote({
    providerId: 'local',
    remoteName: 'cloudssdtest',
    remoteRoot: remoteDir,
    displayName: 'Offline test target',
    mountPoint: join(harness.tempDir, 'mounts', 'Z'),
  });
}

beforeEach(async () => {
  harness = createHarness();
  remoteDir = mkdtempSync(join(tmpdir(), 'cloudssd-offline-remote-'));
  mkdirSync(join(remoteDir, 'docs'), { recursive: true });
  writeFileSync(join(remoteDir, 'docs', 'report.txt'), 'quarterly report');
  writeFileSync(join(remoteDir, 'photo.bin'), Buffer.alloc(4096, 7));
  // Keep pinned copies inside the temporary test directory.
  harness.controller.config.update({
    offline: { enabled: true, dir: join(harness.tempDir, 'offline') },
  });
  await harness.controller.initialize();
});

afterEach(async () => {
  await harness.cleanup();
  rmSync(remoteDir, { recursive: true, force: true });
});

describePin('offline pinning (real local copies)', () => {
  it('downloads a real copy of a remote file and reports it as available', async () => {
    const remote = await addRemote();
    const entry = await harness.controller.offline.pin(remote, 'docs/report.txt');
    expect(entry.state).toBe('queued');
    expect(entry.localPath).toContain('offline');

    const available = await waitFor(async () => {
      const current = harness.controller.offline.list().find((item) => item.id === entry.id);
      return current?.state === 'available';
    }, 40_000);
    expect(available).toBe(true);

    const final = harness.controller.offline.list().find((item) => item.id === entry.id);
    expect(final?.sizeBytes).toBe('quarterly report'.length);
    expect(final?.localPath).toBeTruthy();
    // The copy is a real file on this machine, readable without any cloud access.
    expect(existsSync(final!.localPath)).toBe(true);
    expect(readFileSync(final!.localPath, 'utf8')).toBe('quarterly report');
    expect(statSync(final!.localPath).size).toBe(final?.sizeBytes);
  });

  it('keeps the local copy when the cloud file disappears', async () => {
    const remote = await addRemote();
    const entry = await harness.controller.offline.pin(remote, 'photo.bin');
    await waitFor(async () => {
      const current = harness.controller.offline.list().find((item) => item.id === entry.id);
      return current?.state === 'available';
    }, 40_000);
    const localPath = harness.controller.offline.list().find((item) => item.id === entry.id)!.localPath;

    rmSync(join(remoteDir, 'photo.bin'));
    await sleep(500);
    expect(existsSync(localPath)).toBe(true);
    expect(statSync(localPath).size).toBe(4096);
  });

  it('pins a folder with its contents', async () => {
    const remote = await addRemote();
    writeFileSync(join(remoteDir, 'docs', 'notes.txt'), 'notes');
    const entry = await harness.controller.offline.pin(remote, 'docs');
    expect(entry.isDir).toBe(true);
    const done = await waitFor(async () => {
      const current = harness.controller.offline.list().find((item) => item.id === entry.id);
      return current?.state === 'available';
    }, 40_000);
    expect(done).toBe(true);
    expect(existsSync(join(entry.localPath, 'report.txt'))).toBe(true);
    expect(existsSync(join(entry.localPath, 'notes.txt'))).toBe(true);
  });

  it('records a failed pin instead of pretending it worked', async () => {
    const remote = await addRemote();
    // A file that does not exist in the cloud is rejected immediately instead
    // of showing a pin that would never complete.
    await expect(harness.controller.offline.pin(remote, 'does-not-exist.txt')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(harness.controller.offline.list().some((item) => item.remotePath === 'does-not-exist.txt')).toBe(false);
  });

  it('unpins an item by deleting the local copy only (cloud data stays)', async () => {
    const remote = await addRemote();
    const entry = await harness.controller.offline.pin(remote, 'docs/report.txt');
    await waitFor(async () => {
      const current = harness.controller.offline.list().find((item) => item.id === entry.id);
      return current?.state === 'available';
    }, 40_000);
    const localPath = harness.controller.offline.list().find((item) => item.id === entry.id)!.localPath;

    const result = await harness.controller.offline.unpin(entry.id);
    expect(result.removed).toBe(true);
    expect(existsSync(localPath)).toBe(false);
    expect(existsSync(join(remoteDir, 'docs', 'report.txt'))).toBe(true);
    expect(harness.controller.offline.list().find((item) => item.id === entry.id)).toBeUndefined();
  });

  it('sums the real size of pinned data for the storage screen', async () => {
    const remote = await addRemote();
    const entry = await harness.controller.offline.pin(remote, 'photo.bin');
    await waitFor(async () => {
      const current = harness.controller.offline.list().find((item) => item.id === entry.id);
      return current?.state === 'available';
    }, 40_000);
    expect(harness.controller.offline.totalBytes()).toBeGreaterThanOrEqual(4096);
  });
});
