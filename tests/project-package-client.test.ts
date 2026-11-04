import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {startServer} from '../apps/server/src/index.ts';
import type {InspectApplication, InspectProject} from '../apps/server/src/index.ts';
import type {DatabaseSync} from 'node:sqlite';
import {exportProjectPackage, importProjectPackage, duplicateProject} from '../packages/client/src/project-package.ts';
import {tempRoot, cleanup} from './helpers/project-package-fixture.ts';
import {readProjectState, changeMarks} from './helpers/project-state.ts';

test('project clients preserve local IO boundaries and exact unavailable errors without changing a real host', async t => {
 const root=tempRoot('package-client'), work=tempRoot('package-client-output'), token='synthetic-project-package-client-token';
 let app!:InspectApplication, project!:InspectProject;
 const server=await startServer({dataDir:root,port:0,token,inspectApplication:read=>{app=read;},inspectProject:read=>{project=read;}});
 t.after(async()=>{await server.close();cleanup(root,work);});
 const rpc=async(operation:string,input:unknown)=>{
  const response=await fetch(server.url+'/api/rpc',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({operation,input})});
  const body=await response.json() as {ok:boolean;data:{id:string}};assert.equal(response.status,200);assert.equal(body.ok,true);return body.data;
 };
 const created=await rpc('project.create',{name:'Package boundary'});
 const response=await fetch(server.url+`/api/projects/${created.id}/rpc`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({operation:'project.get',input:{projectId:created.id}})});
 assert.equal(response.status,200);await response.arrayBuffer();
 const snapshot=(db:DatabaseSync)=>({...readProjectState(db),marks:changeMarks(db)});
 const before={app:app(snapshot),project:project(created.id,snapshot),files:readdirSync(root,{recursive:true}).sort()};
 const env={MIOON_BASE_URL:server.url,MIOON_TOKEN:token}, output=path.join(work,'out.mioon');
 await assert.rejects(exportProjectPackage({projectId:created.id},output,{env}),{code:'NOT_FOUND',status:404});
 assert.equal(existsSync(output),false,'a rejected export closes and removes its exclusive output');
 const taken=path.join(work,'taken.mioon');writeFileSync(taken,'keep');
 await assert.rejects(exportProjectPackage({projectId:created.id},taken,{env}),{code:'OUTPUT_EXISTS'});assert.equal(readFileSync(taken,'utf8'),'keep');
 const input=path.join(work,'selected.mioon');writeFileSync(input,'explicit synthetic input');
 await assert.rejects(importProjectPackage({},input,{env}),{code:'VALIDATION_ERROR'});
 await assert.rejects(importProjectPackage({requestId:randomUUID()},input,{env}),{code:'NOT_FOUND',status:404});
 let duplicateRequests=0;
 await assert.rejects(duplicateProject({projectId:created.id,requestId:randomUUID(),name:'Unavailable duplicate'},{env,fetchImpl:async()=>{duplicateRequests++;throw Error('duplicate must not use the network');}}),{code:'PROJECT_COPY_UNAVAILABLE',status:409});
 assert.equal(duplicateRequests,0,'the retired duplicate client refuses before backend lookup or network');
 assert.equal(readFileSync(input,'utf8'),'explicit synthetic input');
 assert.deepEqual({app:app(snapshot),project:project(created.id,snapshot),files:readdirSync(root,{recursive:true}).sort()},before);
});

test('the retired duplicate helper never reads connection options or contacts a backend', async () => {
 let reads=0,requests=0;
 const options={get env():NodeJS.ProcessEnv{reads++;throw Error('connection options must not be inspected');},fetchImpl:async()=>{requests++;throw Error('network must not be used');}};
 for(const input of [{},{projectId:randomUUID(),requestId:randomUUID()},{projectId:randomUUID(),requestId:randomUUID(),name:'Explicit copy'}])
  await assert.rejects(duplicateProject(input,options),{code:'PROJECT_COPY_UNAVAILABLE',status:409});
 assert.equal(reads,0);assert.equal(requests,0);
});
