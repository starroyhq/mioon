// One source of truth for build, package metadata, runtime identity and data roots.
// Channels are selected only by build arguments, never by a launch-time environment.
export interface DesktopIdentity {
  readonly channel: 'production' | 'development';
  readonly appId: string;
  readonly productName: string;
  readonly executableName: string;
}

const identities = Object.freeze({
  production: Object.freeze({channel: 'production', appId: 'app.starroy.mioon',
    productName: 'Mioon', executableName: 'mioon'} as const),
  development: Object.freeze({channel: 'development', appId: 'app.starroy.mioon.dev',
    productName: 'Mioon Dev', executableName: 'mioon-dev'} as const),
});

export type DesktopChannel = keyof typeof identities;

export function identityForChannel(channel: string): DesktopIdentity {
  if (!Object.hasOwn(identities, channel)) throw new Error(`Unknown desktop channel: ${channel}`);
  return identities[channel as DesktopChannel];
}

export function buildChannel(args: readonly string[] = []): DesktopChannel {
  if (args.length === 0) return 'development';
  if (args.length !== 1 || !args[0].startsWith('--channel=')) {
    throw new Error('Usage: build.ts [--channel=production|development]');
  }
  return identityForChannel(args[0].slice('--channel='.length)).channel;
}

const desktopIdentity = Object.freeze({identityForChannel, buildChannel});
export default desktopIdentity;
