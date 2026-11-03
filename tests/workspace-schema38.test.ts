import {DatabaseSync} from 'node:sqlite';
import {publicAsset} from './helpers/current-retained-fixture.ts';
import {validateTimelineAudioRoleRows as validateRows} from '../packages/business/src/timeline-retained-audio-role.ts';

import test from 'node:test';
import assert from 'node:assert/strict';

import {randomUUID} from 'node:crypto';

test('current scanner rejects duplicate role keys and bounded malformed/oversize cells',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE edit_tasks(input TEXT)');
 for(const value of ['{"audioRole":null,"audioRole":"music"}','{"audioRole":','x'.repeat(4*1024*1024+1)] as const){
  db.exec('DELETE FROM edit_tasks');db.prepare('INSERT INTO edit_tasks VALUES(?)').run(value);assert.throws(()=>validateRows(db),{code:'WORKSPACE_AUDIO_ROLE_INVALID'});
 }
});

test('current scanner admits silent video and audio classifications but rejects image explicit clear',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE assets(id TEXT,projectId TEXT,data TEXT);CREATE TABLE timelines(projectId TEXT,data TEXT)');
 const projectId=randomUUID(),assetId=randomUUID();
 for(const mimeType of ['video/mp4','audio/wav','image/png'] as const){
  db.exec('DELETE FROM assets;DELETE FROM timelines');db.prepare('INSERT INTO assets VALUES(?,?,?)').run(assetId,projectId,JSON.stringify({id:assetId,projectId,mimeType,hasAudio:false}));
  db.prepare('INSERT INTO timelines VALUES(?,?)').run(projectId,JSON.stringify({clips:[{assetId,audioRole:null}]}));
  if(mimeType==='image/png')assert.throws(()=>validateRows(db),{code:'WORKSPACE_AUDIO_ROLE_INVALID'});else assert.doesNotThrow(()=>validateRows(db));
 }
});

test('role-bearing exports require exact declaration and role-free exports forbid one',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE assets(id TEXT,projectId TEXT,data TEXT);CREATE TABLE exports(id TEXT,projectId TEXT,data TEXT)');
 const projectId=randomUUID(),asset={id:randomUUID(),projectId,name:'Frozen video',mimeType:'video/mp4',duration:1,width:720,height:1280,hasAudio:true,hasVideo:true,sha256:'a'.repeat(64),relativePath:'media/metadata.mp4'},trackId=randomUUID(),clipId=randomUUID(),stamp='2026-10-15T00:00:00.000Z';
 db.prepare('INSERT INTO assets VALUES(?,?,?)').run(asset.id,projectId,JSON.stringify(asset));
 for(const [roles,profile,valid]of [[true,undefined,false],[true,'wrong',false],[true,'mioon-clip-audio-role-v1',true],[false,'mioon-clip-audio-role-v1',false]] as const){
  const timeline={id:randomUUID(),projectId,revision:1,fps:30,width:720,height:1280,tracks:[{id:trackId,name:'Video',kind:'video',orderIndex:0,hidden:false,muted:false}],clips:[{id:clipId,trackId,assetId:asset.id,name:'Clip',startFrame:0,durationFrames:30,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1,...(roles?{audioRole:'human'}:{})}],durationFrames:30,createdAt:stamp,updatedAt:stamp};
  const value={id:randomUUID(),projectId,requestId:randomUUID(),mode:'timeline',purpose:'preview',timelineRevision:1,snapshot:{timeline,assets:[publicAsset(asset)],...(profile?{audioRoleProfile:profile}:{})},status:'queued',assetId:null,url:null,error:null,createdAt:stamp,updatedAt:stamp};db.exec('DELETE FROM exports');db.prepare('INSERT INTO exports VALUES(?,?,?)').run(value.id,projectId,JSON.stringify(value));
  if(valid)assert.doesNotThrow(()=>validateRows(db));else assert.throws(()=>validateRows(db),{code:'WORKSPACE_AUDIO_ROLE_INVALID'});
 }
});
