import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {CLIP_TRANSFORM_PROFILE,isTimelineRecord} from '@mioon/contracts';
import type {TimelineRecord} from '../packages/contracts/src/timeline-replacement.ts';
import {getTimelineFormat} from '../packages/business/src/timeline-format.ts';
import {TIMELINE_RECEIPT_PROJECT_EXPRESSION} from '../packages/business/src/timeline-receipt-project.ts';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createServices} from '../packages/business/src/services.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

const at='2026-11-12T12:00:00.000Z';
const landscape={fps:30,width:1920,height:1080};
const portrait={fps:30,width:1080,height:1920};

async function fixture(t: TestContext){
 const root=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-format-retained-'));
 const store=openStore(root),{db}=store,services=createServices(store,new Map());
 t.after(async()=>{await services.drain();store.close();await rm(root,{recursive:true,force:true});});
 const projectId=store.projectId;
 await services.call('project.create',{name:t.name});
 const assetId=randomUUID(),relativePath=`media/${assetId}.png`;
 const bytes=png({width:16,height:16,rgba:false,pixel:()=>[255,0,0]});
 await writeFile(path.join(root,relativePath),bytes);
 store.put('assets',{id:assetId,projectId,name:'Source',mimeType:'image/png',width:16,height:16,duration:null,sizeBytes:bytes.length,
  sha256:createHash('sha256').update(bytes).digest('hex'),relativePath,createdAt:at});
 const timelineId=randomUUID(),trackId=randomUUID(),clipId=randomUUID();
 const tracks=[{id:trackId,name:'Video',kind:'video' as const,orderIndex:0,hidden:false,muted:false}];
 const clip={id:clipId,trackId,assetId,name:'Still',startFrame:0,durationFrames:30,sourceInFrame:0,gain:1};
 const snapshot=(x: number)=>({tracks,clips:[{...clip,rect:{x,y:0,width:400,height:400}}],durationFrames:30});
 const current=(format: typeof portrait,x: number): TimelineRecord=>({id:timelineId,projectId,revision:1,createdAt:at,updatedAt:at,...snapshot(x),...format});
 const format=(frameTransaction=true)=>getTimelineFormat(db,{projectId},{frameTransaction});
 return {db,store,services,projectId,clipId,snapshot,current,format};
}

test('format checks both history branches in their own frame and keeps old Mio inheritance',async t=>{
 const f=await fixture(t),{db,projectId}=f;
 f.store.put('timelines',f.current(portrait,220));
 const insert=db.prepare('INSERT INTO timeline_history(id,projectId,position,operation,createdAt,beforeSnapshot,afterSnapshot) VALUES(?,?,?,?,?,?,?)');
 const wide=f.snapshot(1400),tall=f.snapshot(200);
 const entries=[
  ['timeline.clip.add',{tracks:wide.tracks,clips:[],durationFrames:0},wide],
  ['project.version.restore',{...wide,format:landscape},{...tall,format:portrait}],
  ['agent.task.undo',tall,f.snapshot(220)],
 ] as const;
 for(const [index,[operation,before,after]] of entries.entries())insert.run(randomUUID(),projectId,index+1,operation,at,JSON.stringify(before),JSON.stringify(after));
 db.prepare('INSERT INTO timeline_history_cursors VALUES(?,?)').run(projectId,entries.length);
 const stored=()=>db.prepare('SELECT beforeSnapshot,afterSnapshot FROM timeline_history ORDER BY position').all();
 const initial=stored();
 assert.deepEqual(f.format(false).blockedReasons,['CLIPS_PRESENT','HISTORY_PRESENT']);
 assert.equal(f.format().eligible,true);
 const travel=async(operation:'timeline.undo'|'timeline.redo')=>{
  const current=f.format();
  const result=await f.services.call(operation,{projectId,requestId:randomUUID(),expectedRevision:current.timelineRevision});
  assert.ok(isTimelineRecord(result,{projectId}));
  return result;
 };
 const inherited=await travel('timeline.undo');
 assert.deepEqual([inherited.width,inherited.clips[0]?.rect.x],[1080,200]);
 const left=await travel('timeline.undo');
 assert.deepEqual([left.width,left.clips[0]?.rect.x],[1920,1400]);
 const empty=await travel('timeline.undo');
 assert.deepEqual([empty.width,empty.clips.length],[1920,0]);
 assert.equal(f.format().eligible,true);
 const afterWide=await travel('timeline.redo');
 assert.deepEqual([afterWide.width,afterWide.clips[0]?.rect.x],[1920,1400]);
 const afterTall=await travel('timeline.redo');
 assert.deepEqual([afterTall.width,afterTall.clips[0]?.rect.x],[1080,200]);
 const afterMio=await travel('timeline.redo');
 assert.deepEqual([afterMio.width,afterMio.clips[0]?.rect.x],[1080,220]);
 assert.deepEqual(stored(),initial);
 insert.run(randomUUID(),projectId,entries.length+1,'timeline.clip.update',at,JSON.stringify(f.snapshot(220)),JSON.stringify(f.snapshot(1400)));
 for(const gate of [false,true])assert.throws(()=>f.format(gate),{code:'INVALID_TIMELINE_SNAPSHOT'});
});

