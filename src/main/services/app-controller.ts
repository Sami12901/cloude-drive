import { existsSync, mkdirSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ERROR_CODES, makeError } from '../../shared/ipc.js';
import type { BridgeEvent } from '../../shared/ipc.js';
import type {
  AppError,
  AppSettings,
  AppSnapshot,
  ConnectionState,
  DependencyStatus,
  DriveLetterInfo,
  EnvironmentInfo,
  OfflineEntry,
  ProviderDescriptor,
  QuotaInfo,
  RemoteConfig,
  TransferJob,
} from '../../shared/types.js';
import { createDefaultSettings } from '../../shared/defaults.js';
import { getProvider, visibleProviders } from '../providers/registry.js';
import type { AppPaths } from './context.js';
import { ConfigService } from './config-service.js';
import { CredentialVault, VAULT_KEYS } from './credential-vault.js';
import { MountManager } from './mount-manager.js';
import { CacheManager } from './cache-manager.js';
import { OfflineManager } from './offline-manager.js';
import { TransferManager } from './transfer-manager.js';
import { ProviderService } from './provider-service.js';
import { DiagnosticsService, volumeStats } from './diagnostics-service.js';
import { AuthService } from './rclone/auth.js';
import { RcloneEngine } from './rclone/engine.js';
import type { Logger } from './logging.js';
import type { PlatformAdapter } from '../platform/types.js';
import type { SecretProtection } from './credential-vault.js';

/** A quota that could not be read — reported honestly instead of invented. */
function unavailableQuota(note: string): QuotaInfo {
  return {
    available: false,
    totalBytes: null,
    usedBytes: null,
    freeBytes: null,
    trashedBytes: null,
    otherBytes: null,
    note,
  };
}

export interface AppControllerOptions {
  paths: AppPaths;
  platform: PlatformAdapter;
  logger: Logger;
  secrets: SecretProtection;
  emit(event: BridgeEvent): void;
  appVersion: string;
  isPackaged: boolean;
  openExternal(url: string): Promise<boolean>;
  clock?(): Date;
  sleep?(ms: number): Promise<void>;
  /** Directory that may ship a bundled rclone binary. */
  resourcesDir?: string | null;
}

const QUOTA_TTL_MS = 30_000;
const LETTER_TTL_MS = 5_000;

/**
 * The single orchestration point behind the IPC handlers.
 *
 * It owns every service, produces the dashboard snapshot from real engine state
 * (never from optimistic assumptions) and publishes events when something
 * changes, so the UI cannot drift into a fake "connected" state.
 */
export class AppController {
  readonly config: ConfigService;
  readonly vault: CredentialVault;
  readonly engine: RcloneEngine;
  readonly providers: ProviderService;
  readonly mount: MountManager;
  readonly cache: CacheManager;
  readonly offline: OfflineManager;
  readonly transfers: TransferManager;
  readonly auth: AuthService;
  readonly diagnostics: DiagnosticsService;

  private quotaCache: { at: number; remoteId: string; value: QuotaInfo } | null = null;
  private letterCache: { at: number; value: DriveLetterInfo[] } | null = null;
  private lastConnectionError: AppError | undefined;
  private lastConnectedAt: string | null = null;
  private degraded = false;
  private started = false;

