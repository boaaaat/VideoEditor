import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const output = new URL('../../../apps/desktop/src-tauri/resources/mcp/', import.meta.url);
await mkdir(output, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL('../src/index.mjs', import.meta.url))],
  outfile: fileURLToPath(new URL('server.mjs', output)),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  legalComments: 'eof',
});
await copyFile(process.execPath, new URL(process.platform === 'win32' ? 'node.exe' : 'node', output));
