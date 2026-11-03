import {readFileSync} from 'node:fs';
import type {DatabaseSync} from 'node:sqlite';

export type PreviousHistoryVersion = 2 | 3 | 4 | 5;

/** Builds only a historical history database inside the caller's transaction.
 * Versions 2–4 were captured from main 9f5fd08b; version 5 from main 54bdda3a.
 * Every profile was checked object by object against its upgrade manifest.
 * It deliberately imports neither the old
 * workspace reader nor current domain constructors: both will change while
 * these on-disk upgrade inputs must stay fixed. Automatic indexes and
 * sqlite_sequence are recreated by SQLite, rather than copied as fake rows. */
export function buildPreviousHistoryDatabase(db: DatabaseSync, version: PreviousHistoryVersion): void {
  if (!db.isTransaction) throw new TypeError('Building a previous history requires an open transaction');
  db.exec(readFileSync(new URL(`./kernel-history-previous-schema/v${version}.sql`, import.meta.url), 'utf8'));
}
