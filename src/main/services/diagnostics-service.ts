import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { statfs } from 'node:fs/promises';
import type { AppError, DependencyStatus, DiagnosticCheck, DiagnosticsReport, RemoteConfig } from '../../shared/types.js';
import type { Logger } from './logging.js';
import type { AppPaths } from './context.js';
import type { ConfigService } from './config-service.js';
import type { RcloneEngine } from './rclone/engine.js';
import type { MountManager } from './mount-manager.js';
import type { ProviderService } from './provider-service.js';
import type { PlatformAdapter } from '../platform/types.js';
import type { CacheManager } from './cache-manager.js';

export interface DiagnosticsDeps {
  config: ConfigService;
  engine: RcloneEngine;
  mount: MountManager;
  providers: ProviderService;
  cache: CacheManager;
  platform: PlatformAdapter;
  paths: AppPaths;
  logger: Logger;
  appVersion: string;
  environment: () => DiagnosticsReport['environment'];
}

/**
 * Builds the diagnostics report shown on the Diagnostics screen and used for
 * the "export diagnostics" action.
 *
 * The report is non-secret by construction: it contains versions, paths,
 * sanitized engine messages and pass/warn/fail verdicts — never tokens,
 * passwords or file contents.
 */
export class DiagnosticsService {
  constructor(private readonly deps: DiagnosticsDeps) {}

  dependencies(): DependencyStatus[] {
    return [this.deps.engine.dependencyStatus()];
  }

