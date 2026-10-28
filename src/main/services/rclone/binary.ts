import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { MIN_RCLONE_VERSION } from '../../../shared/defaults.js';
import type { DependencyStatus } from '../../../shared/types.js';
import type { Logger } from '../logging.js';
import { RcloneCli } from './cli.js';

export interface RcloneBinaryInfo {
  path: string | null;
  version: string | null;
  available: boolean;
  source: 'packaged' | 'tools' | 'path' | 'configured' | 'none';
  message: string;
  /** Set when a checksum manifest exists and the binary does not match it. */
  checksumVerified: boolean | null;
}

export interface RcloneLocatorOptions {
  /** Directory that ships with the app (electron-builder extraResources). */
  resourcesDir?: string | null;
  /** Repository/dev `tools` directory. */
  toolsDir?: string | null;
  /** Explicitly configured binary (advanced setting / env var). */
  configuredPath?: string | null;
  platform?: NodeJS.Platform;
  /** Search PATH. */
  pathEntries?: string[];
}

const NOT_FOUND: RcloneBinaryInfo = {
  path: null,
  version: null,
  available: false,
  source: 'none',
  message:
    'rclone was not found. CloudSSD needs the official rclone binary to mount cloud storage; install it from the link below or run `npm run deps:fetch-rclone`.',
  checksumVerified: null,
};

/**
 * Finds and validates the rclone binary.
 *
 * Lookup order: configured path -> packaged resources -> repository `tools` dir
 * -> PATH. A candidate is only accepted after `rclone version` runs
 * successfully and reports a supported version, so a stale or foreign binary on
 * PATH cannot be picked up silently.
 */
export class RcloneLocator {
  constructor(
    private readonly logger: Logger,
    private readonly options: RcloneLocatorOptions = {},
  ) {}

  candidates(): string[] {
    const platform = this.options.platform ?? process.platform;
    const names = platform === 'win32' ? ['rclone.exe'] : ['rclone'];
    const out: string[] = [];
    const configured = this.options.configuredPath ?? process.env.CLOUDSSD_RCLONE_PATH;
    if (configured) out.push(resolve(configured));
    if (this.options.resourcesDir) {
      for (const name of names) out.push(join(this.options.resourcesDir, 'rclone', name));
    }
    if (this.options.toolsDir) {
      for (const name of names) out.push(join(this.options.toolsDir, name));
    }
    const pathEntries = this.options.pathEntries ?? (process.env.PATH ?? '').split(platform === 'win32' ? ';' : ':');
    for (const entry of pathEntries) {
      if (!entry) continue;
      for (const name of names) out.push(join(entry, name));
    }
    return [...new Set(out)];
  }

  async resolve(): Promise<RcloneBinaryInfo> {
    for (const candidate of this.candidates()) {
      if (!existsSync(candidate)) continue;
      try {
        await access(candidate, 1); // X_OK
      } catch {
        continue;
      }
      const info = await this.validate(candidate);
      if (info.available) return info;
      this.logger.warn('Rejected rclone candidate.', { candidate, message: info.message });
    }
    return NOT_FOUND;
  }

  async validate(path: string): Promise<RcloneBinaryInfo> {
    const source: RcloneBinaryInfo['source'] =
      this.options.configuredPath && resolve(this.options.configuredPath) === path
        ? 'configured'
        : this.options.resourcesDir && path.startsWith(resolve(this.options.resourcesDir))
          ? 'packaged'
          : this.options.toolsDir && path.startsWith(resolve(this.options.toolsDir))
            ? 'tools'
            : 'path';

    const cli = new RcloneCli(path, () => ({}), this.logger.child('rclone-version'));
    let version: string | null = null;
    try {
      version = await cli.version();
    } catch (error) {
      return {
        path,
        version: null,
        available: false,
        source,
        message: `Found ${path} but it could not be executed: ${(error as Error).message}`,
        checksumVerified: null,
      };
    }
    if (!version) {
      return {
        path,
        version: null,
        available: false,
        source,
        message: `Could not read the version of ${path}.`,
        checksumVerified: null,
      };
    }
    const checksumVerified = verifyChecksumAgainstManifest(path, this.logger);
    if (checksumVerified === false) {
      return {
        path,
        version,
        available: false,
        source,
        message: `The checksum of ${path} does not match tools/rclone-manifest.json. Refusing to run an unverified engine binary.`,
        checksumVerified: false,
      };
    }
    if (!isSupportedVersion(version)) {
      return {
        path,
        version,
        available: false,
        source,
        message: `rclone ${version} is older than the minimum supported version ${MIN_RCLONE_VERSION}.`,
        checksumVerified,
      };
    }
    return {
      path,
      version,
      available: true,
      source,
      message: `rclone ${version} (${source})`,
      checksumVerified,
    };
  }

  toDependencyStatus(info: RcloneBinaryInfo): DependencyStatus {
    return {
      id: 'rclone',
      required: true,
      installed: info.available,
      version: info.version,
      path: info.path,
      downloadUrl: 'https://rclone.org/downloads/',
      license: 'MIT (rclone, https://github.com/rclone/rclone)',
      message: info.message,
      remediation: info.available
        ? undefined
        : 'Download the official rclone build for windows-amd64 from rclone.org/downloads (or run `npm run deps:fetch-rclone`), then retry.',
    };
  }
}

export function isSupportedVersion(version: string): boolean {
  return compareVersions(version, MIN_RCLONE_VERSION) >= 0;
}

/** Compares `a` and `b` (dotted numbers); returns -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Verifies the binary against `tools/rclone-manifest.json` when that file
 * exists. Returns null when no manifest is present (nothing to verify against),
 * true on match, false on mismatch. Mismatch is fatal by design: CloudSSD never
 * runs an engine binary whose integrity cannot be established.
 */
export function verifyChecksumAgainstManifest(binaryPath: string, logger: Logger): boolean | null {
  const manifestPath = join(dirname(binaryPath), 'rclone-manifest.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { sha256?: string; version?: string };
    if (!manifest.sha256) return null;
    const actual = createHash('sha256').update(readFileSync(binaryPath)).digest('hex');
    const expected = manifest.sha256.toLowerCase();
    if (actual !== expected) {
      logger.error('rclone checksum mismatch; refusing to use this binary.', { manifestPath, actual, expected });
      return false;
    }
    return true;
  } catch (error) {
    logger.error('Could not verify the rclone manifest.', { error: (error as Error).message });
    return false;
  }
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function fileSize(path: string): number {
  return statSync(path).size;
}
