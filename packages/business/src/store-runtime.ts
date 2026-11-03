import type {DatabaseSync} from 'node:sqlite';
import type {StoreIdentity} from './store-contract.ts';
import {isProjectDatabase} from './project-file/held-files.ts';
import type {ProjectStore} from './project-file/store.ts';
import {isProjectStore,registerProjectTransactionFence,registerProjectTransactionObserver} from './project-file/store.ts';

/** Only the exact live kernel capability owns a project. Public fields,
 * an attached schema or a copied store never manufacture ownership. */
export function ownsStoreLock(store: StoreIdentity | null | undefined): boolean {
  return isProjectStore(store);
}

/** Reject copied, closed or foreign stores before any project effect. */
export function assertProjectStore(value: unknown): asserts value is ProjectStore {
  if (!isProjectStore(value)) throw Object.assign(new TypeError('Project store identity is not verified'), {code: 'PROJECT_STORE_UNVERIFIED'});
}

export function assertProjectDatabase(db: unknown): void {
  if (!isProjectDatabase(db)) throw Object.assign(new TypeError('Transaction hooks require a live project connection'), {code:'PROJECT_STORE_UNVERIFIED'});
}

/** The original kernel hook tables remain authoritative. No legacy fallback
 * or second registration table is created by this current-store boundary. */
export function registerStoreTransactionFence(db: DatabaseSync, fence: () => void): () => void {
  assertProjectDatabase(db);
  return registerProjectTransactionFence(db, fence);
}

export function registerStoreTransactionObserver(db: DatabaseSync, observer: (result: unknown) => void): () => void {
  assertProjectDatabase(db);
  return registerProjectTransactionObserver(db, observer);
}
