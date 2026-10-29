import assert from 'node:assert/strict';
import type {DatabaseSync} from 'node:sqlite';
import {currentOrdinary54Delta,withoutReviewedConversationObjects,removeReviewedSchema54} from './current-schema54-delta.ts';
import {currentOrdinary56Delta,withoutReviewedInteractionObjects,removeReviewedSchema56} from './current-schema56-delta.ts';
import {currentOrdinary58Delta,withoutReviewedSceneObjects,removeReviewedSchema58} from './current-schema58-delta.ts';
import {currentOrdinary60Delta,withoutReviewedStorageObjects,withReviewedStorageObjects,removeReviewedSchema60} from './current-schema60-delta.ts';
import {currentOrdinary62Delta,withoutReviewedSubjectVariantObjects,withReviewedSubjectVariantObjects,removeReviewedSchema62} from './current-schema62-delta.ts';
import {currentOrdinary64Delta,withoutReviewedPrevisObjects,removeReviewedSchema64} from './current-schema64-delta.ts';
import {currentOrdinary66Delta,withoutReviewedPolicyAnswerObjects,removeReviewedSchema66} from './current-schema66-delta.ts';
import {currentOrdinary68Delta,withoutReviewedKeyframeEditObjects,withReviewedKeyframeEditObjects,removeReviewedSchema68} from './current-schema68-delta.ts';
import {currentOrdinary70Delta,withoutReviewedTransformObjects,withReviewedTransformObjects,removeReviewedSchema70} from './current-schema70-delta.ts';
import {CURRENT_ORDINARY_SCHEMA} from './workspace-schema-current.ts';

interface SchemaObject {readonly type:string;readonly name:string;readonly tbl_name:string;readonly sql:string|null}
interface ReviewedTable {readonly fields:readonly string[];readonly rows:0}
interface ReviewedLayer {
  readonly version:number;
  /** The layer's own schema_version rows: [version, SQLite type, hex of the text]. */
  readonly schemaVersionRows:readonly (readonly string[])[];
  /** Tables the layer adds; a fresh or upgraded ordinary workspace has them empty. */
  readonly tables:Readonly<Record<string,ReviewedTable>>;
  /** The catalog without this layer's reviewed objects; each object is checked first. */
  readonly without:<T extends SchemaObject>(objects:readonly T[])=>T[];
  /** The predecessor catalog with this layer's reviewed objects, sorted by type and name. */
  readonly with:(objects:readonly SchemaObject[])=>SchemaObject[];
  /** Predecessor objects that `without` reconstructs because the layer replaced or removed them. */
  readonly restores:readonly string[];
  /** Turns a workspace that carries this layer into its predecessor, given
   * genuine predecessor evidence; a no-op when the layer is absent. */
  readonly remove:(db:DatabaseSync)=>void;
}
// Independently reviewed additive layers since the frozen ordinary52 catalog,
// newest first. A new schema version adds one row here and its own
// current-schemaNN-delta.ts; tests ask for a version, not for a chain.
const order=(a:SchemaObject,b:SchemaObject):number=>a.type<b.type?-1:a.type>b.type?1:a.name<b.name?-1:a.name>b.name?1:0;
const adding=(added:readonly SchemaObject[])=>(objects:readonly SchemaObject[]):SchemaObject[]=>{
  assert.equal(objects.some(object=>added.some(value=>value.name===object.name)),false,'the predecessor has none of the added objects');
  return [...objects,...added].sort(order);
};
const LAYERS:readonly ReviewedLayer[]=Object.freeze([
  {version:70,schemaVersionRows:currentOrdinary70Delta.schemaVersionRows,tables:currentOrdinary70Delta.tables,without:withoutReviewedTransformObjects,with:withReviewedTransformObjects,restores:[],remove:removeReviewedSchema70},
  {version:68,schemaVersionRows:currentOrdinary68Delta.schemaVersionRows,tables:currentOrdinary68Delta.tables,without:withoutReviewedKeyframeEditObjects,with:withReviewedKeyframeEditObjects,restores:currentOrdinary68Delta.replaced.map(object=>object.name),remove:removeReviewedSchema68},
  {version:66,schemaVersionRows:currentOrdinary66Delta.schemaVersionRows,tables:currentOrdinary66Delta.tables,without:withoutReviewedPolicyAnswerObjects,with:adding(currentOrdinary66Delta.objects),restores:[],remove:removeReviewedSchema66},
  {version:64,schemaVersionRows:currentOrdinary64Delta.schemaVersionRows,tables:currentOrdinary64Delta.tables,without:withoutReviewedPrevisObjects,with:adding(currentOrdinary64Delta.objects),restores:[],remove:removeReviewedSchema64},
  {version:62,schemaVersionRows:currentOrdinary62Delta.schemaVersionRows,tables:currentOrdinary62Delta.tables,without:withoutReviewedSubjectVariantObjects,with:withReviewedSubjectVariantObjects,restores:[...currentOrdinary62Delta.removed,...currentOrdinary62Delta.replaced].map(object=>object.name),remove:removeReviewedSchema62},
  {version:60,schemaVersionRows:currentOrdinary60Delta.schemaVersionRows,tables:{},without:withoutReviewedStorageObjects,with:withReviewedStorageObjects,restores:currentOrdinary60Delta.quotaObjects.map(object=>object.name),remove:removeReviewedSchema60},
  {version:58,schemaVersionRows:currentOrdinary58Delta.schemaVersionRows,tables:currentOrdinary58Delta.tables,without:withoutReviewedSceneObjects,with:adding(currentOrdinary58Delta.objects),restores:[],remove:removeReviewedSchema58},
  {version:56,schemaVersionRows:currentOrdinary56Delta.schemaVersionRows,tables:{},without:withoutReviewedInteractionObjects,with:adding(currentOrdinary56Delta.objects),restores:[],remove:removeReviewedSchema56},
  {version:54,schemaVersionRows:currentOrdinary54Delta.schemaVersionRows,tables:{},without:withoutReviewedConversationObjects,with:adding(currentOrdinary54Delta.objects),restores:[],remove:removeReviewedSchema54},
]);
assert.equal(LAYERS[0]!.version,CURRENT_ORDINARY_SCHEMA,'the newest reviewed layer is the current schema');
const above=(version:number):readonly ReviewedLayer[]=>{
  assert.ok(Number.isInteger(version)&&version>=52&&version<=CURRENT_ORDINARY_SCHEMA,`no reviewed layers relate schema${version} to the current schema`);
  return LAYERS.filter(layer=>layer.version>version);
};

