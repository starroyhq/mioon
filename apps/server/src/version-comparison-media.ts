import path from 'node:path';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import type {Stats} from 'node:fs';
import type {DatabaseSync} from 'node:sqlite';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {createHash} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';

const route = '/api/version-comparison/media';
const fields = ['projectId', 'shotId', 'versionId', 'assetId', 'sha256', 'workspaceOrigin'] as const;
type Identity = Readonly<Record<typeof fields[number], string>>;
export interface VersionComparisonMedia extends Identity {
  readonly jobId: string; readonly relativePath: string; readonly mimeType: string; readonly sizeBytes: number; readonly identityDigest: string;
}
export interface VersionComparisonGraph {
  version(versionId: string, shotId: string, assetId: string): unknown;
  asset(assetId: string): unknown;
}
type GraphReader = (projectId: string) => VersionComparisonGraph;
type ReadHandle = Pick<FileHandle, 'close' | 'createReadStream'> & {stat(): Promise<Stats>};
interface FileResponses {
  send(req: IncomingMessage, res: ServerResponse, options: {file: string; ranges: boolean; headers: () => Record<string, string>}): Promise<void>;
  close(): Promise<void>;
}
export interface VersionComparisonMediaOptions {
  db: DatabaseSync; root: string; signal?: AbortSignal;
  readGraph: GraphReader;
  /** Trusted wiring checks the actual store lock and refuses restored scope. */
  assertAvailable(): void;
  validateFile(file: string): Stats;
  resolvePath(root: string, relativePath: string): Promise<string>;
  createFiles(options: {signal?: AbortSignal; openFile(file: string, flags: number): Promise<ReadHandle>}): FileResponses;
  openFile?(file: string, flags: number): Promise<ReadHandle>;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = /^[0-9a-f]{64}$/;
const unavailable = () => Object.assign(Error('本地文件不可用。'), {code: 'FILE_UNAVAILABLE', status: 404});
const sameFile = (left: Stats, right: Stats): boolean => (['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'] as const).every(key => left[key] === right[key]);

export function versionComparisonMediaIdentity(url: URL): Identity | null {
  if (url.pathname !== route || url.hash || url.username || url.password || url.href.length > 2048) return null;
  const keys = [...url.searchParams.keys()];
  if (url.search.slice(1).split('&').length !== fields.length || /%(?![0-9a-f]{2})/iu.test(url.search) ||
      keys.length !== fields.length || new Set(keys).size !== fields.length || keys.some(key => !(fields as readonly string[]).includes(key))) return null;
  const input = Object.fromEntries(url.searchParams);
  if (fields.slice(0, 4).some(key => input[key].length !== 36 || !uuid.test(input[key])) ||
      input.sha256.length !== 64 || !digest.test(input.sha256) || input.workspaceOrigin !== 'normal') return null;
  return Object.freeze(input) as Identity;
}

/** The graph validates SQL/JSON ownership, reverse owners and snapshot links.
 * The digest is recorded provenance, not a claim that file bytes were hashed.
 * Caller authentication and the live ordinary-workspace gate belong to HTTP.
 * This first slice accepts only the existing job publisher's managed MP4 path,
 * not arbitrary legacy paths, imports, export outputs or restored versions.
 */
export function readVersionComparisonMedia(db: DatabaseSync, url: URL, readGraph: GraphReader): VersionComparisonMedia | null {
  const input = versionComparisonMediaIdentity(url);
  if (!input) return null;
  const outer = db.isTransaction;
  try {
    if (!outer) db.exec('BEGIN DEFERRED');
    const graph = readGraph(input.projectId);
    const version = graph.version(input.versionId, input.shotId, input.assetId), asset = graph.asset(input.assetId);
    if (!object(version) || !object(asset) || typeof version.jobId !== 'string' || !uuid.test(version.jobId) || version.id !== input.versionId ||
        version.projectId !== input.projectId || version.shotId !== input.shotId || version.assetId !== input.assetId || asset.id !== input.assetId || asset.projectId !== input.projectId ||
        version.sha256 !== input.sha256 || asset.sha256 !== input.sha256 || asset.mimeType !== 'video/mp4' ||
        typeof asset.sizeBytes !== 'number' || !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes < 1 ||
        (asset.provenance !== 'generated' && asset.provenance !== 'synthetic-mock') || asset.relativePath !== `media/result-${version.jobId}.mp4`) return null;
    const identityDigest = createHash('sha256').update(JSON.stringify([version, asset])).digest('hex');
    return Object.freeze({...input, jobId: version.jobId, relativePath: asset.relativePath, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, identityDigest});
  } catch { return null; }
  finally { if (!outer && db.isTransaction) db.exec('ROLLBACK'); }
}

/** Called only after the existing Host/Origin/session envelope. This adds no
 * restored/held-record permission or native audio admission. Trusted I/O seams
 * are only for deterministic tests, never HTTP or environment configuration.
 */
export function createVersionComparisonMediaHttp({db, root, signal, readGraph, assertAvailable, validateFile, createFiles, openFile = open, resolvePath}: VersionComparisonMediaOptions) {
  // Keep each bounded transfer's exact graph fence across async open/fstat.
  // This also fences 416 responses, which do not ask the file helper for headers.
  const responseFence = new AsyncLocalStorage<() => void>();
  const checkResponse = (): void => {
    const fence = responseFence.getStore();
    if (!fence) throw unavailable();
    fence();
  };
  const managed = (file: string): Stats => {
    try { return validateFile(file); } catch { throw unavailable(); }
  };
  const available = () => {
    assertAvailable();
    if (signal?.aborted) throw unavailable();
  };
  const files = createFiles({signal, openFile: async (file, flags) => {
    let handle: ReadHandle | undefined;
    try {
      available();
      const before = managed(file);
      handle = await openFile(file, flags | constants.O_NOFOLLOW);
      const openedHandle = handle;
      const opened = await openedHandle.stat();
      available();
      if (!sameFile(before, opened) || !sameFile(opened, managed(file))) throw unavailable();
      checkResponse();
      return {
        stat: async () => {
          const current = await openedHandle.stat();
          available();
          if (!sameFile(opened, current) || !sameFile(current, managed(file))) throw unavailable();
          checkResponse();
          return current;
        },
        createReadStream: options => openedHandle.createReadStream(options),
        close: () => openedHandle.close(),
      };
    } catch {
      await handle?.close();
      throw unavailable();
    }
  }});
  const handle = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== route) return false;
    available();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      throw Object.assign(Error('请使用 GET 或 HEAD'), {code: 'METHOD_NOT_ALLOWED', status: 405});
    }
    if (Buffer.byteLength(req.url ?? '') > 2048 || req.headers['transfer-encoding'] ||
        req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') throw unavailable();
    const descriptor = readVersionComparisonMedia(db, url, readGraph);
    if (!descriptor) throw unavailable();
    const revalidate = () => {
      available();
      const current = readVersionComparisonMedia(db, url, readGraph);
      if (!current || (Object.keys(descriptor) as (keyof VersionComparisonMedia)[]).some(key => descriptor[key] !== current[key])) throw unavailable();
    };
    const requestedFile = path.join(root, descriptor.relativePath), before = managed(requestedFile);
    if (before.size !== descriptor.sizeBytes) throw unavailable();
    let file;
    try { file = await resolvePath(root, descriptor.relativePath); } catch { throw unavailable(); }
    revalidate();
    if (file !== requestedFile || !sameFile(before, managed(file))) throw unavailable();
    await responseFence.run(revalidate, () => files.send(req, res, {file, ranges: true, headers: () => {
      revalidate();
      if (!sameFile(before, managed(file))) throw unavailable();
      return {'Content-Type': descriptor.mimeType, 'Content-Disposition': 'inline', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store'};
    }}));
    return true;
  };
  return Object.freeze({handle, close: files.close});
}
