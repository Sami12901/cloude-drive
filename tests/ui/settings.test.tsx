import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Settings } from '@renderer/pages/Settings.js';
import { useAppStore } from '@renderer/state/store.js';
import { makeRemote, makeSnapshot } from './fixtures.js';
import { callsTo, resetCalls } from './mocks/api.js';

/**
 * Settings screens must be wired to real IPC calls, and destructive actions
 * must ask for confirmation before they touch anything.
 */

vi.mock('@renderer/lib/bridge.js', async () => {
  const mod = await import('./mocks/api.js');
  return { api: mod.api, isDevHost: false };
});

beforeEach(() => {
  resetCalls();
  useAppStore.setState({ snapshot: null, toasts: [], busy: null, lastError: null });
});

function renderSettings(overrides = {}) {
  useAppStore.setState({ snapshot: makeSnapshot({ remote: makeRemote(), ...overrides }) });
  return render(<Settings />);
}

async function openSection(user: ReturnType<typeof userEvent.setup>, name: RegExp | string) {
  await user.click(screen.getByRole('button', { name }));
}

describe('Settings', () => {
  it('offers the cache modes with honest descriptions', async () => {
    const user = userEvent.setup();
    renderSettings();
    await openSection(user, /^Cache$/i);
    expect(screen.getByText(/Mode A — Cloud streaming/i)).toBeInTheDocument();
    expect(screen.getByText(/Files are streamed from the cloud on demand/i)).toBeInTheDocument();
    expect(screen.getByText(/Mode B — Balanced cache/i)).toBeInTheDocument();

    await openSection(user, /Offline files/i);
    expect(screen.getByText(/Offline files \(Mode C\)/i)).toBeInTheDocument();
  });

  it('sends a settings patch when the cache limit changes', async () => {
    const user = userEvent.setup();
    renderSettings();
    await openSection(user, /^Cache$/i);
    const select = screen.getByLabelText(/Cache limit/i);
    await user.selectOptions(select, String(10 * 1024 ** 3));
    const sent = callsTo('updateSettings');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.args[0]).toMatchObject({ cache: { limitBytes: 10 * 1024 ** 3 } });
  });

  it('exposes startup behaviour as explicit switches (no hidden tasks)', async () => {
    const user = userEvent.setup();
    renderSettings();
    await openSection(user, /^Startup$/i);
    expect(screen.getByText(/Start CloudSSD when Windows starts/i)).toBeInTheDocument();
    const switches = screen.getAllByRole('switch');
    expect(switches.length).toBeGreaterThanOrEqual(5);
    // Auto-start is opt-in: it is off in the default settings.
    expect(screen.getByRole('switch', { name: /Start CloudSSD when Windows starts/i })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('requires confirmation before removing an account and states the cloud is untouched', async () => {
    const user = userEvent.setup();
    renderSettings();
    await openSection(user, /^Advanced$/i);

    expect(screen.getByText(/Files in your cloud account are never\s+deleted/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Remove Test Drive/i }));
    // Nothing is sent until the explicit confirmation click.
    expect(callsTo('removeRemote')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /Confirm removal/i }));
    const sent = callsTo('removeRemote');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.args[0]).toMatchObject({ confirmed: true, id: makeRemote().id });
  });
});
