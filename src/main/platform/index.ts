import type { PlatformAdapter } from './types.js';
import { PosixPlatform } from './posix.js';
import { Win32Platform } from './win32.js';

export type { PlatformAdapter } from './types.js';
export { PosixPlatform } from './posix.js';
export { Win32Platform, WINDOWS_DRIVE_LETTERS } from './win32.js';

export function createPlatformAdapter(
  platform: NodeJS.Platform = process.platform,
  overrides?: Partial<PlatformAdapter>,
): PlatformAdapter {
  const base: PlatformAdapter = platform === 'win32' ? new Win32Platform() : new PosixPlatform();
  return overrides ? { ...base, ...overrides } : base;
}
