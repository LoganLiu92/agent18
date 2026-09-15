import { readConfig } from '../../../scripts/config.js';
import { buildApp } from './app.js';
const { app } = await buildApp(readConfig());
await app.listen({ host: process.env.AGENT18_HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 4318) });
console.log('agent18 server listening on port 4318');
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
