import {readFileSync} from 'node:fs';
import type {DatabaseSync} from 'node:sqlite';

export type PreviousHistoryVersion = 2 | 3 | 4;

/** Builds only a historical history database inside the caller's transaction.
 * The SQL was captured from main 9f5fd08b and checked object by object against
 * the existing upgrade manifests. It deliberately imports neither the old
 * workspace reader nor current domain constructors: both will change while
 * these on-disk upgrade inputs must stay fixed. Automatic indexes and
 * sqlite_sequence are recreated by SQLite, rather than copied as fake rows. */
export function buildPreviousHistoryDatabase(db: DatabaseSync, version: PreviousHistoryVersion): void {
  if (!db.isTransaction) throw new TypeError('Building a previous history requires an open transaction');
  db.exec(readFileSync(new URL(`./kernel-history-previous-schema/v${version}.sql`, import.meta.url), 'utf8'));
}
