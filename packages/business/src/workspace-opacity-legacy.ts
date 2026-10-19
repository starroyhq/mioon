/** Fixed application-owned legacy constructor leaf for the dormant42 profile.
 * No public DTO can select constructors or validators. Loading db installs its
 * existing fixed validator dependencies; it does not open a workspace. */
import {createRequire} from 'node:module';
import type {DatabaseSync} from 'node:sqlite';
import {initializeWorkspaceSchema26} from './workspace-schema-v26.ts';
import {initializeWorkspaceSchema28} from './workspace-schema-v28.ts';
import {initializeWorkspaceSchema30} from './workspace-schema-v30.ts';
import {initializeWorkspaceSchema32} from './workspace-schema-v32.ts';
import {initializeWorkspaceSchema34} from './workspace-schema-v34.ts';
import {initializeWorkspaceSchema36} from './workspace-schema-v36.ts';
import {initializeWorkspaceSchema38} from './workspace-schema-v38.ts';
import {initializeWorkspaceSchema40} from './workspace-schema-v40.ts';

const require = createRequire(import.meta.url);
function invalid(): never {throw Object.assign(new Error('Fixed opacity workspace dependencies are unavailable.'), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});}
function initializeThrough24(db: DatabaseSync): void {
  const assembled: unknown = require('./db.ts');
  const legacy: unknown = require('./workspace-fixed-schema.ts');
  if (!assembled || typeof assembled !== 'object' || !legacy || typeof legacy !== 'object') invalid();
  const constructor: unknown = Reflect.get(legacy, 'initializeWorkspaceSchemaThrough24');
  if (typeof constructor !== 'function') invalid();
  Reflect.apply(constructor, undefined, [db]);
}

/** Only new empty reference/candidate databases may call this constructor. The
 *42 initializer proves emptiness before invoking it; no existing40 is upgraded. */
export function initializeOpacityLegacyThrough40(db: DatabaseSync): void {
  if (db.isTransaction || db.prepare('SELECT 1 FROM main.sqlite_schema LIMIT 1').get() || db.prepare('SELECT 1 FROM temp.sqlite_schema LIMIT 1').get()) invalid();
  initializeThrough24(db);
  for (const initialize of [initializeWorkspaceSchema26, initializeWorkspaceSchema28, initializeWorkspaceSchema30,
    initializeWorkspaceSchema32, initializeWorkspaceSchema34, initializeWorkspaceSchema36, initializeWorkspaceSchema38,
    initializeWorkspaceSchema40]) initialize(db);
}
