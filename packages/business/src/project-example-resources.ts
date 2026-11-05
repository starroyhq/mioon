import {createHash} from 'node:crypto';
import {closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import path from 'node:path';
import {AppError} from '../../contracts/src/app-error.ts';
import {projectTemplateManifestSchema} from '../../contracts/src/project-template-manifest.ts';
import type {ProjectTemplateManifest} from '../../contracts/src/project-template-manifest.ts';
import {isAppLibraryHeld} from './app-db/connection.ts';
import {isProjectFileHeld} from './project-file/held-files.ts';
import {inspectProjectFileReadOnly} from './project-file/connection.ts';
import {detectMediaType, mediaTypeOfName, MEDIA_HEADER_BYTES} from './media-reference/media-type.ts';

/** Built-in resources only. No request or environment can add a catalog name. */
export const PROJECT_EXAMPLE_DIRECTORIES: readonly string[] = Object.freeze(['timeline-basics']);
export const PROJECT_EXAMPLE_METADATA_FILES: readonly string[] = Object.freeze(['manifest.json', 'README.md', 'SOURCE.md', 'LICENSE']);
export const PROJECT_EXAMPLE_MAX_BYTES = 5 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 64 * 1024;
const NOTICE_MAX_BYTES = 128 * 1024;
export interface ProjectExampleResourceEntry {readonly directory: string; readonly manifest: ProjectTemplateManifest}
const invalid = (reason: string): AppError => new AppError('PROJECT_EXAMPLE_RESOURCES_INVALID', '示例项目资源不完整或不安全。', 422, {reason});
const generation = (info: BigIntStats): string => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
const sameIdentity = (left: BigIntStats, right: BigIntStats): boolean => left.dev === right.dev && left.ino === right.ino;
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function realDirectory(directory: string): BigIntStats {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || directory.includes('\0')) throw invalid('directory-path');
  let current = path.parse(directory).root, info = lstatSync(current, {bigint: true});
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); info = lstatSync(current, {bigint: true});
    if (!info.isDirectory() || info.isSymbolicLink()) throw invalid('linked-directory');
  }
  if (!info.isDirectory()) throw invalid('directory');
  return info;
}
function readStableFile(file: string, maxBytes: number): Buffer {
  realDirectory(path.dirname(file));
  const before = lstatSync(file, {bigint: true});
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maxBytes)) throw invalid('file-kind-or-size');
  const identity = {dev: String(before.dev), ino: String(before.ino)};
  // Opening and closing another descriptor of a live SQLite inode would drop
  // this process's POSIX locks, even if we only wanted its content hash.
  if (isProjectFileHeld(identity) || isAppLibraryHeld(identity)) throw invalid('held-file');
  const handle = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (generation(fstatSync(handle, {bigint: true})) !== generation(before)) throw invalid('file-changed');
    const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(handle, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw invalid('file-changed');
      offset += count;
    }
    if (readSync(handle, Buffer.alloc(1), 0, 1, offset) !== 0 || generation(fstatSync(handle, {bigint: true})) !== generation(before)
      || generation(lstatSync(file, {bigint: true})) !== generation(before)) throw invalid('file-changed');
    return bytes;
  } finally {closeSync(handle);}
}
function resourceNames(manifest: ProjectTemplateManifest): string[] {
  return [...PROJECT_EXAMPLE_METADATA_FILES, manifest.projectFile.path, ...manifest.assets.map(asset => asset.path)].sort();
}
function filesIn(directory: string, allowed: ReadonlySet<string>, prefix = ''): string[] {
  const result: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    const relative = prefix + name, file = path.join(directory, name), info = lstatSync(file, {bigint: true});
    if (info.isSymbolicLink()) throw invalid('linked-entry');
    if (info.isDirectory()) {
      if (![...allowed].some(value => value.startsWith(relative + '/'))) throw invalid('unexpected-entry');
      const children = filesIn(file, allowed, relative + '/');
      if (children.length === 0) throw invalid('empty-extra-directory');
      result.push(...children);
    } else if (info.isFile() && info.nlink === 1n && allowed.has(relative)) result.push(relative);
    else throw invalid('file-kind-or-size');
  }
  return result.sort();
}

/** Validate the installed artifact, never a repository-relative fallback.
 * Reads are bounded by the delivered 5 MiB per-example limit. */
