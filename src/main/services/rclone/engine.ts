import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { ERROR_CODES } from '../../../shared/ipc.js';
import type { DependencyStatus } from '../../../shared/types.js';
import type { Logger } from '../logging.js';
import type { CredentialVault } from '../credential-vault.js';
import { VAULT_KEYS } from '../credential-vault.js';
import { RcloneCli } from './cli.js';
import { RcloneLocator, type RcloneBinaryInfo, type RcloneLocatorOptions } from './binary.js';
import { RcloneConfigStore } from './config-store.js';

export interface RcloneEngineOptions extends RcloneLocatorOptions {
  configPath: string;
}

/**
 * Owns the rclone binary, the encrypted configuration file and the password
 * that protects it.
 *
 * The configuration password is generated once, stored in the OS-protected
 * credential vault, and handed to rclone through the `RCLONE_CONFIG_PASS`
 * environment variable of the child process. It never appears in argv, in a
 * settings file or in a log line (the logger redacts it as well).
 */
export class RcloneEngine {
  private binaryInfo: RcloneBinaryInfo;
  private cachedPass: string | null = null;
  readonly config: RcloneConfigStore;

  constructor(
    private readonly options: RcloneEngineOptions,
    private readonly vault: CredentialVault,
    private readonly logger: Logger,
  ) {
    this.binaryInfo = {
      path: null,
      version: null,
      available: false,
      source: 'none',
      message: 'rclone has not been located yet.',
      checksumVerified: null,
    };
    this.config = new RcloneConfigStore({
      configPath: options.configPath,
      logger,
      getCli: () => this.cli(),
      getPassword: () => this.configPassword(),
    });
  }

  get info(): RcloneBinaryInfo {
    return this.binaryInfo;
  }

  get available(): boolean {
    return this.binaryInfo.available;
  }

  async refresh(): Promise<RcloneBinaryInfo> {
    const locator = new RcloneLocator(this.logger.child('locator'), this.options);
    this.binaryInfo = await locator.resolve();
    if (this.binaryInfo.available) {
      const { password, created } = await this.config.ensureEncryptedConfiguration();
      if (created || this.cachedPass !== password) {
        await this.rememberPassword(password);
      }
    }
    return this.binaryInfo;
  }

  dependencyStatus(): DependencyStatus {
    const locator = new RcloneLocator(this.logger.child('locator'), this.options);
    return locator.toDependencyStatus(this.binaryInfo);
  }

  /** Creates a CLI bound to the current binary, config path and password. */
  async cli(): Promise<RcloneCli> {
    if (!this.binaryInfo.available) {
      throw new EngineUnavailableError('The rclone engine is not available.');
    }
    const password = await this.configPassword();
    return new RcloneCli(this.binaryInfo.path as string, () => ({
      RCLONE_CONFIG: this.options.configPath,
      RCLONE_CONFIG_PASS: password ?? undefined,
    }), this.logger.child('cli'));
  }

  /** Extra secrets the logger must scrub from every message. */
  sensitiveValues(): string[] {
    return this.cachedPass ? [this.cachedPass] : [];
  }

  private async configPassword(): Promise<string | null> {
    if (this.cachedPass) return this.cachedPass;
    const existing = await this.vault.get(VAULT_KEYS.rcloneConfigPass);
    if (existing) {
      this.cachedPass = existing;
      return existing;
    }
    return null;
  }

  /**
   * Adopts the configuration password the config store generated during
   * `ensureEncryptedConfiguration` (see config-store.ensureEncryptedConfiguration).
   */
  async adoptPassword(password: string): Promise<void> {
    if (this.cachedPass !== password) {
      await this.rememberPassword(password);
    }
  }

  /** Called by the config store once it has created the password. */
  async rememberPassword(password: string): Promise<void> {
    await this.vault.set(VAULT_KEYS.rcloneConfigPass, password);
    this.cachedPass = password;
  }

  async resetPassword(): Promise<void> {
    this.cachedPass = null;
    await this.vault.delete(VAULT_KEYS.rcloneConfigPass);
  }

  ensureDirectories(): void {
    if (!existsSync(this.options.configPath)) {
      mkdirSync(this.options.configPath.replace(/[/\\][^/\\]+$/, ''), { recursive: true, mode: 0o700 });
    }
  }
}

export class EngineUnavailableError extends Error {
  readonly code = ERROR_CODES.DEPENDENCY_MISSING;
  constructor(message: string) {
    super(message);
    this.name = 'EngineUnavailableError';
  }
}