  constructor(private readonly options: AppControllerOptions) {
    const clock = options.clock ?? (() => new Date());
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

    this.config = new ConfigService(options.paths, options.logger.child('config'));
    this.vault = new CredentialVault(join(options.paths.dataDir, 'secrets'), options.secrets, options.logger.child('vault'));

    this.engine = new RcloneEngine(
      {
        configPath: options.paths.rcloneConfigPath,
        resourcesDir: options.resourcesDir ?? null,
        toolsDir: options.paths.binDir,
      },
      this.vault,
      options.logger.child('engine'),
    );

    this.providers = new ProviderService(this.engine, options.logger.child('provider'));
    this.mount = new MountManager({
      engine: this.engine,
      config: this.config,
      platform: options.platform,
      paths: options.paths,
      logger: options.logger.child('mount'),
      emit: options.emit,
      clock,
      sleep,
      requestSnapshotRefresh: () => this.publish(),
    });
    this.cache = new CacheManager({
      config: this.config,
      mount: this.mount,
      platform: options.platform,
      logger: options.logger.child('cache'),
    });
    this.transfers = new TransferManager({
      config: this.config,
      engine: this.engine,
      logger: options.logger.child('transfers'),
      emit: options.emit,
      clock,
      sleep,
      requestSnapshotRefresh: () => this.publish(),
      // `this.offline` is assigned just below; the callback only runs later.
      onOfflineCopyFinished: async (job: TransferJob) => {
        if (!job.remoteId) return;
        const entry = this.config
          .listOffline()
          .find((item) => item.remoteId === job.remoteId && item.localPath === job.dstUri);
        if (entry) await this.offline.onCopyFinished(entry.remoteId, entry.remotePath);
      },
      onOfflineCopyFailed: async (job: TransferJob) => {
        if (!job.remoteId) return;
        const entry = this.config
          .listOffline()
          .find((item) => item.remoteId === job.remoteId && item.localPath === job.dstUri);
        if (entry) {
          await this.offline.onCopyFailed({ remoteId: entry.remoteId, error: job.error });
          this.publish();
        }
      },
    });
    this.offline = new OfflineManager({
      config: this.config,
      providers: this.providers,
      transfers: this.transfers,
      platform: options.platform,
      logger: options.logger.child('offline'),
      clock,
    });
    this.auth = new AuthService({
      engine: this.engine,
      config: this.config,
      vault: this.vault,
      logger: options.logger.child('auth'),
      emit: options.emit,
      clock,
    });
    this.diagnostics = new DiagnosticsService({
      config: this.config,
      engine: this.engine,
      mount: this.mount,
      providers: this.providers,
      cache: this.cache,
      platform: options.platform,
      paths: options.paths,
      logger: options.logger.child('diagnostics'),
      appVersion: options.appVersion,
      environment: () => this.environment(),
    });
  }

  /* ------------------------------------------------------------ lifecycle */

  async initialize(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const dir of [this.options.paths.dataDir, this.options.paths.logDir, this.options.paths.rcloneDir]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    mkdirSync(this.config.get().cache.dir, { recursive: true, mode: 0o700 });
    mkdirSync(this.config.get().offline.dir, { recursive: true, mode: 0o700 });
    await this.options.platform.restrictDirectoryToUser(this.options.paths.dataDir);
    await this.options.platform.restrictDirectoryToUser(join(this.options.paths.dataDir, 'secrets'));

    const info = await this.engine.refresh().catch((error: Error) => {
      this.options.logger.error('Could not initialise the engine.', { error: error.message });
      return null;
    });
    this.options.logger.info('Application controller initialised.', {
      rclone: info?.version ?? null,
      available: info?.available ?? false,
    });

    const settings = this.config.get();
    if (settings.startup.autoMountOnStart || settings.startup.restoreLastMount) {
      const remote = this.config.getActiveRemote();
      if (remote) {
        void this.mountDrive(remote.id).catch((error: Error) => {
          this.options.logger.error('Automatic mount on start failed.', { error: error.message });
        });
      }
    }
    void this.offline.verifyAll().catch(() => undefined);
    this.publish();
  }

  async shutdown(): Promise<void> {
    await this.transfers.shutdown().catch(() => undefined);
    await this.mount.shutdown().catch(() => undefined);
    this.options.logger.info('Application controller stopped.');
  }

  /* --------------------------------------------------------------- snapshot */

