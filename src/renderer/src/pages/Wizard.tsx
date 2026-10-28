import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import type { AuthSession, DirectoryEntry, DriveLetterInfo, ProviderDescriptor, RemoteConfig } from '@shared/types.js';
import { formatBytes } from '@shared/format.js';
import { useAppStore } from '../state/store.js';
import { api } from '../lib/bridge.js';
import { Badge, Button, Card, ErrorBanner, Field, Select, TextInput, Toggle } from '../components/ui.js';
import { AlertIcon, CheckIcon, ChevronRightIcon, ExternalLinkIcon, InfoIcon, ShieldIcon, providerIcon } from '../components/Icons.js';
import { GB } from '@shared/format.js';

const STEPS = [
  'Provider',
  'Permissions',
  'Sign in',
  'Remote & folder',
  'Drive letter',
  'Cache mode',
  'Validate',
  'Mount',
] as const;

interface WizardState {
  providerId: string | null;
  sessionId: string | null;
  remoteName: string;
  remoteRoot: string;
  driveLetter: string | null;
  mountPoint: string;
  mode: 'streaming' | 'balanced';
  limitBytes: number;
  remoteId: string | null;
  clientId: string;
  clientSecret: string;
  useOwnClient: boolean;
  // WebDAV / S3 / local credentials
  url: string;
  user: string;
  password: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  region: string;
}

const INITIAL: WizardState = {
  providerId: null,
  sessionId: null,
  remoteName: '',
  remoteRoot: '',
  driveLetter: null,
  mountPoint: '',
  mode: 'balanced',
  limitBytes: 20 * GB,
  remoteId: null,
  clientId: '',
  clientSecret: '',
  useOwnClient: false,
  url: '',
  user: '',
  password: '',
  accessKeyId: '',
  secretAccessKey: '',
  endpoint: '',
  region: '',
};

