import {assertProjectStore} from './store-runtime.ts';
import type {ProjectStore} from './project-file/store.ts';
import type {OutsidePathConfirmationStore} from './app-db/stores.ts';
import {createReferencedAssetImportHandler} from './referenced-asset-import.ts';

export type ManagedAssetImportStore = ProjectStore;
export interface ManagedAssetImportOptions {
  outsidePaths: OutsidePathConfirmationStore;
  signal?: AbortSignal;
  required(table: 'projects', id: string): unknown;
  now(): string;
  /** Current application admission is rechecked at every asynchronous effect. */
  beforeEffect(): void;
}
/** Both uploads and trusted local paths publish through the same referenced
 * import receipt. A copied or closed store cannot construct another writer. */
export function createManagedAssetImportHandler(store: ManagedAssetImportStore, options: ManagedAssetImportOptions) {
  assertProjectStore(store);
  return createReferencedAssetImportHandler(store, options);
}