export function verifyProjectExampleResources(root: string): readonly ProjectExampleResourceEntry[] {
  realDirectory(root);
  const found = readdirSync(root).sort();
  if (JSON.stringify(found) !== JSON.stringify([...PROJECT_EXAMPLE_DIRECTORIES].sort())) throw invalid('catalog-entries');
  const result: ProjectExampleResourceEntry[] = [];
  for (const name of PROJECT_EXAMPLE_DIRECTORIES) {
    const directory = path.join(root, name), directoryBefore = realDirectory(directory);
    let manifest: ProjectTemplateManifest;
    try {manifest = projectTemplateManifestSchema.parse(JSON.parse(readStableFile(path.join(directory, 'manifest.json'), MANIFEST_MAX_BYTES).toString('utf8')));}
    catch (error) {if (error instanceof AppError) throw error; throw invalid('manifest');}
    const names = resourceNames(manifest);
    if (manifest.templateId !== name || !manifest.projectFile.path.endsWith('.mioon') || new Set(names).size !== names.length
      || manifest.assets.some(asset => mediaTypeOfName(asset.path) === null)) throw invalid('manifest-binding');
    if (JSON.stringify(filesIn(directory, new Set(names))) !== JSON.stringify(names)) throw invalid('unexpected-entry');
    let total = 0;
    for (const relative of names) {
      const file = path.join(directory, ...relative.split('/')), info = lstatSync(file, {bigint: true});
      total += Number(info.size);
      if (!Number.isSafeInteger(total) || total > PROJECT_EXAMPLE_MAX_BYTES) throw invalid('example-size');
    }
    for (const item of [manifest.projectFile, ...manifest.assets]) {
      const bytes = readStableFile(path.join(directory, ...item.path.split('/')), PROJECT_EXAMPLE_MAX_BYTES);
      if (bytes.length !== item.sizeBytes || hash(bytes) !== item.sha256) throw invalid('content-hash');
      if (item !== manifest.projectFile && !detectMediaType(item.path, bytes.subarray(0, MEDIA_HEADER_BYTES))) throw invalid('media-type');
    }
    for (const name of PROJECT_EXAMPLE_METADATA_FILES.filter(name => name !== 'manifest.json')) {
      if (readStableFile(path.join(directory, name), NOTICE_MAX_BYTES).toString('utf8').trim() === '') throw invalid('missing-notice');
    }
    const project = path.join(directory, ...manifest.projectFile.path.split('/'));
    inspectProjectFileReadOnly(project);
    if (generation(lstatSync(directory, {bigint: true})) !== generation(directoryBefore)) throw invalid('directory-changed');
    result.push(Object.freeze({directory, manifest}));
  }
  return Object.freeze(result);
}

/** Copy only already verified files into a new staging directory. Media are
 * independent byte copies, and installation files remain read-only. */
export async function stageProjectExampleResources(sourceRoot: string, destinationRoot: string): Promise<readonly ProjectExampleResourceEntry[]> {
  const entries = verifyProjectExampleResources(sourceRoot);
  if (!path.isAbsolute(destinationRoot) || path.normalize(destinationRoot) !== destinationRoot || destinationRoot.includes('\0')) throw invalid('destination-path');
  realDirectory(path.dirname(destinationRoot));
  mkdirSync(destinationRoot, {mode: 0o755});
  const owned = lstatSync(destinationRoot, {bigint: true});
  try {
    for (const entry of entries) {
      const name = path.basename(entry.directory), directory = path.join(destinationRoot, name); mkdirSync(directory, {mode: 0o755});
      for (const relative of resourceNames(entry.manifest)) {
        const file = path.join(directory, ...relative.split('/'));
        mkdirSync(path.dirname(file), {recursive: true, mode: 0o755});
        const bytes = readStableFile(path.join(entry.directory, ...relative.split('/')), PROJECT_EXAMPLE_MAX_BYTES);
        writeFileSync(file, bytes, {flag: 'wx', mode: 0o444});
      }
    }
    return verifyProjectExampleResources(destinationRoot);
  } catch (error) {
    const current = lstatSync(destinationRoot, {bigint: true, throwIfNoEntry: false});
    if (current && sameIdentity(current, owned) && current.isDirectory() && !current.isSymbolicLink()) rmSync(destinationRoot, {recursive: true});
    throw error;
  }
}
