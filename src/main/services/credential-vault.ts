import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeSecureFile } from './logging.js';
import type { Logger } from './logging.js';

export type CredentialBackend = 'safe-storage' | 'windows-credential-manager' | 'file-permissions-only' | 'unavailable';

/**
 * A protected place to keep secrets.
 *
 * On Windows this is Electron's `safeStorage`, which is backed by DPAPI
 * (CryptProtectData) and therefore encrypted with a per-user key. Anything that
 * cannot be encrypted is never written silently: the backend reports itself as
 * insecure and the diagnostics screen surfaces it.
 */
export interface SecretProtection {
  readonly backend: CredentialBackend;
  readonly secure: boolean;
  readonly warning?: string;
  encrypt(plain: string): Promise<string>;
  decrypt(blob: string): Promise<string>;
}

/** Electron's safeStorage (DPAPI on Windows, Keychain on macOS, libsecret on Linux). */
export class SafeStorageProtection implements SecretProtection {
  readonly backend: CredentialBackend = 'safe-storage';
  readonly secure: boolean;
  readonly warning?: string;

  constructor(
    private readonly safeStorage: {
      isEncryptionAvailable(): boolean;
      encryptString(value: string): Buffer;
      decryptString(value: Buffer): string;
    },
    private readonly logger?: Logger,
  ) {
    this.secure = safeStorage.isEncryptionAvailable();
    if (!this.secure) {
      this.warning =
        'OS key storage is unavailable in this session. Secrets are stored with restrictive file permissions only and are NOT encrypted.';
      logger?.warn(this.warning);
    }
  }

  async encrypt(plain: string): Promise<string> {
    if (!this.secure) {
      // Never pretend: the caller is told through `secure === false`.
      this.logger?.warn('Storing a secret without OS encryption (insecure backend).');
      return `plain:${plain}`;
    }
    return `dpapi:${this.safeStorage.encryptString(plain).toString('base64')}`;
  }

  async decrypt(blob: string): Promise<string> {
    if (blob.startsWith('plain:')) return blob.slice('plain:'.length);
    if (!blob.startsWith('dpapi:')) throw new Error('Unsupported secret encoding.');
    if (!this.secure) {
      throw new Error('Cannot decrypt OS-protected secret: encryption is unavailable in this session.');
    }
    const buffer = Buffer.from(blob.slice('dpapi:'.length), 'base64');
    return this.safeStorage.decryptString(buffer);
  }
}

/** Last-resort backend for headless CI: restrictive permissions, explicitly insecure. */
export class FilePermissionOnlyProtection implements SecretProtection {
  readonly backend: CredentialBackend = 'file-permissions-only';
  readonly secure = false;
  readonly warning =
    'Secrets are stored in a user-only file without encryption (headless/test mode). Never use this for real accounts.';

  async encrypt(plain: string): Promise<string> {
    return `plain:${plain}`;
  }
  async decrypt(blob: string): Promise<string> {
    return blob.startsWith('plain:') ? blob.slice('plain:'.length) : blob;
  }
}

export interface VaultEnvelope {
  version: 1;
  backend: CredentialBackend;
  entries: Record<string, string>;
}

/**
 * Encrypted key/value store for the rclone configuration password and optional
 * per-provider OAuth client secrets. The file itself is user-only (0600 / ACL).
 */
export class CredentialVault {
  private cache = new Map<string, string>();

  constructor(
    private readonly dir: string,
    private readonly protection: SecretProtection,
    private readonly logger: Logger,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private get file(): string {
    return join(this.dir, 'vault.json');
  }

  get info(): { backend: CredentialBackend; secure: boolean; warning?: string } {
    return { backend: this.protection.backend, secure: this.protection.secure, warning: this.protection.warning };
  }

  async get(key: string): Promise<string | null> {
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const envelope = await this.readEnvelope();
    const encoded = envelope?.entries[key];
    if (encoded === undefined) return null;
    try {
      const value = await this.protection.decrypt(encoded);
      this.cache.set(key, value);
      return value;
    } catch (error) {
      this.logger.error('Failed to decrypt a stored secret.', { key, error: (error as Error).message });
      throw error;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const envelope = (await this.readEnvelope()) ?? { version: 1 as const, backend: this.protection.backend, entries: {} };
    envelope.entries[key] = await this.protection.encrypt(value);
    envelope.backend = this.protection.backend;
    writeSecureFile(this.file, JSON.stringify(envelope, null, 2), 0o600);
    this.cache.set(key, value);
  }

  async delete(key: string): Promise<void> {
    const envelope = await this.readEnvelope();
    if (!envelope) return;
    delete envelope.entries[key];
    this.cache.delete(key);
    writeSecureFile(this.file, JSON.stringify(envelope, null, 2), 0o600);
  }

  /** Removes every stored secret (used by "remove account configuration"). */
  async clear(): Promise<void> {
    this.cache.clear();
    if (existsSync(this.file)) rmSync(this.file, { force: true });
  }

  keys(): string[] {
    return [...this.cache.keys()];
  }

  private async readEnvelope(): Promise<VaultEnvelope | null> {
    if (!existsSync(this.file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as VaultEnvelope;
      if (!parsed || typeof parsed !== 'object' || !parsed.entries) return null;
      return parsed;
    } catch (error) {
      this.logger.error('Credential vault is unreadable; refusing to continue with a corrupted store.', {
        error: (error as Error).message,
      });
      throw new Error('The credential vault could not be read. Restore it or reset CloudSSD settings.');
    }
  }
}

/** 32 random bytes, base64url — used as the rclone configuration password. */
export function generateMasterPassword(): string {
  return randomBytes(32).toString('base64url');
}

export const VAULT_KEYS = {
  rcloneConfigPass: 'rclone.config-pass',
  oauthClient: (remoteId: string) => `oauth-client.${remoteId}`,
  webdavPassword: (remoteId: string) => `webdav.password.${remoteId}`,
  s3Secret: (remoteId: string) => `s3.secret.${remoteId}`,
};
