import type {DatabaseSync} from 'node:sqlite';
import {isProjectStore} from '../project-file/store.ts';
import type {ProjectStore} from '../project-file/store.ts';

type CapturePort = () => () => void;
const ports = new WeakMap<DatabaseSync, CapturePort>();

/** Only the host's exact store installs this backend capability. Raw domain
 * transactions can join capture without exposing an origin in public input. */
export function registerProjectVersionCapturePort(store: ProjectStore, port: CapturePort): () => void {
  if (!isProjectStore(store) || ports.has(store.db)) throw new TypeError('Version capture requires one live store owner');
  ports.set(store.db, port);
  return () => {if (ports.get(store.db) === port) ports.delete(store.db);};
}

/** The LUT importer owns BEGIN IMMEDIATE itself. The returned closure runs
 * before its task receipt and COMMIT. Legacy callers have no installed port. */
export function beginProjectVersionCaptureInside(db: DatabaseSync): () => void {
  const port = ports.get(db);
  if (!port) return () => {};
  if (!db.isTransaction) throw new TypeError('Version capture requires an open transaction');
  return port();
}
