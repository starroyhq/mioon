import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {isTimelineRecord,TIMELINE_MUTATION_OPERATIONS} from '@mioon/contracts';
import type {DatabaseSync} from 'node:sqlite';
import {projectRpcPath} from '../packages/contracts/src/project-file.ts';
import {timelineFormatResponseSchema} from '../packages/contracts/src/timeline-format.ts';
import {projectVersionSaveResponseSchema,projectVersionPreviewResponseSchema,projectVersionRestoreResponseSchema} from '../packages/contracts/src/project-version-operations.ts';
import {startServer,type InspectProject} from './helpers/test-server.ts';
import type {TimelineRecord} from '../packages/contracts/src/timeline-replacement.ts';
import {TIMELINE_HISTORY_OPERATIONS} from '../packages/business/src/timeline-history-operations.ts';
import {png} from './helpers/timeline-image-fixtures.ts';
import {changeMarks,readProjectState} from './helpers/project-state.ts';

interface Reply {status:number;body:{ok:boolean;data?:unknown;error?:{code:string;details?:unknown}}}
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
async function fixture(t:TestContext,{preset=true}:{preset?:boolean}={}){
 const root=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-version-format-'));let inspect!:InspectProject;
 const server=await startServer({dataDir:root,port:0,comfyModule:'skip',inspectProject:received=>{inspect=received;}});
 t.after(async()=>{await server.close();await rm(root,{recursive:true,force:true});});
 const request=async(operation:string,input:unknown,projectId?:string):Promise<Reply>=>{
  const response=await fetch(server.url+(projectId===undefined?'/api/rpc':projectRpcPath(projectId)),{method:'POST',
   headers:{authorization:`Bearer ${server.token}`,'content-type':'application/json'},body:JSON.stringify({operation,input})});
  return {status:response.status,body:await response.json() as Reply['body']};
 };
 const created=await request('project.create',{name:'Real version format',...(preset?{timelinePresetId:'portrait_1080'}:{})});
 assert.equal(created.status,200,JSON.stringify(created.body));assert.equal(created.body.ok,true);
 assert.ok(object(created.body.data)&&typeof created.body.data.id==='string');const projectId=created.body.data.id;
 const rpc=(operation:string,input:unknown)=>request(operation,input,projectId);
 const success=async(operation:string,input:unknown)=>{const reply=await rpc(operation,input);assert.equal(reply.status,200,JSON.stringify(reply.body));assert.equal(reply.body.ok,true);return reply.body.data;};
 const timeline=async(operation='timeline.get',input:unknown={projectId}):Promise<TimelineRecord>=>{
  const value=await success(operation,input);assert.ok(isTimelineRecord(value,{projectId}));return value;
 };
 const format=async()=>timelineFormatResponseSchema.parse(await success('timeline.format.get',{projectId}));
 const save=async()=>projectVersionSaveResponseSchema.parse(await success('project.version.save',{projectId,requestId:randomUUID(),name:'A'}));
 const restore=async(versionId:string)=>{
  const preview=projectVersionPreviewResponseSchema.parse(await success('project.version.preview',{projectId,versionId}));assert.equal(preview.restoreAvailable,true);
  const input={projectId,versionId,requestId:randomUUID(),expectedContentSequence:preview.contentSequence,expectedContentToken:preview.contentToken,previewDigest:preview.previewDigest};
  return projectVersionRestoreResponseSchema.parse(await success('project.version.restore',input));
 };
 return {projectId,root,rpc,success,timeline,format,save,restore,request,inspect:()=>inspect};
}

test('restoring portrait version A after a landscape change returns readable history-locked portrait output',async t=>{
 const f=await fixture(t),pristine=await f.format();assert.equal(pristine.presetId,'portrait_1080');assert.equal(pristine.eligible,true);
 const saved=await f.save(),wide=await f.timeline('timeline.format.set',{projectId:f.projectId,requestId:randomUUID(),
  expectedProjectRevision:pristine.projectRevision,expectedRevision:pristine.timelineRevision,presetId:'landscape_1080'});
 assert.deepEqual([wide.width,wide.height],[1920,1080]);assert.equal((await f.format()).presetId,'landscape_1080');
 const restored=await f.restore(saved.version.id);assert.equal(restored.versionId,saved.version.id);
 const actual=await f.format();assert.equal(actual.presetId,'portrait_1080');assert.deepEqual([actual.width,actual.height,actual.fps],[1080,1920,30]);
 assert.equal(actual.eligible,false);assert.ok(actual.blockedReasons.includes('HISTORY_PRESENT'));
 const locked=await f.rpc('timeline.format.set',{projectId:f.projectId,requestId:randomUUID(),expectedProjectRevision:actual.projectRevision,
  expectedRevision:actual.timelineRevision,presetId:'square_1080'});
 assert.equal(locked.status,409,JSON.stringify(locked.body));assert.equal(locked.body.error?.code,'TIMELINE_FORMAT_LOCKED');
});

