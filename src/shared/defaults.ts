import type { AppSettings, CacheSettings, OfflineSettings } from './types.js';
import { GB, MB } from './format.js';

export const SETTINGS_SCHEMA_VERSION = 1;

export const APP_ID = 'CloudSSD';

/** Minimum rclone version known to support every option CloudSSD uses. */
export const MIN_RCLONE_VERSION = '1.62.0';

/** rclone release CloudSSD is validated against (see docs/provider-limitations.md). */
export const VALIDATED_RCLONE_VERSION = '1.69.1';

export const DEFAULT_CACHE_LIMIT_BYTES = 20 * GB;
export const MIN_CACHE_LIMIT_BYTES = 256 * MB;

export const DEFAULT_CHUNK_SIZE_BYTES = 32 * MB;
export const DEFAULT_READ_AHEAD_BYTES = 64 * MB;
export const DEFAULT_MAX_AGE_SECONDS = 24 * 3600;
export const DEFAULT_WRITE_BACK_SECONDS = 15;
export const DEFAULT_CACHE_CLEANUP_INTERVAL_SECONDS = 60;

export interface PlatformPaths {
  dataDir: string;
  cacheDir: string;
  homeDir: string;
  platform: string;
}

export function defaultCacheSettings(paths: PlatformPaths): CacheSettings {
  return {
    mode: 'balanced',
    dir: paths.cacheDir,
    limitBytes: DEFAULT_CACHE_LIMIT_BYTES,
    maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS,
    chunkSizeBytes: DEFAULT_CHUNK_SIZE_BYTES,
    readAheadBytes: DEFAULT_READ_AHEAD_BYTES,
    writeBackSeconds: DEFAULT_WRITE_BACK_SECONDS,
    cleanupIntervalSeconds: DEFAULT_CACHE_CLEANUP_INTERVAL_SECONDS,
    minFreeSpaceBytes: null,
  };
}

export function defaultOfflineSettings(paths: PlatformPaths): OfflineSettings {
  return {
    enabled: true,
    dir: paths.platform === 'win32' ? `${paths.homeDir}\\CloudSSD Offline` : `${paths.homeDir}/CloudSSD-Offline`,
  };
}

export function createDefaultSettings(paths: PlatformPaths): AppSettings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    remotes: [],
    activeRemoteId: null,
    cache: defaultCacheSettings(paths),
    offline: defaultOfflineSettings(paths),
    transfers: {
      concurrency: 4,
      retries: 3,
      backoffBaseMs: 1000,
      maxBackoffMs: 60000,
      bandwidthLimit: null,
    },
    startup: {
      launchOnLogin: false,
      autoMountOnStart: false,
      restoreLastMount: false,
      startMinimizedToTray: false,
      minimizeToTrayOnClose: false,
    },
    mount: {
      autoReconnect: true,
      maxReconnectAttempts: 5,
      reconnectBackoffMs: 4000,
      healthCheckIntervalMs: 10000,
      defaultDriveLetter: 'Z',
      readOnly: false,
      allowOther: false,
    },
    notifications: {
      enabled: true,
      mountEvents: true,
      transferCompletion: true,
      errors: true,
    },
    ui: {
      theme: 'dark',
      language: 'en',
      density: 'comfortable',
    },
    diagnostics: {
      logLevel: 'info',
      retentionDays: 14,
      maxLogBytes: 16 * MB,
    },
  };
}

/** Deep merge used for settings patches (arrays and scalars are replaced). */
export function mergeSettings(base: AppSettings, patch: Partial<AppSettings>): AppSettings {
  return {
    ...base,
    ...patch,
    cache: patch.cache ? { ...base.cache, ...patch.cache } : base.cache,
    offline: patch.offline ? { ...base.offline, ...patch.offline } : base.offline,
    transfers: patch.transfers ? { ...base.transfers, ...patch.transfers } : base.transfers,
    startup: patch.startup ? { ...base.startup, ...patch.startup } : base.startup,
    mount: patch.mount ? { ...base.mount, ...patch.mount } : base.mount,
    notifications: patch.notifications ? { ...base.notifications, ...patch.notifications } : base.notifications,
    ui: patch.ui ? { ...base.ui, ...patch.ui } : base.ui,
    diagnostics: patch.diagnostics ? { ...base.diagnostics, ...patch.diagnostics } : base.diagnostics,
  };
}