  async snapshot(): Promise<AppSnapshot> {
    const settings = this.config.get();
    const remote = this.config.getActiveRemote();
    const mountState = this.mount.current;
    const cache = await this.cache.stats().catch(() => ({
      available: false,
      dir: settings.cache.dir,
      dirWritable: false,
      mode: settings.cache.mode,
      usedBytes: null,
      limitBytes: settings.cache.limitBytes,
      files: null,
      pendingUploads: 0,
      uploading: 0,
      inUse: 0,
      note: 'Cache statistics could not be read.',
    }));

    const [disk, quota, letters, offlineEntries] = await Promise.all([
      this.diskInfo(),
      this.quotaFor(remote),
      this.driveLetters(),
      Promise.resolve(this.offline.list()),
    ]);

    const transfers = this.transfers.list();
    const connection = this.connectionState({ remote, mountStatus: mountState.status });

    return {
      generatedAt: (this.options.clock ?? (() => new Date()))().toISOString(),
      status: {
        connection,
        mount: mountState.status,
        summary: this.statusSummary(connection, mountState.status, remote),
        detail: this.statusDetail(mountState.status, remote),
        lastConnectedAt: this.lastConnectedAt ?? remote?.lastConnectedAt ?? null,
        lastError: this.lastConnectionError ?? remote?.lastError ?? this.mount.lastError,
        blockedByDependency: (this.lastConnectionError ?? this.mount.lastError)?.code === ERROR_CODES.DEPENDENCY_MISSING,
      },
      remote,
      provider: remote ? getProvider(remote.providerId) : null,
      quota,
      disk,
      cache,
      offline: {
        enabled: settings.offline.enabled,
        entries: offlineEntries,
        totalBytes: this.offline.totalBytes(),
      },
      transfers: {
        running: transfers.running,
        queued: transfers.queued,
        history: transfers.history,
        speedBps: this.transfers.speedBps(),
      },
      engine: {
        rclonePath: this.engine.info.path,
        rcloneVersion: this.engine.info.version,
        rcloneAvailable: this.engine.available,
        expectedRclonePath: join(
          this.options.paths.binDir,
          this.options.platform.kind === 'win32' ? 'rclone.exe' : 'rclone',
        ),
        winfsp: await this.options.platform.detectWinFsp(),
        mountPid: mountState.pid,
        mountStartedAt: null,
        rcConnected: this.mount.rc !== null,
        restartCount: this.mount.restartCount(),
      },
      environment: this.environment(),
      settings,
      driveLetters: letters,
    };
  }

  environment(): EnvironmentInfo {
    const vaultInfo = this.vault.info;
    return {
      platform: process.platform,
      arch: process.arch,
      isWindows: process.platform === 'win32',
      osRelease: `${process.platform} ${process.arch}`,
      appVersion: this.options.appVersion,
      dataDir: this.options.paths.dataDir,
      logDir: this.options.paths.logDir,
      cacheDir: this.config.get().cache.dir,
      credentialBackend: vaultInfo.backend,
      credentialSecure: vaultInfo.secure,
      credentialWarning: vaultInfo.warning,
    };
  }

  private connectionState(input: { remote: RemoteConfig | null; mountStatus: string }): ConnectionState {
    const lastError = this.lastConnectionError ?? this.mount.lastError;
    if (!input.remote) return 'disconnected';
    // An active (re)mount attempt outranks the previous failure: reporting
    // "mount failed" while the supervisor is retrying would be a lie.
    if (input.mountStatus === 'mounting') {
      return this.mount.restartCount() > 0 ? 'reconnecting' : 'connecting';
    }
    if (lastError?.code === ERROR_CODES.AUTH_EXPIRED) return 'auth-expired';
    if (lastError?.code === ERROR_CODES.PROVIDER_UNAVAILABLE) return 'provider-unavailable';
    if (lastError?.code === ERROR_CODES.MOUNT_FAILED) return 'mount-failed';
    if (lastError?.code === ERROR_CODES.NETWORK) return 'offline';
    switch (input.mountStatus) {
      case 'mounting':
        return this.mount.restartCount() > 0 ? 'reconnecting' : 'connecting';
      case 'mounted':
        return this.degraded ? 'degraded' : 'connected';
      case 'unmounting':
        return 'disconnected';
      case 'stale':
        return 'mount-failed';
      case 'failed':
        return 'mount-failed';
      default:
        return 'disconnected';
    }
  }

  private statusSummary(connection: ConnectionState, mountStatus: string, remote: RemoteConfig | null): string {
    if (!remote) return 'No cloud account is connected yet.';
    switch (connection) {
      case 'connected':
        return `${remote.displayName} is mounted and available in File Explorer.`;
      case 'connecting':
        return `Mounting ${remote.displayName}…`;
      case 'reconnecting':
        return `Reconnecting ${remote.displayName}…`;
      case 'degraded':
        return `${remote.displayName} is mounted but responding slowly.`;
      case 'offline':
        return 'The internet connection or the cloud provider is unreachable.';
      case 'auth-expired':
        return 'The authorization for this account expired.';
      case 'provider-unavailable':
        return 'The provider is rate limiting or unavailable.';
      case 'mount-failed':
        return mountStatus === 'stale'
          ? 'The drive is mounted but no longer responding (stale).'
          : 'The drive could not be mounted.';
      default:
        return `${remote.displayName} is not mounted.`;
    }
  }

  private statusDetail(mountStatus: string, remote: RemoteConfig | null): string | undefined {
    if (!remote) return undefined;
    const target = this.mount.targetFor(remote) ?? remote.driveLetter ?? remote.mountPoint ?? undefined;
    return target ? `Remote ${remote.remoteName}:${remote.remoteRoot || '/'} → ${target} (${mountStatus})` : undefined;
  }

