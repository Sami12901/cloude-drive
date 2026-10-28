import type { CloudSsdApi } from '@shared/ipc.js';

/**
 * A stand-in for the preload bridge used by the UI tests.
 *
 * Every call is recorded so a test can assert that pressing a button really
 * invoked the IPC channel, and every call resolves with `ok: true` unless the
 * test overrides it — no screen can "succeed" against a mocked cloud.
 */
export interface RecordedCall {
  method: string;
  args: unknown[];
}

export const calls: RecordedCall[] = [];

export const responses = new Map<string, unknown>();

/** Queue a canned response for the next call of `method`. */
export function respondWith(method: string, value: unknown): void {
  responses.set(method, value);
}

export function resetCalls(): void {
  calls.length = 0;
  responses.clear();
}

export function callsTo(method: string): RecordedCall[] {
  return calls.filter((entry) => entry.method === method);
}

export const api: CloudSsdApi = new Proxy({} as CloudSsdApi, {
  get(_target, property) {
    const method = String(property);
    if (method === 'onEvent') return () => () => undefined;
    return async (...args: unknown[]) => {
      calls.push({ method, args });
      if (responses.has(method)) return responses.get(method);
      return { ok: true, value: {} };
    };
  },
});
