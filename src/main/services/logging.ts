import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { redactText, redactValue, type RedactionOptions } from '../../shared/redaction.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEntry {
  ts: string;
  level: LogLevel;
  scope: string;
  message: string;
  meta?: Record<string, unknown>;
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(scope: string): Logger;
  /** Reads back recent entries (used by the diagnostics screen). */
  recent(limit?: number): LogEntry[];
}

export interface FileLoggerOptions {
  dir: string;
  level: LogLevel;
  maxBytes: number;
  retentionDays: number;
  /** Home directory replaced with `~` in every message. */
  homeDir?: string;
  /** Extra literals (engine passwords, session tokens) removed from every message. */
  extraSecrets?: () => string[];
}

/**
 * Structured, sanitized, size- and age-bounded file logger.
 *
 * Every message passes through `redactText`, so rclone output that happens to
 * contain a token cannot leak into the log file.
 */
export class FileLogger implements Logger {
  private readonly scopes: string[];
  private readonly memory: LogEntry[] = [];
  private readonly memoryLimit = 500;

  constructor(
    private readonly options: FileLoggerOptions,
    scope = 'app',
    private readonly parent?: FileLogger,
  ) {
    this.scopes = parent ? [...parent.scopesOf(), scope] : [scope];
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  }

  scopesOf(): string[] {
    return this.scopes;
  }

  child(scope: string): Logger {
    return new FileLogger(this.options, scope, this);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write('debug', message, meta);
  }
  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta);
  }
  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta);
  }
  error(message: string, meta?: Record<string, unknown>): void {
    this.write('error', message, meta);
  }

  recent(limit = 200): LogEntry[] {
    return this.memory.slice(-limit);
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.options.level]) return;
    const scope = this.scopes.join(':');
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      scope,
      message: this.sanitize(message),
      meta: meta ? this.sanitizeMeta(meta) : undefined,
    };
    this.parent?.remember(entry);
    this.remember(entry);
    this.append(entry);
  }

  private remember(entry: LogEntry): void {
    this.memory.push(entry);
    if (this.memory.length > this.memoryLimit) this.memory.splice(0, this.memory.length - this.memoryLimit);
  }

  private sanitize(message: string): string {
    return redactText(message, {
      homeDir: this.options.homeDir,
      extraSecrets: this.options.extraSecrets?.() ?? [],
    });
  }

  private sanitizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(meta)) {
      if (value instanceof Error) {
        out[key] = this.sanitize(value.message);
      } else if (typeof value === 'string') {
        out[key] = this.sanitize(value);
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  private append(entry: LogEntry): void {
    const file = join(this.options.dir, 'cloudssd.log');
    try {
      const line = `${JSON.stringify(entry)}\n`;
      appendFileSync(file, line, { encoding: 'utf8' });
      if (statSync(file).size > this.options.maxBytes) {
        renameSync(file, join(this.options.dir, `cloudssd-${entry.ts.replace(/[:.]/g, '-')}.log`));
      }
      this.enforceRetention();
    } catch {
      // Logging must never break the application.
    }
  }

  private enforceRetention(): void {
    try {
      const cutoff = Date.now() - this.options.retentionDays * 24 * 3600 * 1000;
      for (const name of readdirSync(this.options.dir)) {
        if (!name.startsWith('cloudssd') || !name.endsWith('.log')) continue;
        const full = join(this.options.dir, name);
        const stat = statSync(full);
        if (stat.mtimeMs < cutoff) rmSync(full, { force: true });
      }
    } catch {
      // ignore
    }
  }
}

/** Logger used by unit tests and by the dev host when no data dir is configured. */
export class MemoryLogger implements Logger {
  entries: LogEntry[] = [];

  constructor(
    private readonly scope = 'test',
    public level: LogLevel = 'debug',
    private readonly redaction: RedactionOptions = {},
  ) {}

  child(scope: string): Logger {
    const child = new MemoryLogger(`${this.scope}:${scope}`, this.level, this.redaction);
    // Child loggers share the parent sink so tests (and the diagnostics view)
    // can inspect every entry produced by a subsystem.
    child.entries = this.entries;
    return child;
  }
  recent(limit = 200): LogEntry[] {
    return this.entries.slice(-limit);
  }
  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    // Same sanitization the file logger applies: a test harness must never
    // become the one place where a token can survive in memory or output.
    this.entries.push({
      ts: new Date().toISOString(),
      level,
      scope: this.scope,
      message: redactText(message, this.redaction),
      meta: meta ? (redactValue(meta, this.redaction) as Record<string, unknown>) : undefined,
    });
  }
  debug(message: string, meta?: Record<string, unknown>): void {
    this.write('debug', message, meta);
  }
  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta);
  }
  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta);
  }
  error(message: string, meta?: Record<string, unknown>): void {
    this.write('error', message, meta);
  }
}

/** Creates a file (atomically) with user-only permissions. */
export function writeSecureFile(path: string, contents: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', mode);
  try {
    writeFileSync(fd, contents, { encoding: 'utf8' });
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  try {
    if (existsSync(path)) chmodSync(path, mode);
  } catch {
    /* best effort on POSIX; Windows uses ACLs (see platform/win32.ts) */
  }
}
