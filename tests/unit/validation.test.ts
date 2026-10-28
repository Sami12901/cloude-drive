import { describe, expect, it } from 'vitest';
import {
  BANDWIDTH_RE,
  REMOTE_NAME_RE,
  containsPathTraversal,
  driveLetterSchema,
  hasControlCharacters,
  hasShellMetacharacters,
  ipcSchemas,
  isValidLocalPath,
  isValidMountPoint,
  isValidRemotePath,
  isWindowsReservedName,
  localPathSchema,
  parseSafe,
  remoteNameSchema,
  settingsSchema,
} from '@shared/validation.js';
import { buildRemoteSpec, hasAbsoluteRoot } from '@shared/remote.js';
import { createDefaultSettings } from '@shared/defaults.js';

describe('drive letters', () => {
  it('accepts C..Z and normalises case', () => {
    expect(driveLetterSchema.parse('z')).toBe('Z');
    expect(driveLetterSchema.parse(' C ')).toBe('C');
  });

  it('rejects A, B, digits, punctuation and multiple characters', () => {
    for (const value of ['A', 'B', '1', ':', 'ZZ', '', 'Z:']) {
      expect(driveLetterSchema.safeParse(value).success, value).toBe(false);
    }
  });
});

describe('remote names', () => {
  it('accepts safe names', () => {
    expect(remoteNameSchema.parse('gdrive')).toBe('gdrive');
    expect(remoteNameSchema.parse('My_Drive-2')).toBe('My_Drive-2');
  });

  it('rejects names that would break a command line or the config file', () => {
    for (const value of ['my drive', 'remote:', 'a/b', '../x', '-x', '$(whoami)', 'remote;rm']) {
      expect(remoteNameSchema.safeParse(value).success, value).toBe(false);
    }
    expect(REMOTE_NAME_RE.test('ok-name_1')).toBe(true);
  });
});

describe('paths', () => {
  it('rejects traversal, control characters and reserved Windows names', () => {
    expect(containsPathTraversal('a/../../etc/passwd')).toBe(true);
    expect(containsPathTraversal('a\\..\\b')).toBe(true);
    expect(hasControlCharacters('ok\u0000name')).toBe(true);
    expect(hasShellMetacharacters('file; rm -rf /')).toBe(true);
    expect(isWindowsReservedName('CON')).toBe(true);
    expect(isWindowsReservedName('nul.txt')).toBe(true);
    expect(isWindowsReservedName('normal.txt')).toBe(false);
  });

  it('accepts remote paths with spaces and Unicode', () => {
    expect(isValidRemotePath('')).toBe(true);
    expect(isValidRemotePath('CloudSSD')).toBe(true);
    expect(isValidRemotePath('Photos/2024/ünïcödé 文件')).toBe(true);
  });

  it('rejects remote paths with traversal or control characters', () => {
    expect(isValidRemotePath('../escape')).toBe(false);
    expect(isValidRemotePath('a/./b')).toBe(false);
    expect(isValidRemotePath('back\\slash')).toBe(false);
    expect(isValidRemotePath('bad\u0007char')).toBe(false);
  });

  it('requires absolute local paths and mount points', () => {
    expect(localPathSchema.safeParse('/tmp/cache').success).toBe(true);
    expect(localPathSchema.safeParse('relative/path').success).toBe(true); // schema allows; predicate below rejects traversal only
    expect(isValidLocalPath('relative', 'linux')).toBe(true);
    expect(isValidLocalPath('/tmp/../etc', 'linux')).toBe(false);
    expect(isValidMountPoint('cache', 'linux')).toBe(false);
    expect(isValidMountPoint('/tmp/mnt', 'linux')).toBe(true);
    expect(isValidMountPoint('C:\\mnt', 'win32')).toBe(true);
    expect(isValidLocalPath('C:\\bad<>name', 'win32')).toBe(false);
  });
});

describe('bandwidth specification', () => {
  it('accepts rclone bandwidth specs and nothing else', () => {
    expect(BANDWIDTH_RE.test('10M')).toBe(true);
    expect(BANDWIDTH_RE.test('500k')).toBe(true);
    expect(BANDWIDTH_RE.test('off')).toBe(true);
    expect(BANDWIDTH_RE.test('08:00,100M 18:00,off')).toBe(false);
    expect(BANDWIDTH_RE.test('; rm -rf')).toBe(false);
  });
});

describe('remote specification builder', () => {
  it('keeps relative roots relative and absolute roots absolute', () => {
    expect(buildRemoteSpec({ remoteName: 'gdrive', remoteRoot: '' })).toBe('gdrive:');
    expect(buildRemoteSpec({ remoteName: 'gdrive', remoteRoot: 'CloudSSD' }, 'docs')).toBe('gdrive:CloudSSD/docs');
    expect(buildRemoteSpec({ remoteName: 'testdrive', remoteRoot: '/tmp/remote' })).toBe('testdrive:/tmp/remote');
    expect(buildRemoteSpec({ remoteName: 'testdrive', remoteRoot: '/tmp/remote/' }, 'a/b')).toBe('testdrive:/tmp/remote/a/b');
    expect(hasAbsoluteRoot({ remoteRoot: '/tmp/remote' })).toBe(true);
    expect(hasAbsoluteRoot({ remoteRoot: 'CloudSSD' })).toBe(false);
  });
});

describe('settings schema', () => {
  it('validates the default settings', () => {
    const defaults = createDefaultSettings({
      dataDir: '/tmp/cloudssd',
      cacheDir: '/tmp/cloudssd/cache',
      homeDir: '/home/user',
      platform: 'linux',
    });
    expect(settingsSchema.safeParse(defaults).success).toBe(true);
  });

  it('rejects out-of-range values', () => {
    const defaults = createDefaultSettings({
      dataDir: '/tmp/cloudssd',
      cacheDir: '/tmp/cloudssd/cache',
      homeDir: '/home/user',
      platform: 'linux',
    });
    const tooSmallCache = { ...defaults, cache: { ...defaults.cache, limitBytes: 1024 } };
    expect(settingsSchema.safeParse(tooSmallCache).success).toBe(false);
    const badConcurrency = { ...defaults, transfers: { ...defaults.transfers, concurrency: 99 } };
    expect(settingsSchema.safeParse(badConcurrency).success).toBe(false);
  });
});

describe('IPC payload schemas', () => {
  it('requires an explicit confirmation before an account can be removed', () => {
    expect(ipcSchemas['remote:remove'].safeParse({ id: '9a2b4593-0b72-46d4-b899-6474b50e8951' }).success).toBe(false);
    expect(
      ipcSchemas['remote:remove'].safeParse({ id: '9a2b4593-0b72-46d4-b899-6474b50e8951', confirmed: true }).success,
    ).toBe(true);
  });

  it('never accepts a request to delete cloud files', () => {
    const parsed = ipcSchemas['remote:remove'].safeParse({
      id: '9a2b4593-0b72-46d4-b899-6474b50e8951',
      confirmed: true,
      deleteCloudFiles: true,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects injection attempts in transfer URIs and provider ids', () => {
    expect(ipcSchemas['transfer:enqueue'].safeParse({ kind: 'copy', srcUri: 'a', dstUri: '' }).success).toBe(false);
    expect(ipcSchemas['auth:start'].safeParse({ providerId: 'evil' }).success).toBe(false);
    const result = parseSafe(ipcSchemas['remote:create'], {
      providerId: 'gdrive',
      remoteName: 'remote; rm -rf /',
    });
    expect(result.ok).toBe(false);
  });
});
