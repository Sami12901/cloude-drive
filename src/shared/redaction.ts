/**
 * Redaction helpers.
 *
 * Engine (rclone) output, crash reports and log files must never contain OAuth
 * tokens, rclone config passwords, bearer headers or user home paths. Every
 * string that leaves the main process for a log file, a diagnostic export or the
 * renderer goes through `redactText`.
 */

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  { name: 'rclone-token-json', pattern: /\{\s*"access_token"\s*:\s*"[^"]*"[\s\S]*?\}/g, replacement: '[REDACTED-TOKEN]' },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replacement: '[REDACTED-JWT]' },
  { name: 'bearer', pattern: /(?<=[Bb]earer\s+)[A-Za-z0-9._\-+/=]{8,}/g, replacement: '[REDACTED-BEARER]' },
  {
    name: 'json-token-field',
    pattern: /"(access_token|refresh_token|token|id_token|client_secret|secret_access_key|password|pass|obscured)"\s*:\s*"[^"]*"/gi,
    replacement: '"$1": "[REDACTED]"',
  },
  {
    name: 'ini-secret',
    pattern: /^\s*(password|pass|client_secret|token|access_key_id|secret_access_key|auth)\s*=\s*\S.*$/gim,
    replacement: '$1 = [REDACTED]',
  },
  {
    name: 'cli-secret',
    pattern: /--(password|pass|client-secret|token|header)\b(=|\s+)("[^"]*"|\S+)/gi,
    replacement: '--$1 [REDACTED]',
  },
  {
    name: 'env-secret',
    pattern: /(RCLONE_CONFIG_PASS|RCLONE_PASSWORD|RCLONE_CONFIG_PASS_COMMAND)\s*=\s*\S+/g,
    replacement: '$1=[REDACTED]',
  },
  { name: 'aws-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: '[REDACTED-AWS-KEY]' },
  { name: 'url-userinfo', pattern: /(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, replacement: '$1[REDACTED]@' },
  { name: 'oauth-code', pattern: /\b[0-9a-zA-Z]{40,}\.[0-9a-zA-Z_-]{10,}\b/g, replacement: '[REDACTED-OPAQUE]' },
];

export interface RedactionOptions {
  /** Home directory replaced with `~` when set. */
  homeDir?: string;
  /** Extra literal secrets (session tokens) to strip, e.g. the rclone rc password. */
  extraSecrets?: string[];
}

export function redactText(input: string, options: RedactionOptions = {}): string {
  let out = input;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  if (options.homeDir && options.homeDir.length > 2) {
    const escaped = options.homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.split(escaped).join('~');
  }
  for (const secret of options.extraSecrets ?? []) {
    if (secret && secret.length > 4) {
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.split(escaped).join('[REDACTED]');
    }
  }
  return out;
}

/** Deep-redacts every string inside an arbitrary JSON-ish value. */
export function redactValue<T>(value: T, options: RedactionOptions = {}): T {
  if (typeof value === 'string') return redactText(value, options) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, options)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/(secret|token|password|pass|authorization|refresh)/i.test(key)) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = redactValue(entry, options);
      }
    }
    return out as T;
  }
  return value;
}

/** Keys whose value must never be logged, whatever else the redactor finds. */
const SENSITIVE_ARG_KEYS =
  /^(token|access_token|refresh_token|id_token|password|pass|client_secret|secret|secret_access_key|access_key_id|auth|authorization|key|sas_url|sas|obscured|rc-pass|rc_pass)$/i;

/**
 * Renders a subprocess argument array for logging.
 *
 * `rclone config create` and friends take provider tokens as `--key value` /
 * `key=value` arguments, and argv is the only interface rclone offers for that.
 * Logging the array verbatim would put an OAuth token in the log file, so
 * values of sensitive keys are replaced before the command is ever written down.
 */
export function redactArgs(args: readonly string[]): string {
  const rendered = args.map((rawArg, index) => {
    const arg = rawArg ?? '';
    const equals = arg.indexOf('=');
    if (equals > 0) {
      const key = arg.slice(0, equals);
      const value = arg.slice(equals + 1);
      return SENSITIVE_ARG_KEYS.test(key) ? `${key}=[REDACTED]` : `${key}=${redactText(value)}`;
    }
    // `--flag value` form: redact the value that follows a sensitive flag.
    const previous = (index > 0 ? args[index - 1] : '') ?? '';
    if (/^--/.test(previous) && SENSITIVE_ARG_KEYS.test(previous.replace(/^--/, ''))) {
      return '[REDACTED]';
    }
    return redactText(arg);
  });
  return redactText(rendered.join(' '));
}

/**
 * Test/guard helper: returns the list of secrets that still appear in `text`.
 * Empty array means the text is safe to log or export.
 */
export function findLeakedSecrets(text: string, secrets: string[]): string[] {
  return secrets.filter((secret) => secret.length > 4 && text.includes(secret));
}
