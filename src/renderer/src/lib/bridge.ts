import type { BridgeEvent, BridgeResult, CloudSsdApi } from '@shared/ipc.js';
import { CHANNELS } from '@shared/ipc.js';

/**
 * Renderer entry point to the application.
 *
 * In the packaged app this is the Electron preload bridge (`window.cloudssd`).
 * When the renderer runs against the dev host (`VITE_DEV_HOST=1`) the same typed
 * API is served over HTTP + SSE by a real instance of the main-process services,
 * so the UI is never exercised against fake data.
 */

const DEV_HOST = import.meta.env.VITE_DEV_HOST === '1';

function devHostApi(): CloudSsdApi {
  const call = async <T>(channel: string, payload?: unknown): Promise<BridgeResult<T>> => {
    const response = await fetch(`/api/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });
    return (await response.json()) as BridgeResult<T>;
  };

  return {
    getSnapshot: () => call(CHANNELS.appSnapshot),
    getDiagnostics: () => call(CHANNELS.appDiagnostics),
    listProviders: () => call(CHANNELS.providersList),
    startAuth: (input) => call(CHANNELS.authStart, input),
    submitAuthToken: (input) => call(CHANNELS.authSubmitToken, input),
    cancelAuth: (input) => call(CHANNELS.authCancel, input),
    submitCredentials: (input) => call(CHANNELS.authCredentials, input),
    listRemotes: () => call(CHANNELS.remoteList),
    createRemote: (input) => call(CHANNELS.remoteCreate, input),
    updateRemote: (input) => call(CHANNELS.remoteUpdate, input),
    removeRemote: (input) => call(CHANNELS.remoteRemove, input),
    selectRemote: (input) => call(CHANNELS.remoteSelect, input),
    testRemote: (input) => call(CHANNELS.remoteTest, input ?? {}),
    aboutRemote: (input) => call(CHANNELS.remoteAbout, input ?? {}),
    reconnectRemote: (input) => call(CHANNELS.remoteReconnect, input),
    browseRemote: (input) => call(CHANNELS.remoteBrowse, input),
    mount: (input) => call(CHANNELS.mountMount, input ?? {}),
    unmount: (input) => call(CHANNELS.mountUnmount, input ?? {}),
    setMountTarget: (input) => call(CHANNELS.mountSetTarget, input),
    openMount: () => call(CHANNELS.mountOpen),
    listDriveLetters: () => call(CHANNELS.driveLetters),
    cacheStats: () => call(CHANNELS.cacheStats),
    setCacheLimit: (input) => call(CHANNELS.cacheSetLimit, input),
    setCacheDir: (input) => call(CHANNELS.cacheSetDir, input),
    clearCache: (input) => call(CHANNELS.cacheClear, input),
    openCacheDir: () => call(CHANNELS.cacheOpen),
    listOffline: () => call(CHANNELS.offlineList),
    pinOffline: (input) => call(CHANNELS.offlinePin, input),
    unpinOffline: (input) => call(CHANNELS.offlineUnpin, input),
    refreshOffline: (input) => call(CHANNELS.offlineRefresh, input),
    openOfflineDir: () => call(CHANNELS.offlineOpen),
    listTransfers: () => call(CHANNELS.transferList),
    enqueueTransfer: (input) => call(CHANNELS.transferEnqueue, input),
    cancelTransfer: (input) => call(CHANNELS.transferCancel, input),
    retryTransfer: (input) => call(CHANNELS.transferRetry, input),
    clearTransferHistory: () => call(CHANNELS.transferClearHistory),
    getSettings: () => call(CHANNELS.settingsGet),
    updateSettings: (patch) => call(CHANNELS.settingsUpdate, patch),
    resetSettings: () => call(CHANNELS.settingsReset),
    openDataDir: () => call(CHANNELS.settingsOpenDataDir),
    dependencyStatus: () => call(CHANNELS.dependencyStatus),
    openDependencyDownload: (input) => call(CHANNELS.dependencyOpenDownload, input),
    installWinfsp: (input) => call(CHANNELS.dependencyInstallWinfsp, input),
    openPath: (input) => call(CHANNELS.systemOpenPath, input),
    openExternal: (input) => call(CHANNELS.appOpenExternal, input),
    onEvent: (listener) => {
      const source = new EventSource('/events');
      source.onmessage = (message) => {
        try {
          listener(JSON.parse(message.data) as BridgeEvent);
        } catch {
          /* ignore malformed keep-alive frames */
        }
      };
      return () => source.close();
    },
  };
}

function missingApi(): CloudSsdApi {
  const fail = (): Promise<BridgeResult<never>> =>
    Promise.resolve({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'The CloudSSD bridge is not available in this context.',
        recoverable: false,
      },
    });
  return new Proxy({} as CloudSsdApi, {
    get: () => fail,
  });
}

export const api: CloudSsdApi = DEV_HOST ? devHostApi() : (window.cloudssd ?? missingApi());

export const isDevHost = DEV_HOST;
