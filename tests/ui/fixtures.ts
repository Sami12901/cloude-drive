import { vi } from 'vitest';
import type { AppSnapshot, RemoteConfig } from '@shared/types.js';
import { createDefaultSettings } from '@shared/defaults.js';
import type { CloudSsdApi } from '@shared/ipc.js';

/**
 * UI fixtures.
 *
 * Snapshots are built from the same `createDefaultSettings()` the main process
 * uses, so a rendered screen cannot pass on data the app never produces.
 */

export const paths = {
  dataDir: '/home/tester/AppData/Local/CloudSSD',
  cacheDir: '/home/tester/AppData/Local/CloudSSD/cache',
  homeDir: '/home/tester',
  platform: 'win32',
};

export function makeRemote(overrides: Partial<RemoteConfig> = {}): RemoteConfig {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    providerId: 'gdrive',
    remoteName: 'gdrive',
    remoteRoot: '',
    displayName: 'Test Drive',
    driveLetter: 'Z',
    mountPoint: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    authState: 'ok',
    secretRef: 'rclone:gdrive',
    incomplete: false,
    ...overrides,
  };
}

export function makeSnapshot(overrides: Partial<AppSnapshot> = {}): AppSnapshot {
  const settings = createDefaultSettings(paths);
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    status: {
      connection: 'disconnected',
      mount: 'unmounted',
      summary: 'No cloud account is connected yet.',
    },
    remote: null,
    provider: null,
    quota: {
      available: false,
      totalBytes: null,
      usedBytes: null,
      freeBytes: null,
      trashedBytes: null,
      otherBytes: null,
    },
    disk: { cacheDirFreeBytes: 512 * 1024 * 1024 * 1024, cacheDirTotalBytes: 1024 * 1024 * 1024 * 1024, mountTargetFreeBytes: null },
    cache: {
      available: true,
      dir: paths.cacheDir,
      dirWritable: true,
      mode: 'balanced',
      usedBytes: 0,
      limitBytes: settings.cache.limitBytes,
      files: 0,
      pendingUploads: 0,
      uploading: 0,
      inUse: 0,
    },
    offline: { enabled: true, entries: [], totalBytes: 0 },
    transfers: { running: [], queued: [], history: [], speedBps: null },
    engine: {
      rcloneVersion: '1.75.2',
      rcloneAvailable: true,
      rclonePath: 'C:\\Program Files\\CloudSSD\\rclone.exe',
      expectedRclonePath: 'C:\\Program Files\\CloudSSD\\rclone.exe',
      winfsp: { id: 'winfsp', required: true, installed: true, version: '2.0', message: 'WinFsp is installed.' },
      mountPid: null,
      mountStartedAt: null,
      rcConnected: false,
      restartCount: 0,
    },
    environment: {
      platform: 'win32',
      arch: 'x64',
      isWindows: true,
      osRelease: 'win32 x64',
      appVersion: '1.0.0',
      dataDir: paths.dataDir,
      logDir: `${paths.dataDir}\\logs`,
      cacheDir: paths.cacheDir,
      credentialBackend: 'windows-credential-manager',
      credentialSecure: true,
    },
    settings,
    driveLetters: [
      { letter: 'Z', label: 'Z: (free)', inUse: false, type: 'unknown', free: true },
      { letter: 'C', label: 'C: (in use)', inUse: true, type: 'fixed', free: false },
    ],
    ...overrides,
  } as AppSnapshot;
}

/** A fake bridge that records calls, so UI actions can be asserted on. */
export function makeApi(overrides: Partial<CloudSsdApi> = {}): CloudSsdApi {
  const call = vi.fn(async () => ({ ok: true, value: {} }) as never);
  return new Proxy({} as CloudSsdApi, {
    get(_target, property) {
      if (property === 'onEvent') return () => () => undefined;
      if (property in overrides) return overrides[property as keyof CloudSsdApi];
      return call;
    },
  });
}
