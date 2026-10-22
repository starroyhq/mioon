import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {startServer} from '../apps/server/src/index.ts';
import {exportProjectPackage,importProjectPackage,duplicateProject} from '../packages/client/src/project-package.ts';
import {buildSampleProject,openWorkspace,tempRoot,cleanup,mediaToolsAvailable} from './helpers/project-package-fixture.ts';

const token='synthetic-project-package-client-token';
test('the CLI client exports to a new file, imports it with a caller key and duplicates',{skip:!mediaToolsAvailable&&'ffmpeg unavailable'},async t=>{
 const root=tempRoot('package-client'),work=mkdtempSync(path.join(tmpdir(),'mioon-package-cli-'));t.after(()=>cleanup(root,work));
 const ws=openWorkspace(root),sample=await buildSampleProject(root,ws);ws.store.close();
 const server:any=await startServer({dataDir:root,port:0,token});t.after(()=>server.close());
 const env={MIOON_BASE_URL:server.url,MIOON_TOKEN:token};
 const output=path.join(work,'out.mioon'),progress:unknown[]=[];
 const exported=await exportProjectPackage({projectId:sample.project.id},output,{env,onProgress:value=>progress.push(value),intervalMs:20});
 assert.equal(exported.bytes,statSync(output).size);assert.equal(exported.fileName,'UI 走查项目.mioon');
 writeFileSync(path.join(work,'taken.mioon'),'keep');
 await assert.rejects(exportProjectPackage({projectId:sample.project.id},path.join(work,'taken.mioon'),{env}),{code:'OUTPUT_EXISTS'});
 await assert.rejects(importProjectPackage({},output,{env}),{code:'VALIDATION_ERROR'});
 const requestId=randomUUID();
 const imported=await importProjectPackage({requestId},output,{env});
 assert.equal(imported.name,'UI 走查项目（2）');
 const copy=await duplicateProject({projectId:sample.project.id,requestId:randomUUID(),name:'副本'},{env});
 assert.ok(copy.projectId);
});
