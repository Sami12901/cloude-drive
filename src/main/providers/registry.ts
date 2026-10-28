import { GB, TB } from '../../shared/format.js';
import type { ProviderDescriptor, ProviderId } from '../../shared/types.js';

/**
 * Provider capabilities.
 *
 * Facts here come from the providers' and rclone's published documentation (see
 * docs/provider-limitations.md). Providers are only surfaced in the UI when
 * their status is `supported`; `beta` providers stay hidden behind the
 * "experimental providers" setting until their acceptance tests pass.
 */
export const PROVIDERS: Record<ProviderId, ProviderDescriptor> = {
  gdrive: {
    id: 'gdrive',
    backend: 'drive',
    name: 'Google Drive',
    description: 'Mount a Google Drive account (My Drive and, optionally, a shared drive) as a Windows drive.',
    authMode: 'oauth',
    releaseStatus: 'supported',
    permissions: [
      'See and download the files in your Google Drive',
      'Create, update and delete files you open through CloudSSD',
      'See your account name and email address',
      'Maintain access while you are away (offline access / refresh token)',
    ],
    supportsQuota: true,
    supportsHashes: true,
    maxFileSizeBytes: 5 * TB,
    caseSensitive: false,
    limitations: [
      'Google uploads at most 750 GB per user per day; larger transfers fail until the quota window resets.',
      'Google Docs, Sheets and Slides are exported in a chosen office format — they cannot be edited in place through the drive.',
      'File names must be unique ignoring case in some conflict situations; rename carefully when two names differ only by case.',
      'Quota is shared with Gmail and Google Photos.',
      'Google may throttle requests; CloudSSD retries with exponential backoff and stops after the configured number of attempts.',
    ],
    docsUrl: 'https://rclone.org/drive/',
    requiresOwnOAuthClient: false,
    notes: [
      'CloudSSD uses rclone\'s official Google Drive backend with the standard OAuth consent flow.',
      'rclone\'s shared OAuth client id is being retired during 2026. If sign-in fails with a client-id error, create your own OAuth client in Google Cloud Console and enter it under "Advanced".',
    ],
  },
  onedrive: {
    id: 'onedrive',
    backend: 'onedrive',
    name: 'Microsoft OneDrive',
    description: 'Mount OneDrive Personal, OneDrive for Business or a SharePoint document library.',
    authMode: 'oauth',
    releaseStatus: 'supported',
    permissions: [
      'Read and write the files in the selected OneDrive',
      'Keep access after you close the browser (offline access)',
      'See the drive list of the account so a drive can be selected',
    ],
    supportsQuota: true,
    supportsHashes: true,
    maxFileSizeBytes: 250 * GB,
    caseSensitive: false,
    limitations: [
      'A single file may not exceed 250 GB.',
      'OneDrive is case insensitive: two names that differ only in case collide.',
      'The characters " * : < > ? / \\ | are not allowed in OneDrive names.',
      'Business and SharePoint accounts must select the correct drive; personal accounts default to the user drive.',
      'Microsoft throttles aggressive clients (HTTP 429); rclone backs off automatically, but very large bulk operations can be slowed.',
    ],
    docsUrl: 'https://rclone.org/onedrive/',
    requiresOwnOAuthClient: false,
    notes: [
      'CloudSSD mounts the drive with the official rclone OneDrive backend over the Microsoft Graph API.',
      'Business accounts backed by SharePoint may expose more than one drive; pick the drive in the wizard if listing fails.',
    ],
  },
  dropbox: {
    id: 'dropbox',
    backend: 'dropbox',
    name: 'Dropbox',
    description: 'Mount a Dropbox account (Personal or Business).',
    authMode: 'oauth',
    releaseStatus: 'beta',
    permissions: ['Read and write files in the connected Dropbox', 'Keep access while you are away'],
    supportsQuota: true,
    supportsHashes: true,
    maxFileSizeBytes: 350 * GB,
    caseSensitive: false,
    limitations: [
      'The Dropbox API accepts files up to 350 GB.',
      'Dropbox is case insensitive and normalises some Unicode names.',
      'Dropbox Business: files in team folders need the correct namespace configuration.',
      'Paper documents are exported, not editable.',
    ],
    docsUrl: 'https://rclone.org/dropbox/',
    requiresOwnOAuthClient: false,
    notes: ['Experimental: this provider is hidden until its acceptance tests pass on a real account.'],
  },
  webdav: {
    id: 'webdav',
    backend: 'webdav',
    name: 'WebDAV',
    description: 'Mount any WebDAV-compatible server (Nextcloud, ownCloud, mailbox.org, NAS shares).',
    authMode: 'basic',
    releaseStatus: 'beta',
    permissions: ['Authenticate with the user name and password you already use for the WebDAV server'],
    supportsQuota: false,
    supportsHashes: false,
    maxFileSizeBytes: null,
    caseSensitive: true,
    limitations: [
      'Quota reporting depends on the server and is reported as "Not available" when the server does not provide it.',
      'Feature support (hashes, partial writes, server-side move) varies between servers.',
      'Requires HTTPS for credentials to be protected in transit.',
    ],
    docsUrl: 'https://rclone.org/webdav/',
    notes: ['Experimental: hidden until acceptance tests pass against a reference WebDAV server.'],
  },
  s3: {
    id: 's3',
    backend: 's3',
    name: 'S3-compatible storage',
    description: 'Mount an S3-compatible bucket (Backblaze B2, Wasabi, MinIO, Cloudflare R2, Amazon S3).',
    authMode: 'static',
    releaseStatus: 'beta',
    permissions: ['Uses the access key id and secret key you provide; store them only for this account'],
    supportsQuota: false,
    supportsHashes: true,
    maxFileSizeBytes: 5 * TB,
    caseSensitive: true,
    limitations: [
      'Object storage is case sensitive and has no real folders.',
      'No quota reporting: capacity is reported as "Not available".',
      'Renames are copy+delete; large renames cost transfer time.',
      'Some providers charge per request; file explorer traffic generates requests.',
    ],
    docsUrl: 'https://rclone.org/s3/',
    notes: ['Experimental: hidden until acceptance tests pass against a reference S3 endpoint.'],
  },
  local: {
    id: 'local',
    backend: 'local',
    name: 'Local folder (engine test target)',
    description:
      'Not a cloud provider. Exposes a local folder through the rclone engine so mounting, caching and transfer behaviour can be tested without a cloud account.',
    authMode: 'static',
    releaseStatus: 'testing-only',
    permissions: ['None'],
    supportsQuota: true,
    supportsHashes: true,
    maxFileSizeBytes: null,
    caseSensitive: true,
    limitations: ['Only present in development builds and when CLOUDSSD_ENABLE_TEST_PROVIDER=1.'],
    docsUrl: 'https://rclone.org/local/',
    notes: ['Used by the automated mount lifecycle tests. Never shown in release builds.'],
  },
};

/** Providers offered in the connection wizard for this build. */
export function visibleProviders(options: { includeExperimental: boolean; includeTestTarget: boolean }): ProviderDescriptor[] {
  return Object.values(PROVIDERS).filter((provider) => {
    if (provider.releaseStatus === 'supported') return true;
    if (provider.releaseStatus === 'testing-only') return options.includeTestTarget;
    return options.includeExperimental;
  });
}

export function getProvider(id: string): ProviderDescriptor | null {
  return PROVIDERS[id as ProviderId] ?? null;
}

export function isSupportedProvider(id: string): boolean {
  return getProvider(id)?.releaseStatus === 'supported';
}

/** Default configuration keys used when creating the rclone remote. */
export function defaultRemoteOptions(providerId: ProviderId): Record<string, string> {
  switch (providerId) {
    case 'gdrive':
      return { scope: 'drive' };
    case 'onedrive':
      return { drive_type: 'onedrive' };
    case 'dropbox':
      return {};
    case 'webdav':
      return { vendor: 'other' };
    case 's3':
      return { provider: 'Other' };
    case 'local':
      return { nounc: 'true' };
    default:
      return {};
  }
}
