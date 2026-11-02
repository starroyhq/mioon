import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProjectCoverHttp, writeProjectCover, PROJECT_COVER_LIMITS} from '../apps/server/src/project-host/covers.ts';
import {serverAppDirectories, projectLocation} from '../apps/server/src/project-host/directories.ts';
import {projectSummaryCoverSchema, projectSummarySchema} from '../packages/contracts/src/project-home.ts';
import type {RecentProjectSummary} from '../packages/contracts/src/project-registry.ts';

// A bounded JPEG container for the existing header-only cover dimension check.
function jpeg(width=512, height=256): Buffer {
  return Buffer.from([0xff,0xd8,0xff,0xc0,0,17,8,height>>8,height&255,width>>8,width&255,3,1,0x22,0,2,0x11,1,3,0x11,1,0xff,0xda,0,12,3,1,0,2,0x11,3,0x11,0,0x3f,0,0x12,0x34,0xff,0xd9]);
}
async function fixture(t: TestContext) {
  const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-project-covers-')),directories=serverAppDirectories(root),projectId=randomUUID();
  const source={assetId:randomUUID(),mimeType:'video/mp4' as const,sourceSha256:'a'.repeat(64)},bytes=jpeg();
  const summary:RecentProjectSummary={description:'',revision:1,createdAt:'2026-11-02T00:00:00.000Z',updatedAt:'2026-11-02T00:00:00.000Z',fps:30,width:720,height:1280,presetId:'portrait_720',shotCount:1,durationFrames:30,cover:{assetId:source.assetId,mimeType:source.mimeType}};
  let registry:RecentProjectSummary|null=summary,reads=0;
  const handler=createProjectCoverHttp({directories,readProject:id=>{reads++;return id===projectId?{summary:registry}:null;}});
  const server=createServer((req,res)=>{void handler(req,res,new URL(req.url!,'http://localhost')).then(handled=>{if(!handled){res.writeHead(404);res.end();}});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');
  t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(root,{recursive:true,force:true});});
  const cacheDir=projectLocation(directories,projectId).cacheDir;
  return {root,projectId,source,bytes,cacheDir,summary,reads:()=>reads,registry:(value:RecentProjectSummary|null)=>{registry=value;},
    get:(suffix='',method='GET')=>fetch(`http://127.0.0.1:${address.port}/api/project-covers/${projectId}${suffix}`,{method}),
    save:()=>writeProjectCover({cacheDir,source,jpeg:bytes})};
}

test('closed-project covers read only cache and never create missing storage',async t=>{
  const f=await fixture(t);
  assert.equal((await f.get()).status,404);assert.equal(existsSync(f.cacheDir),false);
  f.save();const response=await f.get();assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/jpeg');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),f.bytes);
  const metadata=JSON.parse(readFileSync(path.join(f.cacheDir,'cover.json'),'utf8'));
  assert.equal(metadata.assetId,f.source.assetId);assert.equal(metadata.sourceSha256,f.source.sourceSha256);
  assert.equal(existsSync(path.join(f.root,'app-library.db')),false);assert.equal(existsSync(path.join(f.root,'workbench.sqlite')),false);
});

test('stale registry cover, malformed receipt, changed JPEG and unsafe cached file return 404',async t=>{
  const f=await fixture(t);f.save();
  f.registry({...f.summary,cover:{assetId:randomUUID(),mimeType:'video/mp4'}});assert.equal((await f.get()).status,404);
  f.registry(f.summary);
  writeFileSync(path.join(f.cacheDir,'cover.json'),'{',{mode:0o600});assert.equal((await f.get()).status,404);
  f.save();writeFileSync(path.join(f.cacheDir,'cover.jpg'),jpeg(256,512),{mode:0o600});assert.equal((await f.get()).status,404);
  f.save();rmSync(path.join(f.cacheDir,'cover.jpg'));symlinkSync(path.join(f.cacheDir,'cover.json'),path.join(f.cacheDir,'cover.jpg'));assert.equal((await f.get()).status,404);
});

test('writer rejects invalid or oversized images and preserves the last verified pair',async t=>{
  const f=await fixture(t);f.save();const before=readFileSync(path.join(f.cacheDir,'cover.json'));
  for(const bytes of [Buffer.from('PNG'),jpeg(513,256),Buffer.alloc(PROJECT_COVER_LIMITS.jpegBytes+1)])assert.throws(()=>writeProjectCover({cacheDir:f.cacheDir,source:f.source,jpeg:bytes}));
  assert.deepEqual(readFileSync(path.join(f.cacheDir,'cover.json')),before);assert.equal((await f.get()).status,200);
});

test('cover endpoint rejects query strings and methods before reading the registry',async t=>{
  const f=await fixture(t);f.save();assert.equal((await f.get('?path=private')).status,404);assert.equal((await f.get('','POST')).status,405);
  assert.equal(f.reads(),0);
  f.registry(null);assert.equal((await f.get()).status,404);
});

test('home cover contract binds the application cache URL to the project ID',async t=>{
  const f=await fixture(t),cover={assetId:f.source.assetId,mimeType:f.source.mimeType,url:`/api/project-covers/${f.projectId}`};
  assert.equal(projectSummaryCoverSchema.safeParse(cover).success,true);
  assert.equal(projectSummaryCoverSchema.safeParse({...cover,url:`/media/${f.source.assetId}`}).success,false);
  const summary={...f.summary,id:f.projectId,name:'Film',lastOpenedAt:null,cover};
  assert.equal(projectSummarySchema.safeParse(summary).success,true);
  assert.equal(projectSummarySchema.safeParse({...summary,cover:{...cover,url:`/api/project-covers/${randomUUID()}`}}).success,false);
});
