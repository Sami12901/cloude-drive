import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDefaultSettings, mergeSettings, SETTINGS_SCHEMA_VERSION } from '../../shared/defaults.js';
import { parseSafe, remoteConfigSchema, settingsSchema, uuidSchema } from '../../shared/validation.js';
import type { AppSettings, OfflineEntry, RemoteConfig, TransferJob } from '../../shared/types.js';
import { writeSecureFile } from './logging.js';
import type { Logger } from './logging.js';
import type { AppPaths } from './context.js';

/**
 * Owns every non-secret, persistent piece of application state:
 *
 *   dataDir/settings.json      user preferences + remote metadata (no secrets)
 *   dataDir/offline-index.json Mode C pinned copies
 *   dataDir/transfers.json     completed/failed job history
 *
 * Files are written atomically (temp + rename) with user-only permissions, and
 * every read is validated with zod. A corrupted file is preserved next to a
 * fresh default instead of being silently discarded.
 */
export class ConfigService {
  private settings: AppSettings;
  private offline = new Map<string, OfflineEntry>();
  private transferHistory: TransferJob[] = [];
  private readonly maxHistory = 200;

  constructor(
    private readonly paths: AppPaths,
    private readonly logger: Logger,
  ) {
    mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
    this.settings = this.loadSettings();
    this.loadOffline();
    this.loadTransfers();
  }

  /* ---------------------------------------------------------------- settings */

  get(): AppSettings {
    return this.settings;
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const merged = mergeSettings(this.settings, patch);
    const parsed = parseSafe(settingsSchema, merged);
    if (!parsed.ok) {
      throw new Error(`Rejected invalid settings update: ${parsed.message}`);
    }
    this.settings = parsed.value;
    this.persistSettings();
    return this.settings;
  }

  reset(): AppSettings {
    this.settings = createDefaultSettings({
      dataDir: this.paths.dataDir,
      cacheDir: this.paths.cacheDir,
      homeDir: this.paths.homeDir,
      platform: process.platform,
    });
    this.persistSettings();
    return this.settings;
  }

  /* ----------------------------------------------------------------- remotes */

  listRemotes(): RemoteConfig[] {
    return this.settings.remotes;
  }

  getRemote(id: string): RemoteConfig | null {
    return this.settings.remotes.find((remote) => remote.id === id) ?? null;
  }

  getActiveRemote(): RemoteConfig | null {
    return this.settings.activeRemoteId ? this.getRemote(this.settings.activeRemoteId) : null;
  }

  addRemote(remote: RemoteConfig): RemoteConfig {
    const parsed = parseSafe(remoteConfigSchema, remote);
    if (!parsed.ok) throw new Error(`Rejected invalid remote: ${parsed.message}`);
    if (this.settings.remotes.some((entry) => entry.remoteName === parsed.value.remoteName)) {
      throw new Error(`A remote named "${parsed.value.remoteName}" already exists.`);
    }
    if (parsed.value.driveLetter) {
      const clash = this.settings.remotes.find(
        (entry) => entry.driveLetter?.toUpperCase() === parsed.value.driveLetter?.toUpperCase(),
      );
      if (clash) throw new Error(`Drive letter ${parsed.value.driveLetter} is already used by "${clash.displayName}".`);
    }
    this.settings = {
      ...this.settings,
      remotes: [...this.settings.remotes, parsed.value],
      activeRemoteId: this.settings.activeRemoteId ?? parsed.value.id,
    };
    this.persistSettings();
    return parsed.value;
  }

  updateRemote(id: string, patch: Partial<RemoteConfig>): RemoteConfig {
    const parsedId = parseSafe(uuidSchema, id);
    if (!parsedId.ok) throw new Error('Invalid remote id.');
    const existing = this.getRemote(id);
    if (!existing) throw new Error('Remote not found.');
    if (patch.driveLetter) {
      const clash = this.settings.remotes.find(
        (entry) => entry.id !== id && entry.driveLetter?.toUpperCase() === patch.driveLetter?.toUpperCase(),
      );
      if (clash) throw new Error(`Drive letter ${patch.driveLetter} is already used by "${clash.displayName}".`);
    }
    const updated: RemoteConfig = { ...existing, ...patch, id: existing.id, updatedAt: new Date().toISOString() };
    const parsed = parseSafe(remoteConfigSchema, updated);
    if (!parsed.ok) throw new Error(`Rejected invalid remote update: ${parsed.message}`);
    this.settings = {
      ...this.settings,
      remotes: this.settings.remotes.map((entry) => (entry.id === id ? parsed.value : entry)),
    };
    this.persistSettings();
    return parsed.value;
  }

