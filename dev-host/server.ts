/**
 * Development host.
 *
 * Runs the *real* main-process services (AppController, mount manager, rclone
 * engine, cache manager, transfer queue) outside Electron, and exposes exactly
 * the same IPC handlers over HTTP + SSE. The renderer in the browser preview
 * therefore drives genuine application logic against the real rclone engine,
 * instead of mock data.
 *
 * This is a development and test tool. It is never shipped in the installer.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { BridgeEvent, BridgeResult } from '../src/shared/ipc.js';
import { createHandlers, invokeHandler, type HandlerRegistry } from '../src/main/ipc/handlers.js';
import { AppController } from '../src/main/services/app-controller.js';
import { FileLogger } from '../src/main/services/logging.js';
import { FilePermissionOnlyProtection } from '../src/main/services/credential-vault.js';
import { PosixPlatform } from '../src/main/platform/posix.js';
import { resolvePaths } from '../src/main/services/context.js';
import type { PlatformAdapter } from '../src/main/platform/types.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(here, '..');
const PORT = Number(process.env.CLOUDSSD_DEV_HOST_PORT ?? 8787);
const DATA_DIR = process.env.CLOUDSSD_DATA_DIR ?? join(repoRoot, '.cloudssd-dev');
const RCLONE_PATH = process.env.CLOUDSSD_RCLONE_PATH ?? join(repoRoot, 'tools', 'rclone');
const APP_VERSION = '1.0.0-dev';

const paths = resolvePaths({ dataDir: DATA_DIR, platform: process.platform });
const logger = new FileLogger({
  dir: paths.logDir,
  level: (process.env.CLOUDSSD_LOG_LEVEL as 'debug' | 'info' | 'error') ?? 'info',
  maxBytes: 8 * 1024 * 1024,
  retentionDays: 3,
  homeDir: paths.homeDir,
});

const clients = new Set<{ id: number; write: (chunk: string) => void }>();

const platform: PlatformAdapter = new PosixPlatform({
  mountRoot: process.env.CLOUDSSD_MOUNT_ROOT ?? '/tmp/cloudssd-mounts',
  openPath: async () => false,
});

const controller = new AppController({
  paths,
  platform,
  logger,
  // No OS keyring in a plain Node process: the dev host reports the store as
  // insecure on purpose instead of pretending secrets are protected.
  secrets: new FilePermissionOnlyProtection(),
  emit: (event: BridgeEvent) => broadcast(event),
  appVersion: APP_VERSION,
  isPackaged: false,
  openExternal: async () => false,
  resourcesDir: null,
});

const handlers: HandlerRegistry = createHandlers({
  controller,
  platform,
  logger: logger.child('ipc'),
  openExternal: async () => false,
  openPath: async () => false,
  allowTestProvider: true,
  includeExperimentalProviders: () => true,
});

function broadcast(event: BridgeEvent): void {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    try {
      client.write(frame);
    } catch {
      clients.delete(client);
    }
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  // CORS + no-store: this is a local development endpoint.
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.setHeader('Cache-Control', 'no-store');

  if (request.method === 'OPTIONS') {
    response.writeHead(204).end();
    return;
  }

  if (pathname === '/events') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      Connection: 'keep-alive',
    });
    const id = Date.now();
    const client = { id, write: (chunk: string) => response.write(chunk) };
    clients.add(client);
    response.write(`data: ${JSON.stringify({ type: 'notification', level: 'info', title: 'Connected to the CloudSSD dev host' })}\n\n`);
    void controller.publish();
    request.on('close', () => clients.delete(client));
    return;
  }

  if (pathname === '/health') {
    respondJson(response, 200, { ok: true, rclone: controller.engine.info.version, dataDir: paths.dataDir });
    return;
  }

  if (pathname.startsWith('/api/')) {
    const channel = decodeURIComponent(pathname.slice('/api/'.length));
    const payload = await readBody(request);
    const sender = { id: 0, url: `http://localhost:${PORT}` };
    const result: BridgeResult<unknown> = await invokeHandler(handlers, channel, payload, sender, logger.child('invoke'));
    respondJson(response, 200, result);
    return;
  }

  // Serve a previously built renderer (optional; the Vite dev server is the
  // normal way to view the UI).
  const distDir = join(repoRoot, 'dist', 'renderer');
  if (existsSync(distDir)) {
    const candidate = join(distDir, pathname === '/' ? 'index.html' : pathname);
    if (candidate.startsWith(distDir) && existsSync(candidate) && (await stat(candidate)).isFile()) {
      const body = await readFile(candidate);
      response.writeHead(200, { 'Content-Type': MIME[extname(candidate)] ?? 'application/octet-stream' });
      response.end(body);
      return;
    }
  }

  respondJson(response, 404, { error: 'Not found. Use the Vite dev server (npm run dev:renderer) for the UI.' });
});

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function main(): Promise<void> {
  if (existsSync(RCLONE_PATH) ) {
    logger.info('Using rclone from the tools directory.', { path: RCLONE_PATH });
  }
  await controller.initialize();
  server.listen(PORT, '0.0.0.0', () => {
    logger.info('CloudSSD dev host listening.', { port: PORT, dataDir: DATA_DIR });
    // eslint-disable-next-line no-console
    console.log(`CloudSSD dev host on http://0.0.0.0:${PORT} (data: ${DATA_DIR})`);
  });

  // Publish a snapshot every few seconds so the UI stays current even if a
  // push event is missed.
  setInterval(() => void controller.publish(), 5000).unref?.();

  const shutdown = async () => {
    logger.info('Dev host shutting down.');
    for (const client of clients) clients.delete(client);
    await controller.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref?.();
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main();

export { controller, handlers, randomUUID };
