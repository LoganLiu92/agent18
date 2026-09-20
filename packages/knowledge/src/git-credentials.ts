import { KnowledgeError, type SourceConfig } from './config.js';
/** Bind each secret reference to one exact HTTPS repository; credentials never enter argv or Git config files. */
export function gitCredentialEnvironment(
  source: SourceConfig,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!source.credentialEnv) return {};
  let bindings: Record<string, unknown>;
  try {
    bindings = JSON.parse(environment.AGENT18_GIT_CREDENTIAL_BINDINGS ?? '{}');
  } catch {
    throw new KnowledgeError('GIT_CREDENTIAL_BINDING_INVALID');
  }
  const url = new URL(source.location);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    bindings[source.credentialEnv] !== source.location
  )
    throw new KnowledgeError('GIT_CREDENTIAL_BINDING_DENIED');
  const secret = environment[source.credentialEnv];
  if (
    !secret ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(secret) ||
    Buffer.from(secret, 'base64').toString('base64') !== secret
  )
    throw new KnowledgeError('GIT_CREDENTIAL_MISSING');
  const value = Buffer.from(secret, 'base64').toString('utf8');
  if (!/^[^:\r\n]+:[^\r\n]{16,}$/.test(value)) throw new KnowledgeError('GIT_CREDENTIAL_MISSING');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${source.location}.extraHeader`,
    GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + secret,
  };
}
