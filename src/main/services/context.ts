import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BridgeEvent } from '../../shared/ipc.js';
import type { PlatformAdapter } from '../platform/types.js';
import type { Logger } from './logging.js';
import type { SecretProtection } from './credential-vault.js';

export interface AppPaths {
  /** Per-user configuration root (%LOCALAPPDATA%\CloudSSD). */
  dataDir: string;
  logDir: string;
  /** Where the rclone configuration file lives. */
  rcloneDir: string;
  rcloneConfigPath: string;
  /** VFS cache root (can be relocated in settings). */
  cacheDir: string;
  /** Where the bundled/expected rclone binary is looked up first. */
  binDir: string;
  homeDir: string;
}

export interface AppContext {
  paths: AppPaths;
  platform: PlatformAdapter;
  logger: Logger;
  secrets: SecretProtection;
  appVersion: string;
  isPackaged: boolean;
  /** Push an event to every renderer / dev-host client. */
  emit(event: BridgeEvent): void;
  clock(): Date;
  sleep(ms: number): Promise<void>;
  openExternal(url: string): Promise<boolean>;
}

export interface PathOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Overrides the data directory (tests and dev host). */
  dataDir?: string;
  homeDir?: string;
}

/**
 * Resolves the per-user application directories.
 *
 * Windows: %LOCALAPPDATA%\CloudSSD — cache and logs live next to the settings.
 * Linux/macOS (dev host & tests): XDG_DATA_HOME or ~/.local/share/CloudSSD.
 */
export function resolvePaths(options: PathOptions = {}): AppPaths {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env.HOME ?? homedir();
  const dataDir =
    options.dataDir ??
    (platform === 'win32'
      ? resolve(env.LOCALAPPDATA ?? join(homeDir, 'AppData', 'Local'), 'CloudSSD')
      : resolve(env.XDG_DATA_HOME ?? join(homeDir, '.local', 'share'), 'CloudSSD'));

  return {
    dataDir,
    logDir: join(dataDir, 'logs'),
    rcloneDir: join(dataDir, 'rclone'),
    rcloneConfigPath: join(dataDir, 'rclone', 'rclone.conf'),
    cacheDir: join(dataDir, 'cache'),
    binDir: join(dataDir, '..', 'tools'),
    homeDir,
  };
}

export function tempDir(): string {
  return tmpdir();
}

/** Picks a free localhost port for the rclone remote-control endpoint. */
export async function findFreePort(preferred?: number): Promise<number> {
  const net = await import('node:net');
  const candidates = preferred ? [preferred] : [];
  for (let i = 0; candidates.length < 40; i += 1) {
    candidates.push(18000 + Math.floor(Math.random() * 20000));
  }
  for (const port of candidates) {
    const free = await new Promise<boolean>((done) => {
      const server = net.createServer();
      server.once('error', () => done(false));
      server.listen(port, '127.0.0.1', () => {
        server.close(() => done(true));
      });
    });
    if (free) return port;
  }
  throw new Error('No free localhost port available for the rclone remote control endpoint.');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Exponential backoff with jitter, bounded by `maxMs`. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const raw = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(raw * 0.2 * Math.random());
  return Math.min(maxMs, raw + jitter);
}
