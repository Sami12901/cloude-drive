import { useState } from 'react';
import clsx from 'clsx';
import { formatRelativeTime } from '@shared/format.js';
import type { RemoteConfig } from '@shared/types.js';
import { useAppStore } from '../state/store.js';
import { api } from '../lib/bridge.js';
import { Badge, Button, Card, EmptyState } from '../components/ui.js';
import { CloudIcon, PlusIcon, RefreshIcon, TrashIcon, providerIcon } from '../components/Icons.js';

/** Lists every configured account and lets the user switch between them. */
export function Accounts({ onAdd }: { onAdd: () => void }) {
  const snapshot = useAppStore((state) => state.snapshot);
  const run = useAppStore((state) => state.run);
  const [confirm, setConfirm] = useState<string | null>(null);

  if (!snapshot) return null;
  const remotes = snapshot.settings.remotes;
  const activeId = snapshot.settings.activeRemoteId;

  return (
    <Card
      title="Cloud accounts"
      subtitle="Each account can be mounted to its own drive letter"
      action={
        <Button variant="primary" icon={<PlusIcon size={16} />} onClick={onAdd}>
          Connect account
        </Button>
      }
    >
      {remotes.length === 0 ? (
        <EmptyState
          icon={<CloudIcon size={28} />}
          title="No accounts connected"
          description="Connect a Google Drive or OneDrive account to create a real cloud-backed drive."
          action={
            <Button variant="primary" onClick={onAdd}>
              Start the connection wizard
            </Button>
          }
        />
      ) : (
        <ul className="space-y-2">
          {remotes.map((remote) => (
            <AccountRow
              key={remote.id}
              remote={remote}
              active={remote.id === activeId}
              confirming={confirm === remote.id}
              onConfirm={(next) => setConfirm(next ? remote.id : null)}
              onSelect={() => void run('select', () => api.selectRemote({ id: remote.id }))}
              onTest={() => void run('test', () => api.testRemote({ id: remote.id }), { success: 'Connection verified' })}
              onReconnect={() => void run('reconnect', () => api.reconnectRemote({ id: remote.id }), { success: 'Authorization refreshed' })}
              onRemove={() =>
                void run('remove', () => api.removeRemote({ id: remote.id, confirmed: true }), {
                  success: 'Account configuration removed',
                }).then(() => setConfirm(null))
              }
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function AccountRow({
  remote,
  active,
  confirming,
  onConfirm,
  onSelect,
  onTest,
  onReconnect,
  onRemove,
}: {
  remote: RemoteConfig;
  active: boolean;
  confirming: boolean;
  onConfirm: (next: boolean) => void;
  onSelect: () => void;
  onTest: () => void;
  onReconnect: () => void;
  onRemove: () => void;
}) {
  return (
    <li
      className={clsx(
        'rounded-xl border p-3',
        active ? 'border-accent bg-accent/5' : 'border-surface-border bg-surface-overlay/40',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="shrink-0">{providerIcon(remote.providerId, 26)}</span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{remote.displayName}</p>
            <p className="truncate text-xs text-content-muted">
              {remote.remoteName}:{remote.remoteRoot || '/'} ·{' '}
              {remote.driveLetter ? `drive ${remote.driveLetter}:` : (remote.mountPoint ?? 'no target')}
              {remote.lastConnectedAt ? ` · last connected ${formatRelativeTime(remote.lastConnectedAt)}` : ''}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {active ? <Badge tone="accent">Active</Badge> : <Button size="sm" variant="secondary" onClick={onSelect}>Use</Button>}
          <Button size="sm" variant="ghost" onClick={onTest}>
            Test
          </Button>
          <Button size="sm" variant="ghost" icon={<RefreshIcon size={14} />} onClick={onReconnect}>
            Reconnect
          </Button>
          {!confirming ? (
            <Button size="sm" variant="danger" icon={<TrashIcon size={14} />} onClick={() => onConfirm(true)}>
              Remove
            </Button>
          ) : (
            <>
              <Button size="sm" variant="danger" onClick={onRemove}>
                Confirm removal
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onConfirm(false)}>
                Cancel
              </Button>
            </>
          )}
        </div>
      </div>
      {remote.lastError && (
        <p className="mt-2 rounded-lg border border-state-error/30 bg-state-error/10 p-2 text-xs text-state-error">
          {remote.lastError.message} {remote.lastError.remediation}
        </p>
      )}
    </li>
  );
}
