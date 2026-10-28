import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Offline } from '@renderer/pages/Offline.js';
import { useAppStore } from '@renderer/state/store.js';
import { makeRemote, makeSnapshot } from './fixtures.js';
import { callsTo, resetCalls } from './mocks/api.js';
import type { OfflineEntry } from '@shared/types.js';

/**
 * Offline pinning is a real local copy: the UI must show the state of that
 * copy and never label a remote-only file as "available offline".
 */

vi.mock('@renderer/lib/bridge.js', async () => {
  const mod = await import('./mocks/api.js');
  return { api: mod.api, isDevHost: false };
});

beforeEach(() => {
  resetCalls();
  useAppStore.setState({ snapshot: null, toasts: [], busy: null, lastError: null });
});

function entry(overrides: Partial<OfflineEntry> = {}): OfflineEntry {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    remoteId: makeRemote().id,
    remotePath: 'Docs/report.docx',
    isDir: false,
    localPath: 'C:\\Users\\tester\\CloudSSD Offline\\gdrive-11111111\\Docs\\report.docx',
    state: 'available',
    sizeBytes: 4 * 1024 * 1024,
    mtime: '2026-01-01T00:00:00.000Z',
    hash: null,
    pinnedAt: '2026-01-01T00:00:00.000Z',
    lastVerifiedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('Offline files', () => {
  it('explains that a pinned item is a real copy before anything is pinned', () => {
    useAppStore.setState({ snapshot: makeSnapshot() });
    render(<Offline />);
    expect(screen.getByText(/Nothing pinned for offline use/i)).toBeInTheDocument();
    expect(screen.getByText(/Connect an account before pinning files/i)).toBeInTheDocument();
    expect(
      screen.getAllByText((_content, element) => /after a real local copy exists/.test(element?.textContent ?? '')).length,
    ).toBeGreaterThan(0);
  });

  it('shows the state, size and local path of each pinned copy', () => {
    useAppStore.setState({
      snapshot: makeSnapshot({
        remote: makeRemote(),
        offline: { enabled: true, entries: [entry()], totalBytes: 4 * 1024 * 1024 },
      }),
    });
    render(<Offline />);
    expect(screen.getByText('Docs/report.docx')).toBeInTheDocument();
    expect(screen.getAllByText(/4\.0 MB/).length).toBeGreaterThan(0);
    expect(screen.getByText(/CloudSSD Offline/i)).toBeInTheDocument();
    const availableBadges = screen
      .queryAllByText('Available offline')
      .filter((element) => element.tagName !== 'STRONG');
    expect(availableBadges.length).toBe(1);
  });

  it('never labels a download in progress or a failed copy as available offline', () => {
    useAppStore.setState({
      snapshot: makeSnapshot({
        remote: makeRemote(),
        offline: {
          enabled: true,
          entries: [
            entry({ id: 'aaaaaaaa-0000-0000-0000-000000000001', state: 'downloading', sizeBytes: null, lastVerifiedAt: undefined }),
            entry({
              id: 'aaaaaaaa-0000-0000-0000-000000000002',
              state: 'failed',
              sizeBytes: null,
              lastVerifiedAt: undefined,
              error: { code: 'not_found', message: 'The cloud file is no longer reachable.', recoverable: true },
            }),
          ],
          totalBytes: 0,
        },
      }),
    });
    render(<Offline />);
    const availableBadges = screen
      .queryAllByText('Available offline')
      .filter((element) => element.tagName !== 'STRONG');
    expect(availableBadges).toHaveLength(0);
    expect(screen.getByText('Downloading')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText(/The cloud file is no longer reachable/i)).toBeInTheDocument();
    // Unknown sizes read as "Not available", never 0 B.
    expect(screen.getAllByText('Not available').length).toBeGreaterThanOrEqual(2);
  });

  it('removes only the local copy when the user asks to unpin', async () => {
    const user = userEvent.setup();
    useAppStore.setState({
      snapshot: makeSnapshot({
        remote: makeRemote(),
        offline: { enabled: true, entries: [entry()], totalBytes: 4 * 1024 * 1024 },
      }),
    });
    render(<Offline />);
    await user.click(screen.getByRole('button', { name: /Remove local copy/i }));
    const sent = callsTo('unpinOffline');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.args[0]).toMatchObject({ id: entry().id, confirmed: true });
  });
});
