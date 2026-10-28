import { useState } from 'react';
import { formatBytes, formatRelativeTime } from '@shared/format.js';
import { useAppStore } from '../state/store.js';
import { api } from '../lib/bridge.js';
import { Badge, Button, Card, EmptyState } from '../components/ui.js';
import { FolderIcon, OfflineIcon, RefreshIcon, TrashIcon } from '../components/Icons.js';
import { OFFLINE_LABEL, OFFLINE_TONE, toneToBadge } from '../lib/status.js';

export function Offline() {
  const snapshot = useAppStore((state) => state.snapshot);
  const run = useAppStore((state) => state.run);
  const [path, setPath] = useState('');

  if (!snapshot) return null;
  const { offline } = snapshot;
  const remote = snapshot.remote;

  return (
    <div className="space-y-4">
      <Card
        title="Offline files (Mode C)"
        subtitle="Selected files and folders are copied to this computer for real offline use"
        action={
          <Button size="sm" variant="secondary" icon={<FolderIcon size={14} />} onClick={() => void run('open', () => api.openOfflineDir())}>
            Open offline folder
          </Button>
        }
      >
        <p className="mb-3 text-xs text-content-secondary">
          A pinned item is only shown as <strong>available offline</strong> after a real local copy exists on this disk.
          Offline copies use physical disk space ({formatBytes(offline.totalBytes)} now) and can go out of date when the
          cloud file changes — CloudSSD marks them <strong>outdated</strong> and offers a refresh.
        </p>

        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[240px] flex-1">
            <span className="mb-1 block text-xs uppercase tracking-wide text-content-muted">Cloud path to pin</span>
            <input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="folder/file.docx"
              className="w-full rounded-lg border border-surface-border bg-surface-base px-3 py-2 text-sm"
            />
          </label>
          <Button
            variant="primary"
            disabled={!remote || !path.trim()}
            onClick={() =>
              void run('pin', () => api.pinOffline({ remoteId: remote?.id as string, remotePath: path.trim() }), {
                success: 'Pinned — the copy is downloading now',
              }).then((value) => {
                if (value) setPath('');
              })
            }
          >
            Pin for offline use
          </Button>
        </div>
      </Card>

      <Card title={`Pinned items (${offline.entries.length})`}>
        {offline.entries.length === 0 ? (
          <EmptyState
            icon={<OfflineIcon size={28} />}
            title="Nothing pinned for offline use"
            description={
              remote
                ? 'Enter a path above to download a real local copy.'
                : 'Connect an account before pinning files.'
            }
          />
        ) : (
          <ul className="space-y-2">
            {offline.entries.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-surface-border p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{entry.remotePath}</p>
                  <p className="text-xs text-content-muted">
                    {formatBytes(entry.sizeBytes)}
                    {entry.lastVerifiedAt ? ` · checked ${formatRelativeTime(entry.lastVerifiedAt)}` : ''}
                  </p>
                  <p className="truncate text-[11px] text-content-muted">{entry.localPath}</p>
                  {entry.error && <p className="text-xs text-state-error">{entry.error.message}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={toneToBadge[OFFLINE_TONE[entry.state]]}>{OFFLINE_LABEL[entry.state]}</Badge>
                  <Button size="sm" variant="secondary" icon={<RefreshIcon size={14} />} onClick={() => void run('refresh', () => api.refreshOffline({ id: entry.id }))}>
                    Refresh
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    icon={<TrashIcon size={14} />}
                    onClick={() =>
                      void run('unpin', () => api.unpinOffline({ id: entry.id, confirmed: true }), {
                        success: 'Local copy removed — the cloud file was not touched',
                      })
                    }
                  >
                    Remove local copy
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
