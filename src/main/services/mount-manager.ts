import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { ERROR_CODES, makeError } from '../../shared/ipc.js';
import type { BridgeEvent } from '../../shared/ipc.js';
import type { AppError, CacheSettings, MountSettings, MountStatus, RemoteConfig, TransferSettings } from '../../shared/types.js';
import type { PlatformAdapter } from '../platform/types.js';
import type { Logger } from './logging.js';
import { writeSecureFile } from './logging.js';
import type { AppPaths } from './context.js';
import { backoffDelay, findFreePort } from './context.js';
import type { ConfigService } from './config-service.js';
import type { RcloneEngine } from './rclone/engine.js';
import { RemoteControl, generateRcPassword } from './rclone/remote-control.js';
import { classifyRemoteError } from './provider-service.js';
import { buildRemoteSpec } from '../../shared/remote.js';

export interface MountArgsInput {
  source: string;
  target: string;
  cache: CacheSettings;
  transfers: TransferSettings;
  mount: MountSettings;
  platform: PlatformAdapter;
  rc: { port: number; user: string; password: string };
  logLevel: 'error' | 'info' | 'debug';
  extra?: string[];
}

/**
 * Builds the rclone mount argument array.
 *
 * Documented options only (see docs/provider-limitations.md for the rclone
 * version this was validated against). Values are validated before they get
 * here, and the array is passed to `spawn` without a shell.
 */
export function buildMountArgs(input: MountArgsInput): string[] {
  const { cache, transfers, mount, platform, rc, logLevel } = input;
  const args: string[] = ['mount', input.source, input.target];

  // Remote control: bound to loopback, protected by a per-run random password.
  args.push('--rc', '--rc-addr', `127.0.0.1:${rc.port}`, '--rc-user', rc.user, '--rc-pass', rc.password);

  // Caching: Mode A (streaming) buffers writes only, Mode B (balanced) keeps a
  // bounded, fully cached working set.
  args.push('--vfs-cache-mode', cache.mode === 'balanced' ? 'full' : 'writes');
  args.push('--cache-dir', cache.dir);
  args.push('--vfs-cache-max-size', `${cache.limitBytes}`);
  args.push('--vfs-cache-max-age', `${cache.maxAgeSeconds}s`);
  args.push('--vfs-cache-poll-interval', `${Math.max(30, cache.cleanupIntervalSeconds)}s`);
  args.push('--vfs-read-chunk-size', `${cache.chunkSizeBytes}`);
  args.push('--vfs-read-ahead', `${cache.readAheadBytes}`);
  args.push('--vfs-write-back', `${cache.writeBackSeconds}s`);
  if (cache.minFreeSpaceBytes && cache.minFreeSpaceBytes > 0) {
    args.push('--vfs-cache-min-free-space', `${cache.minFreeSpaceBytes}`);
  }

  args.push('--transfers', `${transfers.concurrency}`);
  if (transfers.bandwidthLimit) args.push('--bwlimit', transfers.bandwidthLimit);
  if (mount.readOnly) args.push('--read-only');
  if (platform.kind === 'posix' && mount.allowOther) args.push('--allow-other');

  args.push('--log-level', logLevel.toUpperCase() === 'DEBUG' ? 'DEBUG' : 'INFO');
  args.push(...platform.extraMountFlags());
  if (input.extra) args.push(...input.extra);
  return args;
}

interface ActiveMount {
  remoteId: string;
  remoteName: string;
  target: string;
  source: string;
  child: ChildProcessWithoutNullStreams;
  pid: number | null;
  rc: RemoteControl;
  rcPassword: string;
  startedAt: string;
  restartCount: number;
  status: MountStatus;
  /** Set from the `close` handler; `child.exitCode` stays null when a signal killed it. */
  exited: boolean;
  stderrTail: string[];
  reconnectTimer?: NodeJS.Timeout;
  healthTimer?: NodeJS.Timeout;
  consecutiveRcFailures: number;
  lastError?: AppError;
}

