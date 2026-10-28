import type { ConnectionState, MountStatus, OfflineState, TransferState } from '@shared/types.js';

export const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  degraded: 'Degraded',
  offline: 'Offline',
  disconnected: 'Disconnected',
  'auth-expired': 'Authorization expired',
  'mount-failed': 'Mount failed',
  'provider-unavailable': 'Provider unavailable',
};

export type Tone = 'ok' | 'warn' | 'error' | 'info' | 'neutral';

export const CONNECTION_TONE: Record<ConnectionState, Tone> = {
  connected: 'ok',
  connecting: 'info',
  reconnecting: 'info',
  degraded: 'warn',
  offline: 'error',
  disconnected: 'neutral',
  'auth-expired': 'error',
  'mount-failed': 'error',
  'provider-unavailable': 'error',
};

export const MOUNT_LABEL: Record<MountStatus, string> = {
  mounted: 'Mounted',
  mounting: 'Mounting',
  unmounted: 'Not mounted',
  unmounting: 'Unmounting',
  failed: 'Failed',
  stale: 'Stale',
};

export const OFFLINE_LABEL: Record<OfflineState, string> = {
  queued: 'Queued',
  downloading: 'Downloading',
  available: 'Available offline',
  outdated: 'Outdated',
  failed: 'Failed',
  removing: 'Removing',
};

export const OFFLINE_TONE: Record<OfflineState, Tone> = {
  queued: 'info',
  downloading: 'info',
  available: 'ok',
  outdated: 'warn',
  failed: 'error',
  removing: 'neutral',
};

export const TRANSFER_LABEL: Record<TransferState, string> = {
  queued: 'Queued',
  running: 'Running',
  paused: 'Paused',
  succeeded: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const TRANSFER_TONE: Record<TransferState, Tone> = {
  queued: 'neutral',
  running: 'info',
  paused: 'neutral',
  succeeded: 'ok',
  failed: 'error',
  cancelled: 'neutral',
};

export const toneToBadge: Record<Tone, 'ok' | 'warn' | 'error' | 'info' | 'neutral'> = {
  ok: 'ok',
  warn: 'warn',
  error: 'error',
  info: 'info',
  neutral: 'neutral',
};
