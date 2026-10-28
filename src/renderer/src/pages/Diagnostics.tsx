import { useEffect } from 'react';
import clsx from 'clsx';
import { formatDateTime } from '@shared/format.js';
import { useAppStore } from '../state/store.js';
import { api } from '../lib/bridge.js';
import { Badge, Button, Card, Skeleton } from '../components/ui.js';
import { AlertIcon, CheckIcon, InfoIcon, RefreshIcon } from '../components/Icons.js';

export function Diagnostics() {
  const diagnostics = useAppStore((state) => state.diagnostics);
  const refreshDiagnostics = useAppStore((state) => state.refreshDiagnostics);
  const pushToast = useAppStore((state) => state.pushToast);

  useEffect(() => {
    void refreshDiagnostics();
  }, [refreshDiagnostics]);

  return (
    <div className="space-y-4">
      <Card
        title="Diagnostics"
        subtitle={diagnostics ? `Generated ${formatDateTime(diagnostics.generatedAt)} · CloudSSD ${diagnostics.appVersion}` : 'Running checks…'}
        action={
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              icon={<RefreshIcon size={14} />}
              onClick={() => void refreshDiagnostics()}
            >
              Run checks
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!diagnostics}
              onClick={() => {
                if (!diagnostics) return;
                const blob = new Blob([JSON.stringify(diagnostics, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement('a');
                anchor.href = url;
                anchor.download = `cloudssd-diagnostics-${diagnostics.generatedAt.replace(/[:.]/g, '-')}.json`;
                anchor.click();
                URL.revokeObjectURL(url);
                pushToast({ level: 'success', title: 'Diagnostics exported' });
              }}
            >
              Export report
            </Button>
          </div>
        }
      >
        {!diagnostics ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <ul className="space-y-2">
            {diagnostics.checks.map((check) => (
              <li
                key={check.id}
                className={clsx(
                  'rounded-xl border p-3',
                  check.status === 'pass'
                    ? 'border-state-ok/30 bg-state-ok/5'
                    : check.status === 'warn'
                      ? 'border-state-warn/40 bg-state-warn/10'
                      : check.status === 'fail'
                        ? 'border-state-error/40 bg-state-error/10'
                        : 'border-surface-border bg-surface-overlay/40',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2">
                    {check.status === 'pass' ? (
                      <CheckIcon size={16} className="mt-0.5 text-state-ok" />
                    ) : check.status === 'fail' ? (
                      <AlertIcon size={16} className="mt-0.5 text-state-error" />
                    ) : (
                      <InfoIcon size={16} className="mt-0.5 text-content-muted" />
                    )}
                    <div>
                      <p className="text-sm font-medium">{check.label}</p>
                      <p className="mt-0.5 text-xs text-content-secondary">{check.detail}</p>
                      {check.remediation && (
                        <p className="mt-1 text-xs text-accent">Next step: {check.remediation}</p>
                      )}
                    </div>
                  </div>
                  <Badge
                    tone={
                      check.status === 'pass' ? 'ok' : check.status === 'warn' ? 'warn' : check.status === 'fail' ? 'error' : 'neutral'
                    }
                  >
                    {check.status}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {diagnostics && (
        <>
          <Card title="Dependencies" subtitle="Where each component comes from and its licence">
            <ul className="space-y-2">
              {diagnostics.dependencies.map((dependency) => (
                <li key={dependency.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-surface-border px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">
                      {dependency.id} {dependency.version ? `v${dependency.version}` : ''}
                    </p>
                    <p className="text-xs text-content-muted">
                      {dependency.path ?? dependency.message}
                      {dependency.license ? ` · ${dependency.license}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={dependency.installed ? 'ok' : dependency.required ? 'error' : 'neutral'}>
                      {dependency.installed ? 'Installed' : dependency.required ? 'Missing' : 'Not required'}
                    </Badge>
                    {dependency.downloadUrl && (
                      <Button size="sm" variant="ghost" onClick={() => void api.openDependencyDownload({ id: dependency.id })}>
                        Official download
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Recent engine messages" subtitle="Sanitized — tokens and credentials are redacted before they are logged">
            {diagnostics.recentErrors.length === 0 ? (
              <p className="py-3 text-center text-sm text-content-muted">No warnings or errors recorded.</p>
            ) : (
              <ul className="space-y-1 font-mono text-xs">
                {diagnostics.recentErrors.map((entry, index) => (
                  <li key={`${entry.at ?? index}-${index}`} className="rounded-lg border border-surface-border px-3 py-2">
                    <span className="text-content-muted">{entry.at ? formatDateTime(entry.at) : ''} </span>
                    <span className="text-content-secondary">{entry.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Environment" subtitle="Non-secret details about this installation">
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <Row label="Platform" value={`${diagnostics.environment.platform} ${diagnostics.environment.arch}`} />
              <Row label="Application version" value={diagnostics.appVersion} />
              <Row label="Configuration folder" value={diagnostics.environment.dataDir} />
              <Row label="Log folder" value={diagnostics.environment.logDir} />
              <Row label="Cache folder" value={diagnostics.environment.cacheDir} />
              <Row
                label="Credential backend"
                value={`${diagnostics.environment.credentialBackend}${diagnostics.environment.credentialSecure ? ' (encrypted)' : ' (NOT encrypted)'}`}
              />
            </dl>
            <p className="mt-3 text-xs text-content-muted">
              The exported report never contains tokens, passwords or file contents. Errors are redacted before they are
              written to the log.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 rounded-lg border border-surface-border px-3 py-2">
      <dt className="text-content-muted">{label}</dt>
      <dd className="truncate text-right">{value}</dd>
    </div>
  );
}
