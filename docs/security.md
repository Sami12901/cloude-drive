# Security model

This document states what CloudSSD protects, how, and — just as importantly — what it
does **not** protect yet. Anything not listed under "Verified" has not been executed on a
real Windows host; see the verification table in the [README](../README.md#verification-status).

## Assets being protected

| Asset | Where it lives | Protection |
| --- | --- | --- |
| OAuth token / provider credentials | Encrypted rclone configuration file | rclone config encryption (password below) |
| rclone configuration password | OS credential store | DPAPI via Electron `safeStorage` on Windows |
| rc (remote control) password | Memory only, regenerated per mount | Loopback-only endpoint |
| Settings (incl. `secretRef` values) | `%LOCALAPPDATA%\CloudSSD\settings.json` | File permissions `0600`, no secret *values* |
| Offline copies | User-chosen offline directory | Directory permissions restricted to the user |
| Log files | `%LOCALAPPDATA%\CloudSSD\logs\` | `0700` directory, `0600` files, redacted, rotated |

`settings.json` never contains a token. It stores a *reference* such as
`"secretRef": "rclone:gdrive"`, which is an index into the encrypted rclone config.

## Credential storage

- `SafeStorageProtection` (default on Windows) encrypts secrets with Electron
  `safeStorage`, which uses DPAPI per-user on Windows. Stored blobs are prefixed so a blob
  from a different backend is rejected instead of being misread.
- `FilePermissionOnlyProtection` exists for headless CI and for test harnesses. It is
  **explicitly insecure** and reports `secure: false` with a warning, which the app
  surfaces in Diagnostics. CloudSSD never falls back to it silently.
- If no secure backend is available at runtime, the app says so on the Diagnostics screen
  rather than storing plaintext without telling the user.

Tests: `tests/security/credential-vault.test.ts` covers both backends, round-trips, the
"refuse foreign blob" rule, `0600` permissions, and the absence of plaintext on disk.

## Process and IPC boundaries

- `contextIsolation: true`, `nodeIntegration: false`, sandbox-friendly preload; the
  renderer reaches the main process only through a typed bridge.
- A strict Content-Security-Policy is set in `src/renderer/index.html`.
- Every IPC channel is in an allow-list; every payload is validated with zod before it
  reaches a service (`src/main/ipc/handlers.ts` + `src/shared/validation.ts`). Unknown
  channels and malformed payloads are rejected, and destructive channels require an
  explicit `confirmed: true` flag.
- Renderer sender URLs are validated (`isTrustedRendererUrl`); links the app opens
  externally are checked against a provider allow-list (`isAllowedExternalUrl`).
- Subprocesses are always spawned with an argument array — never a shell string — so
  paths and user input cannot be interpreted as commands.

Tests: `tests/security/ipc-validation.test.ts` covers the allow-list, seven malicious
payload shapes, the confirmation requirement, and secret hygiene in the snapshot and the
diagnostics report.

## Logging and redaction

- Every message, meta field and exported diagnostic passes through `redactText`
  (OAuth token JSON, JWTs, bearer headers, `key = value` ini secrets, `--flag value`
  secrets, `RCLONE_*` env secrets, AWS keys, URL user info, opaque codes) and the home
  directory is replaced with `~`.
- rclone command lines are logged through `redactArgs()`, which replaces the values of
  sensitive keys and of values following sensitive flags. Without this, a
  `config create … token={"access_token": …}` command would put a live token in the log.
- Logs are size- and age-bounded (`retentionDays`, `maxLogBytes`) and written with
  `0700`/`0600` permissions.

Tests: `tests/unit/redaction.test.ts` (patterns, `redactArgs`, leak detection) and
`tests/provider/rclone-config.test.ts` ("never writes a token or password to the log").

## Engine (rclone) hardening

- The rclone configuration is password-encrypted; the password travels to the child
  process in its **environment**, never in argv, and never to a log.
- The rc endpoint for cache/transfer statistics listens on `127.0.0.1` only, with a
  random password generated per mount.
- Long option names only, taken from documented rclone flags; the mount argument array is
  asserted in `tests/unit/mount-args.test.ts` so an undocumented flag cannot slip in.
- The binary locator validates a candidate by running `rclone version` and checking the
  reported version, so a stale or foreign binary on `PATH` is rejected rather than used.

## Mount safety

- One mount per account, one lock file per mount target (`mount.lock`, pid + target), so a
  second CloudSSD instance cannot mount the same drive.
- Mount-target inspection distinguishes **stale** (attached but not responding, e.g. the
  engine was killed) from **live and owned by someone else**. Only stale targets are
  recovered automatically; a healthy mount belonging to another program is never
  unmounted, and the user gets a conflict error instead.
- Probing a mount point happens out of process with a timeout, because reading a dead
  FUSE mount blocks indefinitely.
- Unmount sequence: ask rclone to unmount (flushes write-back) → wait → signal → lazy
  detach only as a last resort.

## Known residual risks

1. **OAuth tokens in argv.** rclone only accepts provider values as `config create`
   arguments, so during that short command a token is visible in the process argument
   list to other processes of the same user. Logged copies are redacted, but the OS
   exposure remains. Mitigation requires rclone to accept values another way.
2. **rc password in argv.** rclone requires `--rc-pass` as a flag. The endpoint is
   loopback-only and the password is per-run, but it is briefly visible the same way.
3. **Config password in the child environment.** On Linux, a process's environment is
   readable by the same user (`/proc/<pid>/environ`); on Windows it is not readable by
   other non-elevated users.
4. **Windows-specific paths are unverified.** DPAPI behaviour, Credential Manager storage,
   WinFsp detection, and the drive-letter mount path have not been executed on a Windows
   host. They are covered by unit tests with injected fakes only.
5. **No code signing yet.** Builds are unsigned; SmartScreen will warn until a release is
   signed.

## Reporting a vulnerability

Please open a GitHub issue without including tokens, account names, or file contents. If
the issue involves a credential leak, rotate the affected cloud authorization first
(revoke CloudSSD in your Google/Microsoft account settings), then report.
