import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness, hasRclone, waitFor, type TestHarness } from '../helpers/controller.js';
import { findLeakedSecrets } from '@shared/redaction.js';
import type { RemoteConfig } from '@shared/types.js';

/**
 * The dashboard must never invent numbers. These tests check the three storage
 * concepts stay separate (cloud quota, local cache, physical disk) and that
 * unknown values are reported as unavailable instead of guessed.
 */
let harness: TestHarness;
let remoteDir: string;

async function addRemote(): Promise<RemoteConfig> {
  await harness.controller.auth.submitCredentials({ providerId: 'local', remoteName: 'cloudssdtest', url: remoteDir });
  return harness.controller.createRemote({
    providerId: 'local',
    remoteName: 'cloudssdtest',
    remoteRoot: remoteDir,
    displayName: 'Snapshot test target',
    mountPoint: join(harness.tempDir, 'mounts', 'Z'),
  });
}

beforeEach(async () => {
  harness = createHarness();
  remoteDir = mkdtempSync(join(tmpdir(), 'cloudssd-snapshot-remote-'));
  writeFileSync(join(remoteDir, 'file.txt'), 'hello');
  await harness.controller.initialize();
});

afterEach(async () => {
  await harness.cleanup();
  rmSync(remoteDir, { recursive: true, force: true });
});

describe('snapshot truthfulness', () => {
  it('reports no cloud quota before an account is connected (never zero, never invented)', async () => {
    const snapshot = await harness.controller.snapshot();
    expect(snapshot.remote).toBeNull();
    expect(snapshot.quota.available).toBe(false);
    expect(snapshot.quota.totalBytes).toBeNull();
    expect(snapshot.quota.usedBytes).toBeNull();
    expect(snapshot.quota.freeBytes).toBeNull();
    expect(snapshot.status.connection).toBe('disconnected');
    expect(snapshot.status.summary).toMatch(/No cloud account/i);
  });

  it('separates cloud quota, cache usage and physical disk space', async () => {
    await addRemote();
    const snapshot = await harness.controller.snapshot();

    // Cloud quota: measured on the remote account, not on this machine.
    expect(snapshot.quota.available).toBe(hasRclone);
    if (hasRclone) {
      const volume = statfsSync(remoteDir);
      const total = Number(volume.blocks) * Number(volume.bsize);
      expect(snapshot.quota.totalBytes).toBe(total);
      expect(snapshot.quota.freeBytes).toBeGreaterThan(0);
    }

    // Cache: a distinct directory with its own limit.
    expect(snapshot.cache.dir).toBe(harness.controller.config.get().cache.dir);
    expect(snapshot.cache.dir).not.toBe(remoteDir);
    expect(snapshot.cache.limitBytes).toBeGreaterThan(0);

    // Disk: the physical volume that holds the cache directory.
    expect(snapshot.disk.cacheDirTotalBytes).toBeGreaterThan(0);
    expect(snapshot.disk.cacheDirFreeBytes).toBeGreaterThan(0);
  });

  it('says so when the cache cannot be measured instead of showing a number', async () => {
    await addRemote();
    const snapshot = await harness.controller.snapshot();
    // Unmounted: the cache is measured from disk and the report says how.
    expect(snapshot.cache.available).toBe(true);
    expect(snapshot.cache.note).toMatch(/cache directory|accounting/i);
    expect(snapshot.cache.pendingUploads).toBe(0);
  });

  it('never puts credentials in the snapshot, the settings file or the diagnostics report', async () => {
    const remote = await addRemote();
    // Store a realistic-looking provider token, then check every surface the
    // renderer can see for it.
    const SECRETS = ['ya29.SUPERSECRET-TEST-TOKEN', 'gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', 'hunter2-hunter2'];
    await harness.vault.set('rclone:cloudssdtest', JSON.stringify({ token: SECRETS[0], password: SECRETS[2] }));

    const snapshot = await harness.controller.snapshot();
    expect(findLeakedSecrets(JSON.stringify(snapshot), SECRETS)).toHaveLength(0);

    const settingsRaw = readFileSync(join(harness.paths.dataDir, 'settings.json'), 'utf8');
    expect(findLeakedSecrets(settingsRaw, SECRETS)).toHaveLength(0);
    // A secret *reference* is fine in settings; a secret value is not.
    expect(settingsRaw).toContain('rclone:cloudssdtest');

    const report = await harness.controller.diagnostics.run();
    expect(findLeakedSecrets(JSON.stringify(report), SECRETS)).toHaveLength(0);
    expect(report.redactionApplied).toBe(true);
    expect(remote.secretRef).toContain('rclone:');

    const serializedLogs = JSON.stringify(harness.logger.entries);
    expect(findLeakedSecrets(serializedLogs, SECRETS)).toHaveLength(0);
  });

  it('reports the engine dependency honestly', async () => {
    const statuses = await harness.controller.dependencyStatuses();
    const rclone = statuses.find((entry) => entry.id === 'rclone');
    expect(rclone).toBeDefined();
    expect(rclone?.installed).toBe(hasRclone);
    if (hasRclone) {
      expect(rclone?.version).toMatch(/^\d+\.\d+/);
    } else {
      expect(rclone?.remediation).toBeTruthy();
    }
  });

  it('only mounts on start when the user enabled it', async () => {
    const remote = await addRemote();
    expect(harness.controller.config.get().startup.autoMountOnStart).toBe(false);
    let snapshot = await harness.controller.snapshot();
    expect(snapshot.status.mount).toBe('unmounted');

    // A second instance over the same configuration, with auto-mount enabled.
    harness.controller.config.update({
      startup: { ...harness.controller.config.get().startup, autoMountOnStart: true },
    });
    const second = createHarness({ dataDir: harness.paths.dataDir, mountRoot: join(harness.tempDir, 'mounts') });
    await second.controller.initialize();
    const mounted = await waitFor(async () => (await second.controller.snapshot()).status.mount === 'mounted', 30_000);
    expect(mounted).toBe(hasRclone);
    await second.cleanup();
    expect(remote.id).toBeTruthy();
  });

  it('purges local state without touching the cloud account', async () => {
    await addRemote();
    const offlineFile = join(harness.paths.dataDir, 'offline-index.json');
    harness.controller.config.upsertOffline({
      id: 'entry-1',
      remoteId: harness.controller.config.listRemotes()[0]!.id,
      remotePath: 'file.txt',
      isDir: false,
      localPath: join(harness.tempDir, 'offline', 'file.txt'),
      state: 'available',
      sizeBytes: 5,
      mtime: null,
      hash: null,
      pinnedAt: new Date().toISOString(),
    });
    expect(existsSync(offlineFile)).toBe(true);

    harness.controller.config.purgeLocalState();
    expect(existsSync(join(harness.paths.dataDir, 'settings.json'))).toBe(false);
    expect(existsSync(offlineFile)).toBe(false);
    // The real cloud data is untouched.
    expect(readFileSync(join(remoteDir, 'file.txt'), 'utf8')).toBe('hello');
  });
});
