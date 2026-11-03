import type {DatabaseSync} from 'node:sqlite';

/** Shared read/write surface of an opened store. JSON crosses this boundary
 * as unknown; each domain validates its own records. This module contains
 * types only and never opens or initializes either storage layout. */
export interface Store {
  readonly db: DatabaseSync;
  readonly root: string;
  get(table: string, id: string): unknown;
  list(table: string, projectId?: string): unknown[];
  put<T extends object>(table: string, value: T): T;
  tx<T>(callback: () => T): T;
  close(): void;
}

/** Minimum shape accepted by ownership queries. These fields alone are not
 * proof: the backend verifies the exact live store/connection separately. */
export interface StoreIdentity {
  readonly db: DatabaseSync;
  readonly root?: string;
}