  private async diskInfo(): Promise<AppSnapshot['disk']> {
    const settings = this.config.get();
    const cacheVolume = await volumeStats(settings.cache.dir);
    const target = this.mount.current.target;
    const mountVolume = target ? await volumeStats(target) : { free: null, total: null };
    return {
      cacheDirFreeBytes: cacheVolume.free,
      cacheDirTotalBytes: cacheVolume.total,
      mountTargetFreeBytes: mountVolume.free,
    };
  }

  private async quotaFor(remote: RemoteConfig | null): Promise<QuotaInfo> {
    if (!remote) return unavailableQuota('No account selected.');
    if (this.quotaCache && this.quotaCache.remoteId === remote.id && Date.now() - this.quotaCache.at < QUOTA_TTL_MS) {
      return this.quotaCache.value;
    }
    const value = await this.providers.about(remote);
    this.quotaCache = { at: Date.now(), remoteId: remote.id, value };
    return value;
  }

  private async driveLetters(): Promise<DriveLetterInfo[]> {
    if (this.letterCache && Date.now() - this.letterCache.at < LETTER_TTL_MS) return this.letterCache.value;
    const value = await this.options.platform.listMountTargets();
    this.letterCache = { at: Date.now(), value };
    return value;
  }

  /* ------------------------------------------------------------ operations */

  listProviders(includeExperimental: boolean, includeTestTarget: boolean): ProviderDescriptor[] {
    return visibleProviders({ includeExperimental, includeTestTarget });
  }

  async mountDrive(remoteId?: string): Promise<{ pid: number | null; target: string }> {
    this.lastConnectionError = undefined;
    this.publish();
    try {
      const result = await this.mount.mount(remoteId);
      this.lastConnectedAt = (this.options.clock ?? (() => new Date()))().toISOString();
      this.publish();
      return result;
    } catch (error) {
      this.lastConnectionError = error as AppError;
      this.publish();
      throw error;
    }
  }

  async unmountDrive(options: { force?: boolean; id?: string } = {}): Promise<{ unmounted: boolean }> {
    const result = await this.mount.unmount({ force: options.force, reason: 'user request' });
    this.publish();
    return result;
  }

  async recoverMount(): Promise<{ recovered: boolean; detail: string }> {
    const result = await this.mount.recover();
    this.publish();
    return result;
  }

