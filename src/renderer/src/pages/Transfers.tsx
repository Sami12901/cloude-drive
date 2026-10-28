import { useState } from 'react';
import type { TransferJob } from '@shared/types.js';
import { formatBytes, formatDateTime, formatPercent, formatSpeed } from '@shared/format.js';
import { useAppStore } from '../state/store.js';
import { api } from '../lib/bridge.js';
import { Badge, Button, Card, EmptyState, ProgressBar } from '../components/ui.js';
import { RefreshIcon, TransferIcon, TrashIcon } from '../components/Icons.js';
import { TRANSFER_LABEL, TRANSFER_TONE, toneToBadge } from '../lib/status.js';

export function Transfers() {
  const snapshot = useAppStore((state) => state.snapshot);
  const run = useAppStore((state) => state.run);
  const [src, setSrc] = useState('');
  const [dst, setDst] = useState('');
  const [mode, setMode] = useState<'copy' | 'copyto'>('copy');
  const [error, setError] = useState<string | null>(null);

  if (!snapshot) return null;
  const { running, queued, history } = snapshot.transfers;
  const remote = snapshot.remote;

  return (
    <div className="space-y-4">
      <Card
        title="Transfer queue"
        subtitle="Explicit jobs only — files copied through the drive are handled by the filesystem engine"
        action={
          <Button size="sm" variant="ghost" icon={<RefreshIcon size={14} />} onClick={() => void useAppStore.getState().refresh()}>
            Refresh
          </Button>
        }
      >
        <p className="mb-3 text-xs text-content-secondary">
          This queue is for jobs you start here (downloads, uploads, offline copies). Ordinary drag-and-drop or save
          operations in File Explorer go straight through the mounted drive and are not listed here.
        </p>
        {running.length + queued.length === 0 ? (
          <EmptyState
            icon={<TransferIcon size={28} />}
            title="No active transfers"
            description="Start a copy job below, or pin a file on the Offline screen."
          />
        ) : (
          <ul className="space-y-3">
            {[...running, ...queued].map((job) => (
              <JobRow key={job.id} job={job} onCancel={() => void run('cancel', () => api.cancelTransfer({ id: job.id }))} />
            ))}
          </ul>
        )}
      </Card>

      <Card title="Start a job" subtitle="Source and destination can be a remote (name:path) or a local directory">
        <div className="mb-3">
          <span className="mb-1 block text-xs uppercase tracking-wide text-content-muted">What to copy</span>
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as 'copy' | 'copyto')}
            className="w-full rounded-lg border border-surface-border bg-surface-base px-3 py-2 text-sm"
          >
            <option value="copy">A folder — copy its contents into the destination folder</option>
            <option value="copyto">A single file — copy it to the exact destination path</option>
          </select>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wide text-content-muted">Source</span>
            <input
              value={src}
              onChange={(event) => setSrc(event.target.value)}
              placeholder={remote ? `${remote.remoteName}:folder/file` : 'remote:path or C:\\local\\path'}
              className="w-full rounded-lg border border-surface-border bg-surface-base px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wide text-content-muted">Destination</span>
            <input
              value={dst}
              onChange={(event) => setDst(event.target.value)}
              placeholder="C:\\Users\\me\\Downloads or remote:path"
              className="w-full rounded-lg border border-surface-border bg-surface-base px-3 py-2 text-sm"
            />
          </label>
        </div>
        {error && <p className="mt-2 text-xs text-state-error">{error}</p>}
        <div className="mt-3 flex gap-2">
          <Button
            variant="primary"
            disabled={!src.trim() || !dst.trim()}
            onClick={() => {
              setError(null);
              void run(
                'enqueue',
                () =>
                  api.enqueueTransfer({
                    kind: 'copy',
                    remoteId: remote?.id ?? null,
                    srcUri: src.trim(),
                    dstUri: dst.trim(),
                    mode,
                  }),
                {
                  success: 'Job queued',
                },
              ).then((value) => {
                if (!value) setError('The job was rejected. Check that both paths are valid.');
                else {
                  setSrc('');
                  setDst('');
                }
              });
            }}
          >
            Queue copy job
          </Button>
        </div>
      </Card>

      <Card
        title="History"
        subtitle={`${history.length} completed, failed or cancelled jobs`}
        action={
          history.length > 0 ? (
            <Button size="sm" variant="ghost" icon={<TrashIcon size={14} />} onClick={() => void run('clear', () => api.clearTransferHistory())}>
              Clear
            </Button>
          ) : null
        }
      >
        {history.length === 0 ? (
          <p className="py-4 text-center text-sm text-content-muted">No history yet.</p>
        ) : (
          <ul className="divide-y divide-surface-border">
            {history.slice(0, 50).map((job) => (
              <li key={job.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm">
                    {job.srcUri} <span className="text-content-muted">→</span> {job.dstUri}
                  </p>
                  <p className="text-xs text-content-muted">
                    {formatBytes(job.bytes)}
                    {job.finishedAt ? ` · ${formatDateTime(job.finishedAt)}` : ''}
                    {job.attempt > 1 ? ` · ${job.attempt} attempts` : ''}
                  </p>
                  {job.error && <p className="text-xs text-state-error">{job.error.message}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={toneToBadge[TRANSFER_TONE[job.state]]}>{TRANSFER_LABEL[job.state]}</Badge>
                  {job.state === 'failed' && (
                    <Button size="sm" variant="secondary" onClick={() => void run('retry', () => api.retryTransfer({ id: job.id }))}>
                      Retry
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function JobRow({ job, onCancel }: { job: TransferJob; onCancel: () => void }) {
  const pct = job.totalBytes ? (job.bytes / job.totalBytes) * 100 : null;
  return (
    <li className="rounded-xl border border-surface-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm">
            {job.srcUri} <span className="text-content-muted">→</span> {job.dstUri}
          </p>
          <p className="text-xs text-content-muted">
            Attempt {job.attempt} of {job.maxAttempts}
            {job.state === 'running' ? ` · ${formatSpeed(job.speedBps)}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={toneToBadge[TRANSFER_TONE[job.state]]}>{TRANSFER_LABEL[job.state]}</Badge>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
      {job.state === 'running' && (
        <div className="mt-2 space-y-1">
          <ProgressBar value={pct} />
          <div className="flex justify-between text-xs text-content-muted">
            <span>
              {formatBytes(job.bytes)} / {formatBytes(job.totalBytes)} ({formatPercent(pct)})
            </span>
            <span>{job.etaSeconds ? `~${Math.round(job.etaSeconds)}s left` : ''}</span>
          </div>
        </div>
      )}
    </li>
  );
}
