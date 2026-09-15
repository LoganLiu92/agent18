import { spawn } from 'node:child_process';

/** Recreate file-mounted consumers even when only an atomic config replacement changed. */
export async function startStack(
  compose: string[],
  { build = true, demo = false }: { build?: boolean; demo?: boolean } = {},
) {
  const run = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn('docker', [...compose, ...args], {
        stdio: 'inherit',
        timeout: 600000,
      });
      child.once('error', reject);
      child.once('exit', (code, signal) =>
        code === 0 ? resolve() : reject(new Error(`Compose ${args[0]} failed (${code ?? signal})`)),
      );
    });

  // Build before disrupting running consumers. PostgreSQL keeps its container and volume.
  if (build) await run(['build', 'server']);
  await run(['up', '-d', '--wait', 'postgres']);
  await run(['up', '-d', '--no-deps', '--force-recreate', 'opa']);
  // A fresh one-off container reads the current migration config, including restored DB targets.
  await run(['run', '--rm', '--no-deps', 'migrate']);
  await run(['up', '-d', '--no-deps', '--force-recreate', '--wait', 'server']);
  await run(['up', '-d', '--no-deps', '--force-recreate', '--wait', 'worker']);
  if (demo) await run(['up', '-d', '--no-deps', '--force-recreate', '--wait', 'identity-demo']);
}