  removeRemote(id: string): void {
    const existing = this.getRemote(id);
    if (!existing) throw new Error('Remote not found.');
    this.settings = {
      ...this.settings,
      remotes: this.settings.remotes.filter((entry) => entry.id !== id),
      activeRemoteId: this.settings.activeRemoteId === id ? null : this.settings.activeRemoteId,
    };
    // Local offline copies of this remote are removed too — the cloud account is
    // never touched by this operation.
    for (const [entryId, entry] of this.offline) {
      if (entry.remoteId === id) this.offline.delete(entryId);
    }
    this.persistSettings();
    this.persistOffline();
  }

  setActiveRemote(id: string | null): void {
    if (id !== null && !this.getRemote(id)) throw new Error('Remote not found.');
    this.settings = { ...this.settings, activeRemoteId: id };
    this.persistSettings();
  }

  createId(): string {
    return randomUUID();
  }

  /* ----------------------------------------------------------------- offline */

  listOffline(): OfflineEntry[] {
    return [...this.offline.values()];
  }

  getOffline(id: string): OfflineEntry | null {
    return this.offline.get(id) ?? null;
  }

  upsertOffline(entry: OfflineEntry): OfflineEntry {
    this.offline.set(entry.id, entry);
    this.persistOffline();
    return entry;
  }

  removeOffline(id: string): void {
    this.offline.delete(id);
    this.persistOffline();
  }

  /* --------------------------------------------------------------- transfers */

  history(): TransferJob[] {
    return this.transferHistory;
  }

  appendHistory(job: TransferJob): void {
    this.transferHistory = [job, ...this.transferHistory].slice(0, this.maxHistory);
    this.persistTransfers();
  }

  clearHistory(): number {
    const count = this.transferHistory.length;
    this.transferHistory = [];
    this.persistTransfers();
    return count;
  }

  /* ------------------------------------------------------------ persistence */

  private get settingsFile(): string {
    return join(this.paths.dataDir, 'settings.json');
  }
  private get offlineFile(): string {
    return join(this.paths.dataDir, 'offline-index.json');
  }
  private get transfersFile(): string {
    return join(this.paths.dataDir, 'transfers.json');
  }

  private persistSettings(): void {
    writeSecureFile(this.settingsFile, `${JSON.stringify(this.settings, null, 2)}\n`, 0o600);
  }

  private persistOffline(): void {
    writeSecureFile(this.offlineFile, `${JSON.stringify([...this.offline.values()], null, 2)}\n`, 0o600);
  }

  private persistTransfers(): void {
    writeSecureFile(this.transfersFile, `${JSON.stringify(this.transferHistory, null, 2)}\n`, 0o600);
  }

  private loadSettings(): AppSettings {
    const fallback = () =>
      createDefaultSettings({
        dataDir: this.paths.dataDir,
        cacheDir: this.paths.cacheDir,
        homeDir: this.paths.homeDir,
        platform: process.platform,
      });
    if (!existsSync(this.settingsFile)) {
      const defaults = fallback();
      this.settings = defaults;
      this.persistSettings();
      return defaults;
    }
    try {
      const raw = readFileSync(this.settingsFile, 'utf8');
      const parsed = parseSafe(settingsSchema, JSON.parse(raw));
      if (!parsed.ok) throw new Error(parsed.message);
      if (parsed.value.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
        this.logger.warn('Settings schema version mismatch; starting from defaults.', {
          found: parsed.value.schemaVersion,
          expected: SETTINGS_SCHEMA_VERSION,
        });
        return fallback();
      }
      return parsed.value;
    } catch (error) {
      const backup = `${this.settingsFile}.corrupt-${Date.now()}`;
      renameSync(this.settingsFile, backup);
      this.logger.error('Settings file was unreadable; kept a copy and reset to defaults.', {
        backup,
        error: (error as Error).message,
      });
      const defaults = fallback();
      this.settings = defaults;
      this.persistSettings();
      return defaults;
    }
  }

  private loadOffline(): void {
    if (!existsSync(this.offlineFile)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.offlineFile, 'utf8')) as OfflineEntry[];
      for (const entry of parsed ?? []) {
        if (entry && typeof entry.id === 'string') this.offline.set(entry.id, entry);
      }
    } catch (error) {
      this.logger.error('Offline index unreadable; starting with an empty index.', {
        error: (error as Error).message,
      });
    }
  }

  private loadTransfers(): void {
    if (!existsSync(this.transfersFile)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.transfersFile, 'utf8')) as TransferJob[];
      this.transferHistory = (parsed ?? []).slice(0, this.maxHistory);
    } catch {
      this.transferHistory = [];
    }
  }

  /** Delete every local CloudSSD file (used by uninstall / full reset). */
  purgeLocalState(): void {
    this.offline.clear();
    this.transferHistory = [];
    for (const file of [this.settingsFile, this.offlineFile, this.transfersFile]) {
      if (existsSync(file)) rmSync(file, { force: true });
    }
  }

  fileSizes(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, file] of Object.entries({
      settings: this.settingsFile,
      offline: this.offlineFile,
      transfers: this.transfersFile,
    })) {
      out[name] = existsSync(file) ? statSync(file).size : 0;
    }
    return out;
  }
}