/** A current catalog as the reviewed catalog of `version`: every newer layer's
 * objects are checked and removed, replaced ones restored. Catalogs that never
 * had a newer layer pass through that layer unchanged. */
export function reviewedCatalogAt<T extends SchemaObject>(version:number,objects:readonly T[]):T[] {
  return above(version).reduce<T[]>((current,layer)=>layer.without(current),[...objects]);
}
/** The reviewed catalog of `version` brought forward to the current one:
 * every newer layer's objects are added, replaced ones swapped, oldest first. */
export function reviewedCatalogFrom(version:number,objects:readonly SchemaObject[]):SchemaObject[] {
  return [...above(version)].reverse().reduce<SchemaObject[]>((current,layer)=>layer.with(current),[...objects].sort(order));
}
/** Names of objects that reviewedCatalogAt(version) reconstructs rather than passes through. */
export function reviewedRestoredNamesAfter(version:number):Set<string> {
  return new Set(above(version).flatMap(layer=>layer.restores));
}
/** schema_version rows the layers newer than `version` add, oldest first. */
export function reviewedSchemaVersionRowsAfter(version:number):(readonly string[])[] {
  return [...above(version)].reverse().flatMap(layer=>layer.schemaVersionRows);
}
/** Tables the layers newer than `version` add, oldest first. */
export function reviewedTablesAfter(version:number):[string,ReviewedTable][] {
  return [...above(version)].reverse().flatMap(layer=>Object.entries(layer.tables));
}
/** Test-only downgrade of a fresh current workspace to a genuine historical
 * ordinary `version`, newest layer first. Each layer requires its own genuine
 * predecessor evidence and never rewrites retained rows. */
export function downgradeReviewedWorkspace(db:DatabaseSync,version:number):void {
  for(const layer of above(version))layer.remove(db);
}
