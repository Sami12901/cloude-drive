import { useMemo } from 'react';
import clsx from 'clsx';
import type { AppSnapshot, TransferJob } from '@shared/types.js';
import { formatBytes, formatDateTime, formatPercent, formatRelativeTime, formatSpeed } from '@shared/format.js';
import { useAppStore } from '../state/store.js';
import { api } from '../lib/bridge.js';
import { Badge, Button, Card, ErrorBanner, ProgressBar, Stat } from '../components/ui.js';
import {
  AlertIcon,
  CloudIcon,
  DriveIcon,
  ExternalLinkIcon,
  OfflineIcon,
  PlayIcon,
  RefreshIcon,
  ShieldIcon,
  StopIcon,
  providerIcon,
} from '../components/Icons.js';
import { CONNECTION_LABEL, CONNECTION_TONE, MOUNT_LABEL, OFFLINE_LABEL, OFFLINE_TONE, TRANSFER_LABEL, TRANSFER_TONE, toneToBadge } from '../lib/status.js';

export function Dashboard() {
  const snapshot = useAppStore((state) => state.snapshot);
  const busy = useAppStore((state) => state.busy);
  const run = useAppStore((state) => state.run);

  if (!snapshot) return null;

  const { status, remote, provider, quota, disk, cache, offline, transfers, engine, environment } = snapshot;
  const mounted = status.mount === 'mounted';
  const quotaPct = quota.totalBytes && quota.usedBytes !== null ? (quota.usedBytes / quota.totalBytes) * 100 : null;
  const cachePct = cache.usedBytes !== null && cache.limitBytes > 0 ? (cache.usedBytes / cache.limitBytes) * 100 : null;
  const cacheTone = cachePct !== null && cachePct > 90 ? 'warn' : 'accent';
  const missingDependency = [engine.winfsp, ...(engine.rcloneAvailable ? [] : [{ required: true, installed: false, message: 'rclone missing' }])].filter(
    (dependency) => dependency.required && !dependency.installed,
  );

  return (
    <div className="space-y-4">
      {missingDependency.length > 0 && (
        <div className="rounded-xl border border-state-warn/40 bg-state-warn/10 p-3">
          <div className="flex items-start gap-2">
            <AlertIcon size={18} className="mt-0.5 text-state-warn" />
            <div className="text-sm">
              <p className="font-medium text-state-warn">A required component is missing</p>
              {!engine.rcloneAvailable && (
                <p className="mt-1 text-content-secondary">
                  rclone was not found. CloudSSD needs it to mount cloud storage.{' '}
                  <button
                    className="text-accent underline"
                    onClick={() => void api.openDependencyDownload({ id: 'rclone' })}
                  >
                    Open rclone.org/downloads
                  </button>
                </p>
              )}
              {engine.winfsp.required && !engine.winfsp.installed && (
                <p className="mt-1 text-content-secondary">
                  {engine.winfsp.message}{' '}
                  <button
                    className="text-accent underline"
                    onClick={() => void api.openDependencyDownload({ id: 'winfsp' })}
                  >
                    Open winfsp.dev
                  </button>
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------ hero */}
      <Card
        className="bg-gradient-to-br from-surface-raised to-surface-base"
        title={
          <div className="flex items-center gap-2">
            {provider ? providerIcon(provider.id, 22) : <CloudIcon size={22} />}
            <span>{remote?.displayName ?? 'No cloud account connected'}</span>
            <Badge tone={toneToBadge[CONNECTION_TONE[status.connection]]}>
              <span
                className={clsx(
                  'h-1.5 w-1.5 rounded-full',
                  status.connection === 'connected' ? 'bg-state-ok' : status.connection === 'disconnected' ? 'bg-content-muted' : 'bg-current',
                )}
              />
              {CONNECTION_LABEL[status.connection]}
            </Badge>
          </div>
        }
        subtitle={status.detail ?? 'Connect an account to create your cloud drive.'}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {mounted ? (
              <Button
                variant="secondary"
                icon={<StopIcon size={16} />}
                loading={busy === 'unmount'}
                onClick={() => void run('unmount', () => api.unmount({}), { success: 'Drive unmounted' })}
              >
                Unmount
              </Button>
            ) : (
              <Button
                variant="primary"
                icon={<PlayIcon size={16} />}
                disabled={!remote}
                loading={busy === 'mount'}
                onClick={() => void run('mount', () => api.mount({}), { success: 'Drive mounted' })}
              >
                Mount drive
              </Button>
            )}
            <Button
              variant="secondary"
              icon={<RefreshIcon size={16} />}
              disabled={!remote}
              loading={busy === 'test'}
              onClick={() =>
                void run('test', () => api.testRemote({}), {
                  success: 'Connection test passed',
                })
              }
            >
              Test
            </Button>
            <Button
              variant="secondary"
              icon={<DriveIcon size={16} />}
              disabled={!mounted}
              onClick={() => void run('open', () => api.openMount())}
            >
              Open drive
            </Button>
            {status.mount === 'stale' && (
              <Button variant="warm" icon={<RefreshIcon size={16} />} loading={busy === 'recover'} onClick={() => void run('recover', () => api.mount({}))}>
                Recover
              </Button>
            )}
          </div>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat
            label="Drive target"
            value={remote ? (remote.driveLetter ? `${remote.driveLetter}:` : (remote.mountPoint ?? 'Not configured')) : '—'}
            hint={`Mount state: ${MOUNT_LABEL[status.mount]}`}
            tone={mounted ? 'ok' : status.mount === 'failed' || status.mount === 'stale' ? 'error' : undefined}
          />
          <Stat
            label="Remote root"
            value={remote ? `${remote.remoteName}:${remote.remoteRoot || '/'}` : '—'}
            hint={provider ? provider.name : 'No provider'}
          />
          <Stat
            label="Last successful connection"
            value={status.lastConnectedAt ? formatRelativeTime(status.lastConnectedAt) : 'Not available'}
            hint={status.lastConnectedAt ? formatDateTime(status.lastConnectedAt) : 'Never connected'}
          />
          <Stat
            label="Transfer speed"
            value={formatSpeed(transfers.speedBps)}
            hint={`${transfers.running.length} active · ${transfers.queued.length} queued`}
          />
        </div>
      </Card>

      {status.lastError && (
        <ErrorBanner
          error={status.lastError}
          onRetry={() => void run('test', () => api.testRemote({}))}
        />
      )}

      {/* ----------------------------------------------------------- capacity */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Cloud storage quota" subtitle={provider?.name ?? 'No provider selected'}>
          {quota.available ? (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <span className="text-2xl font-semibold">{formatBytes(quota.usedBytes)}</span>
                <span className="text-sm text-content-secondary">of {formatBytes(quota.totalBytes)}</span>
              </div>
              <ProgressBar value={quotaPct} tone={(quotaPct ?? 0) > 90 ? 'warn' : 'accent'} />
              <p className="text-xs text-content-muted">
                {formatPercent(quotaPct)} used · {formatBytes(quota.freeBytes)} free
                {quota.trashedBytes ? ` · ${formatBytes(quota.trashedBytes)} in trash` : ''}
              </p>
              {quota.note && <p className="text-xs text-content-muted">{quota.note}</p>}
            </div>
          ) : (
            <p className="text-sm text-content-secondary">{quota.note ?? 'Not available'}</p>
          )}
        </Card>

        <Card title="Cache (local disk)" subtitle={cache.dir}>
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <span className="text-2xl font-semibold">{formatBytes(cache.usedBytes)}</span>
              <span className="text-sm text-content-secondary">of {formatBytes(cache.limitBytes)}</span>
            </div>
            <ProgressBar value={cachePct} tone={cacheTone} />
            <p className="text-xs text-content-muted">
              Mode {cache.mode === 'balanced' ? 'B — balanced cache' : 'A — cloud streaming'}
              {cache.files !== null ? ` · ${cache.files} cached files` : ''}
            </p>
            <p className="text-xs text-content-muted">
              {cache.pendingUploads + cache.uploading > 0
                ? `${cache.pendingUploads + cache.uploading} file(s) waiting to upload — these are never evicted`
                : 'No pending uploads'}
            </p>
            {cache.note && <p className="text-xs text-content-muted">{cache.note}</p>}
          </div>
        </Card>

        <Card title="Physical disk" subtitle="Real space on this computer">
          <div className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="text-2xl font-semibold">{formatBytes(disk.cacheDirFreeBytes)}</span>
              <span className="text-sm text-content-secondary">free on the cache volume</span>
            </div>
            <p className="text-xs text-content-muted">
              CloudSSD never reports cloud capacity as local disk space. Offline copies use{' '}
              <strong>{formatBytes(offline.totalBytes)}</strong> of this disk.
            </p>
            <div className="flex items-center justify-between text-xs text-content-secondary">
              <span>Mount target free</span>
              <span>{formatBytes(disk.mountTargetFreeBytes)}</span>
            </div>
          </div>
        </Card>
      </div>

      {/* ------------------------------------------------------------ activity */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Transfers"
          subtitle={`${transfers.running.length} running · ${transfers.queued.length} queued`}
          action={
            transfers.history.length > 0 ? (
              <Button size="sm" variant="ghost" onClick={() => void useAppStore.getState().run('clear', () => api.clearTransferHistory())}>
                Clear history
              </Button>
            ) : null
          }
        >
          {transfers.running.length + transfers.queued.length === 0 ? (
            <p className="py-6 text-center text-sm text-content-muted">
              No active transfers. Files you copy through the drive are transferred by the filesystem engine and
              are not listed here.
            </p>
          ) : (
            <ul className="space-y-2">
              {[...transfers.running, ...transfers.queued].slice(0, 6).map((job) => (
                <TransferRow key={job.id} job={job} />
              ))}
            </ul>
          )}
        </Card>

        <Card title="Offline copies" subtitle={offline.enabled ? 'Mode C — selected files kept on this disk' : 'Offline files disabled'}>
          {offline.entries.length === 0 ? (
            <p className="py-6 text-center text-sm text-content-muted">
              Nothing is pinned for offline use. Pin a file or folder to keep a real local copy.
            </p>
          ) : (
            <ul className="space-y-2">
              {offline.entries.slice(0, 6).map((entry) => (
                <li key={entry.id} className="flex items-center justify-between gap-3 rounded-lg border border-surface-border px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <OfflineIcon size={16} className="shrink-0 text-content-muted" />
                    <span className="truncate text-sm">{entry.remotePath}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone={toneToBadge[OFFLINE_TONE[entry.state]]}>{OFFLINE_LABEL[entry.state]}</Badge>
                    <span className="text-xs text-content-muted">{formatBytes(entry.sizeBytes)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* ------------------------------------------------------------- engine */}
      <Card title="Engine and security" subtitle="Local components that make the drive possible">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat
            label="rclone"
            value={engine.rcloneVersion ? `v${engine.rcloneVersion}` : 'Not available'}
            hint={engine.rclonePath ?? 'Install rclone to continue'}
            tone={engine.rcloneAvailable ? 'ok' : 'error'}
          />
          <Stat
            label="WinFsp"
            value={engine.winfsp.required ? (engine.winfsp.installed ? (engine.winfsp.version ?? 'Installed') : 'Not installed') : 'Not required here'}
            hint={engine.winfsp.message}
            tone={engine.winfsp.required ? (engine.winfsp.installed ? 'ok' : 'error') : undefined}
          />
          <Stat
            label="Credentials"
            value={environment.credentialSecure ? 'DPAPI protected' : 'Not encrypted'}
            hint={environment.credentialWarning ?? `Backend: ${environment.credentialBackend}`}
            tone={environment.credentialSecure ? 'ok' : 'warn'}
          />
          <Stat
            label="Mount process"
            value={engine.mountPid ? `pid ${engine.mountPid}` : 'Not running'}
            hint={engine.rcConnected ? 'Remote control connected' : 'Remote control not connected'}
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-content-muted">
          <span className="inline-flex items-center gap-1">
            <ShieldIcon size={14} /> Telemetry is off by default; nothing is uploaded.
          </span>
          <button
            className="inline-flex items-center gap-1 text-accent hover:underline"
            onClick={() => void api.openPath({ target: environment.dataDir })}
          >
            <ExternalLinkIcon size={14} /> Open configuration folder
          </button>
        </div>
      </Card>
    </div>
  );
}

function TransferRow({ job }: { job: TransferJob }) {
  const pct = job.totalBytes ? (job.bytes / job.totalBytes) * 100 : null;
  return (
    <li className="rounded-lg border border-surface-border px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-sm">{job.srcUri.split(/[\\/]/).pop() ?? job.srcUri}</span>
        <Badge tone={toneToBadge[TRANSFER_TONE[job.state]]}>{TRANSFER_LABEL[job.state]}</Badge>
      </div>
      {job.state === 'running' && (
        <div className="mt-2 space-y-1">
          <ProgressBar value={pct} />
          <div className="flex justify-between text-xs text-content-muted">
            <span>
              {formatBytes(job.bytes)} / {formatBytes(job.totalBytes)}
            </span>
            <span>{formatSpeed(job.speedBps)}</span>
          </div>
        </div>
      )}
    </li>
  );
}

/** Small helper used by the sidebar to show the current provider name. */
export function useProviderName(): string {
  const snapshot = useAppStore((state) => state.snapshot);
  return useMemo(() => snapshot?.provider?.name ?? 'No account', [snapshot]);
}

export type { AppSnapshot };
