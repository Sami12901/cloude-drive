import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Test projects.
 *
 *  unit          — pure logic (validation, formatting, redaction, queue logic)
 *  security      — IPC input validation and credential boundaries
 *  provider      — real rclone configuration handling (encryption, remotes)
 *  mount         — real mount lifecycle against FUSE (rclone + a local remote)
 *  integration   — offline copies, transfer jobs, snapshot correctness
 *  ui            — React error/empty/connected state rendering (jsdom)
 */
// Source files are written as ESM with `.js` specifiers (the compiled output),
// so the aliases below map `@shared/x.js` back to `src/shared/x.ts`.
const aliases = [
  { find: /^@shared\/(.*)\.js$/, replacement: `${fileURLToPath(new URL('./src/shared', import.meta.url))}/$1` },
  { find: /^@shared$/, replacement: fileURLToPath(new URL('./src/shared', import.meta.url)) },
  { find: /^@renderer\/(.*)\.js$/, replacement: `${fileURLToPath(new URL('./src/renderer/src', import.meta.url))}/$1` },
  { find: /^@renderer$/, replacement: fileURLToPath(new URL('./src/renderer/src', import.meta.url)) },
];

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    projects: [
      {
        resolve: { alias: aliases },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        resolve: { alias: aliases },
        test: {
          name: 'security',
          environment: 'node',
          include: ['tests/security/**/*.test.ts'],
        },
      },
      {
        resolve: { alias: aliases },
        test: {
          name: 'provider',
          environment: 'node',
          include: ['tests/provider/**/*.test.ts'],
          testTimeout: 90_000,
          hookTimeout: 90_000,
          fileParallelism: false,
        },
      },
      {
        resolve: { alias: aliases },
        test: {
          name: 'mount',
          environment: 'node',
          include: ['tests/mount/**/*.test.ts'],
          testTimeout: 180_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        resolve: { alias: aliases },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 180_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        resolve: { alias: aliases },
        test: {
          name: 'ui',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['tests/ui/setup.ts'],
          include: ['tests/ui/**/*.test.tsx'],
        },
      },
    ],
  },
});
