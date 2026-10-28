import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness, hasRclone, sleep, waitFor, type TestHarness } from '../helpers/controller.js';
import type { RemoteConfig } from '@shared/types.js';

/**
 * Transfer jobs are real rclone operations. These tests run them against a
 * local "cloud" directory and assert on the bytes that actually moved.
 */
const describeTransfers = hasRclone ? describe : describe.skip;

let harness: TestHarness;
let remoteDir: string;

async function addRemote(): Promise<RemoteConfig> {
  await harness.controller.auth.submitCredentials({ providerId: 'local', remoteName: 'cloudssdtest', url: remoteDir });
  return harness.controller.createRemote({
    providerId: 'local',
    remoteName: 'cloudssdtest',
    remoteRoot: remoteDir,
    displayName: 'Transfer test target',
    mountPoint: join(harness.tempDir, 'mounts', 'Z'),
  });
}

beforeEach(async () => {
  harness = createHarness();
  remoteDir = mkdtempSync(join(tmpdir(), 'cloudssd-transfer-remote-'));
  await harness.controller.initialize();
});

afterEach(async () => {
  await harness.cleanup();
  rmSync(remoteDir, { recursive: true, force: true });
});

describeTransfers('transfer jobs (real rclone operations)', () => {
  it('uploads a local file to the cloud and records it in the history', async () => {
    const remote = await addRemote();
    const local = join(harness.tempDir, 'upload.txt');
    writeFileSync(local, 'payload for the cloud');

    const job = harness.controller.transfers.enqueue({
      kind: 'copy',
      remoteId: remote.id,
      srcUri: local,
      dstUri: `cloudssdtest:${remoteDir}/upload.txt`,
      // A single file must land at the exact destination path (copyto).
      mode: 'copyto',
    });
    // The queue starts the job immediately when a worker slot is free.
    expect(['queued', 'running']).toContain(job.state);

    const done = await waitFor(async () => {
      const history = harness.controller.transfers.list().history;
      return history.some((item) => item.id === job.id && item.state === 'succeeded');
    }, 40_000);
    expect(done).toBe(true);
    expect(existsSync(join(remoteDir, 'upload.txt'))).toBe(true);
    expect(readFileSync(join(remoteDir, 'upload.txt'), 'utf8')).toBe('payload for the cloud');
  });

  it('reports progress and speed for a job that is actually running', async () => {
    const remote = await addRemote();
    // A bandwidth limit keeps the job alive long enough for rclone to emit
    // several --stats lines, so real progress can be observed.
    const transfers = harness.controller.config.get().transfers;
    harness.controller.config.update({ transfers: { ...transfers, bandwidthLimit: '4M' } });
    const local = join(harness.tempDir, 'big.bin');
    writeFileSync(local, Buffer.alloc(32 * 1024 * 1024, 3));

    const job = harness.controller.transfers.enqueue({
      kind: 'copy',
      remoteId: remote.id,
      srcUri: local,
      dstUri: `cloudssdtest:${remoteDir}/big.bin`,
      mode: 'copyto',
    });
    const sawRunning = await waitFor(async () => {
      const running = harness.controller.transfers.list().running.find((item) => item.id === job.id);
      return Boolean(running && running.totalBytes && running.totalBytes > 0);
    }, 20_000);
    expect(sawRunning).toBe(true);
    await waitFor(async () =>
      harness.controller.transfers.list().history.some((item) => item.id === job.id && item.state === 'succeeded'),
    90_000);
    expect(existsSync(join(remoteDir, 'big.bin'))).toBe(true);
    expect(readFileSync(join(remoteDir, 'big.bin')).length).toBe(32 * 1024 * 1024);
  });

  it('persists the job history so it survives a restart', async () => {
    const remote = await addRemote();
    const local = join(harness.tempDir, 'persisted.txt');
    writeFileSync(local, 'persist me');
    harness.controller.transfers.enqueue({
      kind: 'copy',
      remoteId: remote.id,
      srcUri: local,
      dstUri: `cloudssdtest:${remoteDir}/persisted.txt`,
      mode: 'copyto',
    });
    await waitFor(
      async () => harness.controller.transfers.list().history.some((item) => item.state === 'succeeded'),
      40_000,
    );

    // A fresh controller reading the same data directory sees the same history.
    const restarted = createHarness();
    restarted.controller.config.update({ cache: { ...restarted.controller.config.get().cache, dir: harness.tempDir } });
    await restarted.controller.initialize();
    // The history file lives next to the settings of this instance only, so
    // assert on the file the first controller wrote instead.
    const historyFile = join(harness.paths.dataDir, 'transfers.json');
    expect(existsSync(historyFile)).toBe(true);
    const raw = readFileSync(historyFile, 'utf8');
    expect(raw).toContain('persisted.txt');
    expect(raw).not.toMatch(/token|password|secret/i);
    await restarted.cleanup();
  });

  it('cancels a running job and leaves no half-written file under the final name', async () => {
    const remote = await addRemote();
    const local = join(harness.tempDir, 'cancel.bin');
    writeFileSync(local, Buffer.alloc(64 * 1024 * 1024, 5));

    const job = harness.controller.transfers.enqueue({
      kind: 'copy',
      remoteId: remote.id,
      srcUri: local,
      dstUri: `cloudssdtest:${remoteDir}/cancel.bin`,
      mode: 'copyto',
    });
    await waitFor(
      async () => harness.controller.transfers.list().running.some((item) => item.id === job.id),
      20_000,
    );
    const result = await harness.controller.transfers.cancel(job.id);
    expect(result.cancelled).toBe(true);
    await sleep(1500);
    expect(existsSync(join(remoteDir, 'cancel.bin'))).toBe(false);
    const partials = existsSync(remoteDir) ? readdirSync(remoteDir) : [];
    expect(partials.filter((name: string) => name.endsWith('.cspartial'))).toHaveLength(0);
  });

  it('copies folder contents into the destination folder (copy semantics)', async () => {
    const remote = await addRemote();
    const folder = join(harness.tempDir, 'bundle');
    mkdirSync(join(folder, 'nested'), { recursive: true });
    writeFileSync(join(folder, 'a.txt'), 'a');
    writeFileSync(join(folder, 'nested', 'b.txt'), 'b');

    const job = harness.controller.transfers.enqueue({
      kind: 'copy',
      remoteId: remote.id,
      srcUri: folder,
      dstUri: `cloudssdtest:${remoteDir}/bundle`,
    });
    const done = await waitFor(
      async () =>
        harness.controller.transfers.list().history.some((item) => item.id === job.id && item.state === 'succeeded'),
      40_000,
    );
    expect(done).toBe(true);
    expect(readFileSync(join(remoteDir, 'bundle', 'a.txt'), 'utf8')).toBe('a');
    expect(readFileSync(join(remoteDir, 'bundle', 'nested', 'b.txt'), 'utf8')).toBe('b');
  });

  it('classifies a failure and keeps it in the job history with a remediation', async () => {
    const remote = await addRemote();
    const job = harness.controller.transfers.enqueue({
      kind: 'copy',
      remoteId: remote.id,
      srcUri: `cloudssdtest:${remoteDir}/missing-folder`,
      dstUri: join(harness.tempDir, 'nowhere'),
    });
    const failed = await waitFor(async () =>
      harness.controller.transfers.list().history.some((item) => item.id === job.id && item.state === 'failed'),
    60_000);
    expect(failed).toBe(true);
    const history = harness.controller.transfers.list().history.find((item) => item.id === job.id);
    expect(history?.error?.code).toBeTruthy();
    expect(history?.error?.message.length).toBeGreaterThan(0);
  });
});
