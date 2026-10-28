import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RcloneEngine } from '../../src/main/services/rclone/engine.js';
import { MemoryLogger } from '../../src/main/services/logging.js';
import { CredentialVault, FilePermissionOnlyProtection } from '../../src/main/services/credential-vault.js';
import { configureRcloneForTest } from '../helpers/engine.js';

/**
 * These tests run the real rclone binary against a temporary configuration
 * file. They verify the parts CloudSSD depends on: an encrypted configuration,
 * non-interactive remote management and obscured credentials.
 */
let dir: string;
let engine: RcloneEngine;
let logs: MemoryLogger;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cloudssd-rclone-config-'));
  logs = new MemoryLogger('engine');
  const vault = new CredentialVault(join(dir, 'secrets'), new FilePermissionOnlyProtection(), logs);
  engine = configureRcloneForTest(vault, logs, join(dir, 'rclone', 'rclone.conf'));
  await engine.refresh();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('rclone configuration handling', () => {
  it('locates and validates the engine binary', () => {
    expect(engine.available).toBe(true);
    expect(engine.info.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(existsSync(engine.info.path as string)).toBe(true);
  });

  it('creates an encrypted configuration file (never plain text credentials)', () => {
    expect(existsSync(engine.config.path)).toBe(true);
    const contents = readFileSync(engine.config.path, 'utf8');
    expect(contents).toContain('# Encrypted rclone configuration File');
    expect(engine.config.isEncrypted()).toBe(true);
  });

  it('writes the configuration file with user-only permissions', () => {
    const mode = require('node:fs').statSync(engine.config.path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates, lists, updates and deletes remotes non-interactively', async () => {
    await engine.config.createRemote('cloudssd-test', 'local', { nounc: 'true' });
    const listed = await engine.config.listRemotes();
    expect(listed.map((entry) => entry.name)).toContain('cloudssd-test');
    expect(await engine.config.getType('cloudssd-test')).toBe('local');

    await engine.config.updateRemote('cloudssd-test', { nounc: 'false' });
    expect(await engine.config.hasRemote('cloudssd-test')).toBe(true);

    await engine.config.deleteRemote('cloudssd-test');
    expect(await engine.config.hasRemote('cloudssd-test')).toBe(false);
  });

  it('keeps the configuration encrypted after adding a remote', async () => {
    await engine.config.createRemote('after-add', 'local', {});
    expect(engine.config.isEncrypted()).toBe(true);
  });

  it('obscures credentials instead of storing them verbatim', async () => {
    const cli = await engine.cli();
    const obscured = await engine.config.obscure('hunter2');
    expect(obscured).not.toBe('hunter2');
    expect(obscured.length).toBeGreaterThan(0);
    const check = await cli.run(['reveal', obscured], { timeoutMs: 20000 });
    expect(check.stdout.trim()).toBe('hunter2');
  });

  it('never writes a token or password to the log', async () => {
    const cli = await engine.cli();
    await cli.run(['config', 'create', 'log-check', 'local', 'token={"access_token":"ya29.LEAK"}'], {
      timeoutMs: 30000,
    });
    const serialized = JSON.stringify(logs.entries);
    expect(serialized).not.toContain('ya29.LEAK');
  });
});
