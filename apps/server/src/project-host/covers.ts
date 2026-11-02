import {createHash} from 'node:crypto';
import {lstatSync} from 'node:fs';
import type {IncomingMessage, ServerResponse} from 'node:http';
import path from 'node:path';
import {ensurePrivateDirectory, readPrivateFile, writePrivateFileAtomic} from '@mioon/contracts/private-storage';
import {isProjectId} from '../../../../packages/contracts/src/project-file.ts';
import {recentProjectSummarySchema} from '../../../../packages/contracts/src/project-registry.ts';
import type {RecentProject, RecentProjectSummary} from '../../../../packages/contracts/src/project-registry.ts';
import {previsJpegSize} from '../../../../packages/business/src/previs.ts';
import {checkpoint} from '../../../../packages/business/src/operation-lifecycle.ts';
import {projectLocation} from './directories.ts';
import type {AppDirectories} from './directories.ts';
import {isProjectFileHeld} from '../../../../packages/business/src/project-file/index.ts';
import {isAppLibraryHeld} from '../../../../packages/business/src/app-db/index.ts';
import {PrivateStorageError} from '@mioon/contracts/private-storage';

export const PROJECT_COVER_LIMITS = Object.freeze({jpegBytes: 1024 * 1024, metadataBytes: 4096, maxEdge: 512});
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
export interface ProjectCoverMetadata {
  version: 1; assetId: string; mimeType: NonNullable<RecentProjectSummary['cover']>['mimeType'];
  sourceSha256: string; jpegSha256: string;
}
export function parseProjectCoverMetadata(value: unknown): ProjectCoverMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid project cover metadata');
  const entry = value as Record<string, unknown>, fields = ['version', 'assetId', 'mimeType', 'sourceSha256', 'jpegSha256'];
  if (Object.keys(entry).length !== fields.length || Object.keys(entry).some(key => !fields.includes(key)) || entry.version !== 1 ||
    typeof entry.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sourceSha256) || typeof entry.jpegSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.jpegSha256)) throw new TypeError('Invalid project cover metadata');
  const cover = recentProjectSummarySchema.shape.cover.unwrap().parse({assetId: entry.assetId, mimeType: entry.mimeType});
  return {...cover, version: 1, sourceSha256: entry.sourceSha256, jpegSha256: entry.jpegSha256};
}
type CoverSource = Pick<ProjectCoverMetadata, 'assetId' | 'mimeType' | 'sourceSha256'>;
function validJpeg(bytes: Buffer): boolean {
  const size = previsJpegSize(bytes);
  return bytes.length <= PROJECT_COVER_LIMITS.jpegBytes && size !== null && Math.max(size.width, size.height) <= PROJECT_COVER_LIMITS.maxEdge;
}
function assertNotHeld(file: string): void {
  const info = lstatSync(file, {bigint: true, throwIfNoEntry: false});
  if (!info?.isFile()) return;
  const identity = {dev: String(info.dev), ino: String(info.ino)};
  if (isProjectFileHeld(identity) || isAppLibraryHeld(identity)) throw new PrivateStorageError('HELD_DATABASE', 'A held database cannot be used as a project cover');
}
/** Reuse only a complete, bounded pair with the exact source fingerprint. All
 * identity checks precede filesystem opens, including renamed database files. */
export function readProjectCoverCache(cacheDir: string, source: Pick<ProjectCoverMetadata, 'assetId' | 'mimeType'> & {sourceSha256?: string}): Buffer | null {
  try {
    const metadataFile = path.join(cacheDir, 'cover.json'), jpegFile = path.join(cacheDir, 'cover.jpg');
    assertNotHeld(metadataFile); assertNotHeld(jpegFile);
    const raw = readPrivateFile(metadataFile, {root: cacheDir, allowMissing: true, maxBytes: PROJECT_COVER_LIMITS.metadataBytes, encoding: 'utf8'});
    if (typeof raw !== 'string') return null;
    const metadata = parseProjectCoverMetadata(JSON.parse(raw));
    if (metadata.assetId !== source.assetId || metadata.mimeType !== source.mimeType || source.sourceSha256 !== undefined && metadata.sourceSha256 !== source.sourceSha256) return null;
    const bytes = readPrivateFile(jpegFile, {root: cacheDir, allowMissing: true, maxBytes: PROJECT_COVER_LIMITS.jpegBytes});
    return Buffer.isBuffer(bytes) && validJpeg(bytes) && hash(bytes) === metadata.jpegSha256 ? bytes : null;
  } catch {return null;}
}

/** Called only by an already-open project's owner after bounded rendering.
 * Both atomic replacements are inside cacheDir; an interrupted pair fails the
 * reader's hash check instead of serving a JPEG with another source's receipt. */
export function writeProjectCover({cacheDir, source, jpeg}: {cacheDir: string; source: CoverSource; jpeg: Buffer}): void {
  if (!Buffer.isBuffer(jpeg) || !validJpeg(jpeg)) throw new TypeError('Invalid bounded project cover JPEG');
  const metadata = parseProjectCoverMetadata({...source, version: 1, jpegSha256: hash(jpeg)});
  ensurePrivateDirectory(cacheDir, {create: true});
  assertNotHeld(path.join(cacheDir, 'cover.jpg')); assertNotHeld(path.join(cacheDir, 'cover.json'));
  writePrivateFileAtomic(path.join(cacheDir, 'cover.jpg'), jpeg, {root: cacheDir, maxBytes: PROJECT_COVER_LIMITS.jpegBytes});
  writePrivateFileAtomic(path.join(cacheDir, 'cover.json'), JSON.stringify(metadata), {root: cacheDir, maxBytes: PROJECT_COVER_LIMITS.metadataBytes});
}

/** Cache-only application route: registry reads never acquire a project. */
export function createProjectCoverHttp({directories, readProject, signal}: {
  directories: AppDirectories; readProject: (id: string) => Pick<RecentProject, 'summary'> | null; signal?: AbortSignal;
}) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const prefix = '/api/project-covers/';
    if (!url.pathname.startsWith(prefix)) return false;
    checkpoint(signal);
    const projectId = url.pathname.slice(prefix.length);
    const unavailable = (): true => {
      res.writeHead(404, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
      res.end(JSON.stringify({ok: false, error: {code: 'NOT_FOUND', message: '封面不可用。'}})); return true;
    };
    if (!isProjectId(projectId) || url.search) return unavailable();
    if (req.method !== 'GET') {res.writeHead(405, {Allow: 'GET'}); res.end(); return true;}
    const cover = readProject(projectId)?.summary?.cover;
    if (!cover) return unavailable();
    const {cacheDir} = projectLocation(directories, projectId);
    const jpeg = readProjectCoverCache(cacheDir, cover);
    if (jpeg === null) return unavailable();
    checkpoint(signal);
    const latest = readProject(projectId)?.summary?.cover;
    if (!latest || latest.assetId !== cover.assetId || latest.mimeType !== cover.mimeType) return unavailable();
    res.writeHead(200, {'Content-Type': 'image/jpeg', 'Content-Length': jpeg.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
    res.end(jpeg); return true;
  };
}
