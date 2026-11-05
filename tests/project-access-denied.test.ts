import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {createProjectFile,openProjectConnection,recoverProjectFile} from '../packages/business/src/project-file/connection.ts';
import {AppError} from '../packages/contracts/src/app-error.ts';
import {projectAddressErrorDetailsSchemas,projectOpenFailureSchema} from '../packages/contracts/src/project-file.ts';
import {projectEntryAvailabilitySchema} from '../packages/contracts/src/project-entry.ts';
import {asProjectUnavailable} from '../apps/server/src/project-host/errors.ts';

test('EACCES and EPERM at path inspection or header open remain independent access-denied failures',async t=>{
 const root=fs.mkdtempSync(path.join(tmpdir(),'mioon-access-denied-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'project.mioon'),id=createProjectFile(file),before=fs.readFileSync(file);
 for(const method of ['lstatSync','openSync'] as const)for(const code of ['EACCES','EPERM'])await t.test(`${method}/${code}`,()=>{
  const original=fs[method];
  const replacement=(...args:unknown[])=>{if(String(args[0])===file)throw Object.assign(new Error('SYNTHETIC_PRIVATE_OS_DIAGNOSTIC'),{code});return Reflect.apply(original,fs,args);};
  const mocked=t.mock.method(fs,method,replacement as typeof original);syncBuiltinESMExports();
  try{
   let located=false;
   assert.throws(()=>openProjectConnection({projectFile:file,locate:()=>{located=true;throw Error('Must not create private records');}}),error=>{
    assert.ok(error instanceof AppError);assert.equal(error.code,'PROJECT_ACCESS_DENIED');assert.equal(error.status,403);assert.equal((error.details as {reason?:unknown}).reason,'access-denied');
    assert.equal(projectOpenFailureSchema.safeParse({code:error.code,projectFile:file,projectId:null}).success,true);
    assert.equal(String(error).includes('SYNTHETIC_PRIVATE_OS_DIAGNOSTIC'),false);
    const wrapped=asProjectUnavailable(id,error);assert.ok(wrapped instanceof AppError);assert.equal(wrapped.code,'PROJECT_UNAVAILABLE');
    assert.deepEqual(wrapped.details,{projectId:id,reason:'PROJECT_ACCESS_DENIED'});assert.equal(projectAddressErrorDetailsSchemas.PROJECT_UNAVAILABLE.safeParse(wrapped.details).success,true);return true;
   });
   assert.equal(located,false);
   if(method==='lstatSync')assert.deepEqual(recoverProjectFile(file),{state:'access-denied'});
  }finally{mocked.mock.restore();syncBuiltinESMExports();}
  assert.deepEqual(fs.readFileSync(file),before);
 });
 assert.equal(projectEntryAvailabilitySchema.safeParse({state:'access-denied'}).success,true);
 assert.equal(projectEntryAvailabilitySchema.safeParse({state:'invalid',reason:'access-denied'}).success,false,'permission is not a damage reason');
});
