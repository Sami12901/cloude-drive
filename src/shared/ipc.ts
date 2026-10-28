import type {
  AppError,
  AppSettings,
  AppSnapshot,
  AuthSession,
  DependencyStatus,
  DiagnosticsReport,
  DirectoryEntry,
  DriveLetterInfo,
  OfflineEntry,
  ProviderDescriptor,
  QuotaInfo,
  RemoteBrowseResult,
  RemoteConfig,
  TransferJob,
} from './types.js';

/**
 * The single source of truth for the renderer <-> main contract.
 *
 *  - `CHANNELS` is the complete allow-list of IPC channels. The preload bridge
 *    only ever invokes channels listed here, and the main process only registers
 *    handlers for channels listed here.
 *  - `CloudSsdApi` is implemented by the preload bridge and consumed by the
 *    renderer, so a mismatch is a compile error rather than a runtime surprise.
 */

export const CHANNELS = {
  appSnapshot: 'app:snapshot',
  appDiagnostics: 'app:diagnostics',
  appQuit: 'app:quit',
  appOpenExternal: 'app:open-external',

  providersList: 'providers:list',

  authStart: 'auth:start',
  authSubmitToken: 'auth:submit-token',
  authCancel: 'auth:cancel',
  authCredentials: 'auth:credentials',
  authStatus: 'auth:status',

  remoteList: 'remote:list',
  remoteCreate: 'remote:create',
  remoteUpdate: 'remote:update',
  remoteRemove: 'remote:remove',
  remoteSelect: 'remote:select',
  remoteTest: 'remote:test',
  remoteReconnect: 'remote:reconnect',
  remoteAbout: 'remote:about',
  remoteBrowse: 'remote:browse',

  mountMount: 'mount:mount',
  mountUnmount: 'mount:unmount',
  mountSetTarget: 'mount:set-target',
  mountOpen: 'mount:open',
  driveLetters: 'drives:list',

  cacheStats: 'cache:stats',
  cacheSetLimit: 'cache:set-limit',
  cacheSetDir: 'cache:set-dir',
  cacheClear: 'cache:clear',
  cacheOpen: 'cache:open',

  offlineList: 'offline:list',
  offlinePin: 'offline:pin',
  offlineUnpin: 'offline:unpin',
  offlineRefresh: 'offline:refresh',
  offlineOpen: 'offline:open',

  transferList: 'transfers:list',
  transferEnqueue: 'transfers:enqueue',
  transferCancel: 'transfers:cancel',
  transferRetry: 'transfers:retry',
  transferClearHistory: 'transfers:clear-history',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsReset: 'settings:reset',
  settingsOpenDataDir: 'settings:open-data-dir',

  dependencyStatus: 'deps:status',
  dependencyOpenDownload: 'deps:open-download',
  dependencyInstallWinfsp: 'deps:install-winfsp',

  systemOpenPath: 'system:open-path',
  systemEvent: 'cloudssd:event',
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

export const ALL_CHANNELS: string[] = Object.values(CHANNELS);

export type BridgeEvent =
  | { type: 'snapshot'; snapshot: AppSnapshot }
  | { type: 'auth'; session: AuthSession }
  | { type: 'notification'; level: 'info' | 'warn' | 'error'; title: string; body?: string }
  | { type: 'log'; level: 'error' | 'info' | 'debug'; message: string };

/** Every bridge method returns a discriminated result — no thrown IPC errors. */
export type BridgeResult<T> = { ok: true; value: T } | { ok: false; error: AppError };

export interface CloudSsdApi {
  getSnapshot(): Promise<BridgeResult<AppSnapshot>>;
  getDiagnostics(): Promise<BridgeResult<DiagnosticsReport>>;

  listProviders(): Promise<BridgeResult<ProviderDescriptor[]>>;

  startAuth(input: {
    providerId: string;
    remoteName?: string;
    clientId?: string;
    clientSecret?: string;
  }): Promise<BridgeResult<AuthSession>>;
  submitAuthToken(input: { sessionId: string; token: string }): Promise<BridgeResult<AuthSession>>;
  cancelAuth(input: { sessionId: string }): Promise<BridgeResult<{ cancelled: boolean }>>;
  submitCredentials(input: Record<string, unknown>): Promise<BridgeResult<AuthSession>>;

  listRemotes(): Promise<BridgeResult<RemoteConfig[]>>;
  createRemote(input: {
    providerId: string;
    remoteName: string;
    remoteRoot?: string;
    displayName?: string;
    driveLetter?: string | null;
    mountPoint?: string | null;
    /** Present when the remote is created from a completed OAuth session. */
    authSessionId?: string;
    extra?: Record<string, string>;
  }): Promise<BridgeResult<RemoteConfig>>;
  updateRemote(input: {
    id: string;
    patch: {
      displayName?: string;
      remoteRoot?: string;
      driveLetter?: string | null;
      mountPoint?: string | null;
    };
  }): Promise<BridgeResult<RemoteConfig>>;
  removeRemote(input: { id: string; confirmed: true }): Promise<BridgeResult<{ removed: boolean }>>;
  selectRemote(input: { id: string | null }): Promise<BridgeResult<{ selected: string | null }>>;
  testRemote(input?: { id?: string }): Promise<BridgeResult<{ ok: boolean; detail: string; latencyMs: number }>>;
  aboutRemote(input?: { id?: string }): Promise<BridgeResult<QuotaInfo>>;
  reconnectRemote(input: { id: string }): Promise<BridgeResult<{ ok: boolean; detail: string; authUrl?: string }>>;
  browseRemote(input: { id: string; path?: string }): Promise<BridgeResult<RemoteBrowseResult>>;

  mount(input?: { id?: string }): Promise<BridgeResult<{ pid: number | null; target: string }>>;
  unmount(input?: { id?: string; force?: boolean }): Promise<BridgeResult<{ unmounted: boolean }>>;
  setMountTarget(input: {
    id?: string;
    driveLetter?: string | null;
    mountPoint?: string | null;
  }): Promise<BridgeResult<RemoteConfig>>;
  openMount(input?: { id?: string }): Promise<BridgeResult<{ opened: boolean }>>;
  listDriveLetters(): Promise<BridgeResult<DriveLetterInfo[]>>;

  cacheStats(): Promise<BridgeResult<AppSnapshot['cache']>>;
  setCacheLimit(input: { limitBytes: number }): Promise<BridgeResult<AppSnapshot['cache']>>;
  setCacheDir(input: { dir: string }): Promise<BridgeResult<AppSnapshot['cache']>>;
  clearCache(input: { confirmed: true }): Promise<BridgeResult<{ removedBytes: number; skipped: number }>>;
  openCacheDir(): Promise<BridgeResult<{ opened: boolean }>>;

  listOffline(): Promise<BridgeResult<OfflineEntry[]>>;
  pinOffline(input: { remoteId: string; remotePath: string }): Promise<BridgeResult<OfflineEntry>>;
  unpinOffline(input: { id: string; confirmed: true }): Promise<BridgeResult<{ removed: boolean }>>;
  refreshOffline(input: { id: string }): Promise<BridgeResult<OfflineEntry>>;
  openOfflineDir(): Promise<BridgeResult<{ opened: boolean }>>;

  listTransfers(): Promise<BridgeResult<{ running: TransferJob[]; queued: TransferJob[]; history: TransferJob[] }>>;
  enqueueTransfer(input: {
    kind: TransferJob['kind'];
    remoteId?: string | null;
    srcUri: string;
    dstUri: string;
    mode?: 'copy' | 'copyto';
  }): Promise<BridgeResult<TransferJob>>;
  cancelTransfer(input: { id: string }): Promise<BridgeResult<{ cancelled: boolean }>>;
  retryTransfer(input: { id: string }): Promise<BridgeResult<TransferJob>>;
  clearTransferHistory(): Promise<BridgeResult<{ cleared: number }>>;

  getSettings(): Promise<BridgeResult<AppSettings>>;
  updateSettings(patch: Partial<AppSettings>): Promise<BridgeResult<AppSettings>>;
  resetSettings(): Promise<BridgeResult<AppSettings>>;
  openDataDir(): Promise<BridgeResult<{ opened: boolean }>>;

  dependencyStatus(): Promise<BridgeResult<DependencyStatus[]>>;
  openDependencyDownload(input: { id: string }): Promise<BridgeResult<{ opened: boolean }>>;
  installWinfsp(input: { confirmed: true }): Promise<BridgeResult<{ started: boolean; detail: string }>>;

  openPath(input: { target: string }): Promise<BridgeResult<{ opened: boolean }>>;
  openExternal(input: { url: string }): Promise<BridgeResult<{ opened: boolean }>>;
  listDirectoryForTest?(input: { path: string }): Promise<BridgeResult<DirectoryEntry[]>>;

  onEvent(listener: (event: BridgeEvent) => void): () => void;
}

declare global {
  interface Window {
    cloudssd?: CloudSsdApi;
    __CLOUDSSD_DEV_HOST__?: boolean;
  }
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export const ERROR_CODES = {
  VALIDATION: 'validation_error',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  DEPENDENCY_MISSING: 'dependency_missing',
  AUTH_REQUIRED: 'auth_required',
  AUTH_EXPIRED: 'auth_expired',
  AUTH_FAILED: 'auth_failed',
  MOUNT_FAILED: 'mount_failed',
  MOUNT_CONFLICT: 'mount_conflict',
  MOUNT_STALE: 'mount_stale',
  NETWORK: 'network_error',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  QUOTA_EXCEEDED: 'quota_exceeded',
  PERMISSION_DENIED: 'permission_denied',
  DISK_FULL: 'disk_full',
  ENGINE_ERROR: 'engine_error',
  CREDENTIAL_STORE: 'credential_store_error',
  INTERNAL: 'internal_error',
  CANCELLED: 'cancelled',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export function makeError(
  code: ErrorCode | string,
  message: string,
  options: { details?: string; recoverable?: boolean; remediation?: string } = {},
): AppError {
  return {
    code,
    message,
    details: options.details,
    recoverable: options.recoverable ?? false,
    remediation: options.remediation,
    at: new Date().toISOString(),
  };
}