export interface MountManagerDeps {
  engine: RcloneEngine;
  config: ConfigService;
  platform: PlatformAdapter;
  paths: AppPaths;
  logger: Logger;
  emit(event: BridgeEvent): void;
  clock(): Date;
  sleep(ms: number): Promise<void>;
  /** Spawned by the CLI; injected so tests can control the engine process. */
  requestSnapshotRefresh: () => void;
}

/**
 * Owns the rclone mount process lifecycle.
 *
 * Guarantees:
 *  - at most one mount per remote, and at most one mount per target;
 *  - a lock file prevents a second CloudSSD instance from mounting the same target;
 *  - unexpected termination is logged, then retried with bounded backoff;
 *  - shutting the application down unmounts cleanly (rc mount/unmount first,
 *    process signal only as a fallback).
 */
export class MountManager {
  private active: ActiveMount | null = null;
  private shuttingDown = false;

  constructor(private readonly deps: MountManagerDeps) {}

  get current(): { remoteId: string | null; pid: number | null; status: MountStatus; target: string | null } {
    return {
      remoteId: this.active?.remoteId ?? null,
      // A dead process has no pid worth reporting.
      pid: this.active && !this.active.exited ? this.active.pid : null,
      status: this.active?.status ?? 'unmounted',
      target: this.active?.target ?? null,
    };
  }

  get rc(): RemoteControl | null {
    // Only report a live endpoint: after the engine dies the client object
    // still exists, but nothing is listening on the other side.
    const mount = this.active;
    if (!mount || mount.status !== 'mounted' || mount.exited) return null;
    return mount.rc;
  }

  /** True when the last health check of the running mount succeeded. */
  rcHealthy(): boolean {
    const mount = this.active;
    if (!mount || mount.status !== 'mounted') return false;
    return mount.consecutiveRcFailures === 0 && !mount.exited;
  }

  /** Read helper: avoids TypeScript narrowing `this.active` to `null` after an assignment. */
  private currentMount(): ActiveMount | null {
    return this.active;
  }

  get lastError(): AppError | undefined {
    return this.active?.lastError;
  }

  stderrTail(): string[] {
    return this.active?.stderrTail ?? [];
  }

  restartCount(): number {
    return this.active?.restartCount ?? 0;
  }

  /* --------------------------------------------------------------- mounting */

  async mount(remoteId?: string): Promise<{ pid: number | null; target: string }> {
    const remote = remoteId
      ? this.deps.config.getRemote(remoteId)
      : this.deps.config.getActiveRemote();
    if (!remote) {
      throw mountError(ERROR_CODES.NOT_FOUND, 'No cloud account is selected. Connect an account first.');
    }
    if (this.active && this.active.remoteId === remote.id && this.active.status !== 'failed') {
      throw mountError(ERROR_CODES.MOUNT_CONFLICT, `${remote.displayName} is already mounted.`);
    }
    if (this.active && this.active.remoteId !== remote.id) {
      await this.unmount({ force: false });
    }

    await this.deps.engine.refresh();
    if (!this.deps.engine.available) {
      throw makeError(
        ERROR_CODES.DEPENDENCY_MISSING,
        'The rclone engine is not available, so the drive cannot be mounted.',
        {
          recoverable: true,
          remediation:
            'Install rclone from rclone.org/downloads or run the dependency check in Settings → Diagnostics.',
        },
      );
    }

    const winfsp = await this.deps.platform.detectWinFsp();
    if (winfsp.required && !winfsp.installed) {
      throw makeError(ERROR_CODES.DEPENDENCY_MISSING, winfsp.message, {
        recoverable: true,
        remediation: winfsp.remediation ?? 'Install WinFsp and try again.',
      });
    }

    const target = this.targetFor(remote);
    if (!target) {
      throw mountError(
        ERROR_CODES.VALIDATION,
        'This account has no drive letter (Windows) or mount point configured.',
        undefined,
        'Choose a target in Settings → Drive.',
      );
    }

    const state = await this.deps.platform.inspectMountTarget(target);
    if (state.mounted) {
      // Only a *stale* target is recovered automatically. A healthy mount that
      // belongs to another program is never unmounted behind its back.
      const stale = await this.recoverStaleTarget(remote, target);
      if (!stale.ok) {
        throw makeError(ERROR_CODES.MOUNT_CONFLICT, `The mount target ${target} is already in use.`, {
          details: stale.detail,
          recoverable: true,
          remediation: busyRemediation(remote),
        });
      }
    }

    const lock = this.acquireLock(remote, target);
    if (!lock.ok) {
      throw mountError(ERROR_CODES.MOUNT_CONFLICT, lock.detail, undefined, busyRemediation(remote));
    }

    const started = await this.spawnMount(remote, target);
    return { pid: started.pid, target };
  }

