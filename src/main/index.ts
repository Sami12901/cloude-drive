import { app, BrowserWindow, dialog, ipcMain, shell, Menu, Notification, safeStorage } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_CHANNELS, CHANNELS } from '../shared/ipc.js';
import type { BridgeEvent, BridgeResult } from '../shared/ipc.js';
import type { AppSnapshot } from '../shared/types.js';
import { createPlatformAdapter } from './platform/index.js';
import { resolvePaths, sleep } from './services/context.js';
import { AppController } from './services/app-controller.js';
import { FileLogger } from './services/logging.js';
import { SafeStorageProtection } from './services/credential-vault.js';
import { createHandlers, invokeHandler, RENDERER_CHANNELS, type HandlerRegistry } from './ipc/handlers.js';
import { isAllowedExternalUrl, isTrustedRendererUrl } from './security.js';
import { createMainWindow, loadRenderer, type WindowOptions } from './app/window.js';
import { iconPath, TrayController } from './app/tray.js';

const DEV_SERVER_PORT = 5173;
const IS_DEV = !app.isPackaged && process.env.CLOUDSSD_DEV_SERVER === '1';

let mainWindow: BrowserWindow | null = null;
let controller: AppController | null = null;
let tray: TrayController | null = null;
let logger: FileLogger | null = null;
let handlers: HandlerRegistry | null = null;

/* ------------------------------------------------------------------ bootstrap */

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.disableHardwareAcceleration?.();

app.whenReady().then(() => void bootstrap()).catch((error) => {
  // eslint-disable-next-line no-console
  console.error('CloudSSD failed to start:', error);
  app.quit();
});