  /** Tests the provider connection and records the outcome honestly. */
  async testConnection(remoteId?: string): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
    const remote = remoteId ? this.config.getRemote(remoteId) : this.config.getActiveRemote();
    if (!remote) return { ok: false, detail: 'No account selected.', latencyMs: 0 };
    const result = await this.providers.testConnection(remote);
    this.lastConnectionError = result.ok ? undefined : result.error;
    if (result.ok) this.lastConnectedAt = (this.options.clock ?? (() => new Date()))().toISOString();
    this.config.updateRemote(remote.id, {
      lastError: result.ok ? undefined : result.error,
      lastConnectedAt: result.ok ? this.lastConnectedAt ?? undefined : undefined,
    });
    this.publish();
    return result;
  }

  async refreshQuota(remoteId?: string): Promise<QuotaInfo> {
    const remote = remoteId ? this.config.getRemote(remoteId) : this.config.getActiveRemote();
    if (!remote) return unavailableQuota('No account selected.');
    this.quotaCache = null;
    const value = (await this.providers.about(remote)) as QuotaInfo;
    this.quotaCache = { at: Date.now(), remoteId: remote.id, value };
    this.publish();
    return value;
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const before = this.config.get();
    const next = this.config.update(patch);

    if (patch.startup && typeof patch.startup.launchOnLogin === 'boolean') {
      await this.options.platform.setLaunchOnLogin(patch.startup.launchOnLogin, ['--start-minimized']);
    }
    if (patch.cache?.dir && patch.cache.dir !== before.cache.dir) {
      mkdirSync(patch.cache.dir, { recursive: true, mode: 0o700 });
      await this.options.platform.restrictDirectoryToUser(patch.cache.dir);
    }
    if (patch.offline?.dir && patch.offline.dir !== before.offline.dir) {
      mkdirSync(patch.offline.dir, { recursive: true, mode: 0o700 });
    }
    if (patch.transfers?.bandwidthLimit !== undefined) {
      const rc = this.mount.rc;
      if (rc) await rc.setBandwidth(patch.transfers.bandwidthLimit ?? 'off').catch(() => undefined);
    }
    this.publish();
    return next;
  }

  resetSettings(): AppSettings {
    const defaults = createDefaultSettings({
      dataDir: this.options.paths.dataDir,
      cacheDir: this.options.paths.cacheDir,
      homeDir: this.options.paths.homeDir,
      platform: process.platform,
    });
    const next = this.config.update({ ...defaults, remotes: this.config.get().remotes });
    this.publish();
    return next;
  }

  /** Creates the CloudSSD-side record of an account (after authorization). */
  async createRemote(input: {
    providerId: RemoteConfig['providerId'];
    remoteName: string;
    remoteRoot?: string;
    displayName?: string;
    driveLetter?: string | null;
    mountPoint?: string | null;
    authSessionId?: string;
  }): Promise<RemoteConfig> {
    const provider = getProvider(input.providerId);
    if (!provider) throw new Error(`Unknown provider "${input.providerId}".`);

    const id = randomUUID();
    const now = (this.options.clock ?? (() => new Date()))().toISOString();
    const remote: RemoteConfig = {
      id,
      providerId: provider.id,
      remoteName: input.remoteName,
      remoteRoot: input.remoteRoot ?? '',
      displayName: input.displayName ?? `${provider.name} (${input.remoteName})`,
      driveLetter: input.driveLetter ?? (this.options.platform.kind === 'win32' ? this.config.get().mount.defaultDriveLetter : null),
      mountPoint: input.mountPoint ?? null,
      createdAt: now,
      updatedAt: now,
      authState: 'ok',
      secretRef: `rclone:${input.remoteName}`,
      incomplete: false,
    };
    const created = this.config.addRemote(remote);
    this.config.setActiveRemote(created.id);
    this.publish();
    return created;
  }

  /** Removes the local configuration only — cloud files are never deleted. */
  async removeRemote(id: string): Promise<{ removed: boolean }> {
    const remote = this.config.getRemote(id);
    if (!remote) return { removed: false };
    if (this.mount.current.remoteId === id) {
      await this.mount.unmount({ reason: 'account removal' });
    }
    await this.auth.forget(remote).catch((error: Error) => {
      this.options.logger.warn('Could not delete the rclone remote entry.', { error: error.message });
    });
    await this.vault.delete(VAULT_KEYS.oauthClient(remote.remoteName));
    this.config.removeRemote(id);
    this.publish();
    return { removed: true };
  }

  async reconnectAccount(id: string): Promise<{ ok: boolean; detail: string; authUrl?: string }> {
    const remote = this.config.getRemote(id);
    if (!remote) return { ok: false, detail: 'Account not found.' };
    const result = await this.auth.reconnect(remote);
    this.config.updateRemote(id, {
      authState: result.ok ? 'ok' : 'expired',
      lastError: result.ok ? undefined : makeError(ERROR_CODES.AUTH_EXPIRED, result.detail),
    });
    this.publish();
    return result;
  }

  /** Refreshes the mounted view so remote changes are picked up. */
  async refreshRemoteView(): Promise<{ ok: boolean; detail: string }> {
    const rc = this.mount.rc;
    if (!rc) return { ok: false, detail: 'The drive is not mounted.' };
    try {
      await rc.forget();
      return { ok: true, detail: 'Directory cache cleared; remote changes will be visible on next access.' };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }

  async pinOffline(remoteId: string, remotePath: string): Promise<OfflineEntry> {
    const remote = this.config.getRemote(remoteId);
    if (!remote) throw new Error('Account not found.');
    const entry = await this.offline.pin(remote, remotePath);
    this.publish();
    return entry;
  }

  async openExternal(url: string): Promise<boolean> {
    return this.options.openExternal(url);
  }

  dependencyStatuses(): Promise<DependencyStatus[]> {
    return Promise.resolve([this.engine.dependencyStatus()]);
  }

  async publish(): Promise<void> {
    try {
      const snapshot = await this.snapshot();
      this.options.emit({ type: 'snapshot', snapshot });
    } catch (error) {
      this.options.logger.error('Could not build a snapshot.', { error: (error as Error).message });
    }
  }

  /** Free bytes on the volume that holds `path` (used by the dashboard). */
  async freeBytes(path: string): Promise<number | null> {
    try {
      const stats = await statfs(path);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      return null;
    }
  }
}