export function Wizard({ onFinished }: { onFinished: () => void }) {
  const [step, setStep] = useState(0);
  const [state, setState] = useState<WizardState>(INITIAL);
  const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  const [letters, setLetters] = useState<DriveLetterInfo[]>([]);
  const [folders, setFolders] = useState<DirectoryEntry[]>([]);
  const [validation, setValidation] = useState<{ ok: boolean; detail: string } | null>(null);
  const [mountResult, setMountResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [error, setError] = useState<{ message: string; details?: string; remediation?: string } | null>(null);
  const [working, setWorking] = useState(false);
  /** Explicit acknowledgement for providers that are not validated yet. */
  const [acknowledgedPreview, setAcknowledgedPreview] = useState(false);

  const snapshot = useAppStore((state) => state.snapshot);
  const authSession = useAppStore((state) => state.authSession);
  const setAuthSession = useAppStore((state) => state.setAuthSession);
  const pushToast = useAppStore((state) => state.pushToast);

  const provider = useMemo(() => providers.find((entry) => entry.id === state.providerId) ?? null, [providers, state.providerId]);
  const isWindows = snapshot?.environment.isWindows ?? false;

  useEffect(() => {
    void api.listProviders().then((result) => {
      if (result.ok) setProviders(result.value);
    });
  }, []);

  useEffect(() => {
    if (step === 4) {
      void api.listDriveLetters().then((result) => {
        if (result.ok) setLetters(result.value);
      });
    }
  }, [step]);

  useEffect(() => {
    if (step === 3 && state.remoteId) {
      void api.browseRemote({ id: state.remoteId, path: state.remoteRoot }).then((result) => {
        if (result.ok) setFolders(result.value.entries);
      });
    }
  }, [step, state.remoteId, state.remoteRoot]);

  const patch = (next: Partial<WizardState>) => setState((current) => ({ ...current, ...next }));

  async function guard<T>(_label: string, call: () => Promise<{ ok: true; value: T } | { ok: false; error: { message: string; details?: string; remediation?: string } }>): Promise<T | null> {
    setWorking(true);
    setError(null);
    try {
      const result = await call();
      if (result.ok) return result.value;
      setError(result.error);
      return null;
    } finally {
      setWorking(false);
    }
  }

  /* ------------------------------------------------------------------ actions */

  async function startSignIn() {
    if (!provider) return;
    setAuthSession(null);
    const value = await guard('signin', () =>
      api.startAuth({
        providerId: provider.id,
        clientId: state.useOwnClient ? state.clientId || undefined : undefined,
        clientSecret: state.useOwnClient ? state.clientSecret || undefined : undefined,
      }),
    );
    if (value) {
      patch({ sessionId: value.id });
      setAuthSession(value);
    }
  }

  async function submitStaticCredentials() {
    if (!provider) return;
    const value = await guard('credentials', () =>
      api.submitCredentials({
        providerId: provider.id,
        remoteName: state.remoteName,
        url: state.url || undefined,
        user: state.user || undefined,
        password: state.password || undefined,
        accessKeyId: state.accessKeyId || undefined,
        secretAccessKey: state.secretAccessKey || undefined,
        endpoint: state.endpoint || undefined,
        region: state.region || undefined,
      }),
    );
    if (value) {
      setAuthSession(value);
      patch({ sessionId: value.id });
      await createRemote(value.id);
    }
  }

  async function createRemote(sessionId: string) {
    if (!provider) return;
    const value = await guard<RemoteConfig>('create', () =>
      api.createRemote({
        providerId: provider.id,
        remoteName: state.remoteName,
        remoteRoot: state.remoteRoot,
        displayName: `${provider.name} (${state.remoteName})`,
        driveLetter: state.driveLetter,
        mountPoint: state.mountPoint || null,
        authSessionId: sessionId,
      }),
    );
    if (value) {
      patch({ remoteId: value.id });
      pushToast({ level: 'success', title: 'Account configuration saved', body: 'The token is stored in the encrypted configuration.' });
      setStep(4);
    }
  }

  async function validateConnection() {
    if (!state.remoteId) return;
    const value = await guard('validate', () => api.testRemote({ id: state.remoteId ?? undefined }));
    if (value) {
      setValidation({ ok: value.ok, detail: value.detail });
      if (value.ok) {
        await guard('about', () => api.aboutRemote({ id: state.remoteId ?? undefined }));
        setStep(7);
      }
    }
  }

  async function mountDrive() {
    const value = await guard('mount', () => api.mount({ id: state.remoteId ?? undefined }));
    if (value) {
      setMountResult({ ok: true, detail: `Mounted (rclone pid ${value.pid ?? 'unknown'}) at ${value.target}.` });
      pushToast({ level: 'success', title: 'Drive mounted', body: `Available at ${value.target}` });
    }
  }

  async function cancel() {
    if (state.sessionId) await api.cancelAuth({ sessionId: state.sessionId });
    if (state.remoteId) {
      await api.removeRemote({ id: state.remoteId, confirmed: true });
      pushToast({ level: 'info', title: 'Incomplete configuration removed' });
    }
    setAuthSession(null);
    onFinished();
  }

  const session: AuthSession | null = authSession;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <Card
        title="Connect a cloud account"
        subtitle={
          provider
            ? `Step ${step + 1} of ${STEPS.length} — ${STEPS[step]} · ${provider.name}`
            : `Step ${step + 1} of ${STEPS.length} — ${STEPS[step]}`
        }
        action={
          <Button variant="ghost" size="sm" onClick={() => void cancel()}>
            Cancel
          </Button>
        }
      >
        <ol className="mb-5 flex flex-wrap gap-1.5">
          {STEPS.map((label, index) => (
            <li
              key={label}
              className={clsx(
                'rounded-full px-2.5 py-1 text-[11px] font-medium',
                index === step
                  ? 'bg-accent text-white'
                  : index < step
                    ? 'bg-state-ok/15 text-state-ok'
                    : 'bg-surface-hover text-content-muted',
              )}
            >
              {index + 1}. {label}
            </li>
          ))}
        </ol>

        {error && <div className="mb-4">
          <ErrorBanner error={error} />
        </div>}

        {/* 1 ---------------------------------------------------------------- */}
        {step === 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {providers.map((entry) => (
              <button
                key={entry.id}
                onClick={() => {
                  patch({
                    providerId: entry.id,
                    remoteName: defaultRemoteName(entry.id, providers.length),
                    driveLetter: snapshot?.settings.mount.defaultDriveLetter ?? 'Z',
                  });
                  setStep(1);
                }}
                className="flex items-start gap-3 rounded-xl border border-surface-border bg-surface-overlay/50 p-3 text-left transition-colors hover:bg-surface-hover"
              >
                <span className="mt-0.5">{providerIcon(entry.id, 28)}</span>
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{entry.name}</span>
                    {entry.releaseStatus !== 'supported' && <Badge tone="warn">{entry.releaseStatus}</Badge>}
                  </span>
                  <span className="mt-1 block text-xs text-content-secondary">{entry.description}</span>
                </span>
              </button>
            ))}
            {providers.length === 0 && <p className="text-sm text-content-muted">Loading providers…</p>}
          </div>
        )}

        {/* 2 ---------------------------------------------------------------- */}
        {step === 1 && provider && (
          <div className="space-y-4">
            {provider.releaseStatus !== 'supported' && (
              <div className="rounded-xl border border-state-warn/40 bg-state-warn/10 p-3">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-state-warn">
                  <AlertIcon size={16} /> Not validated yet ({provider.releaseStatus})
                </h3>
                <p className="mt-1 text-xs text-content-secondary">
                  CloudSSD has only been end-to-end tested with Google Drive and Microsoft OneDrive on Windows. This
                  provider is wired up through the same rclone engine, but no acceptance test covers it: authorization,
                  quota reporting or mounting may fail. Treat it as a preview, and report what breaks.
                </p>
                <label className="mt-2 flex items-start gap-2 text-xs text-content-primary">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={acknowledgedPreview}
                    onChange={(event) => setAcknowledgedPreview(event.target.checked)}
                  />
                  <span>I understand this provider is not covered by the tested scenarios and may not work.</span>
                </label>
              </div>
            )}
            <div className="rounded-xl border border-surface-border bg-surface-overlay/50 p-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <ShieldIcon size={16} className="text-accent" /> Permissions CloudSSD will request
              </h3>
              <ul className="mt-2 space-y-1 text-sm text-content-secondary">
                {provider.permissions.map((permission) => (
                  <li key={permission} className="flex gap-2">
                    <CheckIcon size={16} className="mt-0.5 shrink-0 text-state-ok" />
                    {permission}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-xl border border-surface-border bg-surface-overlay/50 p-3">
              <h3 className="text-sm font-semibold">Requirements and limits</h3>
              <ul className="mt-2 space-y-1 text-xs text-content-secondary">
                <li>
                  Requires the official rclone engine
                  {snapshot?.engine.rcloneVersion ? ` (found v${snapshot.engine.rcloneVersion})` : ' (not found)'}
                  {isWindows && ' and WinFsp for drive-letter mounting'}.
                </li>
                {provider.maxFileSizeBytes && <li>Largest supported file: {formatBytes(provider.maxFileSizeBytes)}.</li>}
                <li>Quota reporting: {provider.supportsQuota ? 'available from the provider' : 'not published by this provider'}.</li>
                {provider.limitations.slice(0, 3).map((limitation) => (
                  <li key={limitation}>{limitation}</li>
                ))}
              </ul>
              <div className="mt-2 flex flex-wrap gap-3 text-xs">
                <button
                  className="inline-flex items-center gap-1 text-accent hover:underline"
                  onClick={() => void api.openExternal({ url: provider.docsUrl })}
                >
                  <ExternalLinkIcon size={14} /> Provider documentation
                </button>
              </div>
            </div>
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep(0)}>
                Back
              </Button>
              <Button
                variant="primary"
                disabled={provider.releaseStatus !== 'supported' && !acknowledgedPreview}
                onClick={() => setStep(2)}
              >
                Continue
              </Button>
            </div>
          </div>
        )}

        {/* 3 ---------------------------------------------------------------- */}
        {step === 2 && provider && (
          <div className="space-y-4">
            {provider.authMode === 'oauth' ? (
              <>
                <p className="text-sm text-content-secondary">
                  CloudSSD opens the official {provider.name} sign-in page in your browser. You approve access there;
                  CloudSSD never sees your password. The resulting token is written directly into the encrypted
                  rclone configuration.
                </p>
                <Toggle
                  checked={state.useOwnClient}
                  onChange={(next) => patch({ useOwnClient: next })}
                  label="Use my own OAuth client (advanced, optional)"
                  description="Leave this off to use rclone's built-in client. If your provider rejects the shared client, create an OAuth client in your provider console and enter it here. It is stored encrypted."
                />
                {state.useOwnClient && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Client id">
                      <TextInput value={state.clientId} onChange={(event) => patch({ clientId: event.target.value })} placeholder="xxxxxxxx.apps.googleusercontent.com" />
                    </Field>
                    <Field label="Client secret">
                      <TextInput type="password" value={state.clientSecret} onChange={(event) => patch({ clientSecret: event.target.value })} />
                    </Field>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" loading={working} icon={<ExternalLinkIcon size={16} />} onClick={() => void startSignIn()}>
                    Sign in with {provider.name}
                  </Button>
                </div>

                {session && (
                  <div className="rounded-xl border border-surface-border bg-surface-overlay/50 p-3 text-sm">
                    <p className="font-medium">Status: {session.state.replace(/-/g, ' ')}</p>
                    <p className="mt-1 text-content-secondary">{session.message}</p>
                    {session.authUrl && (
                      <button
                        className="mt-2 inline-flex items-center gap-1 text-accent hover:underline"
                        onClick={() => void api.openExternal({ url: session.authUrl as string })}
                      >
                        <ExternalLinkIcon size={14} /> Open the sign-in page manually
                      </button>
                    )}
                  </div>
                )}

                <details className="rounded-xl border border-surface-border p-3 text-sm">
                  <summary className="cursor-pointer text-content-secondary">
                    Browser did not open? Paste the token manually
                  </summary>
                  <div className="mt-3 space-y-2">
                    <p className="text-xs text-content-secondary">
                      Run <code className="rounded bg-surface-hover px-1">rclone authorize {provider.backend}</code> on a
                      machine with a browser and paste the printed JSON token here.
                    </p>
                    <TokenPaste
                      disabled={!state.sessionId}
                      onSubmit={async (token) => {
                        const value = await guard('token', () => api.submitAuthToken({ sessionId: state.sessionId as string, token }));
                        if (value) setStep(3);
                      }}
                    />
                  </div>
                </details>

                <div className="flex justify-between">
                  <Button variant="ghost" onClick={() => setStep(1)}>
                    Back
                  </Button>
                  <Button
                    variant="primary"
                    disabled={session?.state !== 'completed' || !state.remoteName}
                    loading={working}
                    onClick={() => void createRemote(session?.id as string)}
                  >
                    Continue
                  </Button>
                </div>
              </>
            ) : (
              <div className="space-y-3">
                <Field label="Remote name" hint="A short name used internally, e.g. nextcloud">
                  <TextInput value={state.remoteName} onChange={(event) => patch({ remoteName: event.target.value })} />
                </Field>
                {provider.id === 'webdav' && (
                  <>
                    <Field label="Server URL" hint="HTTPS URL of the WebDAV endpoint">
                      <TextInput value={state.url} onChange={(event) => patch({ url: event.target.value })} placeholder="https://example.com/remote.php/dav/files/user/" />
                    </Field>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="User name">
                        <TextInput value={state.user} onChange={(event) => patch({ user: event.target.value })} />
                      </Field>
                      <Field label="Password">
                        <TextInput type="password" value={state.password} onChange={(event) => patch({ password: event.target.value })} />
                      </Field>
                    </div>
                  </>
                )}
                {provider.id === 's3' && (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Access key id">
                        <TextInput value={state.accessKeyId} onChange={(event) => patch({ accessKeyId: event.target.value })} />
                      </Field>
                      <Field label="Secret access key">
                        <TextInput type="password" value={state.secretAccessKey} onChange={(event) => patch({ secretAccessKey: event.target.value })} />
                      </Field>
                      <Field label="Endpoint (optional)">
                        <TextInput value={state.endpoint} onChange={(event) => patch({ endpoint: event.target.value })} placeholder="https://s3.us-west-1.wasabisys.com" />
                      </Field>
                      <Field label="Region (optional)">
                        <TextInput value={state.region} onChange={(event) => patch({ region: event.target.value })} />
                      </Field>
                    </div>
                  </>
                )}
                {provider.id === 'local' && (
                  <Field label="Directory" hint="Engine test target — a local folder exposed through rclone">
                    <TextInput value={state.url} onChange={(event) => patch({ url: event.target.value, remoteRoot: event.target.value })} placeholder="/tmp/cloudssd-test-remote" />
                  </Field>
                )}
                <div className="flex justify-between">
                  <Button variant="ghost" onClick={() => setStep(1)}>
                    Back
                  </Button>
                  <Button variant="primary" loading={working} disabled={!state.remoteName} onClick={() => void submitStaticCredentials()}>
                    Save credentials
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 4 ---------------------------------------------------------------- */}
        {step === 3 && (
          <div className="space-y-4">
            <Field label="Remote name" hint="Unique name for this connection (letters, digits, _ and -)">
              <TextInput value={state.remoteName} onChange={(event) => patch({ remoteName: event.target.value })} />
            </Field>
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-content-muted">Cloud folder</p>
              <div className="rounded-lg border border-surface-border">
                <div className="flex items-center gap-2 border-b border-surface-border px-3 py-2 text-xs text-content-secondary">
                  <span>/{state.remoteRoot}</span>
                  {state.remoteRoot && (
                    <button
                      className="text-accent hover:underline"
                      onClick={() => patch({ remoteRoot: state.remoteRoot.split('/').slice(0, -1).join('/') })}
                    >
                      up one level
                    </button>
                  )}
                </div>
                <ul className="max-h-56 overflow-y-auto p-2">
                  {folders.length === 0 && <li className="px-2 py-3 text-sm text-content-muted">No subfolders here.</li>}
                  {folders.map((entry) => (
                    <li key={entry.path}>
                      <button
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-hover"
                        onClick={() => patch({ remoteRoot: entry.path })}
                      >
                        <ChevronRightIcon size={14} className="text-content-muted" />
                        {entry.name}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              <p className="mt-1 text-xs text-content-muted">
                Leave empty to mount the whole {provider?.name ?? 'remote'} root.
              </p>
            </div>
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep(2)}>
                Back
              </Button>
              <Button
                variant="primary"
                loading={working}
                onClick={async () => {
                  if (state.remoteId) {
                    const value = await guard('update', () =>
                      api.updateRemote({
                        id: state.remoteId as string,
                        patch: { remoteRoot: state.remoteRoot },
                      }),
                    );
                    if (value) setStep(4);
                  }
                }}
              >
                Use this folder
              </Button>
            </div>
          </div>
        )}

        {/* 5 ---------------------------------------------------------------- */}
        {step === 4 && (
          <div className="space-y-4">
            {isWindows ? (
              <div>
                <p className="mb-2 text-sm text-content-secondary">
                  Choose a drive letter that Windows is not using. CloudSSD checks the current state of every letter
                  and refuses to overwrite an existing drive.
                </p>
                <div className="grid grid-cols-6 gap-2 sm:grid-cols-8">
                  {letters.map((letter) => (
                    <button
                      key={letter.letter}
                      disabled={letter.inUse}
                      onClick={() => patch({ driveLetter: letter.letter })}
                      className={clsx(
                        'rounded-lg border px-2 py-3 text-sm font-semibold transition-colors',
                        letter.inUse
                          ? 'cursor-not-allowed border-surface-border bg-surface-hover text-content-muted'
                          : state.driveLetter === letter.letter
                            ? 'border-accent bg-accent text-white'
                            : 'border-surface-border bg-surface-overlay/60 hover:bg-surface-hover',
                      )}
                      title={letter.label}
                    >
                      {letter.letter}:
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <Field label="Mount point" hint="Absolute directory used as the mount target on this platform">
                <TextInput value={state.mountPoint} onChange={(event) => patch({ mountPoint: event.target.value })} placeholder="/tmp/cloudssd-mounts/Z" />
              </Field>
            )}
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep(3)}>
                Back
              </Button>
              <Button
                variant="primary"
                loading={working}
                disabled={isWindows ? !state.driveLetter : !state.mountPoint}
                onClick={async () => {
                  const value = await guard('save-target', () =>
                    api.updateRemote({
                      id: state.remoteId as string,
                      patch: isWindows ? { driveLetter: state.driveLetter } : { mountPoint: state.mountPoint },
                    }),
                  );
                  if (value) setStep(5);
                }}
              >
                Continue
              </Button>
            </div>
          </div>
        )}

        {/* 6 ---------------------------------------------------------------- */}
        {step === 5 && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <ModeCard
                selected={state.mode === 'streaming'}
                onSelect={() => patch({ mode: 'streaming' })}
                title="Mode A — Cloud streaming"
                body="Files stay in the cloud and are fetched on demand. Local disk usage stays low, but uncached files need an internet connection."
              />
              <ModeCard
                selected={state.mode === 'balanced'}
                onSelect={() => patch({ mode: 'balanced' })}
                title="Mode B — Balanced cache"
                body="Keeps a bounded local copy of recently used files for faster repeated access. The cache limit is enforced by the engine."
              />
            </div>
            <Field label="Cache limit" hint="The engine evicts only data it confirms is safe to remove.">
              <Select value={String(state.limitBytes)} onChange={(event) => patch({ limitBytes: Number(event.target.value) })}>
                <option value={String(2 * GB)}>2 GB</option>
                <option value={String(10 * GB)}>10 GB</option>
                <option value={String(20 * GB)}>20 GB</option>
                <option value={String(50 * GB)}>50 GB</option>
                <option value={String(100 * GB)}>100 GB</option>
              </Select>
            </Field>
            <p className="rounded-lg border border-surface-border bg-surface-overlay/50 p-3 text-xs text-content-secondary">
              Mode C (selected offline files) is always available later: pin any file or folder from the Offline screen to
              keep a real local copy. Offline copies consume physical disk space and are shown separately from the cache.
            </p>
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep(4)}>
                Back
              </Button>
              <Button
                variant="primary"
                loading={working}
                onClick={async () => {
                  const current = snapshot?.settings.cache;
                  const value = await guard('save-cache', () =>
                    api.updateSettings({
                      cache: current
                        ? { ...current, mode: state.mode, limitBytes: state.limitBytes }
                        : {
                            mode: state.mode,
                            limitBytes: state.limitBytes,
                            dir: snapshot?.environment.cacheDir ?? '',
                            maxAgeSeconds: 86400,
                            chunkSizeBytes: 32 * GB,
                            readAheadBytes: 64 * GB,
                            writeBackSeconds: 15,
                            cleanupIntervalSeconds: 60,
                            minFreeSpaceBytes: null,
                          },
                    }),
                  );
                  if (value) setStep(6);
                }}
              >
                Continue
              </Button>
            </div>
          </div>
        )}

        {/* 7 ---------------------------------------------------------------- */}
        {step === 6 && (
          <div className="space-y-4">
            <p className="text-sm text-content-secondary">
              This step verifies two different things: that the account authorization works, and that CloudSSD can read
              the remote folder. A green result here does not yet mean the drive is mounted — that happens in the next
              step.
            </p>
            <Button variant="primary" loading={working} onClick={() => void validateConnection()}>
              Test authentication and remote access
            </Button>
            {validation && (
              <div
                className={clsx(
                  'rounded-xl border p-3 text-sm',
                  validation.ok ? 'border-state-ok/40 bg-state-ok/10' : 'border-state-error/40 bg-state-error/10',
                )}
              >
                <p className={validation.ok ? 'text-state-ok' : 'text-state-error'}>
                  {validation.ok ? 'Authentication and remote access verified.' : 'Validation failed.'}
                </p>
                <p className="mt-1 text-content-secondary">{validation.detail}</p>
              </div>
            )}
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep(5)}>
                Back
              </Button>
              {validation?.ok && (
                <Button variant="primary" onClick={() => setStep(7)}>
                  Continue
                </Button>
              )}
            </div>
          </div>
        )}

        {/* 8 ---------------------------------------------------------------- */}
        {step === 7 && (
          <div className="space-y-4">
            <p className="text-sm text-content-secondary">
              Mounting creates the real drive letter and verifies that Windows can read it. If this step fails, the
              account is still saved — nothing has to be repeated.
            </p>
            <Button variant="primary" loading={working} onClick={() => void mountDrive()}>
              Mount and verify
            </Button>
            {mountResult && (
              <div
                className={clsx(
                  'rounded-xl border p-3 text-sm',
                  mountResult.ok ? 'border-state-ok/40 bg-state-ok/10' : 'border-state-error/40 bg-state-error/10',
                )}
              >
                <p className="flex items-center gap-2 text-state-ok">
                  <CheckIcon size={16} /> {mountResult.detail}
                </p>
              </div>
            )}
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep(6)}>
                Back
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  onClick={() => void api.openMount().then(() => pushToast({ level: 'info', title: 'Opened the drive in File Explorer' }))}
                >
                  Open in File Explorer
                </Button>
                <Button variant="primary" onClick={onFinished}>
                  Done
                </Button>
              </div>
            </div>
          </div>
        )}
      </Card>

      {provider?.notes && provider.notes.length > 0 && (
        <div className="rounded-xl border border-surface-border bg-surface-overlay/40 p-3">
          <p className="flex items-center gap-2 text-xs font-semibold text-content-secondary">
            <InfoIcon size={14} /> Notes for {provider.name}
          </p>
          <ul className="mt-1 space-y-1 text-xs text-content-muted">
            {provider.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ModeCard({
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

function TokenPaste({ disabled, onSubmit }: { disabled: boolean; onSubmit: (token: string) => Promise<void> }) {
  const [token, setToken] = useState('');
  return (
    <div className="space-y-2">
      <textarea
        value={token}
        onChange={(event) => setToken(event.target.value)}
        rows={3}
        placeholder='{"access_token":"...","token_type":"Bearer","refresh_token":"...","expiry":"..."}'
        className="w-full rounded-lg border border-surface-border bg-surface-base px-3 py-2 font-mono text-xs"
      />
      <Button size="sm" variant="secondary" disabled={disabled || token.trim().length < 10} onClick={() => void onSubmit(token.trim())}>
        Submit token
      </Button>
      {disabled && (
        <p className="text-xs text-content-muted">Start the sign-in first, then paste the token.</p>
      )}
    </div>
  );
}

function defaultRemoteName(providerId: string, count: number): string {
  const base = providerId === 'gdrive' ? 'gdrive' : providerId === 'onedrive' ? 'onedrive' : providerId;
  return count > 0 ? base : base;
}

export { AlertIcon };
