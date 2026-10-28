import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { CSP_DIRECTIVES, isAllowedExternalUrl, isTrustedRendererUrl, WINDOW_WEB_PREFERENCES } from '../security.js';

export interface WindowOptions {
  preloadPath: string;
  rendererUrl: string | null;
  iconPath: string;
  devServerPort?: number;
  show: boolean;
}

/** Creates the single, hardened application window. */
export function createMainWindow(options: WindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    show: options.show,
    backgroundColor: '#0b0f17',
    title: 'CloudSSD',
    icon: options.iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      ...WINDOW_WEB_PREFERENCES,
      preload: options.preloadPath,
      // `additionalArguments` is intentionally unused: no renderer-controlled
      // values are ever passed to the main process.
    },
  });

  // Content Security Policy.
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP_DIRECTIVES],
      },
    });
  });

  // Navigation is limited to the application itself; everything else opens in
  // the user's browser (and only for allow-listed official sites).
  window.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(url, options.devServerPort)) return;
    event.preventDefault();
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  window.webContents.on('will-attach-webview', (event) => event.preventDefault());

  // Do not let the renderer ask for camera, microphone, geolocation, etc.
  window.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'clipboard-read' || permission === 'clipboard-sanitized-write');
  });

  return window;
}

/** Loads the packaged renderer or the Vite dev server URL. */
export async function loadRenderer(window: BrowserWindow, options: WindowOptions): Promise<void> {
  if (options.rendererUrl) {
    await window.loadURL(options.rendererUrl);
    return;
  }
  await window.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
}
