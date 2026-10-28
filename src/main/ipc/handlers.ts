import type { z } from 'zod';
import { CHANNELS, ERROR_CODES, makeError } from '../../shared/ipc.js';
import type { BridgeResult } from '../../shared/ipc.js';
import type { ProviderId, TransferKind } from '../../shared/types.js';
import { ipcSchemas, parseSafe, type IpcPayloadMap } from '../../shared/validation.js';
import type { AppController } from '../services/app-controller.js';
import type { Logger } from '../services/logging.js';
import type { PlatformAdapter } from '../platform/types.js';

export interface IpcSender {
  /** Electron webContents id / dev-host client id. */
  id: number;
  /** Origin the request came from (must be the application itself). */
  url: string;
}

export interface HandlerContext {
  controller: AppController;
  platform: PlatformAdapter;
  logger: Logger;
  /** Opens a URL in the user's browser (allow-listed by the main process). */
  openExternal(url: string): Promise<boolean>;
  /** Opens a local path in File Explorer. */
  openPath(target: string): Promise<boolean>;
  /** Windows only: run a WinFsp installer the user picked, after confirmation. */
  installWinfspInstaller?(installerPath: string): Promise<{ started: boolean; detail: string }>;
  /** True when the test provider (`local`) may be listed. */
  allowTestProvider: boolean;
  includeExperimentalProviders: () => boolean;
}

type MaybePromise<T> = T | Promise<T>;

type Handler<K extends keyof IpcPayloadMap> = (
  payload: IpcPayloadMap[K],
  sender: IpcSender,
) => MaybePromise<unknown>;

interface HandlerEntry {
  schema?: z.ZodTypeAny;
  /** Handlers without a payload schema take no arguments. */
  handler: (payload: unknown, sender: IpcSender) => MaybePromise<unknown>;
}

/**
 * Every IPC entry point, in one place, each with a validation schema.
 *
 * The registry is shared by the Electron main process and the dev host, so the
 * exact same code (and the same input validation) runs in both.
 */
