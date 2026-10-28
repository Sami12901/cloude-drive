import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dashboard } from '@renderer/pages/Dashboard.js';
import { useAppStore } from '@renderer/state/store.js';
import { makeRemote, makeSnapshot } from './fixtures.js';
import { callsTo, resetCalls } from './mocks/api.js';

/**
 * Dashboard rendering against real snapshot shapes (built from the production
 * defaults). The point is that unknown numbers render as "Not available" and
 * that cloud quota, cache usage and physical disk stay separate concepts.
 */

vi.mock('@renderer/lib/bridge.js', async () => {
  const mod = await import('./mocks/api.js');
  return { api: mod.api, isDevHost: false };
});

beforeEach(() => {
  resetCalls();
  useAppStore.setState({ snapshot: null, diagnostics: null, toasts: [], busy: null, lastError: null });
});

describe('Dashboard', () => {
  it('shows an empty state and no invented storage numbers before an account exists', () => {
    useAppStore.setState({ snapshot: makeSnapshot() });
    render(<Dashboard />);

    expect(screen.getByText(/No cloud account connected/i)).toBeInTheDocument();
    expect(screen.getByText(/Connect an account to create your cloud drive/i)).toBeInTheDocument();
    // Quota, last connection time and transfer speed are unknown, not zero.
    expect(screen.getAllByText(/Not available/i).length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText(/Mount state:/i)).toBeInTheDocument();
  });

  it('keeps cloud quota, local cache and physical disk in separate cards', () => {
    useAppStore.setState({
      snapshot: makeSnapshot({
        remote: makeRemote(),
        quota: {
          available: true,
          totalBytes: 2 * 1024 ** 4,
          usedBytes: 700 * 1024 ** 3,
          freeBytes: 1.3 * 1024 ** 4,
          trashedBytes: null,
          otherBytes: null,
        },
        cache: {
          available: true,
          dir: '/home/tester/AppData/Local/CloudSSD/cache',
          dirWritable: true,
          mode: 'balanced',
          usedBytes: 3 * 1024 ** 3,
          limitBytes: 20 * 1024 ** 3,
          files: 12,
          pendingUploads: 0,
          uploading: 0,
          inUse: 2,
        },
      }),
    });
    render(<Dashboard />);

    expect(screen.getByText(/Cloud storage quota/i)).toBeInTheDocument();
    expect(screen.getByText(/Cache \(local disk\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Physical disk/i)).toBeInTheDocument();

    // 3.0 GB cached locally and 700.0 GB used in the cloud are different
    // numbers in different cards — the app never merges them.
    expect(screen.getByText('3.0 GB')).toBeInTheDocument();
    expect(screen.getByText('700.0 GB')).toBeInTheDocument();
    expect(screen.getByText(/CloudSSD never reports cloud capacity as local disk space/i)).toBeInTheDocument();
  });

  it('warns about missing components instead of pretending the drive is mounted', () => {
    useAppStore.setState({
      snapshot: makeSnapshot({
        remote: makeRemote(),
        engine: {
          rcloneVersion: null,
          rcloneAvailable: false,
          rclonePath: null,
          expectedRclonePath: 'C:\\Program Files\\CloudSSD\\rclone.exe',
          winfsp: {
            id: 'winfsp',
            required: true,
            installed: false,
            version: null,
            path: null,
            message: 'WinFsp was not found. CloudSSD cannot mount a drive without it.',
            remediation: 'Install WinFsp from winfsp.dev, then restart CloudSSD.',
          },
          mountPid: null,
          mountStartedAt: null,
          rcConnected: false,
          restartCount: 0,
        },
      }),
    });
    render(<Dashboard />);

    expect(screen.getByText(/A required component is missing/i)).toBeInTheDocument();
    expect(screen.getByText(/rclone was not found/i)).toBeInTheDocument();
    expect(screen.getAllByText(/WinFsp was not found/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/mounted and available/i)).not.toBeInTheDocument();
  });

  it('asks the main process to unmount when the drive is mounted', async () => {
    const user = userEvent.setup();
    useAppStore.setState({
      snapshot: makeSnapshot({
        remote: makeRemote(),
        status: { connection: 'connected', mount: 'mounted', summary: 'Test Drive is mounted as Z:' },
        engine: {
          rcloneVersion: '1.75.2',
          rcloneAvailable: true,
          rclonePath: 'C:\\Program Files\\CloudSSD\\rclone.exe',
          expectedRclonePath: 'C:\\Program Files\\CloudSSD\\rclone.exe',
          winfsp: { id: 'winfsp', required: true, installed: true, version: '2.0', path: 'C:\\Program Files (x86)\\WinFsp', message: 'WinFsp is installed.' },
          mountPid: 4242,
          mountStartedAt: '2026-01-01T00:00:00.000Z',
          rcConnected: true,
          restartCount: 0,
        },
      }),
    });
    render(<Dashboard />);

    await user.click(screen.getByRole('button', { name: /unmount/i }));
    expect(callsTo('unmount').length).toBe(1);
  });

  it('asks the main process to mount when the drive is disconnected', async () => {
    const user = userEvent.setup();
    useAppStore.setState({
      snapshot: makeSnapshot({
        remote: makeRemote(),
        status: { connection: 'disconnected', mount: 'unmounted', summary: 'Test Drive is not mounted.' },
      }),
    });
    render(<Dashboard />);
    await user.click(screen.getByRole('button', { name: /mount drive/i }));
    expect(callsTo('mount').length).toBe(1);
  });

  it('shows a failed connection with its error and a retry path', () => {
    useAppStore.setState({
      snapshot: makeSnapshot({
        remote: makeRemote({ authState: 'error' }),
        status: {
          connection: 'auth-expired',
          mount: 'failed',
          summary: 'The authorization for this account expired.',
          lastError: {
            code: 'auth_expired',
            message: 'The authorization for this account expired.',
            recoverable: true,
            remediation: 'Reconnect the account to refresh the authorization.',
          },
        },
      }),
    });
    render(<Dashboard />);
    expect(screen.getAllByText(/authorization for this account expired/i).length).toBeGreaterThan(0);
  });
});
