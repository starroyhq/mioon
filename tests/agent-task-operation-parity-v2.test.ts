import test from 'node:test';
import assert from 'node:assert/strict';
import {schemas} from '../packages/contracts/src/index.ts';
import {publicOperationSchemas} from '../packages/contracts/src/public-operations.ts';
import {canvasEditingSchemas} from '../packages/contracts/src/canvas-editing.ts';
import {generationImageServiceSchemas} from '../packages/contracts/src/generation-image-services.ts';
import {trustedAssetMediaSchemas} from '../packages/contracts/src/asset-media.ts';
import {listAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {MIO_USER_ONLY_OPERATIONS,MIO_DEFERRED_OPERATIONS,MIO_WRAPPED_OPERATIONS} from '../packages/business/src/agent/task-operation-parity-v2.ts';
import {MCP_USER_ONLY_OPERATIONS,isMcpOperationAllowed} from '../apps/mcp/src/tool-policy.ts';

const registries:readonly Readonly<Record<string,unknown>>[]=[schemas,publicOperationSchemas,canvasEditingSchemas,generationImageServiceSchemas,trustedAssetMediaSchemas];
const backend=new Set(registries.flatMap(registry=>Object.keys(registry)));
/** Format-5-only tools are real Mio tools inside format-5 projects, so the
 * backend audit evaluates the union of the native/format-4 and format-5
 * catalogs instead of treating a shared operation as uncovered. */
const mioToolOperations=():Set<string>=>new Set([...listAgentTaskTools(true),...listAgentTaskTools(false,true)]
  .map(tool=>tool.operation));
function classify(operations:ReadonlySet<string>):string[]{
 const tools=mioToolOperations();
 return [...operations].filter(operation=>!tools.has(operation)&&!Object.hasOwn(MIO_USER_ONLY_OPERATIONS,operation)&&!Object.hasOwn(MIO_DEFERRED_OPERATIONS,operation)&&!Object.hasOwn(MIO_WRAPPED_OPERATIONS,operation)).sort();
}
test('every backend operation has a real Mio tool or an explicit reviewed exception',()=>{
 assert.deepEqual(classify(backend),[]);
 assert.deepEqual(classify(new Set([...backend,'future.unclassified.operation'])),['future.unclassified.operation']);
 const tools=mioToolOperations(),exceptions=[MIO_USER_ONLY_OPERATIONS,MIO_DEFERRED_OPERATIONS,MIO_WRAPPED_OPERATIONS];
 const names=exceptions.flatMap(table=>Object.keys(table));assert.equal(new Set(names).size,names.length,'exceptions cannot overlap');
 for(const table of exceptions)for(const operation of Object.keys(table))assert.ok(backend.has(operation),`stale exception: ${operation}`);
 for(const [operation,reason] of Object.entries({...MIO_USER_ONLY_OPERATIONS,...MIO_DEFERRED_OPERATIONS})){assert.ok(reason.length>10,operation);assert.equal(tools.has(operation),false,operation);}
 for(const [operation,wrapper] of Object.entries(MIO_WRAPPED_OPERATIONS))for(const tool of wrapper.tools)assert.ok(tools.has(tool),`${operation} wrapper ${tool} exists`);
});
test('MP requested operations are exposed and user-only exceptions cannot become model tools',()=>{
 const tools=mioToolOperations();
 for(const operation of ['canvas.copy.snapshot','scene.cuts.save','scene.shots.undo','scene.task.cancel','subject.variants.list','subject.variants.get','subject.variants.retry','subject.variants.undo','previs.thumbnail.get','previs.thumbnail.set','project.version.save','project.version.list','project.version.preview','frame.task.cancelQueued','image.task.cancelQueued','task.disposition.archiveCompleted','asset.import','asset.media.status.list','asset.media.location.list','image.service.list','image.review.list','image.review.get'])assert.ok(tools.has(operation),operation);
 for(const operation of MCP_USER_ONLY_OPERATIONS){assert.equal(tools.has(operation),false,operation);assert.equal(isMcpOperationAllowed(operation),false,operation);}
 for(const operation of ['canvas.copy.snapshot','asset.media.location.list','image.service.list']){assert.ok(Object.hasOwn(publicOperationSchemas,operation),operation);assert.equal(isMcpOperationAllowed(operation),true,operation);}
 for(const tool of listAgentTaskTools(true))assert.doesNotMatch(tool.operation,/credential|secret|apiKey/u);
});