test('clip version restoration, undo and redo each retain readable output format and their real history',async t=>{
 const f=await fixture(t),initial=await f.timeline();
 const imported=await f.success('asset.import',{projectId:f.projectId,name:'Synthetic source.png',mimeType:'image/png',
  dataBase64:png({width:16,height:16,rgba:false,pixel:()=>[255,0,0]}).toString('base64')});
 assert.ok(object(imported)&&typeof imported.id==='string');const track=initial.tracks.find(value=>value.kind==='video');assert.ok(track);
 const added=await f.timeline('timeline.clip.add',{projectId:f.projectId,requestId:randomUUID(),expectedRevision:initial.revision,
  assetId:imported.id,trackId:track.id,startFrame:0,durationFrames:90});
 const clip=added.clips[0]!;assert.equal(clip.startFrame,0);assert.equal(clip.durationFrames,90);const saved=await f.save();
 const changed=await f.timeline('timeline.clip.update',{projectId:f.projectId,requestId:randomUUID(),expectedRevision:added.revision,
  clipId:clip.id,patch:{startFrame:30,durationFrames:60}});
 assert.deepEqual(changed.clips.map(value=>[value.id,value.startFrame,value.durationFrames]),[[clip.id,30,60]]);
 await f.restore(saved.version.id);const restored=await f.timeline();
 assert.deepEqual(restored.clips.map(value=>[value.id,value.startFrame,value.durationFrames]),[[clip.id,0,90]]);
 const afterRestore=await f.format();assert.equal(afterRestore.presetId,'portrait_1080');assert.equal(afterRestore.eligible,false);assert.ok(afterRestore.blockedReasons.includes('HISTORY_PRESENT'));
 const undone=await f.timeline('timeline.undo',{projectId:f.projectId,requestId:randomUUID(),expectedRevision:restored.revision});
 assert.deepEqual(undone.clips.map(value=>[value.id,value.startFrame,value.durationFrames]),[[clip.id,30,60]]);
 const afterUndo=await f.format();assert.equal(afterUndo.presetId,'portrait_1080');assert.equal(afterUndo.eligible,false);assert.ok(afterUndo.blockedReasons.includes('HISTORY_PRESENT'));
 const redone=await f.timeline('timeline.redo',{projectId:f.projectId,requestId:randomUUID(),expectedRevision:undone.revision});
 assert.deepEqual(redone.clips.map(value=>[value.id,value.startFrame,value.durationFrames]),[[clip.id,0,90]]);
 const afterRedo=await f.format();assert.equal(afterRedo.presetId,'portrait_1080');assert.equal(afterRedo.eligible,false);assert.ok(afterRedo.blockedReasons.includes('HISTORY_PRESENT'));
});

test('a real format-only receipt pins its timeline owner when restoring a version saved without a timeline',async t=>{
 const f=await fixture(t,{preset:false}),empty=await f.format();assert.equal(empty.timelineId,null);assert.equal(empty.timelineRevision,0);
 const saved=await f.save(),input={projectId:f.projectId,requestId:randomUUID(),expectedProjectRevision:empty.projectRevision,expectedRevision:0,presetId:'landscape_1080'};
 const acknowledgement=await f.timeline('timeline.format.set',input);
 assert.deepEqual([acknowledgement.width,acknowledgement.height],[1920,1080]);
 const preview=projectVersionPreviewResponseSchema.parse(await f.success('project.version.preview',{projectId:f.projectId,versionId:saved.version.id}));
 const restored=projectVersionRestoreResponseSchema.parse(await f.success('project.version.restore',{projectId:f.projectId,versionId:saved.version.id,requestId:randomUUID(),
  expectedContentSequence:preview.contentSequence,expectedContentToken:preview.contentToken,previewDigest:preview.previewDigest}));
 const readable=await f.format();assert.equal(readable.timelineId,acknowledgement.id);assert.equal(readable.presetId,'landscape_1080');
 assert.ok(preview.changes.some(change=>change.table==='timelines'&&change.action==='keep-current'));
 assert.ok(restored.keptCurrent.some(change=>change.table==='timelines'));
 assert.deepEqual(await f.timeline('timeline.format.set',input),acknowledgement,'the original format key still replays its original ACK after restoration');
 assert.equal(JSON.stringify(await f.success('timeline.format.set',input)),JSON.stringify(acknowledgement));
});

