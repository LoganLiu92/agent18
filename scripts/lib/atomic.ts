import { writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
/** Same-directory rename prevents readers observing a half-written configuration. */
export async function atomicJson(path: string, value: unknown) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