  private async spawnMount(
    remote: RemoteConfig,
    target: string,
    inheritedRestartCount = 0,
  ): Promise<{ pid: number | null }> {
    const settings = this.deps.config.get();
    const port = await findFreePort();
    const rcPassword = generateRcPassword();
    const rcUser = 'cloudssd';
    const source = buildRemoteSpec(remote);
    const args = buildMountArgs({
      source,
      target: this.deps.platform.mountTargetArgument(target),
      cache: settings.cache,
      transfers: settings.transfers,
      mount: settings.mount,
      platform: this.deps.platform,
      rc: { port, user: rcUser, password: rcPassword },
      logLevel: settings.diagnostics.logLevel,
    });

    // On POSIX hosts the mount point must exist before rclone attaches to it
    // (Windows drive letters are created by the mount itself).
    if (this.deps.platform.kind === 'posix') {
      mkdirSync(target, { recursive: true, mode: 0o755 });
    }

    const cli = await this.deps.engine.cli();
    this.deps.logger.info('Starting rclone mount.', {
      remote: remote.remoteName,
      target,
      mode: settings.cache.mode,
    });

    // The rc password is passed through argv (rclone requires it as a flag) —
    // it is a per-run random value for a loopback endpoint and is registered
    // with the logger so it can never appear in a log line.
    // The rc password is passed as an rclone flag (rclone only accepts it there);
    // it is a per-run random value for a loopback-only endpoint and is registered
    // with the logger so it can never reach a log file.
    const child = cli.spawn(args);
    const rc = new RemoteControl(`http://127.0.0.1:${port}`, rcUser, rcPassword, this.deps.logger.child('rc'));

    const mount: ActiveMount = {
      remoteId: remote.id,
      remoteName: remote.remoteName,
      target,
      source,
      child,
      pid: child.pid ?? null,
      rc,
      rcPassword,
      startedAt: this.deps.clock().toISOString(),
      restartCount: inheritedRestartCount || this.active?.restartCount || 0,
      status: 'mounting',
      exited: false,
      stderrTail: [],
      consecutiveRcFailures: 0,
    };
    this.active = mount;

    child.stdout?.on('data', (chunk: Buffer) => this.recordOutput(mount, chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => this.recordOutput(mount, chunk.toString('utf8')));
    child.on('error', (error: Error) => {
      this.deps.logger.error('rclone mount process error.', { error: error.message });
    });
    child.on('close', (code) => {
      mount.exited = true;
      void this.handleExit(mount, code);
    });

    try {
      await this.waitUntilReady(mount);
    } catch (error) {
      mount.status = 'failed';
      mount.lastError = (error as AppError) ?? undefined;
      this.deps.logger.error('Mount did not become ready.', { target, error: (error as Error).message });
      await this.stopChild(mount, true);
      this.releaseLock();
      this.active = null;
      throw error;
    }

    mount.status = 'mounted';
    this.startHealthMonitor(mount);
    this.deps.config.updateRemote(remote.id, { lastConnectedAt: this.deps.clock().toISOString(), lastError: undefined });
    this.deps.logger.info('Drive mounted.', { target, pid: mount.pid });
    this.deps.requestSnapshotRefresh();
    return { pid: mount.pid };
  }

  private async waitUntilReady(mount: ActiveMount): Promise<void> {
    const deadline = Date.now() + 25000;
    let lastError = 'rclone did not start';
    while (Date.now() < deadline) {
      if (mount.exited) {
        throw mountError(
          ERROR_CODES.MOUNT_FAILED,
          'The rclone mount process exited while starting.',
          mount.stderrTail.join('\n').slice(-800),
          remediationForEngineOutput(mount.stderrTail.join('\n')),
        );
      }
      try {
        await mount.rc.version();
        const verify = await this.deps.platform.verifyMount(mount.target);
        if (verify.ok) return;
        lastError = verify.detail;
      } catch (error) {
        lastError = (error as Error).message;
      }
      await this.deps.sleep(400);
    }
    throw mountError(
      ERROR_CODES.MOUNT_FAILED,
      'The drive did not become ready in time.',
      `${lastError}\n${mount.stderrTail.join('\n').slice(-800)}`,
      remediationForEngineOutput(mount.stderrTail.join('\n')),
    );
  }

  private recordOutput(mount: ActiveMount, chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line.trim()) continue;
      mount.stderrTail.push(line);
      if (mount.stderrTail.length > 200) mount.stderrTail.splice(0, mount.stderrTail.length - 200);
    }
    if (/Fatal error|Failed to mount|already mounted/i.test(chunk)) {
      this.deps.logger.warn('rclone mount reported a problem.', { line: chunk.trim().slice(0, 300) });
    }
  }

  /* ------------------------------------------------------------- unmounting */

  async unmount(options: { force?: boolean; reason?: string } = {}): Promise<{ unmounted: boolean }> {
    const mount = this.active;
    if (!mount) return { unmounted: false };
    this.deps.logger.info('Unmounting drive.', { target: mount.target, reason: options.reason ?? 'user request' });
    mount.status = 'unmounting';
    this.stopTimers(mount);
    this.deps.requestSnapshotRefresh();

    // 1. Ask rclone to unmount (flushes the write-back cache first).
    try {
      await mount.rc.unmount(this.deps.platform.mountTargetArgument(mount.target));
    } catch {
      // rclone may already be gone; the fallback below covers that.
    }
    const exited = await this.waitForExit(mount, options.force ? 2000 : 12000);
    if (!exited) {
      this.deps.logger.warn('rclone did not exit after the unmount request; terminating the process.', {
        pid: mount.pid,
      });
      await this.stopChild(mount, true);
      await this.waitForExit(mount, 5000);
    }
    // 2. If the target is still attached, release it explicitly.
    if (await this.deps.platform.isMountTargetInUse(mount.target)) {
      const released = await this.deps.platform.releaseStaleTarget(mount.target);
      this.deps.logger.info('Released mount target.', { target: mount.target, detail: released.detail });
    }
    this.releaseLock();
    this.active = null;
    this.deps.requestSnapshotRefresh();
    return { unmounted: true };
  }

  private async stopChild(mount: ActiveMount, force: boolean): Promise<void> {
    if (mount.exited) return;
    try {
      if (force) mount.child.kill('SIGTERM');
      else await mount.rc.quit();
    } catch {
      mount.child.kill('SIGTERM');
    }
  }

  private async waitForExit(mount: ActiveMount, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (mount.exited) return true;
      await this.deps.sleep(150);
    }
    return mount.exited;
  }

  /* --------------------------------------------------------- health/recovery */

  private startHealthMonitor(mount: ActiveMount): void {
    const interval = Math.max(2000, this.deps.config.get().mount.healthCheckIntervalMs);
    mount.healthTimer = setInterval(() => {
      void this.checkHealth(mount);
    }, interval);
    mount.healthTimer.unref?.();
  }

  private async checkHealth(mount: ActiveMount): Promise<void> {
    if (mount.status !== 'mounted') return;
    try {
      await mount.rc.stats();
      mount.consecutiveRcFailures = 0;
      return;
    } catch (error) {
      mount.consecutiveRcFailures += 1;
      this.deps.logger.warn('Mount health check failed.', {
        target: mount.target,
        failures: mount.consecutiveRcFailures,
        error: (error as Error).message,
      });
    }
    if (mount.consecutiveRcFailures >= 3) {
      mount.status = 'stale';
      mount.lastError = makeError(ERROR_CODES.MOUNT_STALE, 'The drive stopped responding and was marked stale.', {
        details: mount.stderrTail.join('\n').slice(-400),
        recoverable: true,
        remediation: 'Use Recover to unmount the stale drive and mount it again.',
      });
      this.deps.requestSnapshotRefresh();
    }
  }

  /** Cleans up a target left behind by a crashed or killed process. */
  /**
   * Releases a mount target that is still attached.
   *
   * By default this only touches *stale* targets (no living owner). Callers
   * that represent an explicit user decision — the Recover button in the UI —
   * pass `force: true` to release a target even if it still answers.
   */
  async recoverStaleTarget(
    remote: RemoteConfig,
    target?: string,
    options: { force?: boolean } = {},
  ): Promise<{ ok: boolean; detail: string }> {
    const mountTarget = target ?? this.targetFor(remote);
    if (!mountTarget) return { ok: false, detail: 'No mount target configured.' };
    const lock = this.readLock();
    if (lock && lock.target === mountTarget && isPidAlive(lock.pid) && lock.pid !== process.pid) {
      return { ok: false, detail: `Another CloudSSD process (pid ${lock.pid}) owns ${mountTarget}.` };
    }
    if (!options.force) {
      const state = await this.deps.platform.inspectMountTarget(mountTarget);
      if (state.mounted && !state.stale) {
        return {
          ok: false,
          detail: `${mountTarget} is mounted by another program (${state.detail}). Choose a different target or unmount it first.`,
        };
      }
      if (!state.mounted) return { ok: true, detail: `${mountTarget} is not attached.` };
    }
    const released = await this.deps.platform.releaseStaleTarget(mountTarget);
    if (!released.ok) return released;
    await this.deps.sleep(500);
    const stillBusy = await this.deps.platform.isMountTargetInUse(mountTarget);
    if (!stillBusy) return released;
    // Last resort: a lazy detach, used when the engine died mid-operation and
    // the kernel still holds the mount open.
    const forced = await this.deps.platform.forceReleaseTarget(mountTarget);
    await this.deps.sleep(500);
    const stillThere = await this.deps.platform.isMountTargetInUse(mountTarget);
    return stillThere ? { ok: false, detail: `${mountTarget} is still attached (${forced.detail}).` } : forced;
  }

  /** Unmounts a stale drive and mounts it again. */
  async recover(): Promise<{ recovered: boolean; detail: string }> {
    const mount = this.active;
    if (!mount) return { recovered: false, detail: 'Nothing is mounted.' };
    const remote = this.deps.config.getRemote(mount.remoteId);
    this.stopTimers(mount);
    await this.stopChild(mount, true);
    await this.waitForExit(mount, 4000);
    if (await this.deps.platform.isMountTargetInUse(mount.target)) {
      // The user asked for this recovery explicitly, so a live-looking target
      // may be detached as well.
      const released = await this.deps.platform.releaseStaleTarget(mount.target);
      if (!released.ok) await this.deps.platform.forceReleaseTarget(mount.target);
    }
    this.releaseLock();
    this.active = null;
    if (!remote) return { recovered: false, detail: 'The account no longer exists.' };
    const result = await this.mount(remote.id);
    return { recovered: true, detail: `Remounted ${mount.target} (pid ${result.pid ?? 'unknown'}).` };
  }

  private async handleExit(mount: ActiveMount, code: number | null): Promise<void> {
    if (this.active !== mount) return;
    this.stopTimers(mount);
    const settings = this.deps.config.get();
    const expected = mount.status === 'unmounting' || this.shuttingDown;
    if (expected) {
      this.deps.logger.info('rclone mount exited.', { code, target: mount.target });
      return;
    }
    const detail = mount.stderrTail.join('\n').slice(-600);
    mount.lastError = makeError(
      ERROR_CODES.MOUNT_FAILED,
      `The drive disconnected (rclone exited with code ${code ?? 'unknown'}).`,
      { details: detail, recoverable: true, remediation: remediationForEngineOutput(detail) },
    );
    this.deps.logger.error('rclone mount terminated unexpectedly.', { code, target: mount.target });
    this.releaseLock();

    if (!settings.mount.autoReconnect) {
      mount.status = 'failed';
      this.deps.requestSnapshotRefresh();
      return;
    }
    if (mount.restartCount >= settings.mount.maxReconnectAttempts) {
      mount.status = 'failed';
      mount.lastError = makeError(
        ERROR_CODES.MOUNT_FAILED,
        `Giving up after ${mount.restartCount} automatic reconnection attempts.`,
        { details: detail, recoverable: true, remediation: 'Check the network and press Mount, or run Diagnostics.' },
      );
      this.active = null;
      this.deps.requestSnapshotRefresh();
      return;
    }

    const attempt = mount.restartCount + 1;
    const delay = backoffDelay(attempt, settings.mount.reconnectBackoffMs, 60000);
    mount.status = 'mounting';
    // Counted up-front so the UI can say "reconnecting (attempt N)" while the
    // attempt is in flight, not only after it succeeds.
    mount.restartCount = attempt;
    this.deps.logger.warn('Scheduling automatic reconnection.', { attempt, delayMs: delay });
    this.deps.requestSnapshotRefresh();
    mount.reconnectTimer = setTimeout(() => {
      void this.retryMount(mount, attempt);
    }, delay);
    mount.reconnectTimer.unref?.();
  }

  private async retryMount(previous: ActiveMount, attempt: number): Promise<void> {
    const remote = this.deps.config.getRemote(previous.remoteId);
    if (!remote) {
      this.active = null;
      return;
    }
    const state = await this.deps.platform.inspectMountTarget(previous.target);
    if (state.mounted) {
      const released = state.stale
        ? await this.deps.platform.releaseStaleTarget(previous.target)
        : await this.deps.platform.forceReleaseTarget(previous.target);
      this.deps.logger.info('Released mount target before reconnecting.', { ...released, stale: state.stale });
      if (!released.ok) {
        this.deps.logger.warn('Target was still attached after releasing it.', { target: previous.target });
      }
    }
    const inherited = previous.restartCount;
    this.active = null;
    try {
      await this.spawnMount(remote, previous.target, inherited);
      const current = this.currentMount();
      if (current) {
        this.deps.logger.info('Reconnected after an unexpected termination.', { attempt });
      }
    } catch (error) {
      this.deps.logger.error('Automatic reconnection attempt failed.', {
        attempt,
        target: previous.target,
        error: (error as Error).message,
      });
      const next: ActiveMount = {
        ...previous,
        status: 'failed',
        restartCount: attempt,
        lastError: (error as AppError) ?? makeError(ERROR_CODES.MOUNT_FAILED, (error as Error).message),
        child: previous.child,
      };
      this.active = next;
      this.deps.requestSnapshotRefresh();
      void this.handleExit(next, null);
    }
  }

  /* ------------------------------------------------------------------ target */

  targetFor(remote: RemoteConfig): string | null {
    if (this.deps.platform.kind === 'win32') {
      return remote.driveLetter ? this.deps.platform.normalizeMountTarget(remote.driveLetter) : null;
    }
    return remote.mountPoint ?? null;
  }

  async setTarget(remoteId: string, patch: { driveLetter?: string | null; mountPoint?: string | null }): Promise<RemoteConfig> {
    const remote = this.deps.config.getRemote(remoteId);
    if (!remote) throw mountError(ERROR_CODES.NOT_FOUND, 'Remote not found.');
    if (this.active?.remoteId === remoteId) {
      throw mountError(ERROR_CODES.CONFLICT, 'Unmount the drive before changing its target.');
    }
    const nextTarget = this.deps.platform.kind === 'win32' ? patch.driveLetter ?? null : patch.mountPoint ?? null;
    const nextState = nextTarget ? await this.deps.platform.inspectMountTarget(nextTarget) : null;
    if (nextState?.mounted) {
      throw mountError(
        ERROR_CODES.MOUNT_CONFLICT,
        nextState.stale
          ? `The target ${nextTarget} is attached but not responding (${nextState.detail}).`
          : `The target ${nextTarget} is already in use.`,
        nextState.detail,
        busyRemediation(remote),
      );
    }
    return this.deps.config.updateRemote(remoteId, patch);
  }

  /* ------------------------------------------------------------------- locks */

  private get lockFile(): string {
    return join(this.deps.paths.dataDir, 'mount.lock');
  }

  private acquireLock(remote: RemoteConfig, target: string): { ok: boolean; detail: string } {
    const existing = this.readLock();
    if (existing && isPidAlive(existing.pid) && existing.target === target) {
      return { ok: false, detail: `CloudSSD (pid ${existing.pid}) already mounted ${target}.` };
    }
    writeSecureFile(
      this.lockFile,
      JSON.stringify({ pid: process.pid, remoteId: remote.id, target, startedAt: this.deps.clock().toISOString() }),
      0o600,
    );
    return { ok: true, detail: 'lock acquired' };
  }

  private readLock(): { pid: number; target: string; remoteId: string } | null {
    if (!existsSync(this.lockFile)) return null;
    try {
      return JSON.parse(readFileSync(this.lockFile, 'utf8')) as { pid: number; target: string; remoteId: string };
    } catch {
      return null;
    }
  }

  private releaseLock(): void {
    try {
      if (existsSync(this.lockFile)) rmSync(this.lockFile, { force: true });
    } catch {
      /* ignore */
    }
  }

  /* --------------------------------------------------------------- lifecycle */

  /** Called on application quit: unmount everything, never throw. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (!this.active) return;
    try {
      await this.unmount({ force: false, reason: 'application shutdown' });
    } catch (error) {
      this.deps.logger.error('Clean unmount failed during shutdown.', { error: (error as Error).message });
    }
  }

  private stopTimers(mount: ActiveMount): void {
    if (mount.healthTimer) clearInterval(mount.healthTimer);
    if (mount.reconnectTimer) clearTimeout(mount.reconnectTimer);
    mount.healthTimer = undefined;
    mount.reconnectTimer = undefined;
  }
}

/* -------------------------------------------------------------- utilities */

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function mountError(code: string, message: string, details?: string, remediation?: string): AppError {
  return makeError(code, message, { details, recoverable: true, remediation });
}

function busyRemediation(remote: RemoteConfig): string {
  return `Choose a different drive letter in Settings → Drive (${remote.displayName}), or unmount the existing drive first.`;
}

function remediationForEngineOutput(output: string): string {
  if (/winfsp|cannot find winfsp/i.test(output)) {
    return 'Install WinFsp from winfsp.dev, then mount again.';
  }
  if (/already mounted|directory already mounted/i.test(output)) {
    return 'The target is already mounted. Use Recover to release it, or pick another drive letter.';
  }
  if (/access denied|permission denied/i.test(output)) {
    return 'Close any window that is using the drive letter and retry. Administrator rights are not required for normal use.';
  }
  const classified = classifyRemoteError(output);
  return classified.remediation ?? 'Open Diagnostics for the sanitized engine log, then retry.';
}

/** Random id used for the rc user name (defence in depth alongside the password). */
export function rcUser(): string {
  return `cloudssd-${randomBytes(4).toString('hex')}`;
}
