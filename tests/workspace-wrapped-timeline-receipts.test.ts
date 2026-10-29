import '../packages/business/src/db.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type {DatabaseSync} from 'node:sqlite';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.ts';
import {validateWorkspaceAudioRoleRows} from '../packages/business/src/workspace-audio-role-validation.ts';
import {validateWorkspaceColourRows} from '../packages/business/src/workspace-colour-validation.ts';
import {WRAPPED_TIMELINE_OPERATIONS,wrappedTimelineReceiptView} from '../packages/business/src/workspace-wrapped-timeline-receipts.ts';
import {TIMELINE_SHOT_SYNC_OPERATIONS,TIMELINE_SCENE_SPLIT_OPERATION,TIMELINE_CROSSFADE_OPERATION,TIMELINE_CLIP_GAINS_OPERATION,TIMELINE_CLIP_TRANSFORM_OPERATION,TIMELINE_CLIP_TRANSITION_OPERATION} from '@mioon/contracts';
import {open,insert} from './workspace-schema26-fixtures.mjs';

const id=(n: number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const stamp='2026-10-28T00:00:00.000Z',sha='a'.repeat(64);
type Rows=Pick<DatabaseSync,'prepare'>;
const audioRoles=(db: Rows)=>validateWorkspaceAudioRoleRows(db,{allowAudioRoles:true,frozenEvidenceProfile:'workspace40-restored41'});
const colours=(db: Rows)=>validateWorkspaceColourRows(db,{allowColour:true,allowMixedImages:true,allowJpegImages:true,frozenEvidenceProfile:'workspace40-restored41'});
const rect={x:0,y:0,width:720,height:1280};
const voice=(assetId=id(2))=>({id:id(4),trackId:id(11),assetId,name:'Voice',startFrame:0,durationFrames:30,sourceInFrame:0,rect,gain:1,audioRole:'human'});
const film={id:id(5),trackId:id(10),assetId:id(3),name:'Film',startFrame:0,durationFrames:30,sourceInFrame:0,rect,gain:1,
 colour:{profileId:'mioon-rec709-sdr-clip-v1',source:{assetSha256:sha,streamIndex:0,profileId:'rec709-yuv-sdr-v1',range:'limited',declaredBy:'user',declaredAt:stamp},look:null}};
const timeline=(clips: unknown[]=[voice(),film])=>({id:id(6),projectId:id(1),revision:3,fps:30,width:720,height:1280,
 tracks:[{id:id(10),name:'Video',kind:'video',orderIndex:0,hidden:false,muted:false},{id:id(11),name:'Audio',kind:'audio',orderIndex:1,hidden:false,muted:false}],
 clips,durationFrames:30,createdAt:stamp,updatedAt:stamp});
const wrapped=(operation: string,extra: Record<string,unknown>={})=>({operation,requestId:'request-wrapped',timeline:timeline(),skipped:[],...extra});

function database(t: test.TestContext,response: unknown,requestId='request-wrapped'){
 const db=open(':memory:') as DatabaseSync;t.after(()=>db.close());initializeWorkspaceSchemaThrough24(db);
 for(const project of [id(1),id(9)])insert(db,'projects',{id:project,data:JSON.stringify({id:project})});
 const assets=[{id:id(2),projectId:id(1),mimeType:'audio/wav',duration:1,sha256:sha,hasAudio:true},{id:id(3),projectId:id(1),mimeType:'video/mp4',duration:1,width:720,height:1280,sha256:sha,hasVideo:true,hasAudio:true},
  {id:id(7),projectId:id(9),mimeType:'audio/wav',duration:1,sha256:sha,hasAudio:true}];
 for(const asset of assets)insert(db,'assets',{id:asset.id,projectId:asset.projectId,data:JSON.stringify(asset)});
 insert(db,'timeline_requests',{requestId,requestHash:sha,response:JSON.stringify(response)});
 return db;
}

test('a wrapped receipt whose timeline carries an audio role or a colour reads as that timeline',t=>{
 assert.deepEqual(WRAPPED_TIMELINE_OPERATIONS,[...TIMELINE_SHOT_SYNC_OPERATIONS,TIMELINE_SCENE_SPLIT_OPERATION,TIMELINE_CROSSFADE_OPERATION,TIMELINE_CLIP_GAINS_OPERATION,TIMELINE_CLIP_TRANSFORM_OPERATION,TIMELINE_CLIP_TRANSITION_OPERATION]);
 for(const operation of WRAPPED_TIMELINE_OPERATIONS){
  const db=database(t,wrapped(operation));
  // The frozen workspace40/41 adapter reads the wrapper as a broken render receipt.
  assert.throws(()=>audioRoles(db),{code:'WORKSPACE_AUDIO_ROLE_INVALID'},operation);
  assert.throws(()=>colours(db),{code:'WORKSPACE_COLOUR_INVALID'},operation);
  const view=wrappedTimelineReceiptView(db);
  assert.notEqual(view,db);
  audioRoles(view);colours(view);
  const row=view.prepare('SELECT response FROM main.timeline_requests').get()!;
  assert.deepEqual(JSON.parse(row.response as string),timeline(),'only the timeline is shown');
  assert.deepEqual(JSON.parse(db.prepare('SELECT response FROM main.timeline_requests').get()!.response as string),wrapped(operation),'the stored receipt is unchanged');
 }
});

test('an unbound, unproved or evidence-hiding wrapper stays as stored, and the scanners still reject it',t=>{
 const [operation]=WRAPPED_TIMELINE_OPERATIONS as [string];
 const cases: [string,unknown,string?][]=[
  ['bound to another request',wrapped(operation),'request-other'],
  ['an outcome hiding an audio role',wrapped(operation,{skipped:[{clipId:id(4),reason:'UP_TO_DATE',audioRole:'human'}]})],
  ['an outcome hiding a render snapshot',wrapped(operation,{snapshot:{timeline:timeline(),assets:[]}})],
  ['a timeline that is not a timeline record',{...wrapped(operation),timeline:{...timeline(),fps:'thirty'}}],
 ];
 for(const [name,response,requestId] of cases){
  const db=database(t,response,requestId);
  assert.throws(()=>audioRoles(wrappedTimelineReceiptView(db)),{code:'WORKSPACE_AUDIO_ROLE_INVALID'},name);
 }
 // A projected timeline is still checked clip by clip against the saved assets.
 for(const [name,clip] of [['an asset of another project',voice(id(7))],['an unknown role',{...voice(),audioRole:'robot'}],['a missing asset',voice(id(8))]] as const){
  const db=database(t,{...wrapped(operation),timeline:timeline([clip,film])});
  assert.throws(()=>audioRoles(wrappedTimelineReceiptView(db)),{code:'WORKSPACE_AUDIO_ROLE_INVALID'},name);
 }
 const recoloured=database(t,{...wrapped(operation),timeline:timeline([voice(),{...film,colour:{...film.colour,source:{...film.colour.source,assetSha256:'b'.repeat(64)}}}])});
 assert.throws(()=>colours(wrappedTimelineReceiptView(recoloured)),{code:'WORKSPACE_COLOUR_INVALID'});
});

test('the view is read-only, and is the database itself when nothing is wrapped',t=>{
 const bare=database(t,timeline(),'request-bare');
 assert.equal(wrappedTimelineReceiptView(bare),bare);
 audioRoles(bare);
 const view=wrappedTimelineReceiptView(database(t,wrapped(WRAPPED_TIMELINE_OPERATIONS[0]!)));
 assert.throws(()=>view.prepare('DELETE FROM main.timeline_requests'),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 assert.throws(()=>view.prepare('SELECT 1').run(),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 assert.deepEqual(view.prepare('SELECT count(*) AS count FROM main.assets').all(),[{count:3}]);
});