test('restoring an empty version still removes an unreferenced lazy timeline and keeps format reads noncreating',async t=>{
 const f=await fixture(t,{preset:false}),empty=await f.format();assert.equal(empty.timelineId,null);const saved=await f.save();
 const lazy=await f.timeline();assert.equal((await f.format()).timelineId,lazy.id);
 const preview=projectVersionPreviewResponseSchema.parse(await f.success('project.version.preview',{projectId:f.projectId,versionId:saved.version.id}));
 assert.ok(preview.changes.some(change=>change.table==='timelines'&&change.action==='remove'));
 const restored=await f.restore(saved.version.id);assert.ok(restored.appliedChanges.some(change=>change.table==='timelines'&&change.action==='remove'));
 const after=await f.format();assert.equal(after.timelineId,null);assert.equal(after.timelineRevision,0);assert.equal(after.presetId,'portrait_1080');
 assert.equal(after.eligible,true);assert.deepEqual(after.blockedReasons,[]);assert.deepEqual(await f.format(),after);
});

test('restoring a saved timeline after its lazy owner was removed gives a readable undo baseline',async t=>{
 const f=await fixture(t,{preset:false}),empty=await f.save(),original=await f.timeline(),saved=await f.save();
 await f.restore(empty.version.id);
 assert.equal((await f.format()).timelineId,null);
 await f.restore(saved.version.id);
 const restored=await f.timeline();
 assert.deepEqual(restored.tracks,original.tracks);
 const beforeBytes=()=>f.inspect()(f.projectId,db=>db.prepare("SELECT beforeSnapshot FROM main.timeline_history WHERE projectId=? AND operation='project.version.restore'").get(f.projectId)!.beforeSnapshot);
 const retained=beforeBytes();assert.deepEqual(JSON.parse(String(retained)).tracks,[]);
 const format=await f.format();
 assert.equal(format.timelineId,restored.id);
 assert.ok(format.blockedReasons.includes('HISTORY_PRESENT'));
 const undone=await f.timeline('timeline.undo',{projectId:f.projectId,requestId:randomUUID(),expectedRevision:restored.revision});
 assert.deepEqual(undone.tracks,restored.tracks);
 assert.deepEqual(undone.clips,[]);
 const redone=await f.timeline('timeline.redo',{projectId:f.projectId,requestId:randomUUID(),expectedRevision:undone.revision});
 assert.deepEqual(redone.tracks,restored.tracks);
 assert.equal((await f.format()).timelineRevision,redone.revision);
 assert.equal(beforeBytes(),retained);
});

test('restoring an empty version keeps an owner with real edit history and keeps its format locked',async t=>{
 const f=await fixture(t,{preset:false}),saved=await f.save(),lazy=await f.timeline();
 const input={projectId:f.projectId,requestId:randomUUID(),expectedRevision:lazy.revision,kind:'audio'};
 const changed=await f.timeline('timeline.track.add',input);assert.equal(changed.tracks.length,lazy.tracks.length+1);
 const restored=await f.restore(saved.version.id);assert.ok(restored.keptCurrent.some(change=>change.table==='timelines'));
 const actual=await f.timeline();assert.deepEqual(actual,changed);
 const format=await f.format();assert.equal(format.timelineId,changed.id);assert.equal(format.presetId,'portrait_1080');
 assert.equal(format.eligible,false);assert.ok(format.blockedReasons.includes('HISTORY_PRESENT'));
 const locked=await f.rpc('timeline.format.set',{projectId:f.projectId,requestId:randomUUID(),expectedProjectRevision:format.projectRevision,
  expectedRevision:format.timelineRevision,presetId:'landscape_1080'});
 assert.equal(locked.status,409,JSON.stringify(locked.body));assert.equal(locked.body.error?.code,'TIMELINE_FORMAT_LOCKED');
 assert.deepEqual(await f.timeline('timeline.track.add',input),changed);
});

test('the frozen history vocabulary is exact and does not expose system history writers as client mutations',()=>{
 const excluded=['timeline.render','timeline.undo','timeline.redo'];
 const expected=[...TIMELINE_MUTATION_OPERATIONS.filter(operation=>!excluded.includes(operation)),'agent.task.undo','project.version.restore'].sort();
 assert.equal(Object.isFrozen(TIMELINE_HISTORY_OPERATIONS),true);
 assert.deepEqual([...TIMELINE_HISTORY_OPERATIONS].sort(),expected);
 assert.equal(new Set(TIMELINE_HISTORY_OPERATIONS).size,TIMELINE_HISTORY_OPERATIONS.length);
 for(const operation of excluded)assert.equal((TIMELINE_HISTORY_OPERATIONS as readonly string[]).includes(operation),false);
 for(const operation of ['agent.task.undo','project.version.restore'])assert.equal((TIMELINE_MUTATION_OPERATIONS as readonly string[]).includes(operation),false);
});

