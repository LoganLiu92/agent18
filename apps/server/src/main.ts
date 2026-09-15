import { readConfig } from '../../../scripts/config.js';
import { buildApp } from './app.js';
const { app } = await buildApp(readConfig());
const address = await app.listen({
  host: process.env.AGENT18_HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 4318),
});
console.log(`agent18 server listening at ${address}`);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
