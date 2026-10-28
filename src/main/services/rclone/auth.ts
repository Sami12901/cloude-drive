import { randomUUID } from 'node:crypto';
import { makeError } from '../../../shared/ipc.js';
import type { AppError, AuthSession, ProviderId, RemoteConfig } from '../../../shared/types.js';
import { defaultRemoteOptions, getProvider } from '../../providers/registry.js';
import type { BridgeEvent } from '../../../shared/ipc.js';
import type { Logger } from '../logging.js';
import type { CredentialVault } from '../credential-vault.js';
import { VAULT_KEYS as VAULT } from '../credential-vault.js';
import type { RcloneEngine } from './engine.js';
import type { ConfigService } from '../config-service.js';

const TOKEN_TIMEOUT_MS = 10 * 60 * 1000;

interface InternalSession extends AuthSession {
  token: string | null;
  remoteName?: string;
  providerId: ProviderId;
  clientId?: string;
  clientSecret?: string;
  error?: AppError;
}

export interface AuthServiceDeps {
  engine: RcloneEngine;
  config: ConfigService;
  vault: CredentialVault;
  logger: Logger;
  emit(event: BridgeEvent): void;
  clock(): Date;
}

/**
 * Account authorization.
 *
 * CloudSSD never implements OAuth by hand: it drives rclone's official
 * authorization command, which opens the provider's own consent page and prints
 * the resulting token. The token is written straight into the encrypted rclone
 * configuration and is never returned to the renderer, persisted in React state
 * or written to a log.
 */
export class AuthService {
  private readonly sessions = new Map<string, InternalSession>();

  constructor(private readonly deps: AuthServiceDeps) {}

  list(): AuthSession[] {
    return [...this.sessions.values()].map(toPublicSession);
  }

  get(sessionId: string): AuthSession | null {
    const session = this.sessions.get(sessionId);
    return session ? toPublicSession(session) : null;
  }

  /** Starts `rclone authorize` for OAuth providers. */
  async startOAuth(input: {
    providerId: ProviderId;
    remoteName?: string;
    clientId?: string;
    clientSecret?: string;
  }): Promise<AuthSession> {
    const provider = getProvider(input.providerId);
    if (!provider) throw new Error(`Unknown provider "${input.providerId}".`);
    if (provider.authMode !== 'oauth') {
      throw new Error(`${provider.name} does not use an OAuth flow; submit credentials instead.`);
    }
    if (!this.deps.engine.available) {
      throw Object.assign(new Error('rclone is not available, so sign-in cannot start.'), { code: 'dependency_missing' });
    }

    const id = randomUUID();
    const session: InternalSession = {
      id,
      providerId: provider.id,
      state: 'starting',
      browserOpened: false,
      message: `Starting the ${provider.name} sign-in flow…`,
      createdAt: this.deps.clock().toISOString(),
      token: null,
      remoteName: input.remoteName,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
    };
    this.sessions.set(id, session);
    this.publish(session);

    const cli = await this.deps.engine.cli();
    const args = ['authorize', provider.backend];
    if (input.clientId && input.clientSecret) {
      args.push(input.clientId, input.clientSecret);
    }

    let captured = '';
    const controller = new AbortController();
    const runPromise = cli.run(args, {
      timeoutMs: TOKEN_TIMEOUT_MS,
      signal: controller.signal,
      onStdout: (chunk) => {
        captured += chunk;
        this.consumeOutput(session, captured);
        if (session.token && !controller.signal.aborted) controller.abort();
      },
      onStderr: (chunk) => {
        captured += chunk;
        this.consumeOutput(session, captured);
      },
    });

    void runPromise
      .then((result) => {
        if (session.token) {
          this.complete(session);
          return;
        }
        if (session.state === 'cancelled' || session.state === 'failed') return;
        this.fail(
          session,
          result.timedOut
            ? 'The sign-in window closed before authorization finished.'
            : `rclone authorize ended without a token (exit ${result.code}).`,
          result.stderr,
        );
      })
      .catch((error: Error) => {
        if (session.state === 'cancelled') return;
        this.fail(session, 'The sign-in flow could not be started.', error.message);
      });

    return toPublicSession(session);
  }

