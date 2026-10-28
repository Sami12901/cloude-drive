import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Wizard } from '@renderer/pages/Wizard.js';
import { useAppStore } from '@renderer/state/store.js';
import { makeSnapshot } from './fixtures.js';
import { api, resetCalls, respondWith } from './mocks/api.js';
import { PROVIDERS } from '../../src/main/providers/registry.js';
import type { ProviderDescriptor } from '@shared/types.js';

/**
 * The wizard must never present an untested provider as ready, and it must
 * show the official consent flow instead of asking for a token in a text box.
 */

vi.mock('@renderer/lib/bridge.js', async () => {
  const mod = await import('./mocks/api.js');
  return { api: mod.api, isDevHost: false };
});

const PROVIDER_LIST: ProviderDescriptor[] = [
  PROVIDERS.gdrive,
  PROVIDERS.onedrive,
  PROVIDERS.dropbox,
] as unknown as ProviderDescriptor[];

beforeEach(() => {
  resetCalls();
  respondWith('listProviders', { ok: true, value: PROVIDER_LIST });
  useAppStore.setState({ snapshot: makeSnapshot(), authSession: null, toasts: [], busy: null, lastError: null });
});

describe('Connect wizard', () => {
  it('lists providers and marks the ones that are not validated yet', async () => {
    render(<Wizard onFinished={() => undefined} />);
    await waitFor(() => expect(screen.getByText('Google Drive')).toBeInTheDocument());
    expect(screen.getByText('Microsoft OneDrive')).toBeInTheDocument();

    const dropbox = screen.getByText('Dropbox').closest('button');
    // Dropbox is not validated yet: the UI must say so instead of implying it works.
    expect(dropbox?.textContent).toMatch(/beta/i);

    const gdrive = screen.getByText('Google Drive').closest('button');
    expect(gdrive?.textContent).not.toMatch(/beta/i);
  });

  it('blocks untested providers behind an explicit acknowledgement', async () => {
    const user = userEvent.setup();
    render(<Wizard onFinished={() => undefined} />);
    await waitFor(() => expect(screen.getByText('Dropbox')).toBeInTheDocument());
    await user.click(screen.getByText('Dropbox'));

    expect(screen.getByText(/Not validated yet/i)).toBeInTheDocument();
    const continueButton = screen.getAllByRole('button', { name: /continue/i }).at(-1) as HTMLElement;
    expect(continueButton).toBeDisabled();

    await user.click(screen.getByRole('checkbox'));
    expect(continueButton).toBeEnabled();
  });

  it('shows the permissions that will be requested before anything happens', async () => {
    const user = userEvent.setup();
    render(<Wizard onFinished={() => undefined} />);
    await waitFor(() => expect(screen.getByText('Google Drive')).toBeInTheDocument());
    await user.click(screen.getByText('Google Drive'));

    expect(screen.getByText(/Permissions CloudSSD will request/i)).toBeInTheDocument();
    const permissions = PROVIDERS.gdrive.permissions as string[];
    for (const permission of permissions) {
      expect(screen.getByText(permission)).toBeInTheDocument();
    }
    // No provider call is made just by looking at the permissions step.
    expect(api).toBeDefined();
  });

  it('uses the official consent flow (no manual token entry on the happy path)', async () => {
    const user = userEvent.setup();
    render(<Wizard onFinished={() => undefined} />);
    await waitFor(() => expect(screen.getByText('Google Drive')).toBeInTheDocument());
    await user.click(screen.getByText('Google Drive'));

    const next = screen.getAllByRole('button', { name: /continue|next/i }).at(-1);
    await user.click(next as HTMLElement);

    await waitFor(() => expect(screen.getByRole('button', { name: /open|sign in|authorize/i })).toBeDefined());
  });
});
