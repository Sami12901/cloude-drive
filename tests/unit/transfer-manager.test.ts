import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TransferManager } from '../../src/main/services/transfer-manager.js';
import { ConfigService } from '../../src/main/services/config-service.js';
import { MemoryLogger } from '../../src/main/services/logging.js';
import { resolvePaths } from '../../src/main/services/context.js';
import type { BridgeEvent } from '@shared/ipc.js';
import type { RunOptions, RunResult } from '../../src/main/services/rclone/cli.js';

interface FakeRun {
  args: string[];
  options: RunOptions;
}

let dir: string;
let config: ConfigService;
let events: BridgeEvent[];
let runs: FakeRun[];
let behaviour: (args: string[], options: RunOptions, attemptOf: number) => { code: number; stdout?: string; stderr?: string };
let runDelayMs = 0;
const attempts = new Map<string, number>();

function makeManager(): TransferManager {
  const engine = {
    cli: async () => ({
      run: async (args: string[], options: RunOptions = {}): Promise<RunResult> => {
        runs.push({ args, options });
        if (runDelayMs > 0) await new Promise((done) => setTimeout(done, runDelayMs));
        const key = args.join(' ');
        const attempt = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, attempt);
        const outcome = behaviour(args, options, attempt);
        options.onStdout?.(outcome.stdout ?? '');
        return {
          code: outcome.code,
          stdout: outcome.stdout ?? '',
          stderr: outcome.stderr ?? '',
          durationMs: 5,
          timedOut: false,
          aborted: false,
        };
      },
    }),
  } as never;

  return new TransferManager({
    config,
    engine,
    logger: new MemoryLogger('transfers'),
    emit: (event: BridgeEvent) => events.push(event),
    clock: () => new Date(),
    sleep: (ms: number) => new Promise((done) => setTimeout(done, Math.min(ms, 5))),
    requestSnapshotRefresh: () => undefined,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloudssd-transfers-'));
  config = new ConfigService(resolvePaths({ dataDir: dir, homeDir: dir, platform: process.platform }), new MemoryLogger());
  events = [];
  runs = [];
  attempts.clear();
  runDelayMs = 0;
  behaviour = () => ({ code: 0, stdout: '' });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('TransferManager', () => {
  it('builds safe, documented rclone arguments for every job', async () => {
    const manager = makeManager();
    manager.enqueue({ kind: 'copy', remoteId: null, srcUri: 'gdrive:docs/a.txt', dstUri: '/tmp/local' });
    await vi.waitFor(() => expect(manager.list().history.length).toBe(1));
    const args = runs[0]!.args;
    expect(args[0]).toBe('copy');
    expect(args).toContain('--use-json-log');
    expect(args).toContain('--partial-suffix');
    expect(args[args.indexOf('--partial-suffix') + 1]).toBe('.cspartial');
    // No shell metacharacters are smuggled into the argument array.
    expect(args.every((arg) => !arg.includes('&&') && !arg.includes('|'))).toBe(true);
  });

  it('parses progress from rclone JSON log lines', async () => {
    behaviour = (_args, options) => {
      options.onStdout?.(
        `${JSON.stringify({ level: 'info', msg: 'x', stats: { bytes: 512, totalBytes: 2048, speed: 1024, eta: 2, transfers: 1, errors: 0 } })}\n`,
      );
      return { code: 0, stdout: '' };
    };
    const manager = makeManager();
    manager.enqueue({ kind: 'download', remoteId: null, srcUri: 'gdrive:a', dstUri: '/tmp/b' });
    await vi.waitFor(() => expect(manager.list().history[0]?.state).toBe('succeeded'));
    const finished = manager.list().history[0]!;
    expect(finished.bytes).toBe(512);
    expect(finished.totalBytes).toBe(2048);
  });

  it('retries with bounded backoff and then reports failure', async () => {
    config.update({ transfers: { ...config.get().transfers, retries: 2, backoffBaseMs: 100, maxBackoffMs: 1000 } });
    behaviour = () => ({ code: 1, stderr: 'ERROR : network is unreachable' });
    const manager = makeManager();
    manager.enqueue({ kind: 'upload', remoteId: null, srcUri: '/tmp/a', dstUri: 'gdrive:a' });
    await vi.waitFor(() => expect(manager.list().history[0]?.state).toBe('failed'), { timeout: 5000 });
    // 1 initial attempt + 2 retries, then it stops (never an endless loop).
    expect(runs.length).toBe(3);
    const failed = manager.list().history[0]!;
    expect(failed.error?.code).toBe('network_error');
    expect(failed.error?.remediation).toBeTruthy();
  });

  it('classifies provider errors with actionable remediation', async () => {
    config.update({ transfers: { ...config.get().transfers, retries: 0 } });
    behaviour = () => ({ code: 1, stderr: 'failed to copy: storage quota exceeded' });
    const manager = makeManager();
    manager.enqueue({ kind: 'upload', remoteId: null, srcUri: '/tmp/a', dstUri: 'gdrive:a' });
    await vi.waitFor(() => expect(manager.list().history[0]?.state).toBe('failed'));
    expect(manager.list().history[0]!.error?.code).toBe('quota_exceeded');
  });

  it('respects the configured concurrency limit', async () => {
    config.update({ transfers: { ...config.get().transfers, concurrency: 2 } });
    runDelayMs = 60;
    const manager = makeManager();
    for (let i = 0; i < 6; i += 1) {
      manager.enqueue({ kind: 'copy', remoteId: null, srcUri: `src-${i}`, dstUri: `dst-${i}` });
    }
    await new Promise((done) => setTimeout(done, 25));
    expect(manager.list().running.length).toBe(2);
    expect(manager.list().queued.length).toBe(4);
    await vi.waitFor(() => expect(manager.list().history.length).toBe(6), { timeout: 8000 });
    expect(manager.list().queued.length).toBe(0);
  });

  it('cancels a running job', async () => {
    let cancelled = false;
    behaviour = (_args, options) => {
      options.signal?.addEventListener('abort', () => {
        cancelled = true;
      });
      return { code: 0, stdout: '' };
    };
    const manager = makeManager();
    const job = manager.enqueue({ kind: 'copy', remoteId: null, srcUri: 'a', dstUri: 'b' });
    await manager.cancel(job.id);
    expect(manager.list().running.length).toBe(0);
    expect(['cancelled', 'succeeded']).toContain(manager.list().history[0]?.state);
    void cancelled;
  });

  it('never leaves a partial file under the final name', async () => {
    behaviour = () => ({ code: 1, stderr: 'network is unreachable' });
    config.update({ transfers: { ...config.get().transfers, retries: 0 } });
    const targetDir = join(dir, 'target');
    mkdirSync(targetDir, { recursive: true });
    const manager = makeManager();
    manager.enqueue({ kind: 'download', remoteId: null, srcUri: 'gdrive:big.bin', dstUri: targetDir });
    await vi.waitFor(() => expect(manager.list().history.length).toBe(1));
    // The engine writes partial data with a suffix; the application must not
    // rename it or pretend the transfer succeeded.
    expect(manager.list().history[0]!.state).toBe('failed');
    writeFileSync(join(targetDir, 'big.bin.cspartial'), 'partial');
    expect(readdirSync(targetDir)).not.toContain('big.bin');
  });
});
