import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppController } from '../../src/main/services/app-controller.js';
import { MemoryLogger } from '../../src/main/services/logging.js';
import { CredentialVault, FilePermissionOnlyProtection } from '../../src/main/services/credential-vault.js';
import { PosixPlatform, type PosixAdapterOptions } from '../../src/main/platform/posix.js';
import { resolvePaths, type AppPaths } from '../../src/main/services/context.js';
import type { PlatformAdapter } from '../../src/main/platform/types.js';
import type { BridgeEvent } from '../../src/shared/ipc.js';

export const repoRoot = resolve(process.cwd());
export const rcloneBinary =
  process.env.CLOUDSSD_RCLONE_PATH ?? join(repoRoot, 'tools', process.platform === 'win32' ? 'rclone.exe' : 'rclone');

/** True when a real rclone binary is available for engine-level tests. */
export const hasRclone = existsSync(rcloneBinary);

export interface TestHarness {
  paths: AppPaths;
  controller: AppController;
  vault: CredentialVault;
  platform: PlatformAdapter;
  logger: MemoryLogger;
  events: BridgeEvent[];
  cleanup(): Promise<void>;
  tempDir: string;
}

export interface HarnessOptions extends PosixAdapterOptions {
  mountRoot?: string;
  /**
   * Reuse an existing data directory, so a second AppController can be built
   * over the configuration another one wrote (auto-start, lock files, …).
   */
  dataDir?: string;
}

/**
 * Builds a real AppController against a temporary data directory.
 *
 * Nothing in the harness is mocked except the OS secret store (there is no
 * keyring in CI) and optional platform overrides — the rclone engine, the mount
 * manager and the cache manager are the production implementations.
 */
export function createHarness(options: HarnessOptions = {}): TestHarness {
  const tempDir = mkdtempSync(join(tmpdir(), 'cloudssd-test-'));
  const ownsDataDir = !options.dataDir;
  const dataDir = options.dataDir ?? join(tempDir, 'data');
  const mountRoot = options.mountRoot ?? join(tempDir, 'mounts');
  const paths = resolvePaths({ dataDir, homeDir: tempDir, platform: process.platform });
  // Make the real rclone binary discoverable through the production lookup path
  // (`<dataDir>/../tools`) instead of relying on PATH or an env override.
  if (hasRclone) {
    mkdirSync(paths.binDir, { recursive: true });
    const link = join(paths.binDir, process.platform === 'win32' ? 'rclone.exe' : 'rclone');
    if (!existsSync(link)) symlinkSync(rcloneBinary, link);
  }
  const logger = new MemoryLogger('test', process.env.CLOUDSSD_TEST_LOG_LEVEL === 'debug' ? 'debug' : 'info');
  const events: BridgeEvent[] = [];
  const platform = new PosixPlatform({ mountRoot, openPath: async () => false });
  const vault = new CredentialVault(join(paths.dataDir, 'secrets'), new FilePermissionOnlyProtection(), logger);

  const controller = new AppController({
    paths,
    platform,
    logger,
    secrets: new FilePermissionOnlyProtection(),
    emit: (event: BridgeEvent) => events.push(event),
    appVersion: '1.0.0-test',
    isPackaged: false,
    openExternal: async () => false,
    resourcesDir: null,
  });

  return {
    paths,
    controller,
    vault,
    platform,
    logger,
    events,
    tempDir,
    cleanup: async () => {
      await controller.shutdown().catch(() => undefined);
      if (ownsDataDir) rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

/** Polls until `predicate` is true or the timeout elapses. */
export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 30_000, intervalMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((done) => setTimeout(done, intervalMs));
  }
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Creates a directory that acts as the "cloud" for engine tests. */
export function makeRemoteDir(name = 'remote'): string {
  const dir = mkdtempSync(join(tmpdir(), `cloudssd-${name}-`));
  return dir;
}
