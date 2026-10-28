import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Logger } from '../logging.js';
import { redactArgs } from '../../../shared/redaction.js';

export interface RunOptions {
  timeoutMs?: number;
  /** Extra environment for this process only (used for the config password). */
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  /** Written to stdin and closed (used by `rclone config encryption set`). */
  stdin?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  maxOutputBytes?: number;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
}

export interface SpawnContract {
  (binary: string, args: string[], options: { env: NodeJS.ProcessEnv; windowsHide: boolean }): ChildProcessWithoutNullStreams;
}

const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024;

/**
 * Thin, safe wrapper around `spawn`.
 *
 * Security properties:
 *  - subprocesses are always launched with an argument array (`shell` is never used);
 *  - the rclone configuration password travels in the child environment, never
 *    in argv (argv is visible to every process on the machine);
 *  - output is bounded, so a runaway rclone cannot exhaust memory;
 *  - every command is logged with its arguments **after redaction**: rclone
 *    takes provider tokens as `config create` arguments, so the argument array
 *    is passed through `redactArgs` before it can reach a log file. (Residual
 *    risk, documented in docs/security.md: argv is briefly visible to other
 *    processes of the same user while the command runs.)
 */
export class RcloneCli {
  constructor(
    private readonly binary: string,
    private readonly env: () => Record<string, string | undefined>,
    private readonly logger: Logger,
    private readonly spawnImpl: SpawnContract = (file, args, options) => spawn(file, args, options) as ChildProcessWithoutNullStreams,
  ) {}

  get path(): string {
    return this.binary;
  }

  /**
   * Starts a long-lived process (used for `rclone mount`) and returns the handle
   * so the caller can attach stream and exit handlers. Same safety rules as
   * `run`: argument array only, bounded environment, no shell.
   */
  spawn(args: string[], options: { env?: Record<string, string | undefined> } = {}): ChildProcessWithoutNullStreams {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...stripUndefined(this.env()),
      ...stripUndefined(options.env ?? {}),
      RCLONE_ASK_PASSWORD: 'false',
    };
    this.logger.debug('rclone spawn', { args: redactArgs(args) });
    return this.spawnImpl(this.binary, args, { env: childEnv, windowsHide: true });
  }

  async run(args: string[], options: RunOptions = {}): Promise<RunResult> {
    const startedAt = Date.now();
    const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...stripUndefined(this.env()),
      ...stripUndefined(options.env ?? {}),
      // rclone must never block on an interactive prompt.
      RCLONE_ASK_PASSWORD: 'false',
    };

    this.logger.debug('rclone exec', { args: redactArgs(args) });

    const child = this.spawnImpl(this.binary, args, { env: childEnv, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let spawnError: string | undefined;

    const kill = () => {
      if (!child.killed) child.kill();
    };

    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, options.timeoutMs)
      : undefined;

    const abortHandler = () => {
      aborted = true;
      kill();
    };
    options.signal?.addEventListener('abort', abortHandler, { once: true });

    return new Promise<RunResult>((resolve) => {
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        options.signal?.removeEventListener('abort', abortHandler);
        const durationMs = Date.now() - startedAt;
        const result: RunResult = { code, stdout, stderr, durationMs, timedOut, aborted, spawnError };
        if (code !== 0) {
          this.logger.debug('rclone exited non-zero', {
            code,
            durationMs,
            stderr: tail(stderr, 400),
          });
        }
        resolve(result);
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (stdout.length < maxOutput) stdout += text;
        else kill();
        options.onStdout?.(text);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (stderr.length < maxOutput) stderr += text;
        else kill();
        options.onStderr?.(text);
      });
      child.on('error', (error: Error) => {
        spawnError = error.message;
        finish(null);
      });
      child.on('close', (code) => finish(code));

      if (options.stdin !== undefined) {
        child.stdin?.write(options.stdin);
        child.stdin?.end();
      } else {
        child.stdin?.end();
      }
    });
  }

  /** Runs a command that prints JSON and parses the output. */
  async json<T>(args: string[], options: RunOptions = {}): Promise<T> {
    const result = await this.run(args, options);
    if (result.code !== 0) {
      throw new EngineError(
        `rclone ${args[0] ?? 'command'} failed (exit ${result.code})`,
        tail(result.stderr || result.stdout, 800),
      );
    }
    try {
      return JSON.parse(result.stdout) as T;
    } catch {
      throw new EngineError(`rclone ${args[0] ?? 'command'} returned invalid JSON`, tail(result.stdout, 400));
    }
  }

  async version(): Promise<string | null> {
    const result = await this.run(['version'], { timeoutMs: 20000 });
    if (result.code !== 0) return null;
    const match = /^rclone v([\d.]+)/m.exec(result.stdout);
    return match?.[1] ?? null;
  }
}

export class EngineError extends Error {
  constructor(
    message: string,
    public readonly detail: string,
    public readonly exitCode?: number,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

function stripUndefined(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function tail(value: string, length: number): string {
  return value.length > length ? value.slice(value.length - length) : value;
}
