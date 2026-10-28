import { useState } from 'react';
import clsx from 'clsx';
import type { AppSettings } from '@shared/types.js';
import { GB, formatBytes, formatRelativeTime } from '@shared/format.js';
import { useAppStore } from '../state/store.js';
import { api } from '../lib/bridge.js';
import { Badge, Button, Card, Field, Select, TextInput, Toggle } from '../components/ui.js';
import { AlertIcon, ExternalLinkIcon, FolderIcon, RefreshIcon, TrashIcon } from '../components/Icons.js';
import { OFFLINE_LABEL, OFFLINE_TONE, toneToBadge } from '../lib/status.js';

type Section = 'drive' | 'cache' | 'offline' | 'startup' | 'transfers' | 'appearance' | 'advanced';

const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: 'drive', label: 'Drive' },
  { id: 'cache', label: 'Cache' },
  { id: 'offline', label: 'Offline files' },
  { id: 'startup', label: 'Startup' },
  { id: 'transfers', label: 'Transfers' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'advanced', label: 'Advanced' },
];

export function Settings() {
  const snapshot = useAppStore((state) => state.snapshot);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const run = useAppStore((state) => state.run);
  const pushToast = useAppStore((state) => state.pushToast);
  const [section, setSection] = useState<Section>('drive');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmClearCache, setConfirmClearCache] = useState(false);

  if (!snapshot) return null;
  const settings = snapshot.settings;
  const remote = snapshot.remote;
  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => updateSettings({ [key]: value } as Partial<AppSettings>);

  return (
    <div className="grid gap-4 lg:grid-cols-[200px_1fr]">
      <nav className="space-y-1">
        {SECTIONS.map((entry) => (
          <button
            key={entry.id}
            onClick={() => setSection(entry.id)}
            className={clsx(
              'w-full rounded-lg px-3 py-2 text-left text-sm transition-colors',
              section === entry.id ? 'bg-accent/15 text-accent' : 'text-content-secondary hover:bg-surface-hover',
            )}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <div className="space-y-4">
        {section === 'drive' && (
          <Card title="Drive" subtitle="Where the cloud drive appears in Windows">
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Default drive letter" hint="Used for new accounts">
                  <Select
                    value={settings.mount.defaultDriveLetter}
                    onChange={(event) => set('mount', { ...settings.mount, defaultDriveLetter: event.target.value })}
                  >
                    {snapshot.driveLetters.map((letter) => (
                      <option key={letter.letter} value={letter.letter} disabled={letter.inUse && letter.letter !== remote?.driveLetter}>
                        {letter.letter}: {letter.inUse ? '(in use)' : '(free)'}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Current account" hint={remote ? `${remote.remoteName}:${remote.remoteRoot || '/'}` : 'No account selected'}>
                  <div className="flex items-center gap-2">
                    <TextInput value={remote?.driveLetter ? `${remote.driveLetter}:` : (remote?.mountPoint ?? 'Not configured')} readOnly />
                    <Button size="sm" variant="secondary" onClick={() => void run('letters', () => api.listDriveLetters())}>
                      Check conflicts
                    </Button>
                  </div>
                </Field>
              </div>
              <Field label="Remote folder" hint="Path inside the cloud account that becomes the drive root">
                <div className="flex gap-2">
                  <TextInput
                    defaultValue={remote?.remoteRoot ?? ''}
                    onBlur={(event) => {
                      if (remote && event.target.value !== remote.remoteRoot) {
                        void run('root', () => api.updateRemote({ id: remote.id, patch: { remoteRoot: event.target.value } }), {
                          success: 'Remote folder updated',
                        });
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void run('open', () => api.openMount())}
                  >
                    Open drive
                  </Button>
                </div>
              </Field>
              <Toggle
                checked={settings.mount.readOnly}
                onChange={(next) => set('mount', { ...settings.mount, readOnly: next })}
                label="Mount read-only"
                description="Blocks all write operations through the drive. Requires a remount to take effect."
              />
              <Toggle
                checked={settings.mount.autoReconnect}
                onChange={(next) => set('mount', { ...settings.mount, autoReconnect: next })}
                label="Automatic reconnection"
                description="Retry with exponential backoff when the drive disconnects unexpectedly."
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Reconnection attempts" hint="Bounded — CloudSSD never retries forever">
                  <Select
                    value={String(settings.mount.maxReconnectAttempts)}
                    onChange={(event) => set('mount', { ...settings.mount, maxReconnectAttempts: Number(event.target.value) })}
                  >
                    {[0, 3, 5, 10, 20].map((value) => (
                      <option key={value} value={value}>
                        {value === 0 ? 'No automatic retry' : `${value} attempts`}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Health check interval">
                  <Select
                    value={String(settings.mount.healthCheckIntervalMs)}
                    onChange={(event) => set('mount', { ...settings.mount, healthCheckIntervalMs: Number(event.target.value) })}
                  >
                    {[5000, 10000, 30000, 60000].map((value) => (
                      <option key={value} value={value}>
                        every {value / 1000}s
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            </div>
          </Card>
        )}

        {section === 'cache' && (
          <Card title="Cache" subtitle={`Currently using ${formatBytes(snapshot.cache.usedBytes)} of ${formatBytes(snapshot.cache.limitBytes)}`}>
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <ModeOption
                  title="Mode A — Cloud streaming"
                  body="Files are streamed from the cloud on demand; local disk usage stays low."
                  selected={settings.cache.mode === 'streaming'}
                  onSelect={() => set('cache', { ...settings.cache, mode: 'streaming' })}
                />
                <ModeOption
                  title="Mode B — Balanced cache"
                  body="Keeps a bounded local working set for faster repeated access."
                  selected={settings.cache.mode === 'balanced'}
                  onSelect={() => set('cache', { ...settings.cache, mode: 'balanced' })}
                />
              </div>
              <Field label="Cache limit" hint="Applies fully after the next mount; the engine enforces it while running.">
                <Select value={String(settings.cache.limitBytes)} onChange={(event) => set('cache', { ...settings.cache, limitBytes: Number(event.target.value) })}>
                  {[2, 10, 20, 50, 100, 250].map((value) => (
                    <option key={value} value={value * GB}>
                      {value} GB
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Cache directory" hint="Must be on a volume with enough free space">
                <div className="flex gap-2">
                  <TextInput
                    defaultValue={settings.cache.dir}
                    onBlur={(event) => {
                      if (event.target.value !== settings.cache.dir) {
                        void run('cache-dir', () => api.setCacheDir({ dir: event.target.value }), { success: 'Cache directory updated' });
                      }
                    }}
                  />
                  <Button size="sm" variant="secondary" icon={<FolderIcon size={14} />} onClick={() => void run('open-cache', () => api.openCacheDir())}>
                    Open
                  </Button>
                </div>
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Maximum cache age">
                  <Select
                    value={String(settings.cache.maxAgeSeconds)}
                    onChange={(event) => set('cache', { ...settings.cache, maxAgeSeconds: Number(event.target.value) })}
                  >
                    {[
                      { label: '1 hour', value: 3600 },
                      { label: '6 hours', value: 21600 },
                      { label: '24 hours', value: 86400 },
                      { label: '7 days', value: 604800 },
                    ].map((entry) => (
                      <option key={entry.value} value={entry.value}>
                        {entry.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Cleanup check interval" hint="How often the engine looks for safely removable data">
                  <Select
                    value={String(settings.cache.cleanupIntervalSeconds)}
                    onChange={(event) => set('cache', { ...settings.cache, cleanupIntervalSeconds: Number(event.target.value) })}
                  >
                    {[30, 60, 300, 900].map((value) => (
                      <option key={value} value={value}>
                        every {value}s
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>

              <div className="rounded-xl border border-surface-border bg-surface-overlay/50 p-3">
                <p className="text-sm font-medium">Clear cache</p>
                <p className="mt-1 text-xs text-content-secondary">
                  Removes cached data that the engine confirms is safe to delete. Files that are still waiting to upload
                  are never removed — CloudSSD refuses the operation while uploads are pending.
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {!confirmClearCache ? (
                    <Button variant="secondary" icon={<TrashIcon size={14} />} onClick={() => setConfirmClearCache(true)}>
                      Clear safely removable cache data
                    </Button>
                  ) : (
                    <>
                      <Button
                        variant="danger"
                        loading={useAppStore.getState().busy === 'clear-cache'}
                        onClick={async () => {
                          const result = await run('clear-cache', () => api.clearCache({ confirmed: true }));
                          setConfirmClearCache(false);
                          if (result) {
                            pushToast({
                              level: 'info',
                              title: `Removed ${formatBytes(result.removedBytes)}`,
                              body: result.skipped > 0 ? `${result.skipped} entries were still in use and were kept.` : undefined,
                            });
                          }
                        }}
                      >
                        Confirm — unmount, clear, remount
                      </Button>
                      <Button variant="ghost" onClick={() => setConfirmClearCache(false)}>
                        Cancel
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {snapshot.cache.pendingUploads + snapshot.cache.uploading > 0 && (
                <p className="flex items-center gap-2 rounded-lg border border-state-warn/40 bg-state-warn/10 p-2 text-xs text-state-warn">
                  <AlertIcon size={14} />
                  {snapshot.cache.pendingUploads + snapshot.cache.uploading} file(s) are still queued for upload.
                </p>
              )}
            </div>
          </Card>
        )}

        {section === 'offline' && (
          <Card title="Offline files (Mode C)" subtitle="Real local copies of selected files">
            <div className="space-y-4">
              <Toggle
                checked={settings.offline.enabled}
                onChange={(next) => set('offline', { ...settings.offline, enabled: next })}
                label="Enable offline files"
                description="Lets you pin files and folders so a local copy is kept on this disk."
              />
              <Field label="Offline directory" hint="Pinned copies live here and consume physical disk space">
                <div className="flex gap-2">
                  <TextInput
                    defaultValue={settings.offline.dir}
                    onBlur={(event) => {
                      if (event.target.value !== settings.offline.dir) set('offline', { ...settings.offline, dir: event.target.value });
                    }}
                  />
                  <Button size="sm" variant="secondary" icon={<FolderIcon size={14} />} onClick={() => void run('open-offline', () => api.openOfflineDir())}>
                    Open
                  </Button>
                </div>
              </Field>
              <div>
                <p className="mb-2 text-sm font-medium">Pinned items ({formatBytes(snapshot.offline.totalBytes)} on disk)</p>
                {snapshot.offline.entries.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-surface-border p-4 text-center text-sm text-content-muted">
                    Nothing pinned yet. Use the Offline screen to pin a file or folder.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {snapshot.offline.entries.map((entry) => (
                      <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-surface-border px-3 py-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm">{entry.remotePath}</p>
                          <p className="text-xs text-content-muted">
                            {formatBytes(entry.sizeBytes)}
                            {entry.lastVerifiedAt ? ` · checked ${formatRelativeTime(entry.lastVerifiedAt)}` : ''}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge tone={toneToBadge[OFFLINE_TONE[entry.state]]}>{OFFLINE_LABEL[entry.state]}</Badge>
                          <Button size="sm" variant="ghost" icon={<RefreshIcon size={14} />} onClick={() => void run('refresh', () => api.refreshOffline({ id: entry.id }))}>
                            Refresh
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            icon={<TrashIcon size={14} />}
                            onClick={() =>
                              void run('unpin', () => api.unpinOffline({ id: entry.id, confirmed: true }), {
                                success: 'Local copy removed (cloud file untouched)',
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
              </div>
            </div>
          </Card>
        )}

        {section === 'startup' && (
          <Card title="Startup" subtitle="Only what you explicitly enable">
            <div className="space-y-1">
              <Toggle
                checked={settings.startup.launchOnLogin}
                onChange={(next) => set('startup', { ...settings.startup, launchOnLogin: next })}
                label="Start CloudSSD when Windows starts"
                description="Uses the Windows login-item API. No scheduled tasks or hidden services are created."
              />
              <Toggle
                checked={settings.startup.autoMountOnStart}
                onChange={(next) => set('startup', { ...settings.startup, autoMountOnStart: next })}
                label="Mount the drive automatically on start"
              />
              <Toggle
                checked={settings.startup.restoreLastMount}
                onChange={(next) => set('startup', { ...settings.startup, restoreLastMount: next })}
                label="Restore the previous valid mount after a restart"
              />
              <Toggle
                checked={settings.startup.startMinimizedToTray}
                onChange={(next) => set('startup', { ...settings.startup, startMinimizedToTray: next })}
                label="Start minimized to the system tray"
                description="Requires a tray icon; the tray is only created when this is enabled."
              />
              <Toggle
                checked={settings.startup.minimizeToTrayOnClose}
                onChange={(next) => set('startup', { ...settings.startup, minimizeToTrayOnClose: next })}
                label="Keep running in the tray when the window closes"
              />
            </div>
          </Card>
        )}

        {section === 'transfers' && (
          <Card title="Transfers" subtitle="Applies to queued jobs (downloads, uploads, offline copies)">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Concurrency" hint="Parallel transfers per job">
                <Select
                  value={String(settings.transfers.concurrency)}
                  onChange={(event) => set('transfers', { ...settings.transfers, concurrency: Number(event.target.value) })}
                >
                  {[1, 2, 4, 8].map((value) => (
                    <option key={value} value={value}>
                      {value} at a time
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Retry attempts" hint="Bounded exponential backoff">
                <Select
                  value={String(settings.transfers.retries)}
                  onChange={(event) => set('transfers', { ...settings.transfers, retries: Number(event.target.value) })}
                >
                  {[0, 1, 3, 5, 10].map((value) => (
                    <option key={value} value={value}>
                      {value === 0 ? 'No retry' : `${value} retries`}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Bandwidth limit" hint="e.g. 10M, 500k, or empty for unlimited">
                <TextInput
                  defaultValue={settings.transfers.bandwidthLimit ?? ''}
                  placeholder="unlimited"
                  onBlur={(event) => {
                    const value = event.target.value.trim() || null;
                    if (value !== settings.transfers.bandwidthLimit) {
                      void run('bw', () => api.updateSettings({ transfers: { ...settings.transfers, bandwidthLimit: value } }), {
                        success: 'Bandwidth limit updated',
                      });
                    }
                  }}
                />
              </Field>
            </div>
          </Card>
        )}

        {section === 'appearance' && (
          <Card title="Appearance" subtitle="Dark theme is the default">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Theme">
                <Select value={settings.ui.theme} onChange={(event) => set('ui', { ...settings.ui, theme: event.target.value as AppSettings['ui']['theme'] })}>
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                  <option value="system">Match Windows</option>
                </Select>
              </Field>
              <Field label="Density">
                <Select value={settings.ui.density} onChange={(event) => set('ui', { ...settings.ui, density: event.target.value as AppSettings['ui']['density'] })}>
                  <option value="comfortable">Comfortable</option>
                  <option value="compact">Compact</option>
                </Select>
              </Field>
              <Field label="Language" hint="Interface strings are centralised for translation; only English ships today">
                <Select value={settings.ui.language} onChange={(event) => set('ui', { ...settings.ui, language: event.target.value })}>
                  <option value="en">English</option>
                </Select>
              </Field>
            </div>
          </Card>
        )}

        {section === 'advanced' && (
          <div className="space-y-4">
            <Card title="Diagnostics" subtitle="Logs stay on this computer and are redacted">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Log level">
                  <Select
                    value={settings.diagnostics.logLevel}
                    onChange={(event) =>
                      set('diagnostics', { ...settings.diagnostics, logLevel: event.target.value as AppSettings['diagnostics']['logLevel'] })
                    }
                  >
                    <option value="error">Errors only</option>
                    <option value="info">Information</option>
                    <option value="debug">Debug (restart required)</option>
                  </Select>
                </Field>
                <Field label="Retention (days)">
                  <TextInput
                    type="number"
                    min={1}
                    max={365}
                    defaultValue={settings.diagnostics.retentionDays}
                    onBlur={(event) =>
                      set('diagnostics', { ...settings.diagnostics, retentionDays: Number(event.target.value) })
                    }
                  />
                </Field>
                <Field label="Notifications">
                  <div className="space-y-1">
                    <Toggle
                      checked={settings.notifications.enabled}
                      onChange={(next) => set('notifications', { ...settings.notifications, enabled: next })}
                      label="Enable notifications"
                    />
                    <Toggle
                      checked={settings.notifications.errors}
                      onChange={(next) => set('notifications', { ...settings.notifications, errors: next })}
                      label="Notify about errors"
                    />
                    <Toggle
                      checked={settings.notifications.mountEvents}
                      onChange={(next) => set('notifications', { ...settings.notifications, mountEvents: next })}
                      label="Notify when the drive mounts"
                    />
                  </div>
                </Field>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  icon={<ExternalLinkIcon size={14} />}
                  onClick={() => void run('data-dir', () => api.openDataDir())}
                >
                  Open configuration folder
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    void useAppStore.getState().refreshDiagnostics().then(() => {
                      const report = useAppStore.getState().diagnostics;
                      if (!report) return;
                      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
                      const url = URL.createObjectURL(blob);
                      const anchor = document.createElement('a');
                      anchor.href = url;
                      anchor.download = `cloudssd-diagnostics-${report.generatedAt.replace(/[:.]/g, '-')}.json`;
                      anchor.click();
                      URL.revokeObjectURL(url);
                      pushToast({ level: 'success', title: 'Diagnostics exported (no secrets included)' });
                    });
                  }}
                >
                  Export non-secret diagnostics
                </Button>
              </div>
            </Card>

            <Card title="Danger zone" subtitle="These actions only affect local configuration">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-surface-border p-3">
                  <div>
                    <p className="text-sm font-medium">Restore default settings</p>
                    <p className="text-xs text-content-secondary">Keeps connected accounts; resets preferences and cache limits.</p>
                  </div>
                  <Button
                    variant="secondary"
                    onClick={() => void run('reset', () => api.resetSettings(), { success: 'Settings restored to defaults' })}
                  >
                    Restore defaults
                  </Button>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-state-error/40 p-3">
                  <div>
                    <p className="text-sm font-medium text-state-error">Remove account configuration</p>
                    <p className="text-xs text-content-secondary">
                      Deletes the stored authorization and local cache references. Files in your cloud account are never
                      deleted.
                    </p>
                  </div>
                  {!confirmRemove ? (
                    <Button variant="danger" disabled={!remote} onClick={() => setConfirmRemove(true)}>
                      Remove {remote?.displayName ?? 'account'}
                    </Button>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="danger"
                        loading={useAppStore.getState().busy === 'remove'}
                        onClick={async () => {
                          if (!remote) return;
                          const result = await run('remove', () => api.removeRemote({ id: remote.id, confirmed: true }));
                          setConfirmRemove(false);
                          if (result) pushToast({ level: 'info', title: 'Account configuration removed' });
                        }}
                      >
                        Confirm removal
                      </Button>
                      <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
                        Cancel
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

function ModeOption({
  title,
  body,
  selected,
  onSelect,
}: {
  title: string;
  body: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={clsx(
        'rounded-xl border p-3 text-left transition-colors',
        selected ? 'border-accent bg-accent/10' : 'border-surface-border bg-surface-overlay/50 hover:bg-surface-hover',
      )}
    >
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-1 text-xs text-content-secondary">{body}</p>
    </button>
  );
}
