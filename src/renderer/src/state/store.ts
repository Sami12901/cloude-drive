import { create } from 'zustand';
import type { AppError, AppSettings, AppSnapshot, AuthSession, DiagnosticsReport } from '@shared/types.js';
import type { BridgeResult } from '@shared/ipc.js';
import { api } from '../lib/bridge.js';

export interface Toast {
  id: string;
  level: 'info' | 'success' | 'warn' | 'error';
  title: string;
  body?: string;
}

export interface PendingAction {
  id: string;
  label: string;
}

interface AppState {
  snapshot: AppSnapshot | null;
  diagnostics: DiagnosticsReport | null;
  authSession: AuthSession | null;
  toasts: Toast[];
  busy: string | null;
  lastError: AppError | null;
  /** True until the first snapshot has been received. */
  initialising: boolean;

  refresh(): Promise<void>;
  refreshDiagnostics(): Promise<void>;
  setAuthSession(session: AuthSession | null): void;
  pushToast(toast: Omit<Toast, 'id'>): void;
  dismissToast(id: string): void;
  /** Runs a bridge call with busy state, error surfacing and a confirmation toast. */
  run<T>(label: string, call: () => Promise<BridgeResult<T>>, options?: { success?: string }): Promise<T | null>;
  updateSettings(patch: Partial<AppSettings>): Promise<void>;
}

let unsubscribe: (() => void) | null = null;

export const useAppStore = create<AppState>((set, get) => ({
  snapshot: null,
  diagnostics: null,
  authSession: null,
  toasts: [],
  busy: null,
  lastError: null,
  initialising: true,

  async refresh() {
    const result = await api.getSnapshot();
    // A malformed snapshot would blank every screen, so the previous one is
    // kept and the problem is surfaced instead.
    if (result.ok && result.value && typeof result.value === 'object' && 'status' in result.value) {
      set({ snapshot: result.value, initialising: false });
    } else {
      set({
        initialising: false,
        lastError: result.ok
          ? {
              code: 'internal_error',
              message: 'The application state could not be read.',
              recoverable: true,
            }
          : result.error,
      });
    }
  },

  async refreshDiagnostics() {
    const result = await api.getDiagnostics();
    if (result.ok && result.value && typeof result.value === 'object' && 'checks' in result.value) {
      set({ diagnostics: result.value });
    } else if (!result.ok) {
      set({ lastError: result.error });
    }
  },

  setAuthSession(session) {
    set({ authSession: session });
  },

  pushToast(toast) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
    setTimeout(() => get().dismissToast(id), toast.level === 'error' ? 9000 : 5000);
  },

  dismissToast(id) {
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
  },

  async run<T>(
    label: string,
    call: () => Promise<BridgeResult<T>>,
    options?: { success?: string },
  ): Promise<T | null> {
    set({ busy: label });
    try {
      const result = await call();
      if (result.ok) {
        if (options?.success) {
          get().pushToast({ level: 'success', title: options.success });
        }
        await get().refresh();
        return result.value;
      }
      set({ lastError: result.error });
      get().pushToast({
        level: 'error',
        title: result.error.message,
        body: result.error.remediation ?? result.error.details,
      });
      return null;
    } finally {
      set({ busy: null });
    }
  },

  async updateSettings(patch) {
    await get().run('settings', () => api.updateSettings(patch), { success: 'Settings saved' });
  },
}));

/** Subscribes to push events from the main process (snapshot + notifications). */
export function startEventSubscription(): () => void {
  if (unsubscribe) return unsubscribe;
  unsubscribe = api.onEvent((event) => {
    if (event.type === 'snapshot') {
      useAppStore.setState({ snapshot: event.snapshot, initialising: false });
    } else if (event.type === 'auth') {
      useAppStore.setState({ authSession: event.session });
    } else if (event.type === 'notification') {
      useAppStore.getState().pushToast({
        level: event.level === 'error' ? 'error' : event.level === 'warn' ? 'warn' : 'info',
        title: event.title,
        body: event.body,
      });
    }
  });
  return unsubscribe;
}

/** Polls the snapshot as a safety net in case an event is missed. */
export function startPolling(intervalMs = 5000): () => void {
  const timer = setInterval(() => void useAppStore.getState().refresh(), intervalMs);
  return () => clearInterval(timer);
}
