import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Logger } from '../logging.js';
import type { RcloneCli } from './cli.js';

export interface RemoteSummary {
  name: string;
  type: string;
}

export interface RcloneConfigStoreOptions {
  configPath: string;
  logger: Logger;
  getCli: () => Promise<RcloneCli>;
  getPassword: () => Promise<string | null>;
  /** Injected in tests to create the password deterministically. */
  generatePassword?: () => string;
}

/**
 * Manages the rclone configuration file.
 *
 * The file is always kept in rclone's own encrypted format (AES, scrypt N=16384
 * with the configuration password). CloudSSD generates that password once,
 * stores it in the OS protected vault, and passes it via `RCLONE_CONFIG_PASS`.
 * If encryption cannot be enabled — for example because a configuration password
 * is unavailable — the store refuses to continue instead of writing OAuth tokens
 * in clear text.
 */
export class RcloneConfigStore {
  private encryptionEnsured = false;

  constructor(private readonly options: RcloneConfigStoreOptions) {}

  get path(): string {
    return this.options.configPath;
  }

  exists(): boolean {
    return existsSync(this.options.configPath);
  }

  isEncrypted(): boolean {
    if (!this.exists()) return false;
    try {
      return readFileSync(this.options.configPath, 'utf8').includes('# Encrypted rclone configuration File');
    } catch {
      return false;
    }
  }

  /**
   * Makes sure an encrypted configuration file exists. Safe to call repeatedly.
   * Returns the password in use so the caller can pass it to child processes.
   */
  async ensureEncryptedConfiguration(): Promise<{ password: string; created: boolean }> {
    mkdirSync(dirname(this.options.configPath), { recursive: true, mode: 0o700 });
    const cli = await this.options.getCli();
    let password = await this.options.getPassword();

    if (!password) {
      password = (this.options.generatePassword ?? generatePassword)();
      // Written before the file is encrypted so a crash cannot leave a config
      // encrypted with a password we never stored.
      this.options.logger.info('Created a new rclone configuration password.');
      await this.encryptConfiguration(cli, password);
      this.encryptionEnsured = true;
      return { password, created: true };
    }

    if (!this.encryptionEnsured) {
      if (this.exists() && !this.isEncrypted()) {
        this.options.logger.warn('Found an unencrypted rclone configuration; encrypting it now.');
        await this.encryptConfiguration(cli, password);
      } else if (!this.exists()) {
        await this.encryptConfiguration(cli, password);
      }
      this.encryptionEnsured = true;
    }
    return { password, created: false };
  }

  private async encryptConfiguration(cli: RcloneCli, password: string): Promise<void> {
    // `rclone config encryption set` reads the new password twice from stdin.
    // Nothing secret is passed on the command line.
    const result = await cli.run(['config', 'encryption', 'set'], {
      stdin: `${password}\n${password}\n`,
      timeoutMs: 30000,
      env: { RCLONE_CONFIG_PASS: password },
    });
    if (result.code !== 0 && !this.isEncrypted()) {
      throw new Error(`Could not enable rclone configuration encryption: ${result.stderr.trim()}`);
    }
    if (!this.isEncrypted()) {
      throw new Error('rclone configuration encryption did not complete; refusing to store credentials in clear text.');
    }
  }

  async listRemotes(): Promise<RemoteSummary[]> {
    const cli = await this.options.getCli();
    const password = await this.options.getPassword();
    const result = await cli.run(['listremotes', '--long'], { env: { RCLONE_CONFIG_PASS: password ?? undefined } });
    if (result.code !== 0) {
      throw new Error(`Could not list rclone remotes: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name = '', ...rest] = line.split(':');
        return { name: name.trim(), type: rest.join(':').trim() };
      })
      .filter((entry) => entry.name.length > 0);
  }

  async hasRemote(name: string): Promise<boolean> {
    const remotes = await this.listRemotes();
    return remotes.some((remote) => remote.name === name);
  }

  async getType(name: string): Promise<string | null> {
    const remotes = await this.listRemotes();
    return remotes.find((remote) => remote.name === name)?.type ?? null;
  }

  /** `config create <name> <type> key=value ...` (never interactive). */
  async createRemote(name: string, type: string, options: Record<string, string> = {}): Promise<void> {
    const cli = await this.options.getCli();
    const password = await this.options.getPassword();
    const args = ['config', 'create', name, type, ...toKeyValueArgs(options), '--non-interactive'];
    const result = await cli.run(args, {
      timeoutMs: 60000,
      env: { RCLONE_CONFIG_PASS: password ?? undefined },
    });
    if (result.code !== 0) {
      throw new Error(`Could not create the rclone remote "${name}": ${tailOf(result.stderr || result.stdout)}`);
    }
  }

  /** `config update <name> key=value ...`. */
  async updateRemote(name: string, options: Record<string, string>): Promise<void> {
    const cli = await this.options.getCli();
    const password = await this.options.getPassword();
    const result = await cli.run(['config', 'update', name, ...toKeyValueArgs(options)], {
      timeoutMs: 60000,
      env: { RCLONE_CONFIG_PASS: password ?? undefined },
    });
    if (result.code !== 0) {
      throw new Error(`Could not update the rclone remote "${name}": ${tailOf(result.stderr || result.stdout)}`);
    }
  }

  /**
   * rclone's documented `obscure` command. Obscuring is NOT encryption — it is
   * only used so a password stored in the (already encrypted) configuration file
   * is not readable at a glance.
   */
  async obscure(value: string): Promise<string> {
    const cli = await this.options.getCli();
    const result = await cli.run(['obscure', value], { timeoutMs: 20000 });
    if (result.code !== 0) {
      throw new Error(`Could not obscure the credential: ${tailOf(result.stderr || result.stdout)}`);
    }
    return result.stdout.trim();
  }

  /** Deletes the local configuration entry only. Cloud files are untouched. */
  async deleteRemote(name: string): Promise<void> {
    const cli = await this.options.getCli();
    const password = await this.options.getPassword();
    const result = await cli.run(['config', 'delete', name], {
      timeoutMs: 30000,
      env: { RCLONE_CONFIG_PASS: password ?? undefined },
    });
    if (result.code !== 0 && !result.stderr.includes('not found')) {
      throw new Error(`Could not delete the rclone remote "${name}": ${tailOf(result.stderr || result.stdout)}`);
    }
  }
}

function toKeyValueArgs(options: Record<string, string>): string[] {
  return Object.entries(options)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, ' ').trim()}`);
}

function generatePassword(): string {
  return randomBytes(32).toString('base64url');
}

function tailOf(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 400 ? trimmed.slice(trimmed.length - 400) : trimmed;
}
