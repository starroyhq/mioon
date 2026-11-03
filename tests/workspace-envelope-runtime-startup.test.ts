import test from 'node:test';
import assert from 'node:assert/strict';
import {timelineRetainedRuntime as runtime} from '../packages/business/src/timeline-retained-runtime.ts';
import {validateProjectRetainedRows} from '../packages/business/src/project-retained-validation.ts';
import {assertProjectDatabase} from '../packages/business/src/store-runtime.ts';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createServices} from '../packages/business/src/services.ts';
import {isTimelineRecord} from '../packages/contracts/src/timeline-replacement.ts';
import {isTimelineRenderRecord,TIMELINE_RENDER_RESPONSE_BYTES} from '../packages/contracts/src/timeline-acknowledgement.ts';
import {schemas} from '../packages/contracts/src/index.ts';
test('actual database startup supplies exact production timeline and receipt predicates',()=>{
 assert.equal(runtime.isTimelineRecord,isTimelineRecord);
 assert.equal(runtime.isTimelineRenderRecord,isTimelineRenderRecord);
 assert.equal(runtime.timelineRenderResponseBytes,TIMELINE_RENDER_RESPONSE_BYTES);
 assert.equal(Object.isFrozen(runtime),true);
 assert.equal(runtime.isTimelineRecord({}),false);
 assert.equal(runtime.isTimelineRenderRecord({},{}),false);
 for(const operation of ['timeline.clip.add','timeline.clip.update'] as const){
  for(const input of [{},null,{projectId:'invalid',patch:{volumeEnvelope:null}}] as const){
   assert.equal(runtime.validateClipIntent(operation,input),schemas[operation].safeParse(input).success);
   assert.equal(runtime.validateClipIntent(operation,input),false);
  }
 }
 assert.throws(()=>{Object.assign(runtime,{isTimelineRecord:()=>true});},{name:'TypeError'});
 assert.equal(runtime.isTimelineRecord,isTimelineRecord);
});

test('actual startup capability validates the complete catalog, not only markers',async t=>{
 const {DatabaseSync}=await import('node:sqlite');
 const {mkdtempSync,rmSync}=await import('node:fs');
 const fake=new DatabaseSync(':memory:');t.after(()=>fake.close());
 fake.exec('CREATE TABLE schema_version(version INTEGER PRIMARY KEY)');
 for(const version of [...Array.from({length:24},(_,i)=>i+1),26,28,30,32,34,36,38,40] as const)fake.prepare('INSERT INTO schema_version VALUES(?)').run(version);
 assert.throws(()=>assertProjectDatabase(fake),{code:'PROJECT_STORE_UNVERIFIED'});
 const root=mkdtempSync(new URL('../.tmp-envelope-boundary-',import.meta.url).pathname);
 const store=openStore(root);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const services=createServices(store,new Map());
 t.after(()=>services.drain());
 await services.call('project.create',{name:'Retained validation'});
 await services.call('timeline.get',{projectId:store.projectId});
 assert.doesNotThrow(()=>validateProjectRetainedRows(store));
 assert.throws(()=>validateProjectRetainedRows({...store}),{code:'PROJECT_STORE_UNVERIFIED'});
 store.db.exec('CREATE TABLE unexpected_catalog_object(value TEXT)');
 store.close();
 assert.throws(()=>openStore(root),{code:'PROJECT_INVALID'});
 assert.throws(()=>validateProjectRetainedRows(store),{code:'PROJECT_STORE_UNVERIFIED'});
});
