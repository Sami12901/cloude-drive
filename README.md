# CloudSSD

**Mount your existing cloud storage as a real drive letter (`Z:\`) on Windows.**

CloudSSD is an Electron + React + TypeScript desktop app that turns a Google Drive or
Microsoft OneDrive account into a real, mountable filesystem using the official
[rclone](https://rclone.org/) engine and [WinFsp](https://winfsp.dev/). No paid backend,
no sync-folder workaround, no simulated state — files you drop in `Z:\` really go to the
cloud, and files you read are fetched on demand.

> **Status:** core engine + UI + 120 automated tests are complete and passing.
> Windows drive-letter mounting, WinFsp, DPAPI/Credential Manager, and the installer are
> **code-verified only** — they have never been executed on a Windows host. See
> [Verification status](#verification-status).

---

## Table of contents

- [How it works](#how-it-works)
- [Features](#features)
- [Requirements](#requirements)
- [Quick start (Windows)](#quick-start-windows)
- [Quick start (Linux / macOS, development)](#quick-start-linux--macos-development)
- [Running the app](#running-the-app)
- [Getting rclone](#getting-rclone)
- [Tests](#tests)
- [Project structure](#project-structure)
- [Configuration and environment variables](#configuration-and-environment-variables)
- [Security and privacy](#security-and-privacy)
- [Provider support](#provider-support)
- [Verification status](#verification-status)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

---

## How it works

```
┌───────────────┐   typed IPC    ┌──────────────────┐   argv array   ┌────────────┐
│ React renderer│ ◄────────────► │ Electron main    │ ─────────────► │ rclone     │
│ (UI, no node) │   (validated)  │ (AppController)  │                └─────┬──────┘
└───────────────┘                └────────┬─────────┘                      │
                                          │ rc API (loopback, per-run pw)  │
                                          └───────────────────────────────►│
                                                                    ┌──────▼───────┐
                                                                    │ WinFsp / FUSE│
                                                                    │  → Z:\ drive │
                                                                    └──────────────┘
```

- **Main process** owns everything privileged: the rclone process, the encrypted config,
  the credential vault, mounted drive lifecycle, cache accounting, transfer jobs.
- **Renderer** is sandboxed (`contextIsolation: true`, `nodeIntegration: false`, CSP) and
  can only talk to a schema-validated IPC channel allow-list through a typed preload.
- **Remote control** traffic stays on `127.0.0.1` behind a password generated per run.

## Features

- **Real drive mounting** — `Z:\` in File Explorer, not a sync folder.
- **Three cache modes**
  - *Cloud streaming* — read on demand, minimal local disk use.
  - *Balanced cache* — bounded local working set with a configurable limit.
  - *Selected offline files* — real local copies of chosen files/folders, verified on disk.
- **8-step connection wizard** with the official OAuth consent flow (browser), permissions
  disclosed before you start.
- **Connection health state machine** — connecting / connected / degraded / reconnecting /
  auth-expired / offline / mount-failed, with bounded automatic reconnection.
- **Diagnostics screen** — dependency status, engine version, checks, and a redacted export.
- **Honest storage reporting** — cloud quota, local cache, and physical disk are three
  separate numbers. Unknown values show **Not available**, never `0`.
- **No telemetry** — nothing is uploaded. Startup entries and tray behaviour are off unless
  you switch them on.

## Requirements

| What | Version | Notes |
| --- | --- | --- |
| Node.js | **>= 20.19.0** | declared in `package.json` `engines` |
| npm | 10+ | ships with Node |
| rclone | **>= 1.62.0** (validated on 1.75.2) | [download](https://rclone.org/downloads/) — see [Getting rclone](#getting-rclone) |
| WinFsp | 2.x | **Windows only**, required for drive-letter mounting — [winfsp.dev/rel](https://winfsp.dev/rel/) |
| Windows | 10/11 x64 | target platform |
| Linux/macOS | any recent | development and tests only (mounts to a directory via FUSE) |

## Quick start (Windows)

```powershell
git clone https://github.com/Sami12901/cloude-drive.git
cd cloude-drive
npm install
npm run dev
```

Then, in the app:

1. **Connect account** → pick *Google Drive* or *Microsoft OneDrive* → sign in in your browser.
2. Choose the **remote folder** that becomes the drive root and a **drive letter** (e.g. `Z`).
3. Pick a **cache mode** and limit.
4. **Validate** (checks authorization *and* that CloudSSD can read the remote) → **Mount**.

If Windows asks about WinFsp, install it first — CloudSSD cannot create `Z:\` without it
and will tell you so instead of failing silently.

## Quick start (Linux / macOS, development)

There is no WinFsp on POSIX, but all shared logic (rclone argument construction, process
supervision, readiness detection, reconnection, cache accounting, IPC, UI) is exercised
against a FUSE mount point:

```bash
git clone https://github.com/Sami12901/cloude-drive.git
cd cloude-drive
npm install

# One terminal: the real main-process services over HTTP + SSE
npm run dev:host

# Another terminal: the real renderer talking to that host
npm run dev:renderer      # then open the printed URL
```

On POSIX hosts the "drive letter" maps to a directory (`$CLOUDSSD_MOUNT_ROOT/<letter>`).
The wizard also offers a **Local folder (engine test target)** provider so you can mount a
plain directory and exercise the whole engine without a cloud account.

## Running the app

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite renderer + Electron against the compiled main process |
| `npm run dev:host` | Dev host: real main-process services on port 8787 (no Electron needed) |
| `npm run dev:renderer` | Vite dev server (point it at the dev host with `VITE_DEV_HOST=1`) |
| `npm run dev:full` | Dev host + renderer together |
| `npm run typecheck` | `tsc --noEmit` for main/shared and renderer/web |
| `npm run build` | Compile renderer + main + preload into `dist/` |
| `npm start` | Run Electron against the existing `dist/` build |

Package scripts also declare `deps:check`, `deps:fetch-rclone`, `icons:generate`,
`dist`, and `verify:release`. **These are not implemented yet** — the scripts under
`scripts/` and the `electron-builder.yml` config are still pending, so there is no
installer to build today. (Contributions welcome; see [Contributing](#contributing).)

## Getting rclone

CloudSSD never bundles a binary in git. Pick one:

1. **Official download** (recommended): <https://rclone.org/downloads/> and put
   `rclone.exe` in `tools/`, **or**
2. **Any location**, and point CloudSSD at it:

   ```powershell
   $env:CLOUDSSD_RCLONE_PATH = "C:\tools\rclone\rclone.exe"
   npm run dev
   ```

   ```bash
   export CLOUDSSD_RCLONE_PATH="$HOME/bin/rclone"
   npm run dev:host
   ```

3. **PATH** — if `rclone --version` works in your terminal, CloudSSD finds it.

Lookup order is: `CLOUDSSD_RCLONE_PATH` → packaged `resources/rclone` → repo `tools/` →
`PATH`. A candidate is only accepted after `rclone version` runs successfully and reports a
supported version, so a stale binary on `PATH` is never picked up silently.

## Tests

```bash
npm test                 # all six projects (needs rclone; ~4 min, mount tests are real)
npm run test:unit        # validation, redaction, settings, mount args, queue, eviction
npm run test:security    # IPC validation, credential vault, secret hygiene
npm run test:provider    # real rclone: encrypted config, remote CRUD, obscure/reveal
npm run test:mount       # real FUSE mount lifecycle, crash + reconnect, cache stats
npm run test:integration # offline copies, transfer jobs, snapshot truthfulness
npm run test:ui          # React states in jsdom
```

| Project | Tests | Needs |
| --- | --- | --- |
| `unit` | 50 | nothing |
| `security` | 16 | nothing |
| `provider` | 7 | rclone binary |
| `mount` | 10 | rclone + FUSE (skips automatically without them) |
| `integration` | 19 | rclone (offline copy + transfer tests skip without it) |
| `ui` | 18 | nothing |

Without rclone or FUSE, the engine-level projects **skip and say so** rather than passing
on mocks — run `npm test` and read the console for the skip notice.

## Project structure

```
src/
  main/            Electron main process
    services/      app-controller, mount-manager, cache-manager, transfer-manager,
                   offline-manager, diagnostics, config, credential-vault, security
    rclone/        cli, binary locator, remote-control (rc), engine, config store, auth
    providers/     provider registry (capabilities + release status)
    platform/      win32.ts and posix.ts behind one PlatformAdapter
    ipc/           validated handler table
  preload/         typed bridge (CommonJS, contextIsolation)
  renderer/        React app (pages, components, zustand store, bridge)
  shared/          types, zod validation schemas, defaults, redaction, format
dev-host/          HTTP + SSE host that runs the real services without Electron
tests/             unit, security, provider, mount, integration, ui + helpers
tools/             local rclone binary (downloaded, git-ignored)
```

## Configuration and environment variables

Settings live in `%LOCALAPPDATA%\CloudSSD\` on Windows (`$CLOUDSSD_DATA_DIR` in the dev
host) and are never committed. Secrets never appear in `settings.json` — only a
`secretRef` such as `rclone:gdrive` that points into the encrypted rclone config.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLOUDSSD_RCLONE_PATH` | — | Explicit rclone binary |
| `CLOUDSSD_DATA_DIR` | `.cloudssd-dev` | Dev-host data directory |
| `CLOUDSSD_MOUNT_ROOT` | `/tmp/cloudssd-mounts` | Dev-host mount root (POSIX) |
| `CLOUDSSD_DEV_HOST_PORT` | `8787` | Dev-host port |
| `CLOUDSSD_LOG_LEVEL` | `info` | `error` \| `info` \| `debug` |
| `VITE_DEV_HOST` | `0` | `1` makes the renderer talk to the dev host |

## Security and privacy

See [docs/security.md](docs/security.md) for the full model. In short:

- Credentials are stored in the OS credential store (DPAPI / Windows Credential Manager)
  and in the password-encrypted rclone config. If no secure backend is available, CloudSSD
  says so in Diagnostics rather than silently falling back to plaintext.
- No credential ever reaches React state, `localStorage`, or a log file. Every log line and
  diagnostic export passes through redaction, and logged rclone argument arrays go through
  `redactArgs()` (rclone takes provider tokens as argv — the residual exposure during a
  command is documented in `docs/security.md`).
- Subprocesses are spawned with argument arrays only — never a shell string.
- IPC payloads are validated with zod per channel; unknown channels are rejected.
- No telemetry, no analytics, no crash uploaders.
- Removing an account deletes local configuration and cache references only. Files in the
  cloud account are never deleted.
- **Known residual risk:** while `rclone config create` runs, an OAuth token is briefly
  present in the process argument list, which other processes of the same user can read.

## Provider support

| Provider | Status | Notes |
| --- | --- | --- |
| Google Drive | **Supported** | official OAuth, `drive` scope |
| Microsoft OneDrive | **Supported** | official OAuth |
| Dropbox | beta | wired through rclone; **not covered by acceptance tests** |
| WebDAV | beta | same |
| S3-compatible | beta | same |
| Local folder | testing-only | engine test target, not a cloud provider |

Anything that is not `supported` is badged in the UI and, when selected, blocks the wizard
behind an explicit "I understand this provider is not covered by the tested scenarios"
checkbox.

## Verification status

| Scenario | State |
| --- | --- |
| Engine: config encryption, remote CRUD, mount, read/write/rename/delete, Unicode paths | **Verified** (Linux, rclone 1.75.2 + FUSE) |
| Automatic reconnection after the engine is killed | **Verified** (Linux) |
| Offline pinning = real local copy; unpin leaves the cloud untouched | **Verified** |
| Transfer jobs: progress, cancel, retry, failure classification | **Verified** |
| Snapshot honesty (no invented quota, quota/cache/disk separated) | **Verified** |
| IPC validation, credential vault, redaction | **Verified** |
| React state rendering (empty/connected/failed/dependency-missing) | **Verified** (jsdom) |
| Drive-letter mounting on Windows (`Z:\`) | **Unverified** — no Windows host available |
| WinFsp detection + guided install | **Unverified** |
| DPAPI / Windows Credential Manager storage | **Unverified** |
| OAuth against real Google Drive and OneDrive accounts | **Unverified** — requires the user's own account and network consent |
| Installer (electron-builder + WinFsp prerequisite check) | **Not implemented yet** |
| Startup/login item and tray behaviour | **Unverified** on Windows |

If you run the app on Windows, please open an issue with what worked and what didn't —
especially for the unverified rows.

## Troubleshooting

**"The rclone engine is not available"** — install rclone (see [Getting rclone](#getting-rclone))
and restart. Settings → Diagnostics shows the resolved path and version.

**"The mount target is already in use"** — another program (or another CloudSSD instance)
owns the letter. Pick a different letter, or unmount it first. CloudSSD will not unmount a
healthy mount that belongs to someone else.

**Drive mounts but files are missing** — the remote root may be wrong (Settings → Drive), or
the provider's directory cache is stale; use Diagnostics → refresh the directory cache.

**Cache shows 0 B right after copying** — rclone refreshes its own accounting every
`--vfs-cache-poll-interval` (30–60 s). CloudSSD measures the cache directory in the meantime
and labels where the number came from.

**Mount point hangs on Linux after a crash** — kill any leftover `rclone mount` process and
`fusermount3 -u -z <mountpoint>`; the test harness does this automatically.

## Contributing

1. Fork and branch from `main`.
2. `npm install`, add rclone, then `npm test`.
3. Keep the honesty rules: no simulated state, no invented numbers, no untested provider
   presented as working, no secrets in logs.
4. Add a test with your change — new engine behaviour needs a test that runs the real
   binary, not a mock.
5. `npm run typecheck` must be clean before you open a PR.

High-value gaps right now: `scripts/fetch-rclone.ts`, `scripts/check-dependencies.ts`,
`scripts/generate-icons.mjs`, `electron-builder.yml` + app icons, and the `docs/` set
(setup, security, provider limitations, testing, release verification).

## License

MIT — see [`LICENSE`](LICENSE). WinFsp is separately licensed (GPLv3 with the WinFsp
runtime exception); rclone is MIT. Neither is bundled in this repository.