  async run(): Promise<DiagnosticsReport> {
    const settings = this.deps.config.get();
    const remote = this.deps.config.getActiveRemote();
    const checks: DiagnosticCheck[] = [];

    /* rclone ------------------------------------------------------------ */
    const rclone = this.deps.engine.dependencyStatus();
    checks.push({
      id: 'engine-rclone',
      label: 'Cloud engine (rclone)',
      status: rclone.installed ? 'pass' : 'fail',
      detail: rclone.message,
      remediation: rclone.remediation,
    });

    /* WinFsp ------------------------------------------------------------ */
    const winfsp = await this.deps.platform.detectWinFsp();
    if (winfsp.required) {
      checks.push({
        id: 'engine-winfsp',
        label: 'Windows filesystem driver (WinFsp)',
        status: winfsp.installed ? 'pass' : 'fail',
        detail: `${winfsp.message}${winfsp.version ? ` Version ${winfsp.version}.` : ''}`,
        remediation: winfsp.remediation,
      });
    }

    /* encrypted configuration ------------------------------------------- */
    const configExists = this.deps.engine.config.exists();
    const encrypted = this.deps.engine.config.isEncrypted();
    checks.push({
      id: 'config-encryption',
      label: 'Credential storage',
      status: !configExists ? 'unknown' : encrypted ? 'pass' : 'fail',
      detail: !configExists
        ? 'No rclone configuration file exists yet (no account connected).'
        : encrypted
          ? 'The rclone configuration file is encrypted with a password held in the OS protected store.'
          : 'The rclone configuration file is NOT encrypted. Do not store an account until this is fixed.',
      remediation: encrypted ? undefined : 'Restart CloudSSD so the configuration can be encrypted, or remove and re-add the account.',
    });

    /* credential backend ------------------------------------------------ */
    const environment = this.deps.environment();
    checks.push({
      id: 'credential-backend',
      label: 'Credential protection backend',
      status: environment.credentialSecure ? 'pass' : 'warn',
      detail: `Backend: ${environment.credentialBackend}. ${environment.credentialWarning ?? ''}`.trim(),
      remediation: environment.credentialSecure
        ? undefined
        : 'Run CloudSSD on Windows with a user session so DPAPI protected storage is available.',
    });

    /* cache directory --------------------------------------------------- */
    const cacheStats = await this.deps.cache.stats();
    const cacheFree = await this.deps.cache.freeBytes(cacheStats.dir);
    checks.push({
      id: 'cache-directory',
      label: 'Cache directory',
      status: cacheStats.dirWritable ? 'pass' : 'fail',
      detail: cacheStats.dirWritable
        ? `${cacheStats.dir} is writable${cacheFree !== null ? ` (${Math.round(cacheFree / 1024 ** 3)} GB free)` : ''}. Configured limit: ${Math.round(cacheStats.limitBytes / 1024 ** 3)} GB.`
        : `${cacheStats.dir} is not writable.`,
      remediation: cacheStats.dirWritable ? undefined : 'Choose a different cache directory in Settings → Cache.',
    });
    if (cacheFree !== null && cacheFree < cacheStats.limitBytes) {
      checks.push({
        id: 'cache-headroom',
        label: 'Cache headroom',
        status: 'warn',
        detail: `The cache limit (${Math.round(cacheStats.limitBytes / 1024 ** 3)} GB) is larger than the free space on the cache volume (${Math.round(cacheFree / 1024 ** 3)} GB).`,
        remediation: 'Lower the cache limit or move the cache to a volume with more space.',
      });
    }

    /* mount target ------------------------------------------------------ */
    if (remote) {
      const target = this.deps.mount.targetFor(remote);
      if (!target) {
        checks.push({
          id: 'mount-target',
          label: 'Drive target',
          status: 'warn',
          detail: 'This account has no drive letter configured.',
          remediation: 'Pick a free drive letter in Settings → Drive.',
        });
      } else {
        const inUse = await this.deps.platform.isMountTargetInUse(target);
        const mounted = this.deps.mount.current.status === 'mounted' && this.deps.mount.current.target === target;
        checks.push({
          id: 'mount-target',
          label: 'Drive target availability',
          status: mounted ? 'pass' : inUse ? 'warn' : 'pass',
          detail: mounted
            ? `${target} is mounted and owned by CloudSSD.`
            : inUse
              ? `${target} is in use by something else.`
              : `${target} is free.`,
          remediation: inUse && !mounted ? 'Choose another drive letter, or use Recover if the drive belongs to a crashed session.' : undefined,
        });
      }

      /* remote configuration + authorization --------------------------- */
      const configured = await this.deps.engine.config.hasRemote(remote.remoteName).catch(() => false);
      checks.push({
        id: 'remote-configured',
        label: 'Cloud account configuration',
        status: configured ? 'pass' : 'fail',
        detail: configured
          ? `rclone remote "${remote.remoteName}" exists (type ${(await this.deps.engine.config.getType(remote.remoteName).catch(() => null)) ?? 'unknown'}).`
          : `The rclone remote "${remote.remoteName}" is missing.`,
        remediation: configured ? undefined : 'Remove the account in CloudSSD and connect it again.',
      });

      if (configured) {
        const test = await this.deps.providers.testConnection(remote);
        checks.push({
          id: 'remote-reachable',
          label: 'Cloud provider connectivity',
          status: test.ok ? 'pass' : 'fail',
          detail: test.detail,
          remediation: test.error?.remediation,
        });
      }
    } else {
      checks.push({
        id: 'remote-configured',
        label: 'Cloud account configuration',
        status: 'unknown',
        detail: 'No cloud account is configured yet.',
        remediation: 'Run the connection wizard to add an account.',
      });
    }

    /* mount health ------------------------------------------------------ */
    const mountState = this.deps.mount.current;
    checks.push({
      id: 'mount-health',
      label: 'Mount manager',
      status: mountState.status === 'mounted' ? 'pass' : mountState.status === 'failed' || mountState.status === 'stale' ? 'fail' : 'unknown',
      detail:
        mountState.status === 'mounted'
          ? `Mounted at ${mountState.target} (rclone pid ${mountState.pid ?? 'unknown'}).`
          : `Status: ${mountState.status}.`,
      remediation:
        mountState.status === 'stale'
          ? 'Use Recover to release the stale drive and mount it again.'
          : mountState.status === 'failed'
            ? 'Press Mount to retry. The sanitized engine log below shows why it failed.'
            : undefined,
    });

    /* log hygiene ------------------------------------------------------- */
    const logBytes = this.logDirectorySize();
    checks.push({
      id: 'log-retention',
      label: 'Diagnostics log size',
      status: logBytes > this.deps.config.get().diagnostics.maxLogBytes * 3 ? 'warn' : 'pass',
      detail: `Logs use ${(logBytes / 1024 ** 2).toFixed(1)} MB (retention ${settings.diagnostics.retentionDays} days).`,
      remediation: 'Lower the retention in Settings → Advanced, or delete the log directory while CloudSSD is closed.',
    });

    const recentErrors = this.recentErrors();

    return {
      generatedAt: new Date().toISOString(),
      appVersion: this.deps.appVersion,
      environment: this.deps.environment(),
      engine: {
        rclonePath: this.deps.engine.info.path,
        rcloneVersion: this.deps.engine.info.version,
        rcloneAvailable: this.deps.engine.available,
        expectedRclonePath: join(this.deps.paths.binDir, this.deps.platform.kind === 'win32' ? 'rclone.exe' : 'rclone'),
        winfsp,
        mountPid: mountState.pid,
        mountStartedAt: null,
        rcConnected: this.deps.mount.rc !== null,
        restartCount: this.deps.mount.restartCount(),
      },
      dependencies: [rclone, winfsp],
      checks,
      recentErrors,
      redactionApplied: true,
    };
  }

  private recentErrors(): AppError[] {
    return this.deps.logger
      .recent(300)
      .filter((entry) => entry.level === 'error' || entry.level === 'warn')
      .slice(-20)
      .map((entry) => ({
        code: 'engine_error',
        message: entry.message,
        details: entry.meta ? JSON.stringify(entry.meta) : undefined,
        recoverable: true,
        at: entry.ts,
      }));
  }

  private logDirectorySize(): number {
    const dir = this.deps.paths.logDir;
    if (!existsSync(dir)) return 0;
    try {
      return readdirSync(dir).reduce((total, name) => {
        try {
          return total + statSync(join(dir, name)).size;
        } catch {
          return total;
        }
      }, 0);
    } catch {
      return 0;
    }
  }
}

/** Free/total bytes for a volume (used by the dashboard). */
export async function volumeStats(path: string): Promise<{ free: number | null; total: number | null }> {
  try {
    const stats = await statfs(path);
    return { free: Number(stats.bavail) * Number(stats.bsize), total: Number(stats.blocks) * Number(stats.bsize) };
  } catch {
    return { free: null, total: null };
  }
}

export function remoteLabel(remote: RemoteConfig | null): string {
  return remote ? `${remote.displayName} (${remote.remoteName}:${remote.remoteRoot || '/'})` : 'No account selected';
}
