// electron-builder configuration source. This ESM module is bundled by
// scripts/prepare-builder-config.ts into the ignored .generated/ CJS entrypoints
// electron-builder actually loads. No packaging state is written here.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {identityForChannel} from './identity.ts';
import type {DesktopIdentity} from './identity.ts';
import {readBuildMetadata, validateStagedMetadata} from './build-metadata.ts';
import {verifySubtitleResources,packagedSubtitleDirectory,SUBTITLE_RESOURCE_FILES} from './subtitle-resources.ts';
import {preserveMacRuntimeNotices,inspectMacRuntimeNotices} from './runtime-notices.ts';
import type {RuntimeNoticeContext,RuntimeNoticeManifest} from './runtime-notices.ts';

/** The electron-builder beforePack context fields this module consumes. */
export interface BuilderPackContext {
  readonly packager: {readonly info: {readonly appDir: string}};
}
export interface BuilderConfig {
  appId: string;
  productName: string;
  executableName: string;
  electronVersion: string;
  directories: {app: 'build'; buildResources: 'resources'; output: string};
  icon: string;
  files: string[];
  asar: true;
  extraResources: Array<{from: string; to: string; filter: string[]}>;
  npmRebuild: false;
  publish: null;
  beforePack(context: BuilderPackContext): Promise<void>;
  afterExtract(context: RuntimeNoticeContext): Promise<void>;
  afterPack(context: RuntimeNoticeContext): Promise<void>;
  electronFuses: Record<string, boolean>;
  linux: {
    target: Array<{target: string; arch: string[]}>;
    category: string;
    syncDesktopName: true;
    synopsis: string;
    desktop: {entry: {StartupWMClass: string}};
    artifactName: string;
  };
  mac: {
    icon: string;
    target: Array<{target: string; arch: string[]}>;
    category: string;
    hardenedRuntime: true;
    gatekeeperAssess: false;
    identity: null;
    artifactName: string;
  };
}
const directory = path.dirname(fileURLToPath(import.meta.url));
export function builderConfig(channel: string): BuilderConfig {
  const identity: DesktopIdentity = identityForChannel(channel);
  const { appVersion, electronVersion } = readBuildMetadata();
  const runtimeNotices = new Map<string, RuntimeNoticeManifest | null>();
  return {
    appId: identity.appId,
    productName: identity.productName,
    executableName: identity.executableName,
    electronVersion,
    directories: { app: 'build', buildResources: 'resources', output: `../../release/desktop/${channel}` },
    icon: path.join(directory, 'resources/icon.png'),
    files: ['main.cjs', 'backend.cjs', 'preload.cjs', 'package.json', 'web/**/*', 'icons/**/*', 'licenses/**/*', '!node_modules/**/*'],
    asar: true,
    // External FFmpeg cannot read ASAR members. Only this pinned resource bundle
    // is copied outside ASAR; existing archive scanner limits stay unchanged.
    extraResources: [{from:'build/subtitles',to:'subtitles',filter:[...SUBTITLE_RESOURCE_FILES]}],
    npmRebuild: false,
    publish: null,
    // Reject stale versions and identities before any packaging work.
    beforePack: async (context: BuilderPackContext): Promise<void> => {
      const metadata: unknown = JSON.parse(await fs.readFile(path.join(context.packager.info.appDir, 'package.json'), 'utf8'));
      validateStagedMetadata(metadata, { appVersion, identity });
      await verifySubtitleResources(path.join(context.packager.info.appDir,'subtitles'));
    },
    // Preserve this target's notices before createMacApp removes runtime-root
    // copies. Keep them outside ASAR and verify both after the bundle rename.
    afterExtract: async (context: RuntimeNoticeContext): Promise<void> => {
      if (typeof context.appOutDir !== 'string') return;
      runtimeNotices.delete(context.appOutDir);
      const manifest = await preserveMacRuntimeNotices(context, electronVersion);
      if (manifest) runtimeNotices.set(context.appOutDir, manifest);
    },
    afterPack: async (context: RuntimeNoticeContext): Promise<void> => {
      const appOutDir = typeof context.appOutDir === 'string' ? context.appOutDir : null;
      await inspectMacRuntimeNotices(context, electronVersion, appOutDir === null ? undefined : runtimeNotices.get(appOutDir));
      if (appOutDir !== null) runtimeNotices.delete(appOutDir);
      await verifySubtitleResources(packagedSubtitleDirectory(context));
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
      icon: path.join(directory, 'resources/icon.icns'),
      target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
      category: 'public.app-category.video',
      hardenedRuntime: true,
      gatekeeperAssess: false,
      identity: null,
      artifactName: `${identity.executableName}-\${version}-\${os}-\${arch}.\${ext}`
    }
  };
}
export default builderConfig;
