const fs = require('node:fs/promises');
const path = require('node:path');
const { identityForChannel } = require('./identity.cjs');
const { readBuildMetadata, validateStagedMetadata } = require('./build-metadata.cjs');
module.exports = function builderConfig(channel) {
  const identity = identityForChannel(channel);
  const { appVersion, electronVersion } = readBuildMetadata();
  const runtimeNotices = new Map();
  return {
    appId: identity.appId,
    productName: identity.productName,
    executableName: identity.executableName,
    electronVersion,
    directories: { app: 'build', output: `../../release/desktop/${channel}` },
    files: ['main.cjs', 'backend.cjs', 'package.json', 'web/**/*', 'licenses/**/*', '!node_modules/**/*'],
    asar: true,
    npmRebuild: false,
    publish: null,
    // Reject stale versions and identities before any packaging work.
    beforePack: async context => {
      const metadata = JSON.parse(await fs.readFile(path.join(context.packager.info.appDir, 'package.json'), 'utf8'));
      validateStagedMetadata(metadata, { appVersion, identity });
    },
    // Preserve this target's notices before createMacApp removes runtime-root
    // copies. Keep them outside ASAR and verify both after the bundle rename.
    afterExtract: async context => {
      const { preserveMacRuntimeNotices } = require('./runtime-notices.cjs');
      runtimeNotices.delete(context.appOutDir);
      const manifest = await preserveMacRuntimeNotices(context, electronVersion);
      if (manifest) runtimeNotices.set(context.appOutDir, manifest);
    },
    afterPack: async context => {
      const { inspectMacRuntimeNotices } = require('./runtime-notices.cjs');
      await inspectMacRuntimeNotices(context, electronVersion, runtimeNotices.get(context.appOutDir));
      runtimeNotices.delete(context.appOutDir);
    },
    electronFuses: {
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: false
    },
    linux: {
      target: [{ target: 'tar.gz', arch: ['x64'] }],
      category: 'AudioVideo',
      syncDesktopName: true,
      synopsis: 'Local-first video canvas and multitrack workbench',
      desktop: { entry: { StartupWMClass: identity.appId } },
      artifactName: `${identity.executableName}-\${version}-\${os}-\${arch}.\${ext}`
    },
    // Configuration only: macOS build, signing, notarization and native QA remain unverified.
    mac: {
      target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
      category: 'public.app-category.video',
      hardenedRuntime: true,
      gatekeeperAssess: false,
      identity: null,
      artifactName: `${identity.executableName}-\${version}-\${os}-\${arch}.\${ext}`
    }
  };
};
