import type { RemoteConfig } from './types.js';

/**
 * Builds an rclone source/destination specification, e.g. `gdrive:CloudSSD/docs`.
 *
 * Rules:
 *  - an empty root yields `remote:`;
 *  - a root that starts with `/` is kept absolute (required by path-style
 *    remotes such as `local`, which is used as the engine test target);
 *  - a relative root keeps its relative form (`gdrive:CloudSSD`).
 *
 * The result is only ever passed to rclone as a single argv element.
 */
export function buildRemoteSpec(
  remote: Pick<RemoteConfig, 'remoteName' | 'remoteRoot'>,
  suffix = '',
): string {
  const root = remote.remoteRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const rest = suffix.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  const normalizedRoot = root.startsWith('/') ? `/${root.replace(/^\/+/, '')}` : root.replace(/^\/+/, '');

  if (!normalizedRoot && !rest) return `${remote.remoteName}:`;
  if (normalizedRoot.startsWith('/')) {
    return `${remote.remoteName}:${normalizedRoot}${rest ? `/${rest}` : ''}`;
  }
  return `${remote.remoteName}:${[normalizedRoot, rest].filter(Boolean).join('/')}`;
}

/** True when the remote root is an absolute path (path-style remotes). */
export function hasAbsoluteRoot(remote: Pick<RemoteConfig, 'remoteRoot'>): boolean {
  return remote.remoteRoot.replace(/\\/g, '/').startsWith('/');
}
