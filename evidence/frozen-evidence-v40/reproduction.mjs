// Post-fix replay of the original review fixture. Original evidence is retained unchanged.
// Deterministic read-only review reproducer. Only in-memory SQLite is mutated.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initializeWorkspaceSchemaThrough24} from '../../packages/business/src/workspace-fixed-schema.mjs';
import {initializeWorkspaceSchema26} from '../../packages/business/src/workspace-schema-v26.ts';
import {initializeWorkspaceSchema28} from '../../packages/business/src/workspace-schema-v28.ts';
import {initializeWorkspaceSchema30} from '../../packages/business/src/workspace-schema-v30.ts';
import {initializeWorkspaceSchema32} from '../../packages/business/src/workspace-schema-v32.ts';
import {initializeWorkspaceSchema34} from '../../packages/business/src/workspace-schema-v34.ts';
import {initializeWorkspaceSchema36} from '../../packages/business/src/workspace-schema-v36.ts';
import {initializeWorkspaceSchema38} from '../../packages/business/src/workspace-schema-v38.ts';
import {initializeWorkspaceSchema40,validateWorkspaceSchema40} from '../../packages/business/src/workspace-schema-v40.ts';
import {createWorkspaceRestoreProfileV41} from '../../packages/business/src/workspace-restore-schema-v41.ts';
import {validateWorkspaceVolumeEnvelopeRows as scan} from '../../packages/business/src/workspace-volume-envelope-validation.ts';
import {isTimelineAudioRoleSnapshot} from '../../packages/contracts/src/timeline-audio-role.ts';
import {createTimelineColourPlan,isTimelineColourSnapshot} from '../../packages/contracts/src/timeline-colour.ts';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const stamp='2026-10-15T00:00:00.000Z',profile='mioon-clip-linear-attenuation-v1';
for(const feature of ['audioRole','colour']){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON;PRAGMA trusted_schema=OFF;');
 for(const fn of [initializeWorkspaceSchemaThrough24,initializeWorkspaceSchema26,initializeWorkspaceSchema28,initializeWorkspaceSchema30,initializeWorkspaceSchema32,initializeWorkspaceSchema34,initializeWorkspaceSchema36,initializeWorkspaceSchema38,initializeWorkspaceSchema40])fn(db);
 const asset={id:id(2),projectId:id(1),mimeType:'video/mp4',duration:1,width:720,height:1280,sha256:'a'.repeat(64),hasAudio:true};
 db.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run(id(1),JSON.stringify({id:id(1)}));
 db.prepare('INSERT INTO assets(id,projectId,data) VALUES(?,?,?)').run(id(2),id(1),JSON.stringify(asset));
 const clip={id:id(4),trackId:id(3),assetId:id(2),name:'Frozen clip',startFrame:0,durationFrames:30,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1,volumeEnvelope:{profileId:profile,points:[{frame:0,multiplier:1}]}};
 if(feature==='audioRole')clip.audioRole='human';
 else clip.colour={profileId:'mioon-rec709-sdr-clip-v1',source:{assetSha256:'a'.repeat(64),streamIndex:0,profileId:'rec709-yuv-sdr-v1',range:'limited',declaredBy:'user',declaredAt:stamp},look:null};
 const timeline={id:id(5),projectId:id(1),revision:2,fps:30,width:720,height:1280,tracks:[{id:id(3),name:'Video',kind:'video',orderIndex:0,hidden:false,muted:false}],clips:[clip],durationFrames:30,createdAt:stamp,updatedAt:stamp};
 const snapshot={timeline,assets:[asset],volumeEnvelopeProfile:profile};
 if(feature==='audioRole')snapshot.audioRoleProfile='mioon-clip-audio-role-v1';
 else snapshot.colourPlan=createTimelineColourPlan(timeline,snapshot.assets);
 assert.equal(isTimelineAudioRoleSnapshot(snapshot),true);assert.equal(isTimelineColourSnapshot(snapshot),true);
 const response={id:id(6),projectId:id(1),requestId:'request-frozen-feature',mode:'timeline',purpose:'export',timelineRevision:2,snapshot,status:'queued',assetId:null,url:null,error:null,createdAt:stamp,updatedAt:stamp};
 db.prepare('INSERT INTO timeline_requests VALUES(?,?,?)').run(response.requestId,'a'.repeat(64),JSON.stringify(response));
 validateWorkspaceSchema40(db);console.log(`${feature}: ordinary40 admits before current metadata changes`);
 db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify({...asset,mimeType:feature==='audioRole'?'image/png':'audio/wav'}),asset.id);
 scan(db,{allowVolumeEnvelopes:true});console.log(`${feature}: envelope scanner admits retained frozen snapshot after current metadata changes`);
 validateWorkspaceSchema40(db);console.log(`${feature}: ordinary40 admits frozen evidence despite changed current MIME`);
 assert.equal(createWorkspaceRestoreProfileV41(initializeWorkspaceSchemaThrough24).classifyWorkspaceSchemaV40V41(db).schemaVersion,40);console.log(`${feature}: source40/restored41 classifier admits the strict frozen receipt`);
 db.close();
}
