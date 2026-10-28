import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '../../src/main/services/config-service.js';
import { MemoryLogger } from '../../src/main/services/logging.js';
import { resolvePaths } from '../../src/main/services/context.js';
import type { RemoteConfig } from '@shared/types.js';

let dir: string;
let service: ConfigService;

function remote(overrides: Partial<RemoteConfig> = {}): RemoteConfig {
  return {
    id: '9a2b4593-0b72-46d4-b899-6474b50e8951',
    providerId: 'gdrive',
    remoteName: 'gdrive',
    remoteRoot: 'CloudSSD',
    displayName: 'Google Drive',
    driveLetter: 'Z',
    mountPoint: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    authState: 'ok',
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloudssd-config-'));
  service = new ConfigService(resolvePaths({ dataDir: dir, homeDir: dir, platform: process.platform }), new MemoryLogger());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ConfigService', () => {
  it('creates defaults on first run and persists them with user-only permissions', () => {
    const settings = service.get();
    expect(settings.remotes).toEqual([]);
    expect(existsSync(join(dir, 'settings.json'))).toBe(true);
    const mode = statSync(join(dir, 'settings.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('recovers from a corrupted settings file and keeps a copy', () => {
    writeFileSync(join(dir, 'settings.json'), '{ this is not json');
    const recovered = new ConfigService(
      resolvePaths({ dataDir: dir, homeDir: dir, platform: process.platform }),
      new MemoryLogger(),
    );
    expect(recovered.get().remotes).toEqual([]);
    const backups = readdirSync(dir).filter((name: string) => name.includes('corrupt'));
    expect(backups.length).toBe(1);
  });

  it('stores remotes, rejects duplicates and drive letter clashes', () => {
    service.addRemote(remote());
    expect(() => service.addRemote(remote({ id: '2b2b4593-0b72-46d4-b899-6474b50e8951' }))).toThrow(/already exists/);
    expect(() =>
      service.addRemote(remote({ id: '3c2b4593-0b72-46d4-b899-6474b50e8951', remoteName: 'other', driveLetter: 'Z' })),
    ).toThrow(/already used/);
    expect(service.listRemotes()).toHaveLength(1);
  });

  it('keeps the offline index across instances and clears entries of a removed remote', () => {
    const created = service.addRemote(remote());
    service.upsertOffline({
      id: 'offline-1',
      remoteId: created.id,
      remotePath: 'docs/a.txt',
      isDir: false,
      localPath: '/tmp/offline/a.txt',
      state: 'available',
      sizeBytes: 10,
      mtime: null,
      hash: null,
      pinnedAt: new Date().toISOString(),
    });
    const reloaded = new ConfigService(
      resolvePaths({ dataDir: dir, homeDir: dir, platform: process.platform }),
      new MemoryLogger(),
    );
    expect(reloaded.listOffline()).toHaveLength(1);

    reloaded.removeRemote(created.id);
    // Only local metadata is removed; nothing in the cloud is touched by this API.
    expect(reloaded.listOffline()).toHaveLength(0);
  });

  it('validates patches and refuses invalid settings', () => {
    service.addRemote(remote());
    expect(() => service.update({ cache: { ...service.get().cache, limitBytes: 1 } })).toThrow(/Rejected invalid settings/);
    expect(() => service.updateRemote('9a2b4593-0b72-46d4-b899-6474b50e8951', { remoteRoot: '../escape' })).toThrow(
      /Rejected invalid remote/,
    );
  });

  it('never writes a secret into the settings file', () => {
    service.addRemote(remote({ secretRef: 'rclone:gdrive' }));
    const raw = readFileSync(join(dir, 'settings.json'), 'utf8');
    expect(raw).not.toMatch(/access_token|refresh_token|client_secret|"password"/i);
    expect(raw).toContain('rclone:gdrive');
  });

  it('purges local state on demand', () => {
    service.addRemote(remote());
    service.purgeLocalState();
    expect(existsSync(join(dir, 'settings.json'))).toBe(false);
  });
});