  /** Manual token paste (headless machines, or when the browser cannot open). */
  async submitToken(sessionId: string, token: string): Promise<AuthSession> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Unknown sign-in session.');
    if (session.state === 'cancelled') throw new Error('This sign-in session was cancelled. Start again.');
    session.token = compactToken(token);
    this.complete(session);
    return toPublicSession(session);
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.state = 'cancelled';
    session.message = 'Sign-in cancelled.';
    this.publish(session);
  }

  /**
   * Creates the rclone remote from a completed session. The token only ever
   * lives in the encrypted rclone configuration.
   */
  async createRemoteFromSession(
    sessionId: string,
    options: { remoteName: string; remoteRoot?: string; extra?: Record<string, string> },
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Unknown sign-in session.');
    if (!session.token) throw new Error('Sign-in is not finished yet.');
    const provider = getProvider(session.providerId);
    if (!provider) throw new Error('Unknown provider.');

    const config: Record<string, string> = {
      ...defaultRemoteOptions(provider.id),
      ...(options.extra ?? {}),
      token: session.token,
    };
    if (session.clientId && session.clientSecret) {
      config.client_id = session.clientId;
      config.client_secret = session.clientSecret;
      await this.deps.vault.set(VAULT.oauthClient(options.remoteName), session.clientSecret);
    }
    await this.deps.engine.config.createRemote(options.remoteName, provider.backend, config);
    session.remoteName = options.remoteName;
    this.deps.logger.info('Created rclone remote from a completed sign-in.', { remoteName: options.remoteName });
  }

  /** Non-OAuth providers (WebDAV, S3, local test target). */
  async submitCredentials(input: {
    providerId: ProviderId;
    remoteName: string;
    user?: string;
    password?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    endpoint?: string;
    region?: string;
    url?: string;
    vendor?: string;
  }): Promise<AuthSession> {
    const provider = getProvider(input.providerId);
    if (!provider) throw new Error(`Unknown provider "${input.providerId}".`);
    const id = randomUUID();
    const session: InternalSession = {
      id,
      providerId: provider.id,
      state: 'exchanging',
      browserOpened: false,
      message: `Saving ${provider.name} credentials…`,
      createdAt: this.deps.clock().toISOString(),
      token: null,
      remoteName: input.remoteName,
    };
    this.sessions.set(id, session);
    this.publish(session);

    try {
      const config: Record<string, string> = { ...defaultRemoteOptions(provider.id) };
      if (provider.id === 'webdav') {
        if (!input.url || !input.user || !input.password) {
          throw new Error('WebDAV needs a server URL, a user name and a password.');
        }
        if (!/^https?:\/\//i.test(input.url)) {
          throw new Error('The WebDAV server URL must start with http:// or https://.');
        }
        config.url = input.url;
        config.user = input.user;
        config.pass = await this.deps.engine.config.obscure(input.password);
        if (input.vendor) config.vendor = input.vendor;
      } else if (provider.id === 's3') {
        if (!input.accessKeyId || !input.secretAccessKey) {
          throw new Error('S3-compatible storage needs an access key id and a secret key.');
        }
        config.access_key_id = input.accessKeyId;
        config.secret_access_key = await this.deps.engine.config.obscure(input.secretAccessKey);
        if (input.endpoint) config.endpoint = input.endpoint;
        if (input.region) config.region = input.region;
      } else if (provider.id === 'local') {
        // Test target: a `local` remote addresses the filesystem, so the remote
        // root carries the directory (e.g. `/tmp/cloudssd-test-remote`).
        if (!input.url) throw new Error('A local test target needs a directory path.');
      }
      await this.deps.engine.config.createRemote(input.remoteName, provider.backend, config);
      session.state = 'completed';
      session.message = `${provider.name} configuration saved.`;
      this.publish(session);
      return toPublicSession(session);
    } catch (error) {
      this.fail(session, 'The credentials could not be saved.', (error as Error).message);
      throw error;
    }
  }

  /**
   * Refreshes an expired or revoked authorization by re-running the provider's
   * own flow (rclone prints a URL and updates the stored token atomically).
   */
  async reconnect(remote: RemoteConfig): Promise<{ ok: boolean; detail: string; authUrl?: string }> {
    if (!this.deps.engine.available) return { ok: false, detail: 'rclone is not available.' };
    const cli = await this.deps.engine.cli();
    const args = ['config', 'reconnect', `${remote.remoteName}:`, '--auto-confirm'];
    let output = '';
    const result = await cli.run(args, {
      timeoutMs: TOKEN_TIMEOUT_MS,
      onStdout: (chunk) => (output += chunk),
      onStderr: (chunk) => (output += chunk),
    });
    const authUrl = /Please go to the following link:\s*(\S+)/.exec(output)?.[1];
    if (result.code === 0) {
      return { ok: true, detail: `${remote.displayName} authorization refreshed.`, authUrl };
    }
    return {
      ok: false,
      detail: tail(output || result.stderr || 'rclone config reconnect failed.'),
      authUrl,
    };
  }

  /** Discards the stored credentials of a remote (cloud files are untouched). */
  async forget(remote: RemoteConfig): Promise<void> {
    await this.deps.engine.config.deleteRemote(remote.remoteName);
    await this.deps.vault.delete(VAULT.oauthClient(remote.remoteName));
    for (const session of this.sessions.values()) {
      if (session.remoteName === remote.remoteName) {
        session.token = null;
        this.sessions.delete(session.id);
      }
    }
  }

  /* ------------------------------------------------------------- internals */

  private consumeOutput(session: InternalSession, output: string): void {
    const url = /Please go to the following link:\s*(\S+)/.exec(output)?.[1];
    if (url && session.authUrl !== url) {
      session.authUrl = url;
      session.state = 'waiting-for-user';
      session.message = 'Complete the sign-in in your browser. CloudSSD never sees your password.';
      this.publish(session);
    }
    const token = extractToken(output);
    if (token && !session.token) {
      session.token = token;
      this.complete(session);
    }
  }

  private complete(session: InternalSession): void {
    if (session.state === 'completed') return;
    session.state = 'completed';
    session.message = 'Authorization completed. The token is stored in the encrypted configuration.';
    session.authUrl = undefined;
    this.publish(session);
  }

  private fail(session: InternalSession, message: string, detail?: string): void {
    session.state = 'failed';
    session.message = message;
    session.error = makeError('auth_failed', message, { details: detail ? tail(detail) : undefined, recoverable: true });
    this.publish(session);
  }

  private publish(session: InternalSession): void {
    this.deps.logger.info('auth session update', { id: session.id, provider: session.providerId, state: session.state });
    this.deps.emit({ type: 'auth', session: toPublicSession(session) });
  }
}

function toPublicSession(session: InternalSession): AuthSession {
  return {
    id: session.id,
    providerId: session.providerId,
    state: session.state,
    authUrl: session.authUrl,
    browserOpened: session.browserOpened,
    message: session.message,
    error: session.error,
    createdAt: session.createdAt,
  };
}

/** Pulls the JSON token out of rclone's authorize output. */
export function extractToken(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    if (!trimmed.includes('access_token') && !trimmed.includes('refresh_token')) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.token_type || parsed.access_token || parsed.refresh_token) return compactToken(trimmed);
    } catch {
      continue;
    }
  }
  return null;
}

export function compactToken(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return value.trim();
  }
}

function tail(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 400 ? trimmed.slice(trimmed.length - 400) : trimmed;
}
