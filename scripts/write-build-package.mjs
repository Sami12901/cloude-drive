// Emits a `package.json` with `"type": "commonjs"` next to the compiled main and
// preload bundles. The repository itself is ESM (`"type": "module"`), while
// Electron loads the main process and (sandboxed) preload scripts as CommonJS,
// so each output directory needs its own module-type marker.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const dir of ['dist/main', 'dist/preload']) {
  const target = join(root, dir);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);
  console.log(`wrote ${dir}/package.json (type: commonjs)`);
}
