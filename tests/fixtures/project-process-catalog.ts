import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SCHEMA_MANIFEST} from '../../packages/business/src/project-file/schema/manifest.ts';
import {CONVERTED_TEMP_TRIGGERS} from '../../packages/business/src/project-file/cross-file/converted-triggers.ts';

interface ObjectRow {type:string;name:string;tbl_name:string;sql:string|null}
const taskObject=(name:string)=>!name.startsWith('project_file_')&&/(?:^|_)agent_(?:task|target)_/u.test(name);
const digest=(sql:string|null)=>createHash('sha256').update(sql??'').digest('hex');
const sort=<T extends {type:string;name:string}>(values:T[])=>values.sort((a,b)=>a.type.localeCompare(b.type)||a.name.localeCompare(b.name));
const manifests=Object.values(SCHEMA_MANIFEST).flatMap(value=>[...value.entries]);
const expected=sort([...manifests.filter(entry=>taskObject(entry.name)),...CONVERTED_TEMP_TRIGGERS.filter(entry=>taskObject(entry.name)).map(entry=>({
  type:'trigger',name:entry.name,tbl_name:entry.table,sha256:digest(entry.sql.replace('CREATE TEMP TRIGGER ','CREATE TRIGGER ')),
}))]);
const knownTables=new Set(manifests.filter(entry=>entry.type==='table').map(entry=>entry.name));

/** The same independently derived, pinned manifests the kernel validates.
 * Preserve the exact task/target SQL oracle across its project/history/TEMP
 * split, and keep every other object/row in the caller's crash snapshot. */
export function assertProjectProcessCatalog(state:{schema:readonly ObjectRow[];tables:Readonly<Record<string,unknown>>}):void {
  const actual=sort(state.schema.filter(entry=>taskObject(entry.name)).map(({type,name,tbl_name,sql})=>({type,name,tbl_name,sha256:digest(sql)})));
  assert.deepEqual(actual,expected,'exact project/history/TEMP task and target SQL');
  assert.equal(actual.length,expected.length,'no task or target object may be silently lost');
  assert.equal(digest(JSON.stringify(actual)),digest(JSON.stringify(expected)),'pinned kernel task catalog digest');
  assert.deepEqual(actual.map(entry=>entry.name),expected.map(entry=>entry.name),'unknown task/target objects fail closed');
  for(const name of Object.keys(state.tables))assert.ok(knownTables.has(name),'only tables in the pinned three-database manifest enter the crash oracle');
}
