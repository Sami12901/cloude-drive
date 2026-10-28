import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import type { DependencyStatus, DriveLetterInfo } from '../../shared/types.js';
import type { MountTargetState, PlatformAdapter } from './types.js';

/**
 * POSIX adapter used by the automated mount lifecycle tests and by the dev host.
 *
 * Windows drive letters have no meaning here, so the "drive letter" of a remote
 * maps to an absolute directory (default `<tmp>/cloudssd-mounts/<letter>`).
 * Everything else — rclone argument construction, process supervision,
 * reconnection, cache handling — is the shared code path used on Windows.
 */
export interface PosixAdapterOptions {
  mountRoot?: string;
  openPath?: (target: string) => Promise<boolean>;
}

export class PosixPlatform implements PlatformAdapter {
  readonly kind = 'posix' as const;
  readonly mountRoot: string;

  constructor(options: PosixAdapterOptions = {}) {
    this.mountRoot = options.mountRoot ?? `${tmpdir()}/cloudssd-mounts`;
  }

  normalizeMountTarget(target: string): string {
    return target.replace(/\\/g, '/').replace(/\/+$/, '');
  }

  mountTargetArgument(target: string): string {
    return this.normalizeMountTarget(target);
  }

  mountTargetForShell(target: string): string {
    return this.normalizeMountTarget(target);
  }

  async listMountTargets(): Promise<DriveLetterInfo[]> {
    // Expose the same shape as Windows: one slot per letter, mapped to a directory.
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    return letters.map((letter) => {
      const path = `${this.mountRoot}/${letter}`;
      const inUse = this.directoryMounted(path);
      return {
        letter,
        label: inUse ? `${path} (in use)` : `${path} (free)`,
        inUse,
        type: 'unknown' as const,
        free: !inUse,
      };
    });
  }

  private directoryMounted(path: string): boolean {
    // /proc/mounts is authoritative and, unlike readdir(), never blocks on an
    // unresponsive FUSE mount (a killed daemon leaves the point hanging).
    return isFuseMount(path);
  }

  async isMountTargetInUse(target: string): Promise<boolean> {
    return this.directoryMounted(this.normalizeMountTarget(target));
  }

  async inspectMountTarget(target: string): Promise<MountTargetState> {
    const path = this.normalizeMountTarget(target);
    // /proc/mounts is checked first: `existsSync()` on a mount point whose
    // engine was killed fails with ENOTCONN and would report "does not exist".
    if (!isFuseMount(path)) {
      if (!existsSync(path)) return { mounted: false, stale: false, detail: `${path} does not exist.` };
      return { mounted: false, stale: false, detail: `${path} is a plain directory (nothing attached).` };
    }
    // The mount is attached — find out whether it still answers. The probe runs
    // in a child process with a timeout: reading a dead FUSE mount point blocks.
    const probe = spawnSync('ls', ['-1', path], { timeout: 2000, stdio: 'ignore' });
    if (probe.error || probe.status !== 0 || probe.signal) {
      return {
        mounted: true,
        stale: true,
        detail: `${path} is attached but not responding (${probe.signal ?? probe.error?.message ?? `exit ${probe.status}`}).`,
      };
    }
    return { mounted: true, stale: false, detail: `${path} is attached and responding.` };
  }

  async verifyMount(target: string): Promise<{ ok: boolean; detail: string }> {
    const path = this.normalizeMountTarget(target);
    try {
      if (!isFuseMount(path)) return { ok: false, detail: `${path} has no FUSE mount attached` };
      const entries = readdirSync(path);
      if (!isFuseMount(path)) {
        return { ok: false, detail: `${path} is readable but no FUSE mount is attached` };
      }
      return { ok: true, detail: `${path} is readable (${entries.length} entries)` };
    } catch (error) {
      return { ok: false, detail: `${path} is not readable: ${(error as Error).message}` };
    }
  }

