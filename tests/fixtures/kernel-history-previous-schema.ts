import {readFileSync} from 'node:fs';
import type {DatabaseSync} from 'node:sqlite';

export type PreviousHistoryVersion = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 11;

/** Builds only a historical history database inside the caller's transaction.
 * Versions 2–4 were captured from main 9f5fd08b; version 5 from main 54bdda3a, version 6 from main 4fd0a188, version 7 from S2 main c8c27fd5, and version 8 from V5 main 5ee21d2d084eaba387eb8e1be84c462c18d03dd4; version 9 from S8 main 91611b9aa2d266eb1d0ccc290fe62f57dd62a270.
 * Version 11 is the format 4 candidate catalog from cd1473b4. Every profile
 * was checked object by object against its upgrade manifest.
 * It deliberately imports neither the old
 * workspace reader nor current domain constructors: both will change while
 * these on-disk upgrade inputs must stay fixed. Automatic indexes and
 * sqlite_sequence are recreated by SQLite, rather than copied as fake rows. */
export function buildPreviousHistoryDatabase(db: DatabaseSync, version: PreviousHistoryVersion): void {
  if (!db.isTransaction) throw new TypeError('Building a previous history requires an open transaction');
  db.exec(readFileSync(new URL(`./kernel-history-previous-schema/v${version}.sql`, import.meta.url), 'utf8'));
}
