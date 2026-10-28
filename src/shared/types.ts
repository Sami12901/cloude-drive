/**
 * Shared domain model for CloudSSD.
 *
 * Everything in this file is plain data: it is safe to send over IPC, to log,
 * and to render. Secrets are NEVER part of these types — a remote only ever
 * carries an opaque `secretRef` that points into the credential vault.
 */

export type ProviderId = 'gdrive' | 'onedrive' | 'dropbox' | 'webdav' | 's3' | 'local';

/** How a provider proves identity. */
export type AuthMode =
  | 'oauth' // browser/OAuth2 flow driven by rclone (rclone authorize / config reconnect)
  | 'basic' // user name + password (WebDAV, some S3)
  | 'static'; // access key id + secret (S3-compatible)

export type ReleaseStatus = 'supported' | 'beta' | 'not-ready' | 'testing-only';

export interface ProviderDescriptor {
  id: ProviderId;
  /** rclone backend type, e.g. `drive`. */
  backend: string;
  name: string;
  description: string;
  authMode: AuthMode;
  releaseStatus: ReleaseStatus;
  /** Scopes / permissions the user will be asked to grant. */
  permissions: string[];
  /** Whether `rclone about` returns a trustworthy quota. */
  supportsQuota: boolean;
  supportsHashes: boolean;
  /** Provider specific hard limits, null when unknown or unlimited. */
  maxFileSizeBytes: number | null;
  caseSensitive: boolean;
  limitations: string[];
  docsUrl: string;
  /** True when the provider needs a user supplied OAuth client id/secret. */
  requiresOwnOAuthClient?: boolean;
  /** Notes shown in the wizard, kept short and factual. */
  notes?: string[];
}

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'degraded'
  | 'offline'
  | 'auth-expired'
  | 'mount-failed'
  | 'provider-unavailable';

export type MountStatus = 'unmounted' | 'mounting' | 'mounted' | 'unmounting' | 'failed' | 'stale';

export type AuthState = 'unknown' | 'ok' | 'expired' | 'error';

export interface AppError {
  code: string;
  message: string;
  /** Sanitized technical detail (never contains tokens or credentials). */
  details?: string;
  recoverable: boolean;
  /** Concrete next step shown to the user. */
  remediation?: string;
  at?: string;
}

export interface RemoteConfig {
  id: string;
  providerId: ProviderId;
  /** rclone remote name (`gdrive:`), unique and shell-safe by validation. */
  remoteName: string;
  /** Path inside the remote, e.g. `` (root) or `CloudSSD`. */
  remoteRoot: string;
  displayName: string;
  accountLabel?: string;
  /** Windows drive letter without colon, e.g. `Z`. Null on POSIX. */
  driveLetter: string | null;
  /** POSIX mount directory (test/CI and Linux builds). Null on Windows. */
  mountPoint: string | null;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt?: string;
  lastError?: AppError;
  authState: AuthState;
  /** Opaque reference into the credential vault — never a secret itself. */
  secretRef?: string;
  /** True while the connection wizard has not finished for this remote. */
  incomplete?: boolean;
}

/**
 * Mode A = streaming, Mode B = balanced cache,
 * `offline-pinned` additionally enables Mode C (selected offline files).
 */
export type VfsCacheMode = 'streaming' | 'balanced';

export interface CacheSettings {
  mode: VfsCacheMode;
  dir: string;
  limitBytes: number;
  maxAgeSeconds: number;
  chunkSizeBytes: number;
  readAheadBytes: number;
  /** How long a written file may stay in cache before upload (write-back). */
  writeBackSeconds: number;
  /** How often the engine checks the cache for safely removable data. */
  cleanupIntervalSeconds: number;
  /** Reserve this much space on the cache volume (`--vfs-cache-min-free-space`). */
  minFreeSpaceBytes: number | null;
}

export interface OfflineSettings {
  enabled: boolean;
  dir: string;
}

export interface TransferSettings {
  concurrency: number;
  retries: number;
  backoffBaseMs: number;
  maxBackoffMs: number;
  /** rclone bandwidth spec, e.g. `10M`, or null for unlimited. */
  bandwidthLimit: string | null;
}

export interface StartupSettings {
  launchOnLogin: boolean;
  autoMountOnStart: boolean;
  restoreLastMount: boolean;
  startMinimizedToTray: boolean;
  minimizeToTrayOnClose: boolean;
}

export interface MountSettings {
  autoReconnect: boolean;
  maxReconnectAttempts: number;
  reconnectBackoffMs: number;
  healthCheckIntervalMs: number;
  defaultDriveLetter: string;
  readOnly: boolean;
  allowOther: boolean;
}

export interface NotificationSettings {
  enabled: boolean;
  mountEvents: boolean;
  transferCompletion: boolean;
  errors: boolean;
}

export interface UiSettings {
  theme: 'dark' | 'light' | 'system';
  language: string;
  density: 'comfortable' | 'compact';
}

export interface DiagnosticsSettings {
  logLevel: 'error' | 'info' | 'debug';
  retentionDays: number;
  maxLogBytes: number;
}

export interface AppSettings {
  schemaVersion: number;
  remotes: RemoteConfig[];
  activeRemoteId: string | null;
  cache: CacheSettings;
  offline: OfflineSettings;
  transfers: TransferSettings;
  startup: StartupSettings;
  mount: MountSettings;
  notifications: NotificationSettings;
  ui: UiSettings;
  diagnostics: DiagnosticsSettings;
}

