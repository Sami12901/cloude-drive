import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandlers, invokeHandler, RENDERER_CHANNELS } from '../../src/main/ipc/handlers.js';
import { AppController } from '../../src/main/services/app-controller.js';
import { MemoryLogger } from '../../src/main/services/logging.js';
import { FilePermissionOnlyProtection } from '../../src/main/services/credential-vault.js';
import { PosixPlatform } from '../../src/main/platform/posix.js';
import { resolvePaths } from '../../src/main/services/context.js';
import { CHANNELS } from '@shared/ipc.js';
import { isAllowedExternalUrl, isTrustedRendererUrl } from '../../src/main/security.js';

let dir: string;
let controller: AppController;
let handlers: ReturnType<typeof createHandlers>;
let logs: MemoryLogger;

const sender = { id: 1, url: 'file:///renderer/index.html' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloudssd-ipc-'));
  logs = new MemoryLogger('ipc');
  controller = new AppController({
    paths: resolvePaths({ dataDir: dir, homeDir: dir, platform: process.platform }),
    platform: new PosixPlatform({ mountRoot: join(dir, 'mounts'), openPath: async () => false }),
    logger: logs,
    secrets: new FilePermissionOnlyProtection(),
    emit: () => undefined,
    appVersion: '1.0.0-test',
    isPackaged: false,
    openExternal: async () => false,
    resourcesDir: null,
  });
  handlers = createHandlers({
    controller,
    platform: new PosixPlatform({ mountRoot: join(dir, 'mounts'), openPath: async () => false }),
    logger: logs,
    openExternal: async () => false,
    openPath: async () => false,
    allowTestProvider: true,
    includeExperimentalProviders: () => true,
  });
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('IPC channel allow-list', () => {
  it('only exposes the channels the renderer is allowed to call', () => {
    for (const channel of RENDERER_CHANNELS) {
      expect(handlers[channel], channel).toBeDefined();
    }
    expect(RENDERER_CHANNELS).toContain(CHANNELS.mountMount);
    expect(RENDERER_CHANNELS).not.toContain('dialog:pick-winfsp-installer');
  });

  it('refuses unknown channels', async () => {
    const result = await invokeHandler(handlers, 'evil:command', {}, sender, logs);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
  });
});

describe('payload validation', () => {
  it('rejects malformed and malicious payloads before they reach a service', async () => {
    const cases: Array<[string, unknown]> = [
      [CHANNELS.remoteCreate, { providerId: 'gdrive', remoteName: 'name; rm -rf /' }],
      [CHANNELS.remoteCreate, { providerId: '../../etc', remoteName: 'ok' }],
      [CHANNELS.mountSetTarget, { id: 'not-a-uuid', driveLetter: 'A' }],
      [CHANNELS.cacheSetDir, { dir: 'relative/../../etc' }],
      [CHANNELS.offlinePin, { remoteId: 'not-a-uuid', remotePath: '../escape' }],
      [CHANNELS.transferEnqueue, { kind: 'shell', srcUri: 'a', dstUri: 'b' }],
      [CHANNELS.settingsUpdate, { transfers: { concurrency: 999 } }],
    ];
    for (const [channel, payload] of cases) {
      const result = await invokeHandler(handlers, channel, payload, sender, logs);
      expect(result.ok, `${channel} should reject ${JSON.stringify(payload)}`).toBe(false);
    }
  });

  it('requires an explicit confirmation before removing an account', async () => {
    const rejected = await invokeHandler(handlers, CHANNELS.remoteRemove, { id: '9a2b4593-0b72-46d4-b899-6474b50e8951' }, sender, logs);
    expect(rejected.ok).toBe(false);
    // Even a confirmed removal never accepts a "delete cloud files" flag.
    const withFlag = await invokeHandler(
      handlers,
      CHANNELS.remoteRemove,
      { id: '9a2b4593-0b72-46d4-b899-6474b50e8951', confirmed: true, deleteCloudFiles: true },
      sender,
      logs,
    );
    expect(withFlag.ok).toBe(false);
  });

  it('accepts a well-formed settings update', async () => {
    const result = await invokeHandler(handlers, CHANNELS.settingsUpdate, { ui: { theme: 'light' } }, sender, logs);
    expect(result.ok).toBe(true);
  });
});

describe('renderer origin checks', () => {
  it('trusts the packaged renderer and the local dev server only', () => {
    expect(isTrustedRendererUrl('file:///C:/app/index.html')).toBe(true);
    expect(isTrustedRendererUrl('http://localhost:5173/', 5173)).toBe(true);
    expect(isTrustedRendererUrl('http://127.0.0.1:5173/', 5173)).toBe(true);
    expect(isTrustedRendererUrl('http://localhost:8080/', 5173)).toBe(false);
    expect(isTrustedRendererUrl('https://evil.example.com')).toBe(false);
    expect(isTrustedRendererUrl('')).toBe(false);
  });

  it('only allows official download and documentation hosts', () => {
    expect(isAllowedExternalUrl('https://rclone.org/downloads/')).toBe(true);
    expect(isAllowedExternalUrl('https://winfsp.dev/rel/')).toBe(true);
    expect(isAllowedExternalUrl('http://rclone.org/downloads/')).toBe(false);
    expect(isAllowedExternalUrl('https://example.com/installer.exe')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('secret hygiene', () => {
  it('never returns or logs a token from the snapshot or diagnostics', async () => {
    const fakeToken = 'ya29.SUPERSECRETTOKENVALUE';
    logs.entries.push({ ts: new Date().toISOString(), level: 'info', scope: 'test', message: `token: ${fakeToken}` });
    const snapshot = await invokeHandler(handlers, CHANNELS.appSnapshot, {}, sender, logs);
    expect(snapshot.ok).toBe(true);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(fakeToken);
    expect(serialized).not.toMatch(/"(password|client_secret|access_token)"/i);

    const report = await invokeHandler(handlers, CHANNELS.appDiagnostics, {}, sender, logs);
    expect(report.ok).toBe(true);
    if (report.ok) {
      const value = report.value as { redactionApplied: boolean; recentErrors: Array<{ message: string }> };
      expect(value.redactionApplied).toBe(true);
      expect(JSON.stringify(value.recentErrors)).not.toContain(fakeToken);
    }
  });
});