  async openInFileManager(target: string): Promise<boolean> {
    return this.openPath(this.normalizeMountTarget(target));
  }

  async openPath(target: string): Promise<boolean> {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    return new Promise((resolve) => {
      const child = spawn(opener, [target], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
  }

  async detectWinFsp(): Promise<DependencyStatus> {
    return {
      id: 'winfsp',
      required: false,
      installed: false,
      version: null,
      path: null,
      message: 'WinFsp is a Windows component and is not required on this platform.',
    };
  }

  async restrictDirectoryToUser(path: string): Promise<{ ok: boolean; detail: string }> {
    return new Promise((resolve) => {
      const child = spawn('chmod', ['700', path], { stdio: 'ignore' });
      child.on('error', () => resolve({ ok: false, detail: 'chmod failed' }));
      child.on('close', (code) => resolve({ ok: code === 0, detail: `chmod 700 ${path}` }));
    });
  }

  async releaseStaleTarget(target: string): Promise<{ ok: boolean; detail: string }> {
    const path = this.normalizeMountTarget(target);
    if (!/^[/A-Za-z0-9._ -]+$/.test(path)) {
      return { ok: false, detail: `Refusing to unmount an invalid path: ${target}` };
    }
    return this.fusermount(['-u', path]);
  }

  async forceReleaseTarget(target: string): Promise<{ ok: boolean; detail: string }> {
    const path = this.normalizeMountTarget(target);
    if (!/^[/A-Za-z0-9._ -]+$/.test(path)) {
      return { ok: false, detail: `Refusing to unmount an invalid path: ${target}` };
    }
    if (!this.directoryMounted(path)) return { ok: true, detail: `${path} is not attached.` };
    // `-z` (lazy detach) is the only way to release a mount whose engine was
    // killed mid-operation; the kernel keeps it around until the last handle
    // disappears.
    const lazy = await this.fusermount(['-u', '-z', path]);
    if (lazy.ok) return lazy;
    return this.fusermount(['-uz', path]);
  }

  private fusermount(args: string[]): Promise<{ ok: boolean; detail: string }> {
    return new Promise((resolve) => {
      const child = spawn('fusermount3', args, { stdio: 'ignore' });
      child.on('error', () => {
        const fallback = spawn('fusermount', args, { stdio: 'ignore' });
        fallback.on('error', () => resolve({ ok: false, detail: 'No fusermount available' }));
        fallback.on('close', (code) =>
          resolve({ ok: code === 0, detail: `fusermount ${args.join(' ')} exited ${code}` }),
        );
      });
      child.on('close', (code) => {
        const ok = code === 0;
        if (ok) resolve({ ok: true, detail: `fusermount ${args.join(' ')} succeeded` });
        else resolve({ ok: false, detail: `fusermount3 ${args.join(' ')} exited ${code}` });
      });
    });
  }

  async setLaunchOnLogin(): Promise<boolean> {
    // Auto-start on login is a Windows login-item feature; POSIX hosts do not
    // implement it (the dev host and tests never create startup entries).
    return false;
  }

  extraMountFlags(): string[] {
    return ['--volname', 'CloudSSD'];
  }
}

/** Reads /proc/mounts to decide whether a FUSE filesystem is attached at `path`. */
export function isFuseMount(path: string): boolean {
  try {
    const target = path.replace(/\/$/, '');
    const content = readFileSync('/proc/mounts', 'utf8');
    return content
      .split('\n')
      .some((line) => {
        const parts = line.split(' ');
        return parts.length > 2 && parts[1] === target && (parts[2]?.startsWith('fuse') ?? false);
      });
  } catch {
    return false;
  }
}

/** Default mount directory for a letter on POSIX hosts. */
export function defaultPosixMountPoint(letter: string, mountRoot = `${tmpdir()}/cloudssd-mounts`): string {
  return `${mountRoot}/${letter.toUpperCase()}`;
}

export function homeDirectory(): string {
  return homedir();
}
