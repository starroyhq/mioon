import test from 'node:test';
import assert from 'node:assert/strict';
import type {DatabaseSync} from 'node:sqlite';
import {VOLUME_ENVELOPE_PROFILE} from '../packages/contracts/src/timeline-volume-envelope.ts';
import {validateTimelineOpacityRows as validateRows} from '../packages/business/src/timeline-retained-opacity.ts';
import {validateTimelineAudioRoleRows} from '../packages/business/src/timeline-retained-audio-role.ts';
import {validateTimelineColourRows} from '../packages/business/src/timeline-retained-colour.ts';
import {validateAssetAnnotationRows} from '../packages/business/src/asset-annotation-validation.ts';
import {lexerDatabase,snapshot,insert} from './helpers/current-retained-fixture.ts';

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12,'0')}`;
const stamp = '2026-10-15T00:00:00.000Z';

const envelope = () => ({profileId:VOLUME_ENVELOPE_PROFILE,points:[{frame:0,multiplier:0},{frame:20,multiplier:1}]});
function database(t:test.TestContext){return lexerDatabase(t);}

function project(db: DatabaseSync, projectId=id(1)) {
 insert(db,'projects',{id:projectId,data:JSON.stringify({id:projectId,name:'Deterministic project',revision:1})});
 return projectId;
}
function timeline(fields={}) {
 return {id:id(2),projectId:id(1),revision:1,fps:30,width:720,height:1280,
  tracks:[{id:id(3),name:'Video',kind:'video',orderIndex:0,hidden:false,muted:false}],
  clips:[{id:id(4),trackId:id(3),assetId:id(5),name:'Clip',startFrame:0,durationFrames:20,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1,...fields}],
  durationFrames:20,createdAt:stamp,updatedAt:stamp};
}
const editable = (value: { id?: string; projectId?: string; revision?: number; fps?: number; width?: number; height?: number; tracks: unknown; clips: unknown; durationFrames: unknown; createdAt?: string; updatedAt?: string; }) => ({tracks:value.tracks,clips:value.clips,durationFrames:value.durationFrames});
function seedTimeline(db: DatabaseSync, fields={}) {
 project(db);
 const asset={id:id(5),projectId:id(1),name:'Synthetic metadata only',mimeType:'video/mp4',duration:10,hasAudio:true,hasVideo:true,width:720,height:1280};
 insert(db,'assets',{id:asset.id,projectId:asset.projectId,data:JSON.stringify(asset)});
 const value=timeline(fields);
 insert(db,'timelines',{id:value.id,projectId:value.projectId,data:JSON.stringify(value)});
 return value;
}
function taskRow(number=1, fields={}) {
 const projectId=id(1),requestId=id(100+number);
 return {position:number,id:id(200+number),projectId,operation:'timeline.clip.update',
  input:JSON.stringify({projectId,requestId,expectedRevision:1,clipId:id(4),patch:{name:'Retained'}}),
  requestId,digest:'a'.repeat(64),lane:'timeline:mutation',origin:'new',status:'prepared',revision:1,acknowledged:0,
  claim:null,claimInstance:null,receiptDigest:null,errorCode:null,createdAt:stamp,updatedAt:stamp,bytes:16384,...fields};
}
for(const fields of [{},{volumeEnvelope:null},{volumeEnvelope:envelope()}] as const) test(`current retained rows preserve ${Object.hasOwn(fields,'volumeEnvelope')?fields.volumeEnvelope===null?'null':'non-null':'absent'} timeline/history/receipt shapes`,t=>{
 const db=database(t),value=seedTimeline(db,fields),saved=editable(value);
 insert(db,'timeline_history',{id:id(20),projectId:id(1),position:1,operation:'timeline.clip.update',createdAt:stamp,beforeSnapshot:JSON.stringify(saved,null,2),afterSnapshot:JSON.stringify(saved)});
 insert(db,'timeline_history_cursors',{projectId:id(1),position:1});
 insert(db,'timeline_requests',{requestId:id(21),requestHash:'a'.repeat(64),response:JSON.stringify(value,null,2)});
 const historicalInput={projectId:id(1),requestId:id(101),expectedRevision:1,clipId:id(444),patch:Object.hasOwn(fields,'volumeEnvelope')?fields:{name:'Historical deleted clip'}};
 insert(db,'edit_tasks',taskRow(1,{input:JSON.stringify(historicalInput,null,1),digest:Buffer.alloc(64,0x61),createdAt:Buffer.from('retained timestamp')}));
 const before=snapshot(db);assert.doesNotThrow(()=>validateRows(db));
 assert.deepEqual(snapshot(db),before,'all current/history/receipt/intent raw values remain exact');
 assert.doesNotThrow(()=>validateRows(db));assert.deepEqual(snapshot(db),before,'repeat admission performs no repair or normalization');
 assert.equal(db.prepare('SELECT input FROM edit_tasks').get()!.input,JSON.stringify(historicalInput,null,1));
});

test('current retained rows preserve inherited roles, annotation and image/colour admission',t=>{
 const db=database(t),value=seedTimeline(db,{audioRole:'human',colour:null,volumeEnvelope:null});
 for(const [index,mimeType,profileId] of [[0,'image/png','mioon-srgb-image-clip-v1'],[1,'image/jpeg','mioon-jfif-image-clip-v1']] as const){
  const assetId=id(10+index);insert(db,'assets',{id:assetId,projectId:id(1),data:JSON.stringify({id:assetId,projectId:id(1),mimeType})});
  const image={...timeline().clips[0],id:id(30+index),assetId,startFrame:20+20*index,colour:{profileId,source:null,look:null}};value.clips.push(image);
 }
 value.durationFrames=60;db.prepare('UPDATE timelines SET data=? WHERE id=?').run(JSON.stringify(value),value.id);
 insert(db,'asset_annotations',{assetId:id(5),projectId:id(1),revision:1,tags:'["retained"]',note:'Exact annotation'});
 const before=snapshot(db);assert.doesNotThrow(()=>validateRows(db));
 assert.deepEqual(snapshot(db).tables.asset_annotations,before.tables.asset_annotations);
 assert.deepEqual(snapshot(db),before);
});
for(const [sql,scan,expected] of [
 ["UPDATE timelines SET data=json_set(data,'$.clips[0].audioRole','unknown')",validateTimelineAudioRoleRows,'WORKSPACE_AUDIO_ROLE_INVALID'],
 ["UPDATE timelines SET data=json_set(data,'$.clips[0].colour.profileId','unknown')",validateTimelineColourRows,'WORKSPACE_COLOUR_INVALID'],
 ["INSERT INTO asset_annotations VALUES('"+id(5)+"','"+id(1)+"',1,'[1]','Invalid tags')",validateAssetAnnotationRows,'INVALID_ASSET_ANNOTATION_RECORD'],
] as const) test('current invalid inherited feature data fails without repair',t=>{
 const db=database(t);seedTimeline(db);db.exec(sql);const before=snapshot(db);
 assert.throws(()=>scan(db),{code:expected});assert.throws(()=>validateRows(db));assert.deepEqual(snapshot(db),before);
});
