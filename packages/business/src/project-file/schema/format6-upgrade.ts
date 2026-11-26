import type {DatabaseSync} from 'node:sqlite';
import {FORMAT5_PROJECT_SCHEMA_VERSION, FORMAT6_PROJECT_SCHEMA_VERSION} from './databases.ts';
import {projectManifestForVersion} from './format-manifests.ts';
import {compareManifest, readSchemaManifest} from './manifest-check.ts';
import {assertFormat5ProjectContent} from '../format5-content.ts';
import {projectFileError} from '../errors.ts';

/** Format 6 extends native clip JSON. The exact format-5 tables and every
 * existing content row stay intact, and absent timing stays implicit. */
export function upgradeProject5To6Inside(db: DatabaseSync, schema: 'project' | 'main',
  onBoundary?: (phase: 'before-version-write' | 'after-version-write') => void): void {
  if (!db.isTransaction) throw new TypeError('Format 6 upgrade needs a project transaction');
  const from = projectManifestForVersion(FORMAT5_PROJECT_SCHEMA_VERSION)!;
  const versions = db.prepare(`SELECT version FROM ${schema}.schema_version LIMIT 2`).all();
  const version = db.prepare(`PRAGMA ${schema}.user_version`).get()?.user_version;
  if (version !== from.version || versions.length !== 1 || versions[0]?.version !== from.version) {
    throw projectFileError('PROJECT_INVALID', {database: 'project', reason: 'schema-version'});
  }
  const difference = compareManifest(readSchemaManifest(db, schema), from.entries);
  if (difference.changed.length || difference.missing.length || difference.unexpected.length) {
    throw projectFileError('PROJECT_INVALID', {database: 'project', reason: 'schema'});
  }
  assertFormat5ProjectContent(db, schema);
  onBoundary?.('before-version-write');
  db.prepare(`UPDATE ${schema}.schema_version SET version=?`).run(FORMAT6_PROJECT_SCHEMA_VERSION);
  db.exec(`PRAGMA ${schema}.user_version=${FORMAT6_PROJECT_SCHEMA_VERSION}`);
  onBoundary?.('after-version-write');
}
