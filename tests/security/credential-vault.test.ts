import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CredentialVault,
  FilePermissionOnlyProtection,
  SafeStorageProtection,
  generateMasterPassword,
} from '../../src/main/services/credential-vault.js';
import { MemoryLogger } from '../../src/main/services/logging.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloudssd-vault-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Minimal stand-in for Electron's safeStorage (DPAPI on Windows). */
function fakeSafeStorage(available: boolean) {
  return {
    isEncryptionAvailable: () => available,
    // Not real encryption — the tests only assert the storage contract.
    encryptString: (value: string) => Buffer.from(`enc(${value})`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^enc\(/, '').replace(/\)$/, ''),
  };
}

describe('SecretProtection', () => {
  it('reports a secure backend and round-trips secrets when DPAPI is available', async () => {
    const protection = new SafeStorageProtection(fakeSafeStorage(true));
    expect(protection.secure).toBe(true);
    expect(protection.backend).toBe('safe-storage');
    const blob = await protection.encrypt('master-password');
    expect(blob.startsWith('dpapi:')).toBe(true);
    expect(await protection.decrypt(blob)).toBe('master-password');
  });

  it('never silently degrades: reports the insecure backend and refuses foreign blobs', async () => {
    const logs = new MemoryLogger('vault');
    const insecure = new SafeStorageProtection(fakeSafeStorage(false), logs);
    expect(insecure.secure).toBe(false);
    expect(insecure.warning).toMatch(/NOT encrypted/i);
    expect(logs.entries.some((entry) => entry.level === 'warn')).toBe(true);

    const secure = new SafeStorageProtection(fakeSafeStorage(true));
    const blob = await secure.encrypt('value');
    await expect(insecure.decrypt(blob)).rejects.toThrow(/encryption is unavailable/);
  });

  it('marks the file-permission backend as insecure', () => {
    const protection = new FilePermissionOnlyProtection();
    expect(protection.secure).toBe(false);
    expect(protection.backend).toBe('file-permissions-only');
  });
});

describe('CredentialVault', () => {
  it('stores, reads and deletes secrets', async () => {
    const vault = new CredentialVault(dir, new SafeStorageProtection(fakeSafeStorage(true)), new MemoryLogger('vault'));
    await vault.set('rclone.config-pass', 'secret-value');
    expect(await vault.get('rclone.config-pass')).toBe('secret-value');
    await vault.delete('rclone.config-pass');
    expect(await vault.get('rclone.config-pass')).toBeNull();
  });

  it('writes the vault with user-only permissions and never in clear text', async () => {
    const vault = new CredentialVault(dir, new SafeStorageProtection(fakeSafeStorage(true)), new MemoryLogger('vault'));
    await vault.set('rclone.config-pass', 'super-secret-password');
    const file = join(dir, 'vault.json');
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).not.toContain('super-secret-password');
  });

  it('removes every secret on clear()', async () => {
    const vault = new CredentialVault(dir, new SafeStorageProtection(fakeSafeStorage(true)), new MemoryLogger('vault'));
    await vault.set('a', '1');
    await vault.set('b', '2');
    await vault.clear();
    expect(existsSync(join(dir, 'vault.json'))).toBe(false);
    expect(vault.keys()).toHaveLength(0);
  });

  it('surfaces a corrupted vault instead of ignoring it', async () => {
    const vault = new CredentialVault(dir, new SafeStorageProtection(fakeSafeStorage(true)), new MemoryLogger('vault'));
    await vault.set('a', '1');
    const file = join(dir, 'vault.json');
    writeBroken(file);
    const reopened = new CredentialVault(dir, new SafeStorageProtection(fakeSafeStorage(true)), new MemoryLogger('vault'));
    await expect(reopened.get('a')).rejects.toThrow(/could not be read/i);
  });

  it('generates a strong configuration password (32 random bytes)', () => {
    const first = generateMasterPassword();
    const second = generateMasterPassword();
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(43);
  });
});

function writeBroken(path: string): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { writeFileSync } = require('node:fs') as typeof import('node:fs');
  writeFileSync(path, '{{{ not json');
}