async function bootstrap(): Promise<void> {
  const paths = resolvePaths({ platform: process.platform });
  const fileLogger = new FileLogger({
    dir: paths.logDir,
    level: 'info',
    maxBytes: 16 * 1024 * 1024,
    retentionDays: 14,
    homeDir: paths.homeDir,
  });
  logger = fileLogger;

  const platform = createPlatformAdapter(process.platform, {
    setLaunchOnLogin: async (enabled: boolean, args?: string[]) => {
      app.setLoginItemSettings({ openAtLogin: enabled, args });
      return app.getLoginItemSettings().openAtLogin === enabled;
    },
  });

  const appController = new AppController({
    paths,
    platform,
    logger: fileLogger,
    secrets: new SafeStorageProtection(safeStorage, fileLogger),
    emit: (event) => emitEvent(event),
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    openExternal: async (url) => {
      if (!isAllowedExternalUrl(url)) return false;
      await shell.openExternal(url);
      return true;
    },
    resourcesDir: app.isPackaged ? process.resourcesPath : join(__dirname, '..', '..', 'tools'),
  });
  controller = appController;

  handlers = createHandlers({
    controller: appController,
    platform,
    logger: fileLogger.child('ipc'),
    openExternal: async (url) => {
      if (!isAllowedExternalUrl(url)) return false;
      await shell.openExternal(url);
      return true;
    },
    openPath: async (target) => {
      const result = await shell.openPath(target);
      return result === '' || result === target;
    },
    installWinfspInstaller: async (installerPath) => runMsiInstaller(installerPath, fileLogger),
    allowTestProvider: !app.isPackaged || process.env.CLOUDSSD_ENABLE_TEST_PROVIDER === '1',
    includeExperimentalProviders: () => appController.config.get().ui.language === 'en' && process.env.CLOUDSSD_EXPERIMENTAL_PROVIDERS === '1',
  });

  registerIpc(handlers, fileLogger);

  await appController.initialize();

  const windowOptions: WindowOptions = {
    preloadPath: join(__dirname, '..', 'preload', 'index.js'),
    rendererUrl: IS_DEV ? `http://127.0.0.1:${DEV_SERVER_PORT}` : null,
    iconPath: iconPath(app.isPackaged ? process.resourcesPath : join(__dirname, '..', '..', 'build')),
    devServerPort: DEV_SERVER_PORT,
    show: !(appController.config.get().startup.startMinimizedToTray && process.argv.includes('--start-minimized')),
  };
  mainWindow = createMainWindow(windowOptions);
  mainWindow.on('close', (event) => {
    if (appController.config.get().startup.minimizeToTrayOnClose && tray?.enabled) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  await loadRenderer(mainWindow, windowOptions);

  setupTray(appController, fileLogger);
  setupApplicationMenu();

  // Keep the dashboard honest: refresh the snapshot periodically.
  setInterval(() => void appController.publish(), 5000).unref?.();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && mainWindow) mainWindow.show();
  });
  app.on('before-quit', () => {
    void appController.shutdown();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

/* ---------------------------------------------------------------- IPC plumbing */

function registerIpc(registry: HandlerRegistry, log: FileLogger): void {
  const allowed = new Set(RENDERER_CHANNELS);
  for (const channel of ALL_CHANNELS) {
    if (!allowed.has(channel)) continue;
    ipcMain.handle(channel, async (event, payload: unknown): Promise<BridgeResult<unknown>> => {
      const senderUrl = event.sender?.getURL?.() ?? '';
      const trusted = app.isPackaged
        ? isTrustedRendererUrl(senderUrl) || senderUrl.startsWith('file://')
        : isTrustedRendererUrl(senderUrl, DEV_SERVER_PORT);
      if (!trusted) {
        log.error('Blocked an IPC request from an untrusted sender.', { senderUrl, channel });
        return { ok: false, error: { code: 'validation_error', message: 'Blocked request from an unknown origin.', recoverable: false } };
      }
      return invokeHandler(registry, channel, payload, { id: event.sender.id, url: senderUrl }, log);
    });
  }

  ipcMain.handle(CHANNELS.appOpenExternal, async (_event, payload: unknown) => {
    const url = (payload as { url?: string })?.url ?? '';
    if (!isAllowedExternalUrl(url)) return { ok: false, error: { code: 'validation_error', message: 'URL not allowed.', recoverable: false } };
    await shell.openExternal(url);
    return { ok: true, value: { opened: true } };
  });

  // Showing a native file dialog must never accept an executable target.
  ipcMain.handle('dialog:pick-winfsp-installer', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select the WinFsp installer you downloaded',
      filters: [{ name: 'Windows Installer', extensions: ['msi'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: true, value: { path: null } };
    return { ok: true, value: { path: result.filePaths[0] } };
  });
}

function emitEvent(event: BridgeEvent): void {
  if (event.type === 'snapshot' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(CHANNELS.systemEvent, event);
    tray?.update(event.snapshot);
    return;
  }
  if (event.type === 'notification' && Notification.isSupported()) {
    const settings = controller?.config.get();
    if (settings?.notifications.enabled) {
      new Notification({ title: event.title, body: event.body ?? '' }).show();
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(CHANNELS.systemEvent, event);
  }
}

/* ---------------------------------------------------------------------- tray */

function setupTray(appController: AppController, log: FileLogger): void {
  tray = new TrayController(iconPath(app.isPackaged ? process.resourcesPath : join(__dirname, '..', '..', 'build')), {
    show: () => mainWindow?.show(),
    mount: async () => {
      try {
        await appController.mountDrive();
      } catch (error) {
        log.error('Tray mount failed.', { error: (error as Error).message });
      }
    },
    unmount: () => appController.unmountDrive().then(() => undefined),
    openDrive: async () => {
      const remote = appController.config.getActiveRemote();
      const target = remote ? appController.mount.targetFor(remote) : null;
      if (target) await shell.openPath(target);
    },
    quit: () => app.quit(),
  });

  if (appController.config.get().startup.minimizeToTrayOnClose) tray.enable();
}

function setupApplicationMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? ([{ role: 'appMenu' }] as Electron.MenuItemConstructorOptions[]) : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'User guide',
          click: () => void shell.openExternal('https://rclone.org/docs/'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------ WinFsp installer */

/**
 * Runs the WinFsp MSI the user downloaded, using msiexec with an argument array.
 * Windows will ask for administrator rights (WinFsp installs a filesystem
 * driver); CloudSSD never installs it silently and never downloads it.
 */
async function runMsiInstaller(installerPath: string, log: FileLogger): Promise<{ started: boolean; detail: string }> {
  if (!existsSync(installerPath) || !/\.msi$/i.test(installerPath)) {
    return { started: false, detail: 'The selected file is not an installer (.msi).' };
  }
  if (process.platform !== 'win32') {
    return { started: false, detail: 'WinFsp is only needed on Windows.' };
  }
  log.info('Starting the WinFsp installer at the user request.', { installerPath });
  return new Promise((resolve) => {
    const child = spawn('msiexec.exe', ['/i', installerPath], { stdio: 'ignore', detached: false });
    child.on('error', (error: Error) => resolve({ started: false, detail: error.message }));
    child.on('close', (code) =>
      resolve({
        started: code === 0,
        detail:
          code === 0
            ? 'WinFsp installation finished. Mount the drive again.'
            : `The installer exited with code ${code ?? 'unknown'}.`,
      }),
    );
  });
}

export { controller, logger };
export type { AppSnapshot };
export { sleep };
