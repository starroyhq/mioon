import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {startServer} from '../apps/server/src/index.ts';
import {schemas} from '@mioon/contracts';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {uploadProjectFile} from '../apps/desktop/src/project-file-open.ts';
import {buildSampleProject,openWorkspace,tempRoot,cleanup,mediaToolsAvailable} from './helpers/project-package-fixture.ts';

const token='synthetic-project-package-http-token';
async function call(base:string,route:string,init:RequestInit={}){
 const response=await fetch(base+route,{...init,headers:{authorization:`Bearer ${token}`,...(init.body&&typeof init.body==='string'?{'content-type':'application/json'}:{}),...init.headers}});
 const body=await response.json() as any;return {status:response.status,body};
}

test('project files work over HTTP and stay out of the RPC and MCP catalog',{skip:!mediaToolsAvailable&&'ffmpeg unavailable'},async t=>{
 for(const name of ['project.export','project.import','project.duplicate'])assert.equal(Object.hasOwn(schemas,name),false);
 const root=tempRoot('package-http');t.after(()=>cleanup(root));
 const ws=openWorkspace(root),sample=await buildSampleProject(root,ws);ws.store.close();
 const server:any=await startServer({dataDir:root,port:0,token});t.after(()=>server.close());
 const base=server.url;
 assert.equal((await fetch(`${base}/api/projects/${sample.project.id}/package-preview`)).status,401);
 const preview=await call(base,`/api/projects/${sample.project.id}/package-preview?media=used`);
 assert.equal(preview.status,200);assert.equal(preview.body.data.assets.total,5);
 const started=await call(base,'/api/project-packages/exports',{method:'POST',body:JSON.stringify({projectId:sample.project.id,media:'all'})});
 assert.equal(started.status,200);
 let status=started.body.data;
 for(let i=0;i<200&&status.phase==='running';i++){await pause(20);status=(await call(base,`/api/project-packages/exports/${status.id}`)).body.data;}
 assert.equal(status.phase,'ready');
 const download=await fetch(`${base}/api/project-packages/exports/${status.id}/download`,{headers:{authorization:`Bearer ${token}`}});
 assert.equal(download.status,200);assert.equal(download.headers.get('content-type'),'application/vnd.mioon.project');
 assert.match(download.headers.get('content-disposition')??'',/filename\*=UTF-8''UI%20%E8%B5%B0%E6%9F%A5%E9%A1%B9%E7%9B%AE\.mioon/u);
 const bytes=Buffer.from(await download.arrayBuffer());assert.equal(bytes.length,Number(download.headers.get('content-length')));
 const staged=await call(base,'/api/project-packages/imports',{method:'POST',body:bytes,headers:{'content-type':'application/octet-stream'}});
 assert.equal(staged.status,200);assert.equal(staged.body.data.suggestedName,'UI 走查项目（2）');
 const bad=await call(base,'/api/project-packages/imports',{method:'POST',body:Buffer.from('nope'),headers:{'content-type':'application/octet-stream'}});
 assert.equal(bad.status,400);assert.equal(bad.body.error.code,'PROJECT_PACKAGE_NOT_MIOON');
 // The desktop streams OS-opened files with source=open-file; one window collects each.
 const file=path.join(root,'opened.mioon');writeFileSync(file,bytes);
 await uploadProjectFile({base,token,file});
 const opened=await call(base,'/api/project-packages/imports/opened');
 assert.equal(opened.status,200);assert.equal(opened.body.data.preview.suggestedName,'UI 走查项目（2）');
 assert.equal((await call(base,'/api/project-packages/imports/opened')).body.data.preview,null);
 await call(base,`/api/project-packages/imports/${opened.body.data.preview.id}`,{method:'DELETE'});
 writeFileSync(file,'nope');
 await assert.rejects(uploadProjectFile({base,token,file}),{code:'PROJECT_PACKAGE_NOT_MIOON'});
 assert.equal((await call(base,'/api/project-packages/imports?source=elsewhere',{method:'POST',body:bytes,headers:{'content-type':'application/octet-stream'}})).status,400);
 const committed=await call(base,`/api/project-packages/imports/${staged.body.data.id}/commit`,{method:'POST',body:JSON.stringify({requestId:randomUUID(),name:'  导入的项目  '})});
 assert.equal(committed.status,200);
 const imported:any=(await call(base,'/api/rpc',{method:'POST',body:JSON.stringify({operation:'project.get',input:{projectId:committed.body.data.projectId}})})).body.data;
 assert.equal((imported.project??imported).name,'导入的项目');
 const jobs:any=(await call(base,'/api/rpc',{method:'POST',body:JSON.stringify({operation:'task.disposition.list',input:{projectId:committed.body.data.projectId,targets:(imported.jobs??[]).map((job:any)=>({kind:'generation',taskId:job.id}))}})})).body;
 assert.equal(imported.jobs.length,1);assert.deepEqual(jobs.data.items.map((item:any)=>item.archived),[true],'imported generations are archived out of the task center');
 const copy=await call(base,'/api/project-packages/duplicates',{method:'POST',body:JSON.stringify({projectId:sample.project.id,requestId:randomUUID(),name:'UI 走查项目 副本'})});
 assert.equal(copy.status,200);
 assert.equal((await call(base,`/api/project-packages/exports/${status.id}`,{method:'DELETE'})).status,200);
 assert.equal((await call(base,`/api/project-packages/exports/${status.id}`)).status,404);
});
