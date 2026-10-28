/** Formatting helpers shared by the main process (logs) and the renderer. */

export const KB = 1024;
export const MB = 1024 * 1024;
export const GB = 1024 * 1024 * 1024;
export const TB = 1024 * 1024 * 1024 * 1024;

export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return 'Not available';
  if (bytes < 0) return '-';
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(digits)} KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(digits)} MB`;
  if (bytes < TB) return `${(bytes / GB).toFixed(digits)} GB`;
  return `${(bytes / TB).toFixed(digits)} TB`;
}

export function formatSpeed(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond === null || bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond)) {
    return 'Not available';
  }
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return 'Not available';
  }
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return `${hours}h ${restMinutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return 'Not available';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRelativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'Not available';
  const date = new Date(iso).getTime();
  if (Number.isNaN(date)) return 'Not available';
  const diffSeconds = Math.round((now - date) / 1000);
  if (diffSeconds < 0) return 'just now';
  if (diffSeconds < 45) return 'just now';
  if (diffSeconds < 3600) return `${Math.round(diffSeconds / 60)} min ago`;
  if (diffSeconds < 86400) return `${Math.round(diffSeconds / 3600)} h ago`;
  return `${Math.round(diffSeconds / 86400)} d ago`;
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'Not available';
  return `${Math.min(100, Math.max(0, value)).toFixed(0)}%`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function truncateMiddle(value: string, maxLength = 48): string {
  if (value.length <= maxLength) return value;
  const half = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, half)}…${value.slice(value.length - half)}`;
}
