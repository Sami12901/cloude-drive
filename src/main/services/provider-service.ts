import { ERROR_CODES, makeError } from '../../shared/ipc.js';
import { buildRemoteSpec } from '../../shared/remote.js';
import type {
  AppError,
  DirectoryEntry,
  ProviderDescriptor,
  QuotaInfo,
  RemoteBrowseResult,
  RemoteConfig,
} from '../../shared/types.js';
import { getProvider } from '../providers/registry.js';
import type { Logger } from './logging.js';
import type { RcloneEngine } from './rclone/engine.js';
import { EngineUnavailableError } from './rclone/engine.js';

export interface RemoteTestResult {
  ok: boolean;
  detail: string;
  latencyMs: number;
  error?: AppError;
}

export interface AboutResult extends QuotaInfo {
  error?: AppError;
}

interface LsJsonEntry {
  Path: string;
  Name: string;
  Size: number;
  MimeType: string;
  ModTime: string;
  IsDir: boolean;
  Hashes?: Record<string, string>;
}

interface AboutJson {
  total?: number;
  used?: number;
  free?: number;
  trashed?: number;
  other?: number;
}

/**
 * Provider-facing operations that run against the real rclone engine:
 * connection tests, quota reporting, directory listing and hash lookups.
 *
 * Every failure is translated into an AppError with the provider-specific
 * meaning preserved (expired authorization, quota exceeded, network down,
 * provider unavailable) so the UI can show the correct recovery action.
 */
export class ProviderService {
  constructor(
    private readonly engine: RcloneEngine,
    private readonly logger: Logger,
  ) {}

  describe(providerId: string): ProviderDescriptor | null {
    return getProvider(providerId);
  }

  /** Builds the rclone source/destination spec, e.g. `gdrive:CloudSSD/photos`. */
  remotePath(remote: Pick<RemoteConfig, 'remoteName' | 'remoteRoot'>, suffix = ''): string {
    return buildRemoteSpec(remote, suffix);
  }

  async testConnection(remote: RemoteConfig): Promise<RemoteTestResult> {
    const startedAt = Date.now();
    try {
      const cli = await this.engine.cli();
      const result = await cli.run(['lsd', this.remotePath(remote)], { timeoutMs: 45000 });
      const latencyMs = Date.now() - startedAt;
      if (result.code === 0) {
        return { ok: true, detail: `${remote.displayName} responded in ${latencyMs} ms.`, latencyMs };
      }
      const output = `${result.stderr}\n${result.stdout}`;
      const classified = classifyRemoteError(output);
      this.logger.warn('Remote connection test failed.', {
        remote: remote.remoteName,
        code: classified.code,
        detail: classified.message,
      });
      return { ok: false, detail: classified.message, latencyMs, error: classified };
    } catch (error) {
      if (error instanceof EngineUnavailableError) {
        return {
          ok: false,
          detail: 'The rclone engine is not installed, so nothing can be reached.',
          latencyMs: Date.now() - startedAt,
          error: makeError(ERROR_CODES.DEPENDENCY_MISSING, 'rclone is not available.'),
        };
      }
      const classified = classifyRemoteError((error as Error).message);
      return { ok: false, detail: classified.message, latencyMs: Date.now() - startedAt, error: classified };
    }
  }

  /** `rclone about` — only meaningful for providers that publish a quota. */
  async about(remote: RemoteConfig): Promise<AboutResult> {
    const descriptor = getProvider(remote.providerId);
    if (!descriptor?.supportsQuota) {
      return {
        available: false,
        totalBytes: null,
        usedBytes: null,
        freeBytes: null,
        trashedBytes: null,
        otherBytes: null,
        note: `${descriptor?.name ?? remote.providerId} does not publish a storage quota through the API.`,
      };
    }
    try {
      const cli = await this.engine.cli();
      const data = await cli.json<AboutJson>(['about', this.remotePath(remote), '--json'], { timeoutMs: 45000 });
      const total = typeof data.total === 'number' && data.total > 0 ? data.total : null;
      const used = typeof data.used === 'number' ? data.used : null;
      const free = typeof data.free === 'number' ? data.free : total !== null && used !== null ? total - used : null;
      return {
        available: total !== null || used !== null,
        totalBytes: total,
        usedBytes: used,
        freeBytes: free,
        trashedBytes: typeof data.trashed === 'number' ? data.trashed : null,
        otherBytes: typeof data.other === 'number' ? data.other : null,
        note:
          total === null && used === null
            ? 'The provider did not return capacity figures for this account.'
            : undefined,
      };
    } catch (error) {
      const classified = classifyRemoteError((error as Error).message);
      this.logger.warn('Could not read the remote quota.', { remote: remote.remoteName, detail: classified.message });
      return {
        available: false,
        totalBytes: null,
        usedBytes: null,
        freeBytes: null,
        trashedBytes: null,
        otherBytes: null,
        note: `Quota is not available right now: ${classified.message}`,
        error: classified,
      };
    }
  }

  /** Lists one directory level of the remote (used by the wizard folder picker). */
  async browse(remote: RemoteConfig, path = ''): Promise<RemoteBrowseResult> {
    const cli = await this.engine.cli();
    const target = this.remotePath(remote, path);
    const entries = await cli.json<LsJsonEntry[]>(['lsjson', target, '--dirs-only'], { timeoutMs: 60000 });
    const list: DirectoryEntry[] = entries
      .filter((entry) => entry.IsDir)
      .slice(0, 500)
      .map((entry) => ({
        name: entry.Name,
        path: [path, entry.Name].filter(Boolean).join('/'),
        isDir: true,
        size: null,
        mtime: entry.ModTime ?? null,
      }));
    return { path, entries: list, truncated: entries.length > 500 };
  }

