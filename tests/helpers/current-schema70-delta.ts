import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {DatabaseSync} from 'node:sqlite';
import {validateWorkspaceTransformRows} from '../../packages/business/src/workspace-transform-validation.ts';
interface SchemaObject {readonly type:string;readonly name:string;readonly tbl_name:string;readonly sql:string|null}
interface CurrentOrdinary70Delta {
 readonly schemaVersionRows:readonly (readonly string[])[];readonly objects:readonly SchemaObject[];
 readonly tables:Readonly<Record<string,{fields:readonly string[];rows:0}>>;readonly catalog:{count:number;sha256:string};
}
/** Independently reviewed clip transform schema70: a marker-only layer, as
 * schema40 was for volume envelopes. It adds no schema object; persisted clip
 * transforms are admitted by role from this marker on. Frozen in
 * tests/fixtures/workspace-schema-profiles/current-ordinary-70-delta.json. */
export const currentOrdinary70Delta:CurrentOrdinary70Delta=JSON.parse(readFileSync(
 new URL('../fixtures/workspace-schema-profiles/current-ordinary-70-delta.json',import.meta.url),'utf8'));
assert.equal(currentOrdinary70Delta.objects.length,0,'schema70 adds no schema object');
/** A70 catalog is its reviewed68 predecessor unchanged. */
export function withoutReviewedTransformObjects<T extends SchemaObject>(objects:readonly T[]):T[] {return [...objects];}
export function withReviewedTransformObjects(objects:readonly SchemaObject[]):SchemaObject[] {return [...objects];}
/** A test-only downgrade needs genuine68 evidence: no persisted transform and
 * no transform receipt anywhere. Newer layers go first; use
 * downgradeReviewedWorkspace from reviewed-schema-layers.ts. */
export function removeReviewedSchema70(db:DatabaseSync):void {
 if(!db.prepare('SELECT 1 FROM schema_version WHERE version=70').get())return;
 assert.equal(db.prepare('SELECT 1 FROM schema_version WHERE version>70').get(),undefined,'newer reviewed layers are removed first');
 assert.doesNotThrow(()=>validateWorkspaceTransformRows(db,{allowTransforms:false}),'clip transforms cannot be disguised as historical68');
 db.exec('DELETE FROM schema_version WHERE version=70');
}
