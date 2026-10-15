import test from 'node:test';
import assert from 'node:assert/strict';
import '../packages/business/src/db.mjs';
import {requireWorkspaceEnvelopeRuntime,installWorkspaceEnvelopeRuntime} from '../packages/business/src/workspace-envelope-runtime.ts';
import {isTimelineRecord} from '../packages/contracts/src/timeline-replacement.mjs';
import {isTimelineRenderRecord,TIMELINE_RENDER_RESPONSE_BYTES} from '../packages/contracts/src/timeline-acknowledgement.mjs';
import {schemas} from '../packages/contracts/src/index.mjs';
test('actual database startup supplies exact production timeline and receipt predicates',()=>{
 const runtime=requireWorkspaceEnvelopeRuntime();
 assert.equal(runtime.isTimelineRecord,isTimelineRecord);
 assert.equal(runtime.isTimelineRenderRecord,isTimelineRenderRecord);
 assert.equal(runtime.timelineRenderResponseBytes,TIMELINE_RENDER_RESPONSE_BYTES);
 assert.equal(Object.isFrozen(runtime),true);
 assert.equal(runtime.isTimelineRecord({}),false);
 assert.equal(runtime.isTimelineRenderRecord({},{}),false);
 for(const operation of ['timeline.clip.add','timeline.clip.update']){
  for(const input of [{},null,{projectId:'invalid',patch:{volumeEnvelope:null}}]){
   assert.equal(runtime.validateClipIntent(operation,input),schemas[operation].safeParse(input).success);
   assert.equal(runtime.validateClipIntent(operation,input),false);
  }
 }
 assert.throws(()=>installWorkspaceEnvelopeRuntime(runtime),{code:'WORKSPACE_VOLUME_ENVELOPE_RUNTIME_UNAVAILABLE'});
 assert.equal(requireWorkspaceEnvelopeRuntime(),runtime);
});

test('actual startup capability validates the complete catalog, not only markers',async t=>{
 const {DatabaseSync}=await import('node:sqlite');
 const {mkdtempSync,rmSync}=await import('node:fs');
 const {openStore}=await import('../packages/business/src/db.mjs');
 const {readTimelineVolumeEnvelopeCapability}=await import('../packages/business/src/timeline-volume-envelope-capability.ts');
 const fake=new DatabaseSync(':memory:');t.after(()=>fake.close());
 fake.exec('CREATE TABLE schema_version(version INTEGER PRIMARY KEY)');
 for(const version of [...Array.from({length:24},(_,i)=>i+1),26,28,30,32,34,36,38,40])fake.prepare('INSERT INTO schema_version VALUES(?)').run(version);
 assert.equal(readTimelineVolumeEnvelopeCapability(fake).editable,false);
 const root=mkdtempSync(new URL('../.tmp-envelope-boundary-',import.meta.url).pathname);
 const store=openStore(root);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 assert.equal(readTimelineVolumeEnvelopeCapability(store.db).editable,true);
 store.db.exec('CREATE TABLE unexpected_catalog_object(value TEXT)');
 assert.equal(readTimelineVolumeEnvelopeCapability(store.db).editable,false);
});