  /**
   * Reads metadata (size, modification time, hash, type) for a single remote
   * object. Files and directories are both listed, so callers can rely on
   * `isDir` instead of guessing from the path.
   */
  async stat(remote: RemoteConfig, remotePath: string): Promise<{ size: number | null; mtime: string | null; hash: string | null; isDir: boolean } | null> {
    const cli = await this.engine.cli();
    const target = this.remotePath(remote, remotePath);
    const parent = target.replace(/\/[^/]*$/, '');
    const name = target.split('/').pop() ?? '';
    try {
      const entries = await cli.json<LsJsonEntry[]>(['lsjson', parent, '--hash'], { timeoutMs: 60000 });
      const match = entries.find((entry) => entry.Name === name);
      if (!match) return null;
      return {
        size: typeof match.Size === 'number' ? match.Size : null,
        mtime: match.ModTime ?? null,
        hash: match.Hashes ? (match.Hashes.MD5 ?? match.Hashes.SHA1 ?? match.Hashes.sha1 ?? null) : null,
        isDir: match.IsDir,
      };
    } catch (error) {
      this.logger.debug('Could not stat the remote object.', { target, error: (error as Error).message });
      return null;
    }
  }

  /** Verifies that a remote object still matches a locally pinned copy. */
  async checksum(remote: RemoteConfig, remotePath: string): Promise<string | null> {
    try {
      const cli = await this.engine.cli();
      const output = await cli.run(['hashsum', 'MD5', this.remotePath(remote, remotePath), '--download'], {
        timeoutMs: 120000,
      });
      if (output.code !== 0) return null;
      return output.stdout.trim().split(/\s+/)[0] ?? null;
    } catch {
      return null;
    }
  }
}

const FAILURE_PATTERNS: Array<{ pattern: RegExp; code: string; message: string; remediation: string; recoverable: boolean }> = [
  {
    pattern: /couldn't fetch token|invalid_grant|token has been expired or revoked|unauthorized|401/i,
    code: ERROR_CODES.AUTH_EXPIRED,
    message: 'The authorization for this account has expired or was revoked.',
    remediation: 'Reconnect the account from the dashboard (Connect account → Reconnect).',
    recoverable: true,
  },
  {
    pattern: /rate limit|too many requests|429|quota exceeded.*rate/i,
    code: ERROR_CODES.PROVIDER_UNAVAILABLE,
    message: 'The provider is rate limiting requests right now.',
    remediation: 'Wait a few minutes and retry. Reduce transfer concurrency in Settings → Transfers.',
    recoverable: true,
  },
  {
    pattern: /storage quota|quota exceeded|insufficient (storage|space)/i,
    code: ERROR_CODES.QUOTA_EXCEEDED,
    message: 'The cloud account is out of storage quota.',
    remediation: 'Free space in the cloud account or upgrade the provider plan, then retry the transfer.',
    recoverable: true,
  },
  {
    pattern: /couldn't connect|no such host|connection refused|i\/o timeout|dial tcp|network is unreachable|unexpected EOF|tls/i,
    code: ERROR_CODES.NETWORK,
    message: 'The cloud provider could not be reached. Check the internet connection.',
    remediation: 'Reconnect to the internet; CloudSSD will retry automatically if auto-reconnect is enabled.',
    recoverable: true,
  },
  {
    pattern: /directory not found|not found|does not exist/i,
    code: ERROR_CODES.NOT_FOUND,
    message: 'The configured remote folder does not exist (or is not visible to this account).',
    remediation: 'Change the remote root in Settings → Drive, or create the folder in the cloud account first.',
    recoverable: true,
  },
  {
    pattern: /permission denied|forbidden|access denied|403/i,
    code: ERROR_CODES.PERMISSION_DENIED,
    message: 'The account is not allowed to access this location.',
    remediation: 'Reconnect the account and make sure the requested scopes were granted.',
    recoverable: true,
  },
  {
    pattern: /winfsp|cannot find winfsp/i,
    code: ERROR_CODES.DEPENDENCY_MISSING,
    message: 'WinFsp is missing, so Windows cannot create the drive letter.',
    remediation: 'Install WinFsp from winfsp.dev (administrator rights required), then mount again.',
    recoverable: true,
  },
];

/** Maps raw engine output onto a user-facing error with a recovery action. */
export function classifyRemoteError(output: string): AppError {
  for (const entry of FAILURE_PATTERNS) {
    if (entry.pattern.test(output)) {
      return makeError(entry.code, entry.message, {
        details: output.trim().slice(-400),
        recoverable: entry.recoverable,
        remediation: entry.remediation,
      });
    }
  }
  const clean = output.trim().split('\n').filter(Boolean).slice(-1)[0] ?? 'Unknown engine error.';
  return makeError(ERROR_CODES.ENGINE_ERROR, clean.slice(0, 400), {
    details: output.trim().slice(-400),
    recoverable: true,
    remediation: 'Open Diagnostics for details, then retry. If it repeats, export diagnostics from Settings.',
  });
}
