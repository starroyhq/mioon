import {createHash} from 'node:crypto';
import {closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, rmdirSync, unlinkSync, writeSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import path from 'node:path';
import {AppError} from '../../../../packages/contracts/src/app-error.ts';
import {projectTemplateManifestSchema} from '../../../../packages/contracts/src/project-template-manifest.ts';
import type {ProjectTemplateManifest} from '../../../../packages/contracts/src/project-template-manifest.ts';
import type {MediaReference} from '../../../../packages/contracts/src/media-reference.ts';
import type {Locale} from '../../../../packages/i18n/src/types.ts';
import {projectHomeNativeMessages} from '../../../../packages/i18n/src/catalogs/project-home-native.ts';
import type {CopyProjectOptions} from '../../../../packages/business/src/project-file/copy.ts';
import {isAppLibraryHeld} from '../../../../packages/business/src/app-db/connection.ts';
import {isProjectFileHeld} from '../../../../packages/business/src/project-file/held-files.ts';
import {inspectCopiedProjectFile, syncCopiedDirectory, syncCopiedFile, validateProjectCopyStagingDirectory} from '../../../../packages/business/src/project-file/backup.ts';
import {detectMediaType, MEDIA_HEADER_BYTES, mediaTypeOfName} from '../../../../packages/business/src/media-reference/media-type.ts';
import {mediaMtimeMs, sampleRanges} from '../../../../packages/business/src/media-reference/fingerprint.ts';

export type {ProjectTemplateManifest} from '../../../../packages/contracts/src/project-template-manifest.ts';
/** These are trusted server configuration, never a caller-provided manifest or root. */
export interface ProjectTemplateCatalogEntry {readonly directory: string; readonly manifest: ProjectTemplateManifest}
export interface ProjectTemplateDescription {
  readonly templateId: string; readonly version: number; readonly projectFile: string; readonly projectId: string; readonly sourceProjectDir: string;
  readonly sourceGeneration: string;
  readonly sourceStamp: {readonly contentSequence: number; readonly contentToken: string};
}
export interface PreparedProjectTemplateAssets {
  readonly referenceTargets: ReadonlyMap<string, MediaReference>;
  readonly presentation?: CopyProjectOptions['templatePresentation'];
  /** Absolute staging files, useful to the owning publication intent. */
  readonly files: readonly string[];
}
export interface ProjectTemplateCatalog {
  describe(templateId: string, version: number): ProjectTemplateDescription;
  prepareAssets(templateId: string, version: number, options: {readonly directory: string; readonly targetDirectory: string; readonly locale?: Locale; readonly assertMutationAllowed?: () => void}): PreparedProjectTemplateAssets;
  /** Recheck a complete stage or a published folder without reopening or
   * comparing the newly keyed/renamed project against the source template. */
  verifyPreparedAssets(templateId: string, version: number, directory: string): void;
}
const invalid = (reason: string, relativePath?: string): AppError => new AppError('PROJECT_TEMPLATE_INVALID', '模板不完整或不安全，未创建项目。', 422, {reason, ...(relativePath === undefined ? {} : {path: relativePath})});
const generation = (info: BigIntStats): string => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
const identity = (info: BigIntStats) => ({dev: String(info.dev), ino: String(info.ino)});
const sameIdentity = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino;

function sourceFile(directory: string, item: ProjectTemplateManifest['projectFile']): {file: string; info: BigIntStats} {
  const resolved = path.join(directory, ...item.path.split('/'));
  try {
    validateProjectCopyStagingDirectory(path.dirname(resolved));
    const info = lstatSync(resolved, {bigint: true});
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) throw invalid('not-a-single-link-file', item.path);
    if (isProjectFileHeld(identity(info)) || isAppLibraryHeld(identity(info))) throw invalid('held-file', item.path);
    if (info.size !== BigInt(item.sizeBytes)) throw invalid('size', item.path);
    return {file: resolved, info};
  } catch (error) {if (error instanceof AppError && error.code === 'PROJECT_TEMPLATE_INVALID') throw error; throw invalid('unreadable-or-linked-path', item.path);}
}

/** Reads a manifest file through an O_NOFOLLOW handle and checks the exact
 * generation both at the handle and at the path. No held SQLite file is opened. */