export function createHandlers(ctx: HandlerContext): Record<string, HandlerEntry> {
  const { controller } = ctx;

  const withSchema = <K extends keyof IpcPayloadMap>(key: K, handler: Handler<K>): HandlerEntry => ({
    schema: ipcSchemas[key],
    handler: handler as (payload: unknown, sender: IpcSender) => MaybePromise<unknown>,
  });

  const noPayload = (handler: () => MaybePromise<unknown>): HandlerEntry => ({
    handler: () => handler(),
  });

  return {
    /* ------------------------------------------------------------ application */
    [CHANNELS.appSnapshot]: noPayload(() => controller.snapshot()),
    [CHANNELS.appDiagnostics]: noPayload(() => controller.diagnostics.run()),

    /* -------------------------------------------------------------- providers */
    [CHANNELS.providersList]: noPayload(() =>
      controller.listProviders(ctx.includeExperimentalProviders(), ctx.allowTestProvider),
    ),

    /* ------------------------------------------------------------------- auth */
    [CHANNELS.authStart]: withSchema('auth:start', (payload) =>
      controller.auth.startOAuth({
        providerId: payload.providerId as ProviderId,
        remoteName: payload.remoteName,
        clientId: payload.clientId,
        clientSecret: payload.clientSecret,
      }),
    ),
    [CHANNELS.authSubmitToken]: withSchema('auth:submitToken', (payload) =>
      controller.auth.submitToken(payload.sessionId, payload.token),
    ),
    [CHANNELS.authCancel]: withSchema('auth:cancel', async (payload) => {
      await controller.auth.cancel(payload.sessionId);
      return { cancelled: true };
    }),
    [CHANNELS.authCredentials]: withSchema('auth:credentials', (payload) =>
      controller.auth.submitCredentials({
        providerId: payload.providerId as ProviderId,
        remoteName: payload.remoteName,
        user: payload.user,
        password: payload.password,
        accessKeyId: payload.accessKeyId,
        secretAccessKey: payload.secretAccessKey,
        endpoint: payload.endpoint,
        region: payload.region,
        url: payload.url,
        vendor: payload.vendor,
      }),
    ),
    [CHANNELS.authStatus]: noPayload(() => controller.auth.list()),

    /* ---------------------------------------------------------------- remotes */
    [CHANNELS.remoteList]: noPayload(() => controller.config.listRemotes()),
    [CHANNELS.remoteCreate]: withSchema('remote:create', async (payload) => {
      if (payload.authSessionId) {
        await controller.auth.createRemoteFromSession(payload.authSessionId, {
          remoteName: payload.remoteName,
          remoteRoot: payload.remoteRoot,
          extra: payload.extra,
        });
      } else {
        const exists = await controller.engine.config.hasRemote(payload.remoteName);
        if (!exists) {
          throw makeError(
            ERROR_CODES.AUTH_REQUIRED,
            `The rclone remote "${payload.remoteName}" does not exist.`,
            {
              recoverable: true,
              remediation: 'Finish the provider sign-in before creating the CloudSSD drive.',
            },
          );
        }
      }
      return controller.createRemote({
        providerId: payload.providerId as ProviderId,
        remoteName: payload.remoteName,
        remoteRoot: payload.remoteRoot,
        displayName: payload.displayName,
        driveLetter: payload.driveLetter ?? null,
        mountPoint: payload.mountPoint ?? null,
      });
    }),
    [CHANNELS.remoteUpdate]: withSchema('remote:update', (payload) => {
      if (payload.patch.driveLetter !== undefined || payload.patch.mountPoint !== undefined) {
        return controller.mount.setTarget(payload.id, payload.patch);
      }
      return controller.config.updateRemote(payload.id, payload.patch);
    }),
    [CHANNELS.remoteRemove]: withSchema('remote:remove', (payload) => controller.removeRemote(payload.id)),
    [CHANNELS.remoteSelect]: withSchema('remote:select', async (payload) => {
      controller.config.setActiveRemote(payload.id);
      await controller.publish();
      return { selected: payload.id };
    }),
    [CHANNELS.remoteTest]: withSchema('remote:test', (payload) => controller.testConnection(payload.id)),
    [CHANNELS.remoteReconnect]: withSchema('remote:reconnect', (payload) => controller.reconnectAccount(payload.id)),
    [CHANNELS.remoteAbout]: withSchema('remote:about', (payload) => controller.refreshQuota(payload.id)),
    [CHANNELS.remoteBrowse]: withSchema('remote:browse', async (payload) => {
      const remote = controller.config.getRemote(payload.id);
      if (!remote) throw makeError(ERROR_CODES.NOT_FOUND, 'Account not found.');
      return controller.providers.browse(remote, payload.path);
    }),

    /* ------------------------------------------------------------------ mount */
    [CHANNELS.mountMount]: withSchema('mount:mount', (payload) => controller.mountDrive(payload.id)),
    [CHANNELS.mountUnmount]: withSchema('mount:unmount', (payload) =>
      controller.unmountDrive({ id: payload.id, force: payload.force }),
    ),
    [CHANNELS.mountSetTarget]: withSchema('mount:set-target', (payload) => {
      const id = payload.id ?? controller.config.get().activeRemoteId ?? undefined;
      if (!id) throw makeError(ERROR_CODES.NOT_FOUND, 'No account selected.');
      return controller.mount.setTarget(id, {
        driveLetter: payload.driveLetter ?? null,
        mountPoint: payload.mountPoint ?? null,
      });
    }),
    [CHANNELS.mountOpen]: noPayload(async () => {
      const remote = controller.config.getActiveRemote();
      if (!remote) throw makeError(ERROR_CODES.NOT_FOUND, 'No account selected.');
      const target = controller.mount.targetFor(remote);
      if (!target) throw makeError(ERROR_CODES.VALIDATION, 'This account has no drive target configured.');
      const opened = await ctx.platform.openInFileManager(target);
      return { opened };
    }),
    [CHANNELS.driveLetters]: noPayload(() => ctx.platform.listMountTargets()),

    /* ------------------------------------------------------------------ cache */
    [CHANNELS.cacheStats]: noPayload(() => controller.cache.stats()),
    [CHANNELS.cacheSetLimit]: withSchema('cache:setLimit', (payload) => controller.cache.setLimit(payload.limitBytes)),
    [CHANNELS.cacheSetDir]: withSchema('cache:setDir', (payload) => controller.cache.setDir(payload.dir)),
    [CHANNELS.cacheClear]: withSchema('cache:clear', () => controller.cache.clear()),
    [CHANNELS.cacheOpen]: noPayload(async () => {
      await controller.cache.openDir();
      return { opened: true };
    }),

    /* ---------------------------------------------------------------- offline */
    [CHANNELS.offlineList]: noPayload(() => controller.offline.list()),
    [CHANNELS.offlinePin]: withSchema('offline:pin', (payload) => controller.pinOffline(payload.remoteId, payload.remotePath)),
    [CHANNELS.offlineUnpin]: withSchema('offline:unpin', (payload) => controller.offline.unpin(payload.id)),
    [CHANNELS.offlineRefresh]: withSchema('offline:refresh', (payload) => controller.offline.refresh(payload.id)),
    [CHANNELS.offlineOpen]: noPayload(async () => {
      await controller.offline.openDir();
      return { opened: true };
    }),

    /* -------------------------------------------------------------- transfers */
    [CHANNELS.transferList]: noPayload(() => controller.transfers.list()),
    [CHANNELS.transferEnqueue]: withSchema('transfer:enqueue', (payload) =>
      controller.transfers.enqueue({
        kind: payload.kind as TransferKind,
        remoteId: payload.remoteId ?? null,
        srcUri: payload.srcUri,
        dstUri: payload.dstUri,
        mode: payload.mode,
      }),
    ),
    [CHANNELS.transferCancel]: withSchema('transfer:cancel', (payload) => controller.transfers.cancel(payload.id)),
    [CHANNELS.transferRetry]: withSchema('transfer:retry', (payload) => controller.transfers.retry(payload.id)),
    [CHANNELS.transferClearHistory]: noPayload(() => ({ cleared: controller.transfers.clearHistory() })),

    /* --------------------------------------------------------------- settings */
    [CHANNELS.settingsGet]: noPayload(() => controller.config.get()),
    [CHANNELS.settingsUpdate]: withSchema('settings:update', (payload) =>
      controller.updateSettings(payload as Partial<import('../../shared/types.js').AppSettings>),
    ),
    [CHANNELS.settingsReset]: noPayload(() => controller.resetSettings()),
    [CHANNELS.settingsOpenDataDir]: noPayload(async () => ({ opened: await ctx.openPath(controller.environment().dataDir) })),

    /* ----------------------------------------------------------- dependencies */
    [CHANNELS.dependencyStatus]: noPayload(async () => {
      const statuses = await controller.dependencyStatuses();
      statuses.push(await ctx.platform.detectWinFsp());
      return statuses;
    }),
    [CHANNELS.dependencyOpenDownload]: withSchema('deps:open-download', async (payload) => {
      const url = payload.id === 'rclone' ? 'https://rclone.org/downloads/' : 'https://winfsp.dev/rel/';
      return { opened: await ctx.openExternal(url) };
    }),
    [CHANNELS.dependencyInstallWinfsp]: withSchema('deps:install-winfsp', async (payload) => {
      // CloudSSD never downloads or installs a driver on its own: the user
      // downloads the official installer, then explicitly runs it here
      // (Windows will ask for administrator rights).
      if (payload.installerPath && ctx.installWinfspInstaller) {
        if (!/\.msi$/i.test(payload.installerPath)) {
          throw makeError(ERROR_CODES.VALIDATION, 'Select the WinFsp installer (.msi) you downloaded from winfsp.dev.');
        }
        return ctx.installWinfspInstaller(payload.installerPath);
      }
      await ctx.openExternal('https://winfsp.dev/rel/');
      return {
        started: false,
        detail:
          'Opened the official WinFsp download page. Install WinFsp (GPLv3 with runtime exception, administrator rights required), then mount the drive again.',
      };
    }),

    /* --------------------------------------------------------------- system */
    [CHANNELS.systemOpenPath]: withSchema('system:openPath', async (payload) => ({
      opened: await ctx.openPath(payload.target),
    })),
  };
}

