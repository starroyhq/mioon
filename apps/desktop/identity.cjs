// One source of truth for build, package metadata, runtime identity and data roots.
// Channels are selected only by build arguments, never by a launch-time environment.
const identities = Object.freeze({
  production: Object.freeze({ channel: 'production', appId: 'app.starroy.mioon',
    productName: 'Mioon', executableName: 'mioon' }),
  development: Object.freeze({ channel: 'development', appId: 'app.starroy.mioon.dev',
    productName: 'Mioon Dev', executableName: 'mioon-dev' })
});
function identityForChannel(channel) {
  if (!Object.hasOwn(identities, channel)) throw new Error(`Unknown desktop channel: ${channel}`);
  return identities[channel];
}
function buildChannel(args = []) {
  if (args.length === 0) return 'development';
  if (args.length !== 1 || !args[0].startsWith('--channel=')) {
    throw new Error('Usage: build.mjs [--channel=production|development]');
  }
  return identityForChannel(args[0].slice('--channel='.length)).channel;
}
module.exports = { identityForChannel, buildChannel };