function readManifestFile(directory: string, item: ProjectTemplateManifest['projectFile'], consume?: (chunk: Buffer) => void): {sampledSha256: string; header: Buffer} {
  const source = sourceFile(directory, item), fd = openSync(source.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (generation(fstatSync(fd, {bigint: true})) !== generation(source.info)) throw invalid('source-changed', item.path);
    const hash = createHash('sha256'), samples = createHash('sha256'), ranges = sampleRanges(item.sizeBytes);
    const buffer = Buffer.alloc(65_536), header = Buffer.alloc(Math.min(MEDIA_HEADER_BYTES, item.sizeBytes));
    let offset = 0;
    while (offset < item.sizeBytes) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, item.sizeBytes - offset), offset);
      if (count <= 0) throw invalid('source-changed', item.path);
      const chunk = buffer.subarray(0, count); hash.update(chunk);
      for (const range of ranges) {
        const start = Math.max(offset, range.start), end = Math.min(offset + count, range.start + range.length);
        if (start < end) samples.update(chunk.subarray(start - offset, end - offset));
      }
      if (offset < header.length) chunk.copy(header, offset, 0, Math.min(chunk.length, header.length - offset));
      consume?.(chunk); offset += count;
    }
    if (hash.digest('hex') !== item.sha256) throw invalid('content-hash', item.path);
    if (generation(fstatSync(fd, {bigint: true})) !== generation(source.info)
      || generation(lstatSync(source.file, {bigint: true})) !== generation(source.info)) throw invalid('source-changed', item.path);
    return {sampledSha256: samples.digest('hex'), header};
  } finally {closeSync(fd);}
}

/** Built-in templates are selected by an immutable catalog key. No request can
 * turn an arbitrary .mioon file, directory or manifest into a template. */
