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
import {MAC_UNIVERSAL_ARCH,mergedMacRuntimeNotices,preserveMacRuntimeNotices,inspectMacRuntimeNotices,writeMacRuntimeNoticeProvenance} from './runtime-notices.ts';
import type {RuntimeNoticeContext,RuntimeNoticeManifest} from './runtime-notices.ts';
import {verifyProjectExampleResources} from '@mioon/business/project-example-resources';
import {candidateUpdateFeedUrl} from '../../.github/scripts/mac-update-feed.ts';
import {verifyMacAppPermissions, withMacUpdateZip} from './mac-update-package-permissions.ts';

/** The electron-builder beforePack context fields this module consumes. */
export interface BuilderPackContext {
  readonly electronPlatformName?: unknown;
  readonly arch?: unknown;
  readonly packager: {readonly info: {readonly appDir: string}};
}
interface BuilderArtifactContext {
  readonly file?: string;
  readonly target: {readonly name: string} | null;
  readonly packager: {readonly platform: {readonly nodeName: string}; readonly appInfo: {readonly productFilename: string}};
}
type MacPublishConfig = {provider: 'github'; owner: 'starroyhq'; repo: 'mioon'; releaseType: 'release'}
  | {provider: 'generic'; url: string};
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
  dmg: {writeUpdateInfo: false};
  beforePack(context: BuilderPackContext): Promise<void>;
  afterExtract(context: RuntimeNoticeContext): Promise<void>;
  afterPack(context: RuntimeNoticeContext): Promise<void>;
  artifactBuildCompleted(context: BuilderArtifactContext): Promise<void>;
  fileAssociations: Array<{ext: string; name: string; description: string; mimeType: string; role: 'Editor'}>;
  electronFuses: Record<string, boolean>;
  linux: {
    icon: string;
    target: Array<{target: string; arch: string[]}>;
    category: string;
    syncDesktopName: true;
    synopsis: string;
    desktop: {entry: {StartupWMClass: string}};
    artifactName: string;
  };
  win?: {
    target: Array<{target: 'portable'; arch: ['x64']}>;
    signExecutable: false;
    requestedExecutionLevel: 'asInvoker';
    extraResources: Array<{from: string; to: string; filter: string[]}>;
    artifactName: string;
  };
  mac: {
    icon: string;
    target: Array<{target: string; arch: string[]}>;
    publish: MacPublishConfig | null;
    detectUpdateChannel: false;
    category: string;
    hardenedRuntime: true;
    gatekeeperAssess: false;
    identity: null;
    signIgnore: string[];
    extendInfo: Record<string,string>;
    artifactName: string;
  };
}
const directory = path.dirname(fileURLToPath(import.meta.url));
/** A native ACL helper built for another architecture cannot load in Electron. */
export async function verifyWindowsPrivateStorageHelper(appDir: string, arch: unknown): Promise<void> {
  // electron-builder's Arch.x64 is 1. Windows ARM packaging is not part of W0.
  if (arch !== 1) throw Error('Windows development packaging currently requires x64.');
  const file = path.join(appDir, 'native', 'mioon_private_storage.node');
  const info = await fs.lstat(file).catch(() => {throw Error('Build the Windows x64 private storage helper before packaging.');});
  if (!info.isFile() || info.isSymbolicLink()) throw Error('Windows private storage helper must be a regular file.');
  const handle = await fs.open(file, 'r');
  try {
    const dos = Buffer.alloc(64), pe = Buffer.alloc(6);
    if ((await handle.read(dos, 0, dos.length, 0)).bytesRead !== dos.length || dos.toString('ascii', 0, 2) !== 'MZ') {
      throw Error('Windows private storage helper has an invalid executable header.');
    }
    const offset = dos.readUInt32LE(60);
    if (offset < 64 || offset > 1024 * 1024 || offset > info.size - pe.length ||
        (await handle.read(pe, 0, pe.length, offset)).bytesRead !== pe.length || pe.readUInt32LE(0) !== 0x00004550) {
      throw Error('Windows private storage helper has an invalid executable header.');
    }
    if (pe.readUInt16LE(4) !== 0x8664) throw Error('Windows private storage helper architecture must match the x64 package.');
  } finally {await handle.close();}
}
export function builderConfig(channel: string, updateFeedUrl = process.env.MIOON_RELEASE_UPDATE_FEED_URL ?? ''): BuilderConfig {
  const identity: DesktopIdentity = identityForChannel(channel);
  const { appVersion, electronVersion } = readBuildMetadata();
  const runtimeNotices = new Map<string, RuntimeNoticeManifest | null>();
  const packedMacNotices = new Map<string, RuntimeNoticeManifest>();
  let macPublish: MacPublishConfig | null = null;
  if (identity.channel === 'production') {
    macPublish = updateFeedUrl ? {provider: 'generic', url: candidateUpdateFeedUrl(updateFeedUrl)}
      : {provider: 'github', owner: 'starroyhq', repo: 'mioon', releaseType: 'release'};
  }
  return {
    appId: identity.appId,
    productName: identity.productName,
    executableName: identity.executableName,
    electronVersion,
    directories: { app: 'build', buildResources: 'resources', output: `../../release/desktop/${channel}` },
    icon: path.join(directory, 'resources/icon.png'),
    files: ['main.cjs', 'backend.cjs', 'project-catalog.cjs', 'preload.cjs', 'package.json', 'web/**/*', 'icons/**/*', 'licenses/**/*', '!node_modules/**/*'],
    asar: true,
    // SQLite templates and external FFmpeg resources must be ordinary files
    // outside ASAR. Both resource trees are verified before and after packing.
    extraResources: [{from:'build/subtitles',to:'subtitles',filter:[...SUBTITLE_RESOURCE_FILES]},
      {from:'build/examples',to:'examples',filter:['**/*']}],
    npmRebuild: false,
    publish: null,
    // The DMG is stapled after electron-builder exits. Keep the updater
    // manifest and blockmap tied to the already stapled app in the final ZIP.
    dmg: {writeUpdateInfo: false},
    // Reject stale versions and identities before any packaging work.
    beforePack: async (context: BuilderPackContext): Promise<void> => {
      if (context.electronPlatformName === 'win32') {
        if (identity.channel !== 'development') throw Error('Windows packaging is available only for development.');
      }
      const metadata: unknown = JSON.parse(await fs.readFile(path.join(context.packager.info.appDir, 'package.json'), 'utf8'));
      validateStagedMetadata(metadata, { appVersion, identity });
      if (context.electronPlatformName === 'win32') await verifyWindowsPrivateStorageHelper(context.packager.info.appDir, context.arch);
      await verifySubtitleResources(path.join(context.packager.info.appDir,'subtitles'));
      verifyProjectExampleResources(path.join(context.packager.info.appDir,'examples'));
    },
    // Preserve this target's notices before createMacApp removes runtime-root
    // copies. Keep them outside ASAR and verify both after the bundle rename.
    afterExtract: async (context: RuntimeNoticeContext): Promise<void> => {
      if (typeof context.appOutDir !== 'string') return;
      runtimeNotices.delete(context.appOutDir);
      packedMacNotices.delete(context.appOutDir);
      const manifest = await preserveMacRuntimeNotices(context, electronVersion);
      if (manifest) runtimeNotices.set(context.appOutDir, manifest);
    },
    afterPack: async (context: RuntimeNoticeContext): Promise<void> => {
      const appOutDir = typeof context.appOutDir === 'string' ? context.appOutDir : null;
      const universal = context.arch === MAC_UNIVERSAL_ARCH;
      const originalNotices = universal ? mergedMacRuntimeNotices(context, electronVersion, packedMacNotices)
        : appOutDir === null ? undefined : runtimeNotices.get(appOutDir);
      const manifest = await inspectMacRuntimeNotices(context, electronVersion, originalNotices);
      const subtitles = packagedSubtitleDirectory(context);
      await verifySubtitleResources(subtitles);
      verifyProjectExampleResources(path.join(path.dirname(subtitles), 'examples'));
      if (context.electronPlatformName === 'darwin' || context.electronPlatformName === 'mas') {
        await verifyMacAppPermissions(path.resolve(subtitles, '../../..'));
      }
      await writeMacRuntimeNoticeProvenance(context, electronVersion, appVersion, manifest);
      if (appOutDir !== null) {
        runtimeNotices.delete(appOutDir);
        if (manifest && !universal) packedMacNotices.set(appOutDir, manifest);
      }
    },
    artifactBuildCompleted: async ({file, target, packager}: BuilderArtifactContext): Promise<void> => {
      if (identity.channel !== 'development' || packager.platform.nodeName !== 'darwin' || target?.name !== 'zip') return;
      if (!file) throw Error('Mac ZIP artifact path is missing');
      // electron-builder also emits this target's .zip.blockmap sidecar.
      if (path.extname(file) !== '.zip') return;
      await withMacUpdateZip(file, `${packager.appInfo.productFilename}.app`, verifyMacAppPermissions);
    },
    // OS file intents open the original project path through the trusted host.
    fileAssociations: [{ ext: 'mioon', name: 'Mioon Project', description: 'Mioon Project File', mimeType: 'application/vnd.mioon.project', role: 'Editor' }],
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
      icon: path.join(directory, 'resources/icon.png'),
      target: [{ target: 'tar.gz', arch: ['x64'] }],
      category: 'AudioVideo',
      syncDesktopName: true,
      synopsis: 'Local-first video canvas and multitrack workbench',
      desktop: { entry: { StartupWMClass: identity.appId } },
      artifactName: `${identity.executableName}-\${version}-\${os}-\${arch}.\${ext}`
    },
    ...(identity.channel === 'development' ? {win: {
      target: [{target: 'portable' as const, arch: ['x64'] as ['x64']}],
      // Keep PE metadata and icons; only signing is disabled in the dev package.
      signExecutable: false as const,
      requestedExecutionLevel: 'asInvoker' as const,
      extraResources: [{from: 'build/native', to: 'native', filter: ['mioon_private_storage.node']}],
      artifactName: `${identity.executableName}-\${version}-win-\${arch}.\${ext}`,
    }} : {}),
    // The release invocation supplies signing and notarization explicitly.
    mac: {
      icon: path.join(directory, 'resources/icon.icns'),
      target: [{ target: 'dmg', arch: ['universal'] }, { target: 'zip', arch: ['universal'] }],
      publish: macPublish,
      detectUpdateChannel: false,
      category: 'public.app-category.video',
      hardenedRuntime: true,
      gatekeeperAssess: false,
      identity: null,
      // The signer treats ordinary binary data as signing candidates. The
      // outer app seals these manifest-verified files as resources. No
      // executable, framework or other resource is excluded.
      signIgnore: [String.raw`[/\\]Contents[/\\]Resources[/\\]examples[/\\]timeline-basics[/\\](?:manifest\.json|README\.md|SOURCE\.md|LICENSE|timeline-basics\.mioon|media[/\\](?:overlay-star\.png|scene-[ab]\.mp4|sound-bed\.wav))$`],
      extendInfo: {
        NSDesktopFolderUsageDescription: 'Mioon opens and saves the projects and media you choose on your Desktop.',
        NSDocumentsFolderUsageDescription: 'Mioon opens and saves the projects and media you choose in Documents.',
        NSDownloadsFolderUsageDescription: 'Mioon opens and saves the projects and media you choose in Downloads.',
        NSRemovableVolumesUsageDescription: 'Mioon opens and saves the projects and media you choose on removable drives.',
      },
      artifactName: `${identity.executableName}-\${version}-mac.\${ext}`
    }
  };
}
export default builderConfig;
