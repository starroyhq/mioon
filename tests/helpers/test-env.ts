import {providerEnvironmentKeys} from '../../packages/business/src/providers/environment.ts';

const providerKeys = new Set(providerEnvironmentKeys.map(key => key.toUpperCase()));

export function testEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(source).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !providerKeys.has(entry[0].toUpperCase()),
  ));
}

/** For fixture entry points that boot application code in this process. */
export function isolateTestProviderEnvironment(): void {
  for (const key of Object.keys(process.env)) {
    if (providerKeys.has(key.toUpperCase())) delete process.env[key];
  }
}