type WrappedReceipt={operation:string;requestId:string;timeline:TimelineRecord};

async function transformReceipt(t: TestContext){
 const f=await fixture(t),{db,projectId,clipId}=f;
 f.store.put('timelines',f.current(landscape,1400));
 const operation='timeline.clip.setTransform',requestId=randomUUID();
 const transform={profileId:CLIP_TRANSFORM_PROFILE,keyframes:[{frame:0,x:90,y:0,scale:1}],rotation:0,crop:{left:0,top:0,right:0,bottom:0}};
 const input={projectId,requestId,clipId,expectedRevision:1,transform};
 const receipt=await f.services.call(operation,input);
 const row=db.prepare('SELECT requestHash,response FROM timeline_requests WHERE requestId=?').get(requestId);
 assert.ok(typeof row?.response==='string'&&typeof row.requestHash==='string');
 const saved=JSON.parse(row.response) as WrappedReceipt;
 return {...f,operation,input,receipt,row,saved};
}

test('a real wrapped transform receipt pins its nested owner, remains byte-identical and replays',async t=>{
 const f=await transformReceipt(t);
 const owner=f.db.prepare(`SELECT (${TIMELINE_RECEIPT_PROJECT_EXPRESSION}) AS owner FROM timeline_requests WHERE requestId=?`).get(f.input.requestId);
 assert.equal(owner?.owner,f.projectId);
 assert.deepEqual(f.format(false).blockedReasons,['CLIPS_PRESENT','HISTORY_PRESENT','REQUEST_HISTORY']);
 assert.equal(f.format().eligible,true);
 assert.deepEqual(await f.services.call(f.operation,f.input),f.receipt);
 assert.deepEqual(f.db.prepare('SELECT requestHash,response FROM timeline_requests WHERE requestId=?').get(f.input.requestId),f.row);
});

const invalidWrappers: readonly [string,(saved: WrappedReceipt)=>WrappedReceipt][]=[
 ['unknown discriminator',saved=>({...saved,operation:'timeline.unknown'})],
 ['wrong request key', saved=>({...saved,requestId:randomUUID()})],
 ['contradictory project IDs', saved=>({...saved,projectId:randomUUID()})],
 ['unknown nested project', saved=>({...saved,timeline:{...saved.timeline,projectId:randomUUID()}})],
 ['future revision', saved=>({...saved,timeline:{...saved.timeline,revision:saved.timeline.revision+1}})],
 ['wrong timeline ID', saved=>({...saved,timeline:{...saved.timeline,id:randomUUID()}})],
 ['mismatched outcome', saved=>({...saved,transform:null})],
];

for(const [label,change] of invalidWrappers)test(`format rejects a retained wrapper with ${label}`,async t=>{
 const f=await transformReceipt(t),requestId=randomUUID();
 const text=JSON.stringify(change({...f.saved,requestId}));
 f.db.prepare('INSERT INTO timeline_requests VALUES(?,?,?)').run(requestId,f.row.requestHash!,text);
 for(const gate of [false,true])assert.throws(()=>f.format(gate),{code:'INVALID_TIMELINE_SNAPSHOT'});
 assert.equal(f.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(requestId)?.response,text);
});

test('a duplicate nested owner cannot scope a wrapped receipt to the wrong project',async t=>{
 const f=await transformReceipt(t),requestId=randomUUID();
 const text=JSON.stringify({...f.saved,requestId}).replace(`"projectId":"${f.projectId}"`,`"projectId":"${f.projectId}","projectId":"${randomUUID()}"`);
 f.db.prepare('INSERT INTO timeline_requests VALUES(?,?,?)').run(requestId,f.row.requestHash!,text);
 const owner=f.db.prepare(`SELECT (${TIMELINE_RECEIPT_PROJECT_EXPRESSION}) AS owner FROM timeline_requests WHERE requestId=?`).get(requestId);
 assert.equal(owner?.owner,null);
 assert.throws(()=>f.format(),{code:'INVALID_TIMELINE_SNAPSHOT'});
});

for(const side of ['before','after'])test(`format history rejects a frame transaction missing the ${side} frame`,async t=>{
 const f=await fixture(t),{db,projectId}=f;
 f.store.put('timelines',f.current(portrait,220));
 // Both rectangles fit either frame. Only the missing explicit evidence is invalid.
 const before={...f.snapshot(200),...(side==='before'?{}:{format:landscape})};
 const after={...f.snapshot(220),...(side==='after'?{}:{format:portrait})};
 db.prepare('INSERT INTO timeline_history(id,projectId,position,operation,createdAt,beforeSnapshot,afterSnapshot) VALUES(?,?,?,?,?,?,?)')
  .run(randomUUID(),projectId,1,'timeline.format.set',at,JSON.stringify(before),JSON.stringify(after));
 db.prepare('INSERT INTO timeline_history_cursors VALUES(?,?)').run(projectId,1);
 for(const gate of [false,true])assert.throws(()=>f.format(gate),{code:'INVALID_TIMELINE_SNAPSHOT'});
});
