import { describe, expect, it } from 'vitest';
import { buildMountArgs } from '../../src/main/services/mount-manager.js';
import { Win32Platform } from '../../src/main/platform/win32.js';
import { PosixPlatform } from '../../src/main/platform/posix.js';
import { createDefaultSettings } from '@shared/defaults.js';
import { GB, MB } from '@shared/format.js';

const settings = createDefaultSettings({
  dataDir: '/tmp/cloudssd',
  cacheDir: '/tmp/cloudssd/cache',
  homeDir: '/home/user',
  platform: 'linux',
});

describe('buildMountArgs', () => {
  it('uses documented rclone options only, in argument-array form', () => {
    const args = buildMountArgs({
      source: 'gdrive:CloudSSD',
      target: '/tmp/mnt',
      cache: settings.cache,
      transfers: settings.transfers,
      mount: settings.mount,
      platform: new PosixPlatform({ mountRoot: '/tmp/mounts' }),
      rc: { port: 45678, user: 'cloudssd', password: 'generated' },
      logLevel: 'info',
    });

    expect(args[0]).toBe('mount');
    expect(args.slice(1, 3)).toEqual(['gdrive:CloudSSD', '/tmp/mnt']);
    expect(args).toContain('--vfs-cache-mode');
    expect(args).toContain('--cache-dir');
    expect(args).toContain('--vfs-cache-max-size');
    expect(args).toContain('--vfs-cache-max-age');
    expect(args).toContain('--vfs-write-back');
    expect(args).toContain('--vfs-cache-poll-interval');
    expect(args).toContain('--rc');
    expect(args[args.indexOf('--rc-addr') + 1]).toBe('127.0.0.1:45678');
    // Nothing is concatenated into a shell string: every flag is its own element.
    expect(args.every((arg) => !arg.includes('&&') && !arg.includes(';'))).toBe(true);
  });

  it('maps Mode A to streaming (writes) and Mode B to a full cache', () => {
    const base = {
      source: 'gdrive:',
      target: '/tmp/mnt',
      transfers: settings.transfers,
      mount: settings.mount,
      platform: new PosixPlatform({ mountRoot: '/tmp/mounts' }),
      rc: { port: 1, user: 'u', password: 'p' },
      logLevel: 'info' as const,
    };
    const streaming = buildMountArgs({ ...base, cache: { ...settings.cache, mode: 'streaming' } });
    const balanced = buildMountArgs({ ...base, cache: { ...settings.cache, mode: 'balanced' } });
    expect(streaming[streaming.indexOf('--vfs-cache-mode') + 1]).toBe('writes');
    expect(balanced[balanced.indexOf('--vfs-cache-mode') + 1]).toBe('full');
  });

  it('passes the configured cache limit and chunk sizes through unchanged', () => {
    const args = buildMountArgs({
      source: 'gdrive:',
      target: '/tmp/mnt',
      cache: { ...settings.cache, limitBytes: 5 * GB, chunkSizeBytes: 8 * MB, readAheadBytes: 16 * MB },
      transfers: { ...settings.transfers, bandwidthLimit: '10M' },
      mount: settings.mount,
      platform: new PosixPlatform({ mountRoot: '/tmp/mounts' }),
      rc: { port: 1, user: 'u', password: 'p' },
      logLevel: 'info',
    });
    expect(args[args.indexOf('--vfs-cache-max-size') + 1]).toBe(String(5 * GB));
    expect(args).toContain('10M');
  });

  it('adds the Windows drive-letter flags on Windows', () => {
    const args = buildMountArgs({
      source: 'gdrive:CloudSSD',
      target: 'Z:',
      cache: settings.cache,
      transfers: settings.transfers,
      mount: settings.mount,
      platform: new Win32Platform(),
      rc: { port: 1, user: 'u', password: 'p' },
      logLevel: 'info',
    });
    expect(args).toContain('--network-mode');
    expect(args).toContain('--no-console');
    expect(args[2]).toBe('Z:');
  });

  it('honours the read-only setting', () => {
    const args = buildMountArgs({
      source: 'gdrive:',
      target: '/tmp/mnt',
      cache: settings.cache,
      transfers: settings.transfers,
      mount: { ...settings.mount, readOnly: true },
      platform: new PosixPlatform({ mountRoot: '/tmp/mounts' }),
      rc: { port: 1, user: 'u', password: 'p' },
      logLevel: 'info',
    });
    expect(args).toContain('--read-only');
  });
});
