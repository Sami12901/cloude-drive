import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RcloneEngine } from '../../src/main/services/rclone/engine.js';
import type { CredentialVault } from '../../src/main/services/credential-vault.js';
import type { Logger } from '../../src/main/services/logging.js';

const repoRoot = resolve(process.cwd());

/** rclone binary used by engine-level tests (never committed to the repository). */
export const rcloneBinary =
  process.env.CLOUDSSD_RCLONE_PATH ??
  join(repoRoot, 'tools', process.platform === 'win32' ? 'rclone.exe' : 'rclone');

export const hasRclone = existsSync(rcloneBinary);

/** Builds a RcloneEngine bound to a specific binary, vault and config path. */
export function configureRcloneForTest(
  vault: CredentialVault,
  logger: Logger,
  configPath: string,
): RcloneEngine {
  return new RcloneEngine(
    {
      configPath,
      resourcesDir: null,
      toolsDir: join(repoRoot, 'tools'),
      configuredPath: hasRclone ? rcloneBinary : null,
    },
    vault,
    logger,
  );
}
