import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { openApi, publicApiDefinitions } from '../apps/server/src/openapi.js';
import { documents } from '../apps/server/src/docs.js';
const output = resolve('.local/release');
await mkdir(output, { recursive: true, mode: 0o700 });
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
if (version !== openApi.info.version) throw new Error('API_VERSION_DRIFT');
for (const [, , file] of documents) {
  if (!(await stat(file)).isFile()) throw new Error('DOC_MISSING');
}
const sdk = await readFile('packages/web-sdk/dist/agent18.js');
if (gzipSync(sdk).length > 15 * 1024) throw new Error('SDK_BUDGET_EXCEEDED');
await writeFile(resolve(output, 'openapi.json'), JSON.stringify(openApi, null, 2) + '\n');
await writeFile(resolve(output, 'agent18.js'), sdk);
await writeFile(resolve(output, 'LICENSE-SDK'), await readFile('packages/web-sdk/LICENSE'));
const files = [];
for (const name of ['agent18.js', 'openapi.json', 'LICENSE-SDK']) {
  const data = await readFile(resolve(output, name));
  files.push({ name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
}
const manifest = {
  version,
  apiOperations: publicApiDefinitions.length,
  sdkGzipBytes: gzipSync(sdk).length,
  files,
};
await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ ...manifest, directory: output }, null, 2));