export type OfflineState =
  | 'queued'
  | 'downloading'
  | 'available'
  | 'outdated'
  | 'failed'
  | 'removing';

export interface OfflineEntry {
  id: string;
  remoteId: string;
  /** Path relative to the remote root, POSIX separators. */
  remotePath: string;
  isDir: boolean;
  /** Absolute local path of the pinned copy. */
  localPath: string;
  state: OfflineState;
  sizeBytes: number | null;
  mtime: string | null;
  hash: string | null;
  pinnedAt: string;
  lastVerifiedAt?: string;
  error?: AppError;
}

export type TransferKind = 'download' | 'upload' | 'copy' | 'offline-pin';

export type TransferState =
  | 'queued'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface TransferJob {
  id: string;
  kind: TransferKind;
  remoteId: string | null;
  srcUri: string;
  dstUri: string;
  /**
   * `copy` copies the *contents* of a source folder into the destination
   * folder; `copyto` copies one object to an exact destination path. Using the
   * wrong one turns a pinned file into a folder containing that file.
   */
  mode?: 'copy' | 'copyto';
  state: TransferState;
  attempt: number;
  maxAttempts: number;
  bytes: number;
  totalBytes: number | null;
  speedBps: number | null;
  etaSeconds: number | null;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: AppError;
}

export interface QuotaInfo {
  available: boolean;
  totalBytes: number | null;
  usedBytes: number | null;
  freeBytes: number | null;
  trashedBytes: number | null;
  otherBytes: number | null;
  note?: string;
}

export interface DiskInfo {
  /** Free space on the drive that hosts the cache directory. */
  cacheDirFreeBytes: number | null;
  cacheDirTotalBytes: number | null;
  /** Free space on the mount target drive (the drive letter host volume). */
  mountTargetFreeBytes: number | null;
}

export interface CacheInfo {
  available: boolean;
  dir: string;
  dirWritable: boolean;
  mode: VfsCacheMode;
  usedBytes: number | null;
  limitBytes: number;
  files: number | null;
  /** Files rclone still has to upload: these must never be evicted. */
  pendingUploads: number;
  uploading: number;
  inUse: number;
  note?: string;
}

export interface DependencyStatus {
  id: 'rclone' | 'winfsp';
  required: boolean;
  installed: boolean;
  version: string | null;
  path: string | null;
  /** Where the user can get it (official source only). */
  downloadUrl?: string;
  license?: string;
  message: string;
  remediation?: string;
}

export interface EngineInfo {
  rclonePath: string | null;
  rcloneVersion: string | null;
  rcloneAvailable: boolean;
  /** Recommended path for the bundled/expected binary. */
  expectedRclonePath: string | null;
  winfsp: DependencyStatus;
  mountPid: number | null;
  mountStartedAt: string | null;
  rcConnected: boolean;
  restartCount: number;
}

export interface EnvironmentInfo {
  /** `process.platform` value (`win32`, `darwin`, `linux`). */
  platform: string;
  arch: string;
  isWindows: boolean;
  osRelease: string;
  appVersion: string;
  dataDir: string;
  logDir: string;
  cacheDir: string;
  credentialBackend: 'safe-storage' | 'windows-credential-manager' | 'file-permissions-only' | 'unavailable';
  credentialSecure: boolean;
  credentialWarning?: string;
}

export interface AppStatus {
  connection: ConnectionState;
  mount: MountStatus;
  summary: string;
  detail?: string;
  lastConnectedAt?: string | null;
  lastError?: AppError;
  /** True when the last error was caused by missing local dependencies. */
  blockedByDependency?: boolean;
}

export interface AppSnapshot {
  generatedAt: string;
  status: AppStatus;
  remote: RemoteConfig | null;
  provider: ProviderDescriptor | null;
  quota: QuotaInfo;
  disk: DiskInfo;
  cache: CacheInfo;
  offline: { enabled: boolean; entries: OfflineEntry[]; totalBytes: number };
  transfers: { running: TransferJob[]; queued: TransferJob[]; history: TransferJob[]; speedBps: number | null };
  engine: EngineInfo;
  environment: EnvironmentInfo;
  settings: AppSettings;
  /** Drives (Windows) or mount candidates (POSIX) currently in use. */
  driveLetters: DriveLetterInfo[];
}

export interface DriveLetterInfo {
  letter: string;
  label: string;
  inUse: boolean;
  type: 'fixed' | 'removable' | 'network' | 'cdrom' | 'ram' | 'unknown';
  free: boolean;
}

export interface DiagnosticsReport {
  generatedAt: string;
  appVersion: string;
  environment: EnvironmentInfo;
  engine: EngineInfo;
  dependencies: DependencyStatus[];
  checks: DiagnosticCheck[];
  /** Sanitized engine output used to build the report. */
  recentErrors: AppError[];
  /** Never includes secrets; asserted by tests. */
  redactionApplied: true;
}

export interface DiagnosticCheck {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail' | 'unknown';
  detail: string;
  remediation?: string;
}

export interface AuthSession {
  id: string;
  providerId: ProviderId;
  state: 'starting' | 'waiting-for-user' | 'exchanging' | 'completed' | 'failed' | 'cancelled';
  /** Authorization URL the user must open (official provider consent page). */
  authUrl?: string;
  /** True when rclone opened the system browser itself. */
  browserOpened: boolean;
  message: string;
  error?: AppError;
  createdAt: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
  mtime: string | null;
}

export interface RemoteBrowseResult {
  path: string;
  entries: DirectoryEntry[];
  truncated: boolean;
}
