import type { Logger } from '../logging.js';

export interface CoreStats {
  bytes: number;
  speed: number;
  transfers: number;
  totalBytes: number;
  errors: number;
  eta: number | null;
  fatalError: boolean;
  retryError: boolean;
}

export interface VfsStats {
  diskCache: {
    bytesUsed: number;
    files: number;
    erroredFiles: number;
    uploadsInProgress: number;
    uploadsQueued: number;
    outOfSpace: boolean;
    path: string;
  };
  inUse: number;
  fs: string;
  opt?: { CacheMode?: number; CacheMaxSize?: number };
}

export interface TransferredEntry {
  name: string;
  size: number;
  bytes: number;
  checked: boolean;
  completed: boolean;
  error?: string;
  group?: string;
}

export interface RcVersion {
  version: string;
  os: string;
  arch: string;
}

/**
 * Client for rclone's documented remote-control (rc) HTTP API.
 *
 * The endpoint is bound to 127.0.0.1 on a random port and protected with a
 * per-run random user/password (Basic auth). Credentials are never written to
 * disk or logged — they only exist in the mount manager's memory.
 */
export class RemoteControl {
  constructor(
    private readonly baseUrl: string,
    private readonly user: string,
    private readonly password: string,
    private readonly logger: Logger,
    private readonly timeoutMs = 5000,
  ) {}

  get url(): string {
    return this.baseUrl;
  }

  async call<T>(path: string, input?: Record<string, unknown>, timeoutMs = this.timeoutMs): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.user}:${this.password}`).toString('base64')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input ?? {}),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`rc ${path} failed: HTTP ${response.status}`);
      }
      const text = await response.text();
      return JSON.parse(text) as T;
    } catch (error) {
      const message = (error as Error).name === 'AbortError' ? `rc ${path} timed out` : (error as Error).message;
      const sanitized = message.replace(this.password, '[REDACTED]');
      this.logger.debug('rc call failed', { path, error: sanitized });
      throw new Error(sanitized);
    } finally {
      clearTimeout(timer);
    }
  }

  async version(): Promise<RcVersion> {
    return this.call<RcVersion>('core/version');
  }

  async stats(): Promise<CoreStats> {
    return this.call<CoreStats>('core/stats');
  }

  async transferred(): Promise<{ transferred: TransferredEntry[] }> {
    return this.call<{ transferred: TransferredEntry[] }>('core/transferred');
  }

  async vfsStats(): Promise<VfsStats> {
    return this.call<VfsStats>('vfs/stats');
  }

  /** Drops the directory cache so remote changes appear on the next access. */
  async forget(input: { fs?: string; path?: string } = {}): Promise<unknown> {
    return this.call('vfs/forget', input);
  }

  async refresh(input: { fs?: string; path?: string; recursive?: boolean } = {}): Promise<unknown> {
    return this.call('vfs/refresh', input);
  }

  async unmount(mountPoint: string): Promise<unknown> {
    return this.call('mount/unmount', { mountPoint });
  }

  async listMounts(): Promise<{ mountPoints: Array<{ Fs: string; MountPoint: string }> }> {
    return this.call<{ mountPoints: Array<{ Fs: string; MountPoint: string }> }>('mount/listmounts');
  }

  /** Asks rclone to exit cleanly (flushes the write-back cache first). */
  async quit(): Promise<void> {
    try {
      await this.call('core/quit', {}, 3000);
    } catch {
      // rclone closes the connection while quitting; that is expected.
    }
  }

  async setBandwidth(rate: string): Promise<unknown> {
    return this.call('core/bwlimit', { rate });
  }
}

/** Generates the random rc password used for a single mount session. */
export function generateRcPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
