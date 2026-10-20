import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createProjectHomeServices} from '../packages/business/src/project-home.ts';

async function fixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'mioon-project-summary-')),store=openStore(root),services=createServices(store,new Map());
  t.after(async()=>{await services.drain();store.close();await rm(root,{recursive:true,force:true});});
  return {root,store,services,state:()=>Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))};
}
test('home summaries never initialize timelines and atomically created formats keep their saved geometry',async t=>{
  const f=await fixture(t),empty=await f.services.call('project.create',{name:'Empty'}),landscape=await f.services.call('project.create',{name:'Landscape',timelinePresetId:'landscape_1080'});
  const before=f.state(),home=createProjectHomeServices(f.store),result=home.handlers['project.summary.list']();
  assert.deepEqual(f.state(),before);const plain=result.find(p=>p.id===empty.id),wide=result.find(p=>p.id===landscape.id);
  assert.deepEqual([plain.width,plain.height,plain.shotCount,plain.durationFrames,plain.cover],[1080,1920,0,0,null]);
  assert.deepEqual([wide.width,wide.height],[1920,1080]);
  assert.equal(f.store.db.prepare('SELECT 1 FROM timelines WHERE projectId=?').get(empty.id),undefined);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM timeline_history WHERE projectId=?').get(landscape.id).n,0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM timeline_format_requests WHERE projectId=?').get(landscape.id).n,0);
  const eligibility=await f.services.call('timeline.format.get',{projectId:landscape.id});assert.equal(eligibility.eligible,true);
});
test('cover, duration and content update derive from owned saved records without touching the project',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-19T00:00:00.000Z')});
  const f=await fixture(t),project=await f.services.call('project.create',{name:'Legacy'});
  let timeline=await f.services.call('timeline.format.set',{projectId:project.id,expectedProjectRevision:project.revision,expectedRevision:0,requestId:randomUUID(),presetId:'portrait_720'});
  const id=randomUUID(),stamp='2026-10-20T00:00:00.000Z';
  f.store.put('assets',{id,projectId:project.id,name:'cover.png',mimeType:'image/png',relativePath:`media/${id}.png`,sha256:createHash('sha256').update('fixture').digest('hex'),sizeBytes:7,width:16,height:16,duration:0,hasAudio:false,createdAt:stamp});
  timeline=await f.services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),trackId:timeline.tracks[0].id,assetId:id,startFrame:15,durationFrames:30});
  const before=f.state(),home=createProjectHomeServices(f.store,{readRecentOpened:()=>({[project.id]:'2026-10-19T02:00:00.000Z'})}),[summary]=home.handlers['project.summary.list']();
  assert.deepEqual(f.state(),before);assert.deepEqual([summary.width,summary.height,summary.durationFrames],[720,1280,45]);
  assert.deepEqual(summary.cover,{assetId:id,mimeType:'image/png',url:`/media/${id}`});assert.equal(summary.lastOpenedAt,'2026-10-19T02:00:00.000Z');
  assert.equal(summary.updatedAt,stamp);assert.deepEqual(f.store.get('projects',project.id),project);
});