export function createProjectTemplateCatalog(entries: readonly ProjectTemplateCatalogEntry[]): ProjectTemplateCatalog {
  const catalog = new Map<string, {directory: string; manifest: ProjectTemplateManifest}>();
  for (const entry of entries) {
    const parsed = projectTemplateManifestSchema.safeParse(entry.manifest);
    if (!parsed.success || !path.isAbsolute(entry.directory) || path.normalize(entry.directory) !== entry.directory) throw invalid('manifest');
    const manifest = parsed.data, names = [manifest.projectFile.path, ...manifest.assets.map(value => value.path)];
    if (!manifest.projectFile.path.endsWith('.mioon') || manifest.assets.some(value => mediaTypeOfName(value.path) === null)
      || new Set(names).size !== names.length || names.some(value => names.some(other => other !== value && other.startsWith(value + '/')))) throw invalid('manifest-paths');
    const key = manifest.templateId + ':' + manifest.version;
    if (catalog.has(key)) throw invalid('duplicate-template');
    // Zod has cloned every nested input; later configuration mutation cannot
    // change the authority selected by a stable template ID and version.
    catalog.set(key, {directory: entry.directory, manifest});
  }
  const select = (templateId: string, version: number) => {
    const selected = catalog.get(templateId + ':' + version);
    if (!selected) throw new AppError('PROJECT_TEMPLATE_NOT_FOUND', '未找到指定版本的模板。', 404, {templateId, version});
    return selected;
  };
  const describe = (templateId: string, version: number): ProjectTemplateDescription => {
    const {directory, manifest} = select(templateId, version);
    const before = sourceFile(directory, manifest.projectFile), sourceGeneration = generation(before.info);
    readManifestFile(directory, manifest.projectFile);
    const projectFile = before.file;
    const inspected = inspectCopiedProjectFile(projectFile);
    // Hash verification and the SQLite content pair must describe the same
    // file generation, including edits between the two synchronous readers.
    if (generation(sourceFile(directory, manifest.projectFile).info) !== sourceGeneration) throw invalid('source-changed', manifest.projectFile.path);
    return {templateId, version, projectFile, projectId: inspected.projectId, sourceProjectDir: path.dirname(projectFile), sourceGeneration,
      sourceStamp: {contentSequence: inspected.contentSequence, contentToken: inspected.contentToken}};
  };
  return {describe, verifyPreparedAssets(templateId, version, directory) {
    const {manifest} = select(templateId, version);
    if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) throw invalid('target-path');
    validateProjectCopyStagingDirectory(directory);
    for (const item of manifest.assets) {
      const verified = readManifestFile(directory, item);
      if (!detectMediaType(item.path, verified.header)) throw invalid('not-media', item.path);
    }
  }, prepareAssets(templateId, version, {directory, targetDirectory, locale, assertMutationAllowed = () => {}}) {
    const selected = select(templateId, version), description = describe(templateId, version);
    if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || !path.isAbsolute(targetDirectory) || path.normalize(targetDirectory) !== targetDirectory) throw invalid('target-path');
    validateProjectCopyStagingDirectory(directory);
    const referenceTargets = new Map<string, MediaReference>(), created: Array<{file: string; info: BigIntStats}> = [], directories: string[] = [];
    try {
      for (const item of selected.manifest.assets) {
        assertMutationAllowed();
        const destination = path.join(directory, ...item.path.split('/'));
        let parent = directory;
        for (const part of item.path.split('/').slice(0, -1)) {
          parent = path.join(parent, part);
          if (!lstatSync(parent, {throwIfNoEntry: false})) {mkdirSync(parent, {mode: 0o700}); directories.push(parent);}
          validateProjectCopyStagingDirectory(parent);
        }
        const fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        const claimed = fstatSync(fd, {bigint: true}); created.push({file: destination, info: claimed});
        let verified: ReturnType<typeof readManifestFile>;
        try {
          verified = readManifestFile(selected.directory, item, chunk => {
            assertMutationAllowed();
            for (let offset = 0; offset < chunk.length;) offset += writeSync(fd, chunk, offset, chunk.length - offset);
          });
        } finally {closeSync(fd);}
        if (!detectMediaType(item.path, verified.header)) throw invalid('not-media', item.path);
        syncCopiedFile(destination);
        const finalInfo = lstatSync(destination, {bigint: true});
        if (!sameIdentity(finalInfo, claimed) || finalInfo.size !== BigInt(item.sizeBytes)) throw invalid('target-changed', item.path);
        const source = sourceFile(selected.directory, item).file;
        const target = path.join(targetDirectory, ...item.path.split('/'));
        const relativeTarget = path.relative(targetDirectory, target).split(path.sep).join('/');
        referenceTargets.set(source, {pathForm: 'relative', path: relativeTarget, volume: null, sizeBytes: item.sizeBytes,
          mtimeMs: mediaMtimeMs(finalInfo), sampledSha256: verified.sampledSha256, fullSha256: item.sha256});
      }
      // The project file is immutable template input too; do not accept media
      // from a catalog whose project was replaced while it was prepared.
      const after = describe(templateId, version);
      if (after.projectId !== description.projectId) throw invalid('source-changed');
      assertMutationAllowed();
      for (const folder of [...directories].reverse()) syncCopiedDirectory(folder);
      syncCopiedDirectory(directory);
      const presentation = templateId === 'timeline-basics' && version === 1 && locale ? {
        description: projectHomeNativeMessages['projectHomeNative.example.description'][locale],
        assetNames: new Map([
          ['media/scene-a.mp4', projectHomeNativeMessages['projectHomeNative.example.firstLight'][locale]],
          ['media/scene-b.mp4', projectHomeNativeMessages['projectHomeNative.example.afterHours'][locale]],
          ['media/overlay-star.png', projectHomeNativeMessages['projectHomeNative.example.starCard'][locale]],
          ['media/sound-bed.wav', projectHomeNativeMessages['projectHomeNative.example.soundBed'][locale]],
        ]),
      } : undefined;
      return {referenceTargets, files: created.map(value => value.file), ...(presentation ? {presentation} : {})};
    } catch (error) {
      for (const item of created.reverse()) {
        const actual = lstatSync(item.file, {bigint: true, throwIfNoEntry: false});
        if (actual && sameIdentity(actual, item.info)) unlinkSync(item.file);
      }
      for (const folder of directories.reverse()) {try {rmdirSync(folder);} catch { /* Never remove another owner's content. */ }}
      throw error;
    }
  }};
}
