import nodePath from 'node:path';
import {isNormalizedAbsolutePath, isPortableRelativePath} from '../../../contracts/src/media-reference.ts';
import type {MediaPathForm, MediaReference} from '../../../contracts/src/media-reference.ts';
import {mediaReferenceError} from './errors.ts';

// Paths of media references (docs/PROJECT-FILE.md, "素材引用"). Pure
// functions: nothing here touches the file system. Names are compared in one
// way only, after NFC normalization and, once either side is a Windows path,
// without case; so a reference stored on Windows still maps on a Mac (12-05).

/** `path.posix` or `path.win32`: the platform whose local paths are accepted. */
export type PathApi = typeof nodePath.posix;

/** An absolute path split into its root and names. */
export interface AbsolutePathParts {
  readonly flavor: 'posix' | 'win32';
  /** `/`, a drive such as `C:\` (letter upper-cased) or a share `\\server\share`. */
  readonly root: string;
  readonly segments: readonly string[];
}

// Characters a Windows name cannot hold; `a:b` would name a stream of `a`.
const WINDOWS_RESERVED = /[<>:"|?*\u0000-\u001f]/u;
const VOLUME_NAME_MAX_LENGTH = 255;

function toParts(flavor: AbsolutePathParts['flavor'], root: string, names: readonly string[]): AbsolutePathParts | null {
  const segments: string[] = [];
  for (const name of names) {
    if (name === '' || name === '.') continue;
    if (name === '..' || flavor === 'win32' && WINDOWS_RESERVED.test(name)) return null;
    segments.push(name);
  }
  return {flavor, root, segments};
}
const shareName = (name: string): boolean => name !== '' && name !== '.' && name !== '..' && !WINDOWS_RESERVED.test(name);

/** `/…`, a drive path `C:\…` (also `C:/…`) or a share `\\server\share\…`.
 * Empty and `.` segments are dropped. Null for `..` segments, device paths
 * (`\\?\…`, `\\.\…`), drive-relative paths (`C:a`), relative paths, and
 * Windows names holding a character Windows refuses in names. */
export function parseAbsolutePath(value: string): AbsolutePathParts | null {
  if (typeof value !== 'string' || value.includes('\u0000')) return null;
  if (value.startsWith('\\\\')) {
    const [server = '', share = '', ...names] = value.slice(2).split(/[\\/]/u);
    return shareName(server) && shareName(share) ? toParts('win32', `\\\\${server}\\${share}`, names) : null;
  }
  const drive = /^([A-Za-z]):[\\/]/u.exec(value);
  if (drive) return toParts('win32', `${drive[1].toUpperCase()}:\\`, value.slice(3).split(/[\\/]/u));
  return value.startsWith('/') ? toParts('posix', '/', value.slice(1).split('/')) : null;
}

/** POSIX paths with `/`, Windows paths with `\`; a share without names has no
 * trailing separator, so every result passes `isNormalizedAbsolutePath`. */
export function formatAbsolutePath({flavor, root, segments}: AbsolutePathParts): string {
  if (flavor === 'posix') return `/${segments.join('/')}`;
  return root.endsWith('\\') ? `${root}${segments.join('\\')}` : [root, ...segments].join('\\');
}

const flavorOf = (pathApi: PathApi): AbsolutePathParts['flavor'] => pathApi.sep === '\\' ? 'win32' : 'posix';
/** parseAbsolutePath, for paths of the platform `pathApi` stands for only. */
export function parseLocalPath(value: string, pathApi: PathApi = nodePath): AbsolutePathParts | null {
  const parsed = parseAbsolutePath(value);
  return parsed?.flavor === flavorOf(pathApi) ? parsed : null;
}

const nameKey = (name: string, foldCase: boolean): string => foldCase ? name.normalize('NFC').toLowerCase() : name.normalize('NFC');
const sameName = (a: string, b: string, foldCase: boolean): boolean => a === b || nameKey(a, foldCase) === nameKey(b, foldCase);
const sameRoot = (a: AbsolutePathParts, b: AbsolutePathParts): boolean => a.flavor === b.flavor && sameName(a.root, b.root, a.flavor === 'win32');
/** Whether `inner` is `outer` itself or below it. */
function startsWithPath(outer: AbsolutePathParts, inner: AbsolutePathParts): boolean {
  if (!sameRoot(outer, inner) || outer.segments.length > inner.segments.length) return false;
  const foldCase = outer.flavor === 'win32';
  return outer.segments.every((name, index) => sameName(name, inner.segments[index], foldCase));
}
const pathKey = (parts: AbsolutePathParts): string =>
  [parts.flavor, ...[parts.root, ...parts.segments].map(name => nameKey(name, parts.flavor === 'win32'))].join('\u0000');

/** Whether `file` is `directory` itself or below it. Both are absolute paths
 * of the platform `pathApi` stands for; under different roots it never is. */
export function isInsideDirectory(directory: string, file: string, pathApi: PathApi = nodePath): boolean {
  const outer = parseLocalPath(directory, pathApi), inner = parseLocalPath(file, pathApi);
  return outer !== null && inner !== null && startsWithPath(outer, inner);
}

/** `isInsideDirectory` of any of `directories`, for example the folders the
 * user confirmed outside the project directory (`MediaAccess.mayReadOutside`). */
export function insideAnyDirectory(directories: readonly string[], pathApi: PathApi = nodePath): (file: string) => boolean {
  const outers = directories.map(directory => parseLocalPath(directory, pathApi)).filter((parts): parts is AbsolutePathParts => parts !== null);
  return file => {
    const inner = parseLocalPath(file, pathApi);
    return inner !== null && outers.some(outer => startsWithPath(outer, inner));
  };
}

/** The volume name a path shows: `<name>` of macOS `/Volumes/<name>/…`, or
 * the share `\\server\share`; null otherwise. A drive's label would take the
 * native module. */
export function volumeNameOf(absolutePath: string): string | null {
  const parsed = parseAbsolutePath(absolutePath);
  let name: string | null = null;
  if (parsed?.flavor === 'win32') name = parsed.root.endsWith('\\') ? null : parsed.root;
  else if (parsed?.segments[0] === 'Volumes' && parsed.segments.length >= 2) name = parsed.segments[1];
  return name !== null && name.length <= VOLUME_NAME_MAX_LENGTH ? name : null;
}

const invalidPath = () => mediaReferenceError('MEDIA_REFERENCE_INVALID', {reason: 'path'});

export interface ReferencePath {
  readonly pathForm: MediaPathForm;
  readonly path: string;
  readonly volume: string | null;
}
/** How a reference stores `file`. On the project's volume (`sameVolume`, from
 * the devices of the file and the project directory) and under the same root
 * (one drive letter, or one server and share): the path relative to
 * `projectDir`, with `/`. Otherwise the normalized absolute path, with the
 * volume name when the path shows it. MEDIA_REFERENCE_INVALID (`path`) when
 * neither can be stored, for example for the project directory itself, or a
 * POSIX name holding `\`, which the contract reads as a separator. */
export function referencePathFor(projectDir: string, file: string, sameVolume: boolean, pathApi: PathApi = nodePath): ReferencePath {
  const directory = parseLocalPath(projectDir, pathApi), target = parseLocalPath(file, pathApi);
  if (directory === null || target === null) throw invalidPath();
  if (sameVolume && sameRoot(directory, target)) {
    const foldCase = directory.flavor === 'win32';
    let common = 0;
    while (common < directory.segments.length && common < target.segments.length &&
      sameName(directory.segments[common], target.segments[common], foldCase)) common++;
    const relative = [...new Array<string>(directory.segments.length - common).fill('..'), ...target.segments.slice(common)].join('/');
    if (!isPortableRelativePath(relative)) throw invalidPath();
    return {pathForm: 'relative', path: relative, volume: null};
  }
  const absolute = formatAbsolutePath(target);
  if (target.segments.some(name => name.includes('\\')) || !isNormalizedAbsolutePath(absolute)) throw invalidPath();
  return {pathForm: 'absolute', path: absolute, volume: volumeNameOf(absolute)};
}

/** The local path a reference points at: a relative path resolved against
 * `projectDir` (`..` stops at the root, as path.resolve does), an absolute one
 * normalized. Null when it names no file here: an absolute path of the other
 * platform, or a name this platform cannot hold. */
export function resolveReferencePath(projectDir: string, reference: Pick<MediaReference, 'pathForm' | 'path'>, pathApi: PathApi = nodePath): string | null {
  if (reference.pathForm === 'absolute') {
    const parsed = parseLocalPath(reference.path, pathApi);
    return parsed === null ? null : formatAbsolutePath(parsed);
  }
  const directory = parseLocalPath(projectDir, pathApi);
  if (directory === null || !isPortableRelativePath(reference.path)) return null;
  const segments = [...directory.segments];
  for (const name of reference.path.split('/')) {
    if (name === '..') segments.pop();
    else segments.push(name);
  }
  // Parsing the result again refuses names the platform cannot hold.
  const resolved = parseLocalPath(formatAbsolutePath({...directory, segments}), pathApi);
  return resolved !== null && resolved.segments.length === segments.length ? formatAbsolutePath(resolved) : null;
}

export interface RelinkBases {
  readonly from: AbsolutePathParts;
  readonly to: AbsolutePathParts;
}
/** Relinking (12-05): the folders of the old and the new path of one file
 * lose their longest common tail of names, and what is left are the old and
 * the new base, e.g. `/Volumes/素材盘` and `/Volumes/素材盘-备份`. File names
 * are not compared, so a renamed file still maps its folder. Null unless both
 * are absolute paths; either may be of the other platform. */
export function relinkBases(oldFile: string, newFile: string): RelinkBases | null {
  const from = parseAbsolutePath(oldFile), to = parseAbsolutePath(newFile);
  if (from === null || to === null || from.segments.length === 0 || to.segments.length === 0) return null;
  const foldCase = from.flavor === 'win32' || to.flavor === 'win32';
  const oldFolder = from.segments.slice(0, -1), newFolder = to.segments.slice(0, -1);
  let common = 0;
  while (common < oldFolder.length && common < newFolder.length &&
    sameName(oldFolder[oldFolder.length - 1 - common], newFolder[newFolder.length - 1 - common], foldCase)) common++;
  return {
    from: {...from, segments: oldFolder.slice(0, oldFolder.length - common)},
    to: {...to, segments: newFolder.slice(0, newFolder.length - common)},
  };
}
/** Where `oldFile` is after the move `bases` describes: the same names below
 * the new base. Null when it is not below the old base, or one of its names
 * cannot be part of a path of the new base's platform. */
export function relinkTarget(bases: RelinkBases, oldFile: string): string | null {
  const old = parseAbsolutePath(oldFile);
  if (old === null || old.segments.length <= bases.from.segments.length || !startsWithPath(bases.from, old)) return null;
  const segments = [...bases.to.segments, ...old.segments.slice(bases.from.segments.length)];
  const target = formatAbsolutePath({...bases.to, segments});
  return parseAbsolutePath(target)?.segments.length === segments.length ? target : null;
}

/** Orders strings by code point rather than by UTF-16 code unit. */
export function compareCodePoints(a: string, b: string): number {
  const left = a[Symbol.iterator](), right = b[Symbol.iterator]();
  for (;;) {
    const x = left.next(), y = right.next();
    if (x.done || y.done) return x.done ? (y.done ? 0 : -1) : 1;
    const difference = (x.value.codePointAt(0) ?? 0) - (y.value.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
}

interface FolderGroup {
  readonly parts: AbsolutePathParts;
  readonly directory: string;
  count: number;
}
/** The folders of absolute file paths, of either platform, with the number of
 * files in each (12-06). A folder inside another one is counted with the
 * outer one; folders side by side stay apart. In code point order. */
export function outsideDirectoryGroups(files: readonly string[]): readonly {readonly directory: string; readonly count: number}[] {
  const folders = new Map<string, FolderGroup>();
  for (const file of files) {
    const parsed = parseAbsolutePath(file);
    if (parsed === null || parsed.segments.length === 0) continue;
    const folder = {...parsed, segments: parsed.segments.slice(0, -1)};
    const key = pathKey(folder), known = folders.get(key);
    if (known) known.count++;
    else folders.set(key, {parts: folder, directory: formatAbsolutePath(folder), count: 1});
  }
  const groups: FolderGroup[] = [];
  // Outer folders come first, so an inner one always finds its outermost folder.
  for (const folder of [...folders.values()].sort((a, b) => a.parts.segments.length - b.parts.segments.length)) {
    const outer = groups.find(group => startsWithPath(group.parts, folder.parts));
    if (outer) outer.count += folder.count;
    else groups.push({...folder});
  }
  return groups.sort((a, b) => compareCodePoints(a.directory, b.directory)).map(({directory, count}) => ({directory, count}));
}
