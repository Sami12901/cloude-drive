import { useEffect, useMemo, useState, type ReactElement } from 'react';
import clsx from 'clsx';
import { useAppStore, startEventSubscription, startPolling } from './state/store.js';
import { Dashboard } from './pages/Dashboard.js';
import { Wizard } from './pages/Wizard.js';
import { Accounts } from './pages/Accounts.js';
import { Transfers } from './pages/Transfers.js';
import { Offline } from './pages/Offline.js';
import { Settings } from './pages/Settings.js';
import { Diagnostics } from './pages/Diagnostics.js';
import {
  CloudIcon,
  DashboardIcon,
  DiagnosticsIcon,
  DriveIcon,
  OfflineIcon,
  SettingsIcon,
  TransferIcon,
  AlertIcon,
  CheckIcon,
  CloseIcon,
  InfoIcon,
  providerIcon,
} from './components/Icons.js';
import { CONNECTION_LABEL, CONNECTION_TONE, toneToBadge } from './lib/status.js';
import { Badge, Button } from './components/ui.js';
import { isDevHost } from './lib/bridge.js';

type View = 'dashboard' | 'accounts' | 'transfers' | 'offline' | 'settings' | 'diagnostics';

const NAV: Array<{ id: View; label: string; icon: (props: { size?: number }) => ReactElement }> = [
  { id: 'dashboard', label: 'Dashboard', icon: DashboardIcon },
  { id: 'accounts', label: 'Accounts', icon: CloudIcon },
  { id: 'transfers', label: 'Transfers', icon: TransferIcon },
  { id: 'offline', label: 'Offline files', icon: OfflineIcon },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
  { id: 'diagnostics', label: 'Diagnostics', icon: DiagnosticsIcon },
];

