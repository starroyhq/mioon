import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {startServer} from '../apps/server/src/index.ts';
import {projectRenameInputSchema, projectDeleteInputSchema} from '../packages/contracts/src/project-lifecycle.ts';

test('rename uses real registry CAS and exact replay; delete keeps its explicit unavailable boundary',async t=>{
 const root=realpathSync(mkdtempSync(path.join(tmpdir(),'mioon-project-lifecycle-'))),token='synthetic-project-lifecycle-token';
 const server=await startServer({dataDir:root,port:0,token});t.after(async()=>{await server.close();rmSync(root,{recursive:true,force:true});});
 const call=async(operation:string,input:unknown)=>{
  const response=await fetch(server.url+'/api/rpc',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({operation,input})});
  return {status:response.status,body:await response.json() as {ok:boolean;data:Record<string,unknown>;error?:{code:string}}};
 };
 const a=await call('project.create',{name:'Rename me'}),b=await call('project.create',{name:'Keep me'}),id=String(a.body.data.id);
 const input={requestId:randomUUID(),projectId:id,expectedRevision:1,name:'  Renamed  '};
 assert.equal(projectRenameInputSchema.parse(input).name,'Renamed');
 const remove={requestId:randomUUID(),projectId:id,expectedRevision:1,confirmPermanentDeletion:true};
 for(const value of [{...remove,confirmPermanentDeletion:false},{...remove,archive:true},{projectId:id}])assert.equal(projectDeleteInputSchema.safeParse(value).success,false);
 const result=await call('project.rename',input);assert.equal(result.status,200);assert.equal(result.body.data.name,'Renamed');assert.equal(result.body.data.revision,2);
 assert.deepEqual(await call('project.rename',input),result);
 assert.equal((await call('project.rename',{...input,name:'Different'})).body.error?.code,'IDEMPOTENCY_CONFLICT');
 assert.equal((await call('project.rename',{...input,requestId:randomUUID()})).body.error?.code,'REVISION_CONFLICT');
 const listed=await call('project.list',{});assert.ok(Array.isArray(listed.body.data));
 assert.equal((listed.body.data as Record<string,unknown>[]).find(row=>row.id===b.body.data.id)?.name,'Keep me');
 const denied=await call('project.delete',{...remove,expectedRevision:2});assert.equal(denied.status,409);assert.equal(denied.body.error?.code,'PROJECT_DELETE_UNAVAILABLE');
 assert.deepEqual(await call('project.list',{}),listed);
});
