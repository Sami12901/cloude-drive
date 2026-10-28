import type { DependencyStatus, DriveLetterInfo } from '../../shared/types.js';

/**
 * State of a mount target.
 *
 * `stale` means the target is attached but no longer serving requests — the
 * classic symptom of a killed engine process. It must never be confused with a
 * healthy mount owned by another program, which CloudSSD must not touch.
 */
export interface MountTargetState {
  mounted: boolean;
  stale: boolean;
  detail: string;
}

/**
 * Everything that differs between Windows and the POSIX test/CI host lives
 * behind this interface, so the mount engine can be exercised end-to-end on
 * Linux while the Windows implementation stays small and reviewable.
 */
export interface PlatformAdapter {
  readonly kind: 'win32' | 'posix';

  /** Windows: `Z` (no colon). POSIX: absolute mount directory. */
  normalizeMountTarget(target: string): string;

  /** Windows: `Z:` for rclone. POSIX: the mount directory. */
  mountTargetArgument(target: string): string;

  /** Windows: `Z:\`. POSIX: the mount directory. */
  mountTargetForShell(target: string): string;

  /** Windows: one entry per drive letter C..Z. POSIX: candidate directories. */
  listMountTargets(): Promise<DriveLetterInfo[]>;

  isMountTargetInUse(target: string): Promise<boolean>;

  /**
   * Reports whether a target is attached and, if so, whether it is serving
   * requests. Must never block: probing an unresponsive FUSE mount point can
   * hang indefinitely, so implementations probe out-of-process with a timeout.
   */
  inspectMountTarget(target: string): Promise<MountTargetState>;

  /** True when the mount is alive and readable (post-mount verification). */
  verifyMount(target: string): Promise<{ ok: boolean; detail: string }>;

  openInFileManager(target: string): Promise<boolean>;

  openPath(target: string): Promise<boolean>;

  detectWinFsp(): Promise<DependencyStatus>;

  /** Restricts a directory to the current user (icacls on Windows, chmod on POSIX). */
  restrictDirectoryToUser(path: string): Promise<{ ok: boolean; detail: string }>;

  /** OS-native "start on login" (Electron login item on Windows; no-op in tests). */
  setLaunchOnLogin(enabled: boolean, args?: string[]): Promise<boolean>;

  /**
   * Releases a mount target that is still attached but has no living CloudSSD
   * process (Windows: `net use Z: /delete`, POSIX: `fusermount -u`).
   */
  releaseStaleTarget(target: string): Promise<{ ok: boolean; detail: string }>;

  /**
   * Last-resort detach used when a killed engine left the target attached and
   * unresponsive (Windows: `net use <letter> /delete /y`, POSIX:
   * `fusermount -u -z`). Only called after the user asked for a recovery or
   * before an automatic reconnection.
   */
  forceReleaseTarget(target: string): Promise<{ ok: boolean; detail: string }>;

  /** Extra rclone mount flags required by the platform. */
  extraMountFlags(): string[];
}