export type HandlerRegistry = ReturnType<typeof createHandlers>;

/**
 * Executes a handler with validation and converts every failure into a
 * `BridgeResult` error, so the renderer never has to parse thrown exceptions.
 */
export async function invokeHandler(
  registry: HandlerRegistry,
  channel: string,
  payload: unknown,
  sender: IpcSender,
  logger: Logger,
): Promise<BridgeResult<unknown>> {
  const entry = registry[channel];
  if (!entry) {
    return { ok: false, error: makeError(ERROR_CODES.VALIDATION, `Unknown IPC channel "${channel}".`) };
  }
  let validated: unknown = payload;
  if (entry.schema) {
    const parsed = parseSafe(entry.schema, payload);
    if (!parsed.ok) {
      logger.warn('Rejected an IPC payload.', { channel, reason: parsed.message });
      return {
        ok: false,
        error: makeError(ERROR_CODES.VALIDATION, `Invalid request: ${parsed.message}`),
      };
    }
    validated = parsed.value;
  }
  try {
    const value = await entry.handler(validated, sender);
    return { ok: true, value };
  } catch (error) {
    const appError =
      (error as { code?: string })?.code && typeof (error as { message?: string }).message === 'string'
        ? (error as unknown as import('../../shared/types.js').AppError)
        : makeError(ERROR_CODES.INTERNAL, (error as Error).message ?? 'The operation failed.', {
            details: (error as Error).stack?.split('\n').slice(1, 3).join(' '),
            recoverable: true,
            remediation: 'Retry the action. If it fails again, open Diagnostics and export the report.',
          });
    logger.error('IPC handler failed.', { channel, code: appError.code, error: appError.message });
    return { ok: false, error: appError };
  }
}

