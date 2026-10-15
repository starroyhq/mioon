import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {validateWorkspaceVolumeEnvelopeRows as scan,hasWorkspaceVolumeEnvelopeEvidence as has} from '../packages/business/src/workspace-volume-envelope-validation.ts';
import {readyMixLoudness} from './fixtures/timeline-mix-loudness-fixtures.mjs';
import {readyClipLoudness} from './fixtures/timeline-clip-loudness-fixtures.mjs';
import {VOLUME_ENVELOPE_PROFILE as profile} from '../packages/contracts/src/timeline-volume-envelope.mjs';
const project='10000000-0000-4000-8000-000000000001',asset='20000000-0000-4000-8000-000000000002',clipId='30000000-0000-4000-8000-000000000003',trackId='40000000-0000-4000-8000-000000000004';
const envelope=()=>({profileId:profile,points:[{frame:0,multiplier:1},{frame:60,multiplier:.5}]});
const clip=(value=envelope())=>({id:clipId,assetId:asset,trackId,durationFrames:60,sourceInFrame:0,volumeEnvelope:value});
const timeline=(value=envelope())=>({projectId:project,tracks:[],clips:[clip(value)],durationFrames:60});
const history=(value=envelope())=>({tracks:[],clips:[clip(value)],durationFrames:60});
const input=(value=envelope())=>({projectId:project,requestId:'request-envelope-1',expectedRevision:1,clipId,patch:{volumeEnvelope:value}});
const families=[['timelines','data'],['timeline_history','beforeSnapshot'],['timeline_history','afterSnapshot'],['timeline_requests','response'],['edit_tasks','input'],['exports','data'],['workspace_restore_timeline_history','beforeSnapshot'],['workspace_restore_timeline_history','afterSnapshot'],['agent_edit_proposals','definition']];
const quote=s=>'"'+s+'"';
function fixture(t,table='timelines',field='data'){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(`PRAGMA trusted_schema=OFF; CREATE TABLE assets(id TEXT,projectId TEXT,data TEXT);CREATE TABLE ${quote(table)}(projectId TEXT,operation TEXT,errorCode TEXT,${quote(field)});`);
 db.prepare('INSERT INTO assets VALUES(?,?,?)').run(asset,project,JSON.stringify({id:asset,mimeType:'audio/wav',duration:2,hasAudio:true}));
 const put=(value,raw=false)=>db.prepare(`INSERT INTO ${quote(table)}(projectId,operation,${quote(field)}) VALUES(?,?,?)`).run(project,'timeline.clip.update',raw?value:JSON.stringify(value));
 return {db,put,scan:allow=>scan(db,{allowVolumeEnvelopes:allow}),state:()=>db.prepare(`SELECT * FROM ${quote(table)}`).all()};
}
const bad=(fn,allowed=true)=>assert.throws(fn,{code:allowed?'WORKSPACE_VOLUME_ENVELOPE_INVALID':'RESTORE_SCHEMA_UNSUPPORTED'});
test('all retained evidence families refuse old profiles including explicit null, without writes',t=>{
 for(const [table,field]of families){const f=fixture(t,table,field);f.put({retained:[{volumeEnvelope:null}]});const before=f.state();bad(()=>f.scan(false),false);assert.deepEqual(f.state(),before);}
});
test('complete current/history/receipt rows and exact partial intents admit in compatible profiles',t=>{
 for(const [table,field]of families){const f=fixture(t,table,field);
  f.put(table==='edit_tasks'?input():table==='agent_edit_proposals'?{operation:'timeline.clip.update',input:input(),patch:input().patch}:table.includes('history')?history():timeline());
  const before=f.state();f.scan(true);assert.deepEqual(f.state(),before);
 }
});
test('historical update survives missing current clip, Undo duration changes and missing source',t=>{
 const f=fixture(t,'edit_tasks','input');f.db.exec('DELETE FROM assets');f.put(input());f.scan(true);
 const old=input();old.patch.durationFrames=30;f.put(old);bad(()=>f.scan(true));
});
test('historical intent lexical bounds remain strict without generic array relaxation',t=>{
 const mutations=[v=>v.patch.volumeEnvelope.points.reverse(),v=>v.patch.volumeEnvelope.points[1].frame=18001,v=>v.patch.volumeEnvelope.extra=true,v=>v.patch.volumeEnvelope.points[0].multiplier=-.1,v=>v.patch.extra=[],v=>v.unknown=1,v=>v.patch.volumeEnvelope.points=[],v=>v.patch.volumeEnvelope.points[0].frame=.5,v=>v.patch.volumeEnvelope.points[0].multiplier=2];
 for(const mutate of mutations){const f=fixture(t,'edit_tasks','input'),value=input();mutate(value);f.put(value);bad(()=>f.scan(true));}
});
test('frozen snapshots use their own metadata and ownership, never current cache',t=>{
 const f=fixture(t,'exports','data');const frozen={timeline:timeline(),assets:[{id:asset,mimeType:'audio/wav',duration:2}],volumeEnvelopeProfile:profile};
 f.put({snapshot:frozen});f.db.prepare('UPDATE assets SET data=?').run(JSON.stringify({mimeType:'image/png',duration:0,hasAudio:false}));f.scan(true);
 f.db.prepare('UPDATE assets SET projectId=?').run(clipId);bad(()=>f.scan(true));
});
test('snapshot declarations are exact production strings, including null/unknown/inactive/missing negatives',t=>{
 for(const declared of [null,'unknown',{profileId:profile},undefined]){const f=fixture(t,'exports','data');f.put({snapshot:{timeline:timeline(),assets:[{id:asset,mimeType:'audio/wav',duration:2}],...(declared===undefined?{}:{volumeEnvelopeProfile:declared})}});bad(()=>f.scan(true));}
 const f=fixture(t,'exports','data');f.put({snapshot:{timeline:timeline(null),assets:[{id:asset,mimeType:'audio/wav',duration:2}],volumeEnvelopeProfile:profile}});bad(()=>f.scan(true));
});
test('explicit null snapshot has no active profile and preserves original shape',t=>{
 const f=fixture(t,'exports','data');f.put({snapshot:{timeline:timeline(null),assets:[{id:asset,mimeType:'image/png'}]}});f.scan(true);
});
test('frozen source cannot be an image, missing, duplicate or out of source bounds',t=>{
 for(const assets of [[],[{id:asset,mimeType:'image/png',duration:2}],[{id:asset,mimeType:'audio/wav',duration:1}],[{id:asset,mimeType:'audio/wav',duration:2},{id:asset,mimeType:'audio/wav',duration:2}]]){const f=fixture(t,'exports','data');f.put({snapshot:{timeline:timeline(),assets,volumeEnvelopeProfile:profile}});bad(()=>f.scan(true));}
});
test('escaped and duplicate keys cannot hide evidence before parsing, including nested arrays',t=>{
 const raws=['{"volumeEnvelope":null,"volumeEnvelope":0}','{"a":{"volume\\u0045nvelope":null},"a":{}}','{"items":[{"volume\\u0045nvelope":null}]}','{"volumeEnvelope":null,','{"volume\\u0045nvelope":null,','{"x":1,"x":2,"volumeEnvelope":null}'];
 for(const raw of raws)for(const allowed of [false,true]){const f=fixture(t);f.put(raw,true);bad(()=>f.scan(allowed),allowed);}
});
test('unrelated malformed legacy JSON stays with historical readers; positive malformed evidence refuses',t=>{
 const f=fixture(t);f.put('{"legacy":',true);f.scan(false);f.scan(true);f.put('{"volumeEnvelopeProfile":"unknown"',true);bad(()=>f.scan(true));
});
test('oversized cells and non-text storage are never parsed, schema views reject',t=>{
 for(const value of [' '.repeat(4*1024*1024+1),Buffer.from('{"volumeEnvelope":null}'),17]){const f=fixture(t);f.put(value,true);bad(()=>f.scan(true));}
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE VIEW timelines AS SELECT 1 AS data');bad(()=>scan(db,{allowVolumeEnvelopes:true}));
});
test('depth/node and complete snapshot byte guards remain bounded',t=>{
 const deep=timeline();deep.nested={};let node=deep.nested;for(let i=0;i<130;i++)node=node.next={};const f=fixture(t);f.put(deep);bad(()=>f.scan(true));
 const nodes=fixture(t);nodes.put({...timeline(),noise:Array(200001).fill(0)});bad(()=>nodes.scan(true));
 const bytes=fixture(t,'exports','data');bytes.put({snapshot:{timeline:timeline(),assets:[{id:asset,mimeType:'audio/wav',duration:2}],volumeEnvelopeProfile:profile,noise:'a'.repeat(262144)}});bad(()=>bytes.scan(true));
});
test('processing digest/profile and orphan declarations are positive evidence, never candidate protocol',t=>{
 for(const value of [{volumeEnvelopeProcessingProfile:profile},{volumeEnvelopeProcessingProfile:null},{identity:{volumeEnvelopeSha256:'a'.repeat(64)}},{identity:{volumeEnvelopeSha256:null}},{profileId:profile}]){assert.equal(has(value),true);const f=fixture(t);f.put(value);bad(()=>f.scan(false),false);bad(()=>f.scan(true));}
 assert.equal(has({items:[{volumeEnvelope:null}]}),true);assert.equal(has({other:null}),false);
});
test('all retained task errors are inspected and unknown envelope error namespace is not admitted',t=>{
 for(const code of ['INVALID_VOLUME_ENVELOPE','VOLUME_ENVELOPE_SOURCE_UNSUPPORTED','VOLUME_ENVELOPE_FUTURE_CODE']){const f=fixture(t,'edit_tasks','input');f.db.prepare('INSERT INTO edit_tasks(errorCode,input) VALUES(?,?)').run(code,'{}');bad(()=>f.scan(false),false);if(code.endsWith('FUTURE_CODE'))bad(()=>f.scan(true));else f.scan(true);}
});

test('actual production full/isolated processing reports admit their exact profile and digest identities',t=>{
 for(const value of [readyMixLoudness(),readyClipLoudness()]){
  value.projectId=project;value.volumeEnvelopeProcessingProfile=profile;
  if('processingProfile' in value)value.identity.volumeEnvelopeSha256='c'.repeat(64);
  const f=fixture(t,'timeline_requests','response');f.put(value);f.scan(true);
 }
});
test('incomplete frozen wrappers cannot fall back to current source cache',t=>{
 const f=fixture(t,'exports','data');f.put({snapshot:{timeline:timeline()}});bad(()=>f.scan(true));
});
