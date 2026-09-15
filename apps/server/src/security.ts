import type { Config } from '../../../scripts/config.js';

export function contentSecurityPolicy(config: Config, requestUrl: string) {
  const origin = new URL(config.consoleOrigin);
  // Only the local synthetic console fetches credentials from the demo issuer.
  const demoConsole =
    requestUrl.split('?')[0] === '/console' &&
    origin.protocol === 'http:' &&
    ['localhost', '127.0.0.1'].includes(origin.hostname) &&
    config.projects.some((project) => project.issuer === 'urn:agent18:demo-saas');
  const connections = demoConsole ? ' http://localhost:4319 http://127.0.0.1:4319' : '';
  return `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'${connections}; frame-ancestors 'none'; base-uri 'none'`;
}
