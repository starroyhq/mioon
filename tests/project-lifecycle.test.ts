import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {startServer} from './helpers/test-server.ts';
import {projectRenameInputSchema, projectDeleteInputSchema, projectDeleteResponseSchema} from '../packages/contracts/src/project-lifecycle.ts';

test('trash contracts bind the confirmed registration and reject permanent cleanup claims',()=>{
 const input={requestId:randomUUID(),projectId:randomUUID(),expectedRevision:1,projectFile:path.join(process.cwd(),'Confirmed.mioon'),fileIdentity:{dev:'1',ino:'2'},confirmTrash:true};
 assert.deepEqual(projectDeleteInputSchema.parse(input),input);
 const {confirmTrash:_confirmation,...withoutConfirmation}=input;
 for(const value of [withoutConfirmation,{...input,confirmTrash:false},{...input,confirmPermanentDeletion:true},{...input,archive:true},
  {...input,projectFile:'Confirmed.mioon'},{...input,projectFile:path.join(process.cwd(),'Confirmed.sqlite')},
  {...input,fileIdentity:{dev:1,ino:2}},{...input,fileIdentity:{...input.fileIdentity,source:'caller'}},
  {...input,expectedRevision:0}])assert.equal(projectDeleteInputSchema.safeParse(value).success,false);
 const response={requestId:input.requestId,projectId:input.projectId,projectFile:input.projectFile,trashed:true,records:'retained'};
 assert.deepEqual(projectDeleteResponseSchema.parse(response),response);
 for(const value of [{...response,cleanup:'pending'},{...response,deleted:true},{...response,records:'deleted'},
  {requestId:input.requestId,projectId:input.projectId,deleted:true,cleanup:'complete'}])assert.equal(projectDeleteResponseSchema.safeParse(value).success,false);
});

test('rename uses real registry CAS and exact replay; legacy permanent deletion is strictly rejected',async t=>{
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
 const denied=await call('project.delete',{...remove,expectedRevision:2});assert.equal(denied.status,400);assert.equal(denied.body.error?.code,'VALIDATION_ERROR');
 assert.deepEqual(await call('project.list',{}),listed);
});