interface Fault {name:string;guard?:string;sql:string;value?:string|number}
const faults:readonly Fault[]=[
 {name:'malformed before snapshot',guard:'immutable_timeline_history',sql:'UPDATE main.timeline_history SET beforeSnapshot=? WHERE id=?',value:'{'},
 {name:'invalid after snapshot',guard:'immutable_timeline_history',sql:'UPDATE main.timeline_history SET afterSnapshot=? WHERE id=?',value:JSON.stringify({tracks:[],clips:'invalid',durationFrames:0})},
 {name:'noncontiguous history position',guard:'immutable_timeline_history',sql:'UPDATE main.timeline_history SET position=? WHERE id=?',value:9},
 {name:'unknown history operation',guard:'immutable_timeline_history',sql:'UPDATE main.timeline_history SET operation=? WHERE id=?',value:'project.version.unrecognized'},
 {name:'missing cursor',sql:'DELETE FROM main.timeline_history_cursors WHERE projectId=?'},
 {name:'cursor beyond recorded history',sql:'UPDATE main.timeline_history_cursors SET position=999 WHERE projectId=?'},
 {name:'malformed format receipt digest',guard:'immutable_timeline_responses',sql:'UPDATE main.timeline_requests SET requestHash=? WHERE requestId=?',value:'not-a-digest'},
 {name:'malformed format receipt response',guard:'immutable_timeline_responses',sql:'UPDATE main.timeline_requests SET response=? WHERE requestId=?',value:'{'},
];
function injectFault(db:DatabaseSync,fault:Fault,key:string):void{
 const mutate=()=>fault.value===undefined?db.prepare(fault.sql).run(key):db.prepare(fault.sql).run(fault.value,key);
 if(!fault.guard){mutate();return;}
 const saved=db.prepare("SELECT sql FROM main.sqlite_schema WHERE type='trigger' AND name=?").get(fault.guard);
 assert.ok(saved&&typeof saved.sql==='string');assert.throws(mutate,/immutable/);
 db.exec(`DROP TRIGGER main.${fault.guard}`);
 try{mutate();}finally{db.exec(saved.sql);}
 assert.throws(mutate,/immutable/,'the production immutable guard is restored before any business request');
}

for(const fault of faults)test(`a real restore with ${fault.name} still rejects format reads and writes without repairs`,async t=>{
 const f=await fixture(t),initial=await f.format(),saved=await f.save(),formatRequestId=randomUUID();
 await f.timeline('timeline.format.set',{projectId:f.projectId,requestId:formatRequestId,expectedProjectRevision:initial.projectRevision,
  expectedRevision:initial.timelineRevision,presetId:'landscape_1080'});
 await f.restore(saved.version.id);const valid=await f.format();assert.equal(valid.eligible,false);assert.ok(valid.blockedReasons.includes('HISTORY_PRESENT'));
 const inspect=f.inspect();
 inspect(f.projectId,db=>{
  const history=db.prepare("SELECT id,operation FROM main.timeline_history WHERE projectId=? AND operation='project.version.restore'").all(f.projectId);
  assert.equal(history.length,1);assert.equal(history[0]!.operation,'project.version.restore');
  // All successful history/receipts were produced by real authenticated RPC.
  // Only this explicit corruption step can bypass an immutable trigger.
  const key=fault.sql.includes('timeline_requests')?formatRequestId:fault.sql.includes('timeline_history_cursors')?f.projectId:String(history[0]!.id);
  injectFault(db,fault,key);
 });
 const before=inspect(f.projectId,db=>({state:readProjectState(db),marks:changeMarks(db)}));
 for(const [operation,input] of [['timeline.format.get',{projectId:f.projectId}],['timeline.format.set',{projectId:f.projectId,
  requestId:randomUUID(),expectedProjectRevision:valid.projectRevision,expectedRevision:valid.timelineRevision,presetId:'square_1080'}]] as const){
  const invalid=await f.rpc(operation,input);assert.equal(invalid.status,409,JSON.stringify(invalid.body));assert.equal(invalid.body.ok,false);
  assert.equal(invalid.body.error?.code,'INVALID_TIMELINE_SNAPSHOT');
  assert.deepEqual(inspect(f.projectId,db=>({state:readProjectState(db),marks:changeMarks(db)})),before,'invalid reads/writes do not repair snapshots, cursor or receipts');
 }
});
