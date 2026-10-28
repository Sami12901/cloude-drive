import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS } from '../shared/ipc.js';
import type { BridgeEvent, BridgeResult, CloudSsdApi } from '../shared/ipc.js';

/**
 * The only bridge between the renderer and the main process.
 *
 * Properties:
 *  - a fixed allow-list of channels (no arbitrary `send`, no `invoke` with a
 *    renderer-supplied channel name);
 *  - every payload crosses as a plain object and is validated again in the main
 *    process with zod;
 *  - no Node.js integration, no `require`, no filesystem access.
 */

type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];

function invoke<T>(channel: Channel, payload?: unknown): Promise<BridgeResult<T>> {
  return ipcRenderer.invoke(channel, payload) as Promise<BridgeResult<T>>;
}

const api: CloudSsdApi = {
  getSnapshot: () => invoke(CHANNELS.appSnapshot),
  getDiagnostics: () => invoke(CHANNELS.appDiagnostics),

  listProviders: () => invoke(CHANNELS.providersList),

  startAuth: (input) => invoke(CHANNELS.authStart, input),
  submitAuthToken: (input) => invoke(CHANNELS.authSubmitToken, input),
  cancelAuth: (input) => invoke(CHANNELS.authCancel, input),
  submitCredentials: (input) => invoke(CHANNELS.authCredentials, input),

  listRemotes: () => invoke(CHANNELS.remoteList),
  createRemote: (input) => invoke(CHANNELS.remoteCreate, input),
  updateRemote: (input) => invoke(CHANNELS.remoteUpdate, input),
  removeRemote: (input) => invoke(CHANNELS.remoteRemove, input),
  selectRemote: (input) => invoke(CHANNELS.remoteSelect, input),
  testRemote: (input) => invoke(CHANNELS.remoteTest, input ?? {}),
  aboutRemote: (input) => invoke(CHANNELS.remoteAbout, input ?? {}),
  reconnectRemote: (input) => invoke(CHANNELS.remoteReconnect, input),
  browseRemote: (input) => invoke(CHANNELS.remoteBrowse, input),

  mount: (input) => invoke(CHANNELS.mountMount, input ?? {}),
  unmount: (input) => invoke(CHANNELS.mountUnmount, input ?? {}),
  setMountTarget: (input) => invoke(CHANNELS.mountSetTarget, input),
  openMount: () => invoke(CHANNELS.mountOpen),
  listDriveLetters: () => invoke(CHANNELS.driveLetters),

  cacheStats: () => invoke(CHANNELS.cacheStats),
  setCacheLimit: (input) => invoke(CHANNELS.cacheSetLimit, input),
  setCacheDir: (input) => invoke(CHANNELS.cacheSetDir, input),
  clearCache: (input) => invoke(CHANNELS.cacheClear, input),
  openCacheDir: () => invoke(CHANNELS.cacheOpen),

  listOffline: () => invoke(CHANNELS.offlineList),
  pinOffline: (input) => invoke(CHANNELS.offlinePin, input),
  unpinOffline: (input) => invoke(CHANNELS.offlineUnpin, input),
  refreshOffline: (input) => invoke(CHANNELS.offlineRefresh, input),
  openOfflineDir: () => invoke(CHANNELS.offlineOpen),

  listTransfers: () => invoke(CHANNELS.transferList),
  enqueueTransfer: (input) => invoke(CHANNELS.transferEnqueue, input),
  cancelTransfer: (input) => invoke(CHANNELS.transferCancel, input),
  retryTransfer: (input) => invoke(CHANNELS.transferRetry, input),
  clearTransferHistory: () => invoke(CHANNELS.transferClearHistory),

  getSettings: () => invoke(CHANNELS.settingsGet),
  updateSettings: (patch) => invoke(CHANNELS.settingsUpdate, patch),
  resetSettings: () => invoke(CHANNELS.settingsReset),
  openDataDir: () => invoke(CHANNELS.settingsOpenDataDir),

  dependencyStatus: () => invoke(CHANNELS.dependencyStatus),
  openDependencyDownload: (input) => invoke(CHANNELS.dependencyOpenDownload, input),
  installWinfsp: (input) => invoke(CHANNELS.dependencyInstallWinfsp, input),

  openPath: (input) => invoke(CHANNELS.systemOpenPath, input),
  openExternal: (input) => invoke(CHANNELS.appOpenExternal, input),

  onEvent: (listener: (event: BridgeEvent) => void) => {
    const handler = (_event: unknown, payload: BridgeEvent) => listener(payload);
    ipcRenderer.on(CHANNELS.systemEvent, handler);
    return () => {
      ipcRenderer.removeListener(CHANNELS.systemEvent, handler);
    };
  },
};

contextBridge.exposeInMainWorld('cloudssd', api);

export type { CloudSsdApi };