/** Channels the renderer is allowed to call (used by the preload allow-list). */
export const RENDERER_CHANNELS: string[] = [
  CHANNELS.appSnapshot,
  CHANNELS.appDiagnostics,
  CHANNELS.providersList,
  CHANNELS.authStart,
  CHANNELS.authSubmitToken,
  CHANNELS.authCancel,
  CHANNELS.authCredentials,
  CHANNELS.authStatus,
  CHANNELS.remoteList,
  CHANNELS.remoteCreate,
  CHANNELS.remoteUpdate,
  CHANNELS.remoteRemove,
  CHANNELS.remoteSelect,
  CHANNELS.remoteTest,
  CHANNELS.remoteReconnect,
  CHANNELS.remoteAbout,
  CHANNELS.remoteBrowse,
  CHANNELS.mountMount,
  CHANNELS.mountUnmount,
  CHANNELS.mountSetTarget,
  CHANNELS.mountOpen,
  CHANNELS.driveLetters,
  CHANNELS.cacheStats,
  CHANNELS.cacheSetLimit,
  CHANNELS.cacheSetDir,
  CHANNELS.cacheClear,
  CHANNELS.cacheOpen,
  CHANNELS.offlineList,
  CHANNELS.offlinePin,
  CHANNELS.offlineUnpin,
  CHANNELS.offlineRefresh,
  CHANNELS.offlineOpen,
  CHANNELS.transferList,
  CHANNELS.transferEnqueue,
  CHANNELS.transferCancel,
  CHANNELS.transferRetry,
  CHANNELS.transferClearHistory,
  CHANNELS.settingsGet,
  CHANNELS.settingsUpdate,
  CHANNELS.settingsReset,
  CHANNELS.settingsOpenDataDir,
  CHANNELS.dependencyStatus,
  CHANNELS.dependencyOpenDownload,
  CHANNELS.dependencyInstallWinfsp,
  CHANNELS.systemOpenPath,
];
