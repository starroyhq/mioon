import {createRequire} from 'node:module';
import type {DatabaseSync} from 'node:sqlite';

const require = createRequire(import.meta.url);
/** Fixed source constructor for trusted in-memory profile references only.
 * Reading a profile never opens a data directory or selects imported SQL. */
export function initializeRippleLegacyThrough24(db: DatabaseSync): void {
  const assembled: unknown = require('./db.ts');
  const legacy: unknown = require('./workspace-fixed-schema.ts');
  if (!assembled || typeof assembled !== 'object' || !legacy || typeof legacy !== 'object')
    throw Object.assign(new Error('Ripple schema dependencies are unavailable.'), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});
  const constructor: unknown = Reflect.get(legacy, 'initializeWorkspaceSchemaThrough24');
  if (typeof constructor !== 'function')
    throw Object.assign(new Error('Ripple source constructor is unavailable.'), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});
  Reflect.apply(constructor, undefined, [db]);
}
