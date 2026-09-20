import { parseEnv } from 'node:util';
/** dotenv quoting differs from JSON. Check the exact round-trip before writing credentials. */
export function serializeEnv(env: Record<string, string | undefined>) {
  return (
    Object.entries(env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes('\0'))
          throw new Error('ENV_VALUE_UNSUPPORTED');
        for (const quote of ["'", '"']) {
          if (value.includes(quote)) continue;
          const line = `${key}=${quote}${value}${quote}`;
          if (parseEnv(line)[key] === value) return line;
        }
        throw new Error('ENV_VALUE_UNSUPPORTED');
      })
      .join('\n') + '\n'
  );
}
