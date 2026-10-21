import {createHash} from 'node:crypto';
import path from 'node:path';
import {privateStorageIdentity} from './private-storage.ts';

/** Minimal identity supplied by the caller's validated filesystem boundary. */
export interface WorkspaceStatIdentity {
  dev:number|bigint;
  ino:number|bigint;
  birthtimeMs?:number;
}
export interface WorkspaceScopeInput {
  channel:'web'|'production'|'development';
  root:string;
  directory:WorkspaceStatIdentity;
  db:WorkspaceStatIdentity;
}

/** Node-only fingerprint, byte-compatible with existing companion sidecars.
 * This does not read the filesystem or validate ownership, paths or symlinks.
 * Callers must retain those checks and pass their canonical, absolute root.
 * Do not change field order, string conversion or the absent-birthtime sentinel.
 */
export function calculateWorkspaceScope({channel,root,directory,db}:WorkspaceScopeInput):string{
  if(process.platform==='win32')return createHash('sha256').update(JSON.stringify(['windows-file-id-v1',channel,path.resolve(root),privateStorageIdentity(directory),privateStorageIdentity(db),db.birthtimeMs??null])).digest('hex');
  return createHash('sha256').update(JSON.stringify([channel,path.resolve(root),String(directory.dev),String(directory.ino),String(db.dev),String(db.ino),db.birthtimeMs??null])).digest('hex');
}
