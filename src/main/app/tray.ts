import { Menu, Tray, app, type BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppSnapshot } from '../../shared/types.js';

export interface TrayCallbacks {
  show(): void;
  mount(): Promise<void>;
  unmount(): Promise<void>;
  openDrive(): Promise<void>;
  quit(): void;
}

/**
 * Optional system tray interface.
 *
 * The tray only appears when the user enables it in Settings → Startup; CloudSSD
 * never starts hidden in the tray by default.
 */
export class TrayController {
  private tray: Tray | null = null;
  private snapshot: AppSnapshot | null = null;

  constructor(
    private readonly iconPath: string,
    private readonly callbacks: TrayCallbacks,
  ) {}

  get enabled(): boolean {
    return this.tray !== null;
  }

  enable(): void {
    if (this.tray) return;
    if (!existsSync(this.iconPath)) return;
    this.tray = new Tray(this.iconPath);
    this.tray.setToolTip('CloudSSD');
    this.refreshMenu();
  }

  disable(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  update(snapshot: AppSnapshot): void {
    this.snapshot = snapshot;
    this.refreshMenu();
  }

  private refreshMenu(): void {
    if (!this.tray) return;
    const status = this.snapshot?.status;
    const mounted = status?.mount === 'mounted';
    const template = Menu.buildFromTemplate([
      { label: `CloudSSD — ${status?.connection ?? 'disconnected'}`, enabled: false },
      { type: 'separator' },
      { label: 'Open CloudSSD', click: () => this.callbacks.show() },
      {
        label: mounted ? 'Unmount drive' : 'Mount drive',
        click: () => {
          void (mounted ? this.callbacks.unmount() : this.callbacks.mount());
        },
      },
      { label: 'Open drive in File Explorer', enabled: mounted, click: () => void this.callbacks.openDrive() },
      { type: 'separator' },
      { label: 'Quit', click: () => this.callbacks.quit() },
    ]);
    this.tray.setContextMenu(template);
  }
}

/** Resolves the tray/notification icon for the current platform. */
export function iconPath(resourcesDir: string): string {
  const name = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const candidates = [join(resourcesDir, name), join(__dirname, '..', '..', '..', 'build', name)];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] as string;
}

export function appName(): string {
  return app.getName();
}

export type { BrowserWindow };
