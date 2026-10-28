import { existsSync, readdirSync, statfsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { DependencyStatus, DriveLetterInfo } from '../../shared/types.js';
import type { MountTargetState, PlatformAdapter } from './types.js';

const WINFSP_DOWNLOAD_URL = 'https://winfsp.dev/rel/';
const WINFSP_LICENSE = 'GPLv3 with the WinFsp runtime exception (see https://github.com/winsp/winfsp/blob/master/License.txt)';

/** Drive letters Windows will let us use (A: and B: are reserved for floppies). */
export const WINDOWS_DRIVE_LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('') as string[];

export interface Win32AdapterOptions {
  /** Executes a fixed, non-interpolated command (no user input is ever passed). */
  runFixedCommand?: (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  setLaunchOnLogin?: (enabled: boolean, args?: string[]) => Promise<boolean>;
  restrictDirectory?: (path: string) => Promise<{ ok: boolean; detail: string }>;
}

function defaultRunner(file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', () => resolve({ code: -1, stdout: '', stderr: 'spawn failed' }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Windows platform adapter.
 *
 * Drive letters are probed with `statfs` (no shell, no WMI dependency): a letter
 * that is already assigned answers, a free letter raises ENOENT.
 */
export class Win32Platform implements PlatformAdapter {
  readonly kind = 'win32' as const;

  constructor(private readonly options: Win32AdapterOptions = {}) {}

  normalizeMountTarget(target: string): string {
    return target.replace(/[:\\/]/g, '').toUpperCase().slice(0, 1);
  }

  mountTargetArgument(target: string): string {
    return `${this.normalizeMountTarget(target)}:`;
  }

  mountTargetForShell(target: string): string {
    return `${this.normalizeMountTarget(target)}:\\`;
  }

  async listMountTargets(): Promise<DriveLetterInfo[]> {
    const letters = await Promise.all(WINDOWS_DRIVE_LETTERS.map((letter) => this.probeLetter(letter)));
    return letters;
  }

  private probeLetter(letter: string): DriveLetterInfo {
    const root = `${letter}:\\`;
    try {
      const stat = statfsSync(root);
      const freeBytes = Number(stat.bavail) * Number(stat.bsize);
      return {
        letter,
        label: `${letter}: (${formatFree(freeBytes)} free)`,
        inUse: true,
        type: guessDriveType(letter),
        free: false,
      };
    } catch {
      return { letter, label: `${letter}: (free)`, inUse: false, type: 'unknown', free: true };
    }
  }

  async isMountTargetInUse(target: string): Promise<boolean> {
    const letter = this.normalizeMountTarget(target);
    if (!/^[C-Z]$/.test(letter)) return true;
    try {
      statfsSync(`${letter}:\\`);
      return true;
    } catch {
      return false;
    }
  }

  async inspectMountTarget(target: string): Promise<MountTargetState> {
    const letter = this.normalizeMountTarget(target);
    if (!/^[C-Z]$/.test(letter)) {
      return { mounted: false, stale: false, detail: `${target} is not a usable drive letter.` };
    }
    const root = `${letter}:\\`;
    try {
      statfsSync(root);
    } catch {
      return { mounted: false, stale: false, detail: `${root} is not assigned.` };
    }
    // The letter answers `statfs`. Probe it out of process with a timeout: a
    // drive whose engine died can block the caller indefinitely.
    const probe = await Promise.race([
      (this.options.runFixedCommand ?? defaultRunner)('cmd.exe', ['/c', 'dir', root]),
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
        setTimeout(() => resolve({ code: -2, stdout: '', stderr: 'timeout' }), 3000),
      ),
    ]);
    const responding = probe.code === 0;
    return {
      mounted: true,
      stale: !responding,
      detail: responding
        ? `${root} is attached and responding.`
        : `${root} is assigned but not responding (${probe.stderr.trim() || `exit ${probe.code}`}).`,
    };
  }

  async verifyMount(target: string): Promise<{ ok: boolean; detail: string }> {
    const root = this.mountTargetForShell(target);
    try {
      const entries = readdirSync(root);
      return { ok: true, detail: `${root} is readable (${entries.length} entries)` };
    } catch (error) {
      return { ok: false, detail: `${root} is not readable: ${(error as Error).message}` };
    }
  }

  async forceReleaseTarget(target: string): Promise<{ ok: boolean; detail: string }> {
    const letter = this.normalizeMountTarget(target);
    if (!/^[C-Z]$/.test(letter)) return { ok: false, detail: `${target} is not a usable drive letter.` };
    const runner = this.options.runFixedCommand ?? defaultRunner;
    const result = await runner('net.exe', ['use', `${letter}:`, '/delete', '/y']);
    return {
      ok: result.code === 0,
      detail:
        result.code === 0
          ? `Removed the network mapping for ${letter}:.`
          : `net use ${letter}: /delete /y exited ${result.code} (${result.stdout.trim() || result.stderr.trim()})`,
    };
  }

  async openInFileManager(target: string): Promise<boolean> {
    return this.openPath(this.mountTargetForShell(target));
  }

  async openPath(target: string): Promise<boolean> {
    const result = await (this.options.runFixedCommand ?? defaultRunner)('explorer.exe', [target]);
    return result.code === 0;
  }

  async detectWinFsp(): Promise<DependencyStatus> {
    const candidates = [
      String.raw`C:\Program Files (x86)\WinFsp\bin\winfsp-x64.dll`,
      String.raw`C:\Program Files\WinFsp\bin\winfsp-x64.dll`,
    ];
    const installedPath = candidates.find((candidate) => existsSync(candidate)) ?? null;

    let version: string | null = null;
    const registry = await (this.options.runFixedCommand ?? defaultRunner)('reg.exe', [
      'query',
      String.raw`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\WinFsp`,
      '/v',
      'DisplayVersion',
    ]);
    if (registry.code === 0) {
      const match = /DisplayVersion\s+REG_SZ\s+([\d.]+)/i.exec(registry.stdout);
      version = match?.[1] ?? null;
    }
    if (!version) {
      const wowRegistry = await (this.options.runFixedCommand ?? defaultRunner)('reg.exe', [
        'query',
        String.raw`HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\WinFsp`,
        '/v',
        'DisplayVersion',
      ]);
      const match = /DisplayVersion\s+REG_SZ\s+([\d.]+)/i.exec(wowRegistry.stdout);
      version = match?.[1] ?? null;
    }

    const installed = installedPath !== null || version !== null;
    return {
      id: 'winfsp',
      required: true,
      installed,
      version,
      path: installedPath,
      downloadUrl: WINFSP_DOWNLOAD_URL,
      license: WINFSP_LICENSE,
      message: installed
        ? `WinFsp ${version ?? 'installed'} detected.`
        : 'WinFsp is not installed. CloudSSD needs WinFsp to create a real drive letter.',
      remediation: installed
        ? undefined
        : 'Install WinFsp from winfsp.dev (requires administrator rights), then mount again. CloudSSD never installs drivers automatically.',
    };
  }

  async restrictDirectoryToUser(path: string): Promise<{ ok: boolean; detail: string }> {
    if (this.options.restrictDirectory) return this.options.restrictDirectory(path);
    // icacls: remove inheritance, grant only the current user full control.
    const result = await (this.options.runFixedCommand ?? defaultRunner)('icacls.exe', [
      path,
      '/inheritance:r',
      '/grant:r',
      `${process.env.USERNAME ?? '%USERNAME%'}:F`,
      '/T',
    ]);
    return {
      ok: result.code === 0,
      detail: result.code === 0 ? 'Directory restricted to the current user.' : `icacls failed: ${result.stderr.trim()}`,
    };
  }

  async releaseStaleTarget(target: string): Promise<{ ok: boolean; detail: string }> {
    const letter = this.normalizeMountTarget(target);
    if (!/^[C-Z]$/.test(letter)) {
      return { ok: false, detail: `Refusing to release an invalid drive letter: ${target}` };
    }
    // CloudSSD mounts with --network-mode, so a dead mount leaves a mapped
    // network drive behind; `net use` is the documented way to release it.
    const result = await (this.options.runFixedCommand ?? defaultRunner)('net.exe', [
      'use',
      `${letter}:`,
      '/delete',
      '/y',
    ]);
    return {
      ok: result.code === 0,
      detail: result.code === 0 ? `Released drive ${letter}:` : `net use failed: ${result.stderr.trim() || result.stdout.trim()}`,
    };
  }

  async setLaunchOnLogin(enabled: boolean, args: string[] = []): Promise<boolean> {
    if (this.options.setLaunchOnLogin) return this.options.setLaunchOnLogin(enabled, args);
    return false;
  }

  extraMountFlags(): string[] {
    // --network-mode makes the drive visible as a network drive in Explorer,
    // which is the configuration rclone documents for drive-letter mounts.
    return ['--network-mode', '--no-console', '--volname', 'CloudSSD'];
  }
}

function formatFree(bytes: number): string {
  if (bytes > 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(0)} GB`;
  if (bytes > 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function guessDriveType(letter: string): DriveLetterInfo['type'] {
  try {
    const root = `${letter}:\\`;
    // A CD-ROM has no writable free space reported by statfs in most cases;
    // without WMI we cannot reliably distinguish, so we report what we know.
    const stat = statfsSync(root);
    if (Number(stat.bavail) === 0) return 'cdrom';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Exported for tests: the letters CloudSSD may assign. */
export function candidateDriveLetters(): string[] {
  return [...WINDOWS_DRIVE_LETTERS];
}
