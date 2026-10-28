/**
 * Security policy for the renderer.
 *
 * Rules enforced here:
 *  - a strict Content Security Policy (no remote code, no inline scripts);
 *  - navigation is limited to the application itself;
 *  - new windows and webViews are refused;
 *  - only a small allow-list of documentation URLs may be opened externally;
 *  - IPC senders must be the application window (checked in the registry).
 */

export const CSP_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'self'",
  // Tailwind/Vite inject styles; inline styles are required for the design system.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** Official documentation and download sites CloudSSD is allowed to open. */
const ALLOWED_EXTERNAL_HOSTS = new Set([
  'rclone.org',
  'downloads.rclone.org',
  'winfsp.dev',
  'github.com',
  'support.microsoft.com',
  'myaccount.google.com',
  'onedrive.live.com',
  'www.dropbox.com',
]);

export function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return false;
    return ALLOWED_EXTERNAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * True when the request came from the packaged application or from the local
 * Vite dev server (which only listens on this machine).
 */
export function isTrustedRendererUrl(url: string, devServerPort?: number): boolean {
  if (!url) return false;
  if (url.startsWith('file://')) return true;
  if (url.startsWith('devtools://')) return true;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      const host = parsed.hostname;
      if (host === 'localhost' || host === '127.0.0.1') {
        return devServerPort ? Number(parsed.port) === devServerPort : false;
      }
    }
  } catch {
    return false;
  }
  return false;
}

/** Options applied to every BrowserWindow created by CloudSSD. */
export const WINDOW_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  spellcheck: false,
  // No remote/module loading from the renderer.
  enableWebSQL: false,
  autoplayPolicy: 'user-gesture-required' as const,
} as const;