export function App() {
  const [view, setView] = useState<View>('dashboard');
  const [wizardOpen, setWizardOpen] = useState(false);
  const snapshot = useAppStore((state) => state.snapshot);
  const initialising = useAppStore((state) => state.initialising);
  const refresh = useAppStore((state) => state.refresh);
  const theme = snapshot?.settings.ui.theme ?? 'dark';

  useEffect(() => {
    void refresh();
    const stopEvents = startEventSubscription();
    const stopPolling = startPolling(5000);
    return () => {
      stopEvents();
      stopPolling();
    };
  }, [refresh]);

  useEffect(() => {
    const root = document.documentElement;
    const prefersLight =
      theme === 'light' ||
      (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: light)').matches);
    root.classList.toggle('dark', !prefersLight);
    root.classList.toggle('light', prefersLight);
  }, [theme]);

  const statusTone = useMemo(() => (snapshot ? CONNECTION_TONE[snapshot.status.connection] : 'neutral'), [snapshot]);

  return (
    <div className="flex h-full">
      {/* ------------------------------------------------------------ sidebar */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-surface-border bg-surface-raised">
        <div className="flex items-center gap-2 px-4 py-4">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-accent/15 text-accent">
            <DriveIcon size={20} />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">CloudSSD</p>
            <p className="truncate text-[11px] text-content-muted">Cloud storage as a real drive</p>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-2">
          {NAV.map((entry) => {
            const Icon = entry.icon;
            return (
              <button
                key={entry.id}
                onClick={() => {
                  setView(entry.id);
                  setWizardOpen(false);
                }}
                className={clsx(
                  'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                  view === entry.id && !wizardOpen
                    ? 'bg-accent/15 text-accent'
                    : 'text-content-secondary hover:bg-surface-hover hover:text-content-primary',
                )}
              >
                <Icon size={18} />
                {entry.label}
                {entry.id === 'transfers' && (snapshot?.transfers.running.length ?? 0) > 0 && (
                  <span className="ml-auto rounded-full bg-accent px-2 text-[10px] font-semibold text-white">
                    {snapshot?.transfers.running.length}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="border-t border-surface-border p-3">
          {snapshot?.remote ? (
            <div className="flex items-center gap-2">
              {providerIcon(snapshot.remote.providerId, 20)}
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{snapshot.remote.displayName}</p>
                <p className="truncate text-[11px] text-content-muted">
                  {snapshot.remote.driveLetter ? `${snapshot.remote.driveLetter}:` : (snapshot.remote.mountPoint ?? 'no target')}
                </p>
              </div>
            </div>
          ) : (
            <Button variant="primary" size="sm" className="w-full" onClick={() => setWizardOpen(true)}>
              Connect account
            </Button>
          )}
        </div>
      </aside>

      {/* --------------------------------------------------------------- main */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-surface-border bg-surface-raised px-6 py-3">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold">
              {wizardOpen ? 'Connection wizard' : NAV.find((entry) => entry.id === view)?.label}
            </h1>
            <p className="truncate text-xs text-content-muted">
              {snapshot?.status.summary ?? 'Starting CloudSSD…'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {isDevHost && (
              <Badge tone="info" title="The UI is talking to the dev host, which runs the real main-process services on this machine.">
                Dev host
              </Badge>
            )}
            {snapshot && (
              <Badge tone={toneToBadge[statusTone]}>
                <span
                  className={clsx(
                    'h-1.5 w-1.5 rounded-full',
                    snapshot.status.connection === 'connected'
                      ? 'bg-state-ok'
                      : snapshot.status.connection === 'disconnected'
                        ? 'bg-content-muted'
                        : 'bg-current',
                  )}
                />
                {CONNECTION_LABEL[snapshot.status.connection]}
              </Badge>
            )}
            {snapshot?.remote && !wizardOpen && (
              <Button variant="primary" size="sm" onClick={() => setWizardOpen(true)}>
                Add account
              </Button>
            )}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-6">
          {initialising && !snapshot ? (
            <p className="text-sm text-content-muted">Loading application state…</p>
          ) : wizardOpen ? (
            <Wizard onFinished={() => setWizardOpen(false)} />
          ) : view === 'dashboard' ? (
            <Dashboard />
          ) : view === 'accounts' ? (
            <Accounts onAdd={() => setWizardOpen(true)} />
          ) : view === 'transfers' ? (
            <Transfers />
          ) : view === 'offline' ? (
            <Offline />
          ) : view === 'settings' ? (
            <Settings />
          ) : (
            <Diagnostics />
          )}
        </div>
      </main>

      <Toasts />
    </div>
  );
}

function Toasts() {
  const toasts = useAppStore((state) => state.toasts);
  const dismiss = useAppStore((state) => state.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className={clsx(
            'pointer-events-auto flex animate-slide-up items-start gap-2 rounded-xl border p-3 shadow-lg shadow-black/30',
            toast.level === 'error'
              ? 'border-state-error/50 bg-state-error/15'
              : toast.level === 'warn'
                ? 'border-state-warn/50 bg-state-warn/15'
                : toast.level === 'success'
                  ? 'border-state-ok/50 bg-state-ok/15'
                  : 'border-surface-border bg-surface-overlay',
          )}
        >
          {toast.level === 'error' ? (
            <AlertIcon size={16} className="mt-0.5 shrink-0 text-state-error" />
          ) : toast.level === 'success' ? (
            <CheckIcon size={16} className="mt-0.5 shrink-0 text-state-ok" />
          ) : toast.level === 'warn' ? (
            <AlertIcon size={16} className="mt-0.5 shrink-0 text-state-warn" />
          ) : (
            <InfoIcon size={16} className="mt-0.5 shrink-0 text-content-muted" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{toast.title}</p>
            {toast.body && <p className="mt-0.5 text-xs text-content-secondary">{toast.body}</p>}
          </div>
          <button onClick={() => dismiss(toast.id)} className="text-content-muted hover:text-content-primary" aria-label="Dismiss">
            <CloseIcon size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
