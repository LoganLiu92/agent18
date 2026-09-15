import { build } from 'vite';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
await build({
  configFile: false,
  build: {
    outDir: 'packages/web-sdk/dist',
    lib: { entry: 'packages/web-sdk/src/index.ts', formats: ['es'], fileName: 'agent18' },
    minify: true,
    emptyOutDir: true,
  },
});
const bytes = await readFile('packages/web-sdk/dist/agent18.js');
const compressed = gzipSync(bytes).length;
console.log(`agent18 SDK + optional widget: ${bytes.length} bytes; gzip ${compressed} bytes`);
if (compressed > 15 * 1024) throw new Error('SDK exceeded 15 KiB gzip budget');
