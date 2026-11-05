
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

import {startServer} from '../apps/server/src/index.ts';
import type {InspectApplication,InspectProject} from '../apps/server/src/index.ts';

import {schemaObjects} from './helpers/project-database.ts';
import type {DatabaseSync} from 'node:sqlite';
import {schemas} from '@mioon/contracts';



import {tempRoot, cleanup} from './helpers/project-package-fixture.ts';

const token='synthetic-project-package-http-token';
async function call(base:string,route:string,init:RequestInit={}){
 const response=await fetch(base+route,{...init,headers:{authorization:`Bearer ${token}`,...(init.body&&typeof init.body==='string'?{'content-type':'application/json'}:{}),...init.headers}});
 const body=await response.json() as any;return {status:response.status,body};
}



test('real project hosts refuse legacy package routes and permanent deletion without changing either database owner',async t=>{
 for(const name of ['project.export','project.import','project.duplicate'])assert.equal(Object.hasOwn(schemas,name),false);
 const root=tempRoot('package-unavailable');let application!:InspectApplication,projectStore!:InspectProject;
 const server=await startServer({dataDir:root,port:0,token,inspectApplication:read=>{application=read;},inspectProject:read=>{projectStore=read;}});
 t.after(async()=>{await server.close();cleanup(root);});
 const created=await call(server.url,'/api/rpc',{method:'POST',body:JSON.stringify({operation:'project.create',input:{name:'Real unavailable boundary'}})});
 assert.equal(created.status,200);const project=created.body.data as {id:string;revision:number};
 const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
 const snapshot=(db:DatabaseSync)=>({objects:schemaObjects(db),rows:schemaObjects(db).filter(row=>row.type==='table').map(({schema,name})=>[schema,name,db.prepare(`SELECT * FROM ${quote(schema)}.${quote(name)} ORDER BY rowid`).all()]),changes:db.prepare('SELECT total_changes() AS n').get()!.n});
 const before={application:application(snapshot),project:projectStore(project.id,snapshot)};
 for(const [route,method] of [[`/api/projects/${project.id}/package-preview?media=used`,'GET'],['/api/project-packages/exports','POST'],['/api/project-packages/imports','POST'],['/api/project-packages/duplicates','POST'],['/api/project-packages/save-as','POST']] as const){
  const response=await call(server.url,route,{method,...(method==='POST'?{body:JSON.stringify({projectId:project.id,requestId:randomUUID()})}:{})});
  assert.equal(response.status,404);assert.equal(response.body.error.code,'NOT_FOUND');
 }
 const rejected=await call(server.url,'/api/rpc',{method:'POST',body:JSON.stringify({operation:'project.delete',input:{projectId:project.id,requestId:randomUUID(),expectedRevision:project.revision,confirmPermanentDeletion:true}})});
 assert.equal(rejected.status,400);assert.equal(rejected.body.error.code,'VALIDATION_ERROR');
 assert.deepEqual({application:application(snapshot),project:projectStore(project.id,snapshot)},before,'unavailable maintenance writes no project/application row, receipt, schema or change mark');
});
