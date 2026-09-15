const endpoints = ['http://127.0.0.1:4318/health/ready', 'http://127.0.0.1:4319/health'];
try {
  for (const url of endpoints) {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error('unready');
  }
} catch {
  console.error('Local demo is not ready. Run pnpm run setup && pnpm demo:start before integration tests.');
  process.exit(1);
}
