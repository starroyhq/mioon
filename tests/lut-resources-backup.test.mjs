import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync,lstatSync,writeFileSync} from 'node:fs';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
import {openStore,getWorkspaceRestoreContext} from '../packages/business/src/db.mjs';import {createServices} from '../packages/business/src/services.mjs';
import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.mjs';import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.mjs';
import {isWorkspaceBackupPayloadPath} from '../packages/contracts/src/workspace-backup.mjs';
const text='# retained lexical original\r\nTITLE "Resource portable"\r\nLUT_3D_SIZE 2\r\n0 0 0\r\n1 0 0\r\n0 1 0\r\n1 1 0\r\n0 0 1\r\n1 0 1\r\n0 1 1\r\n1 1 1';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function source(t,sourceSchema=32){const base=mkdtempSync(path.join(os.tmpdir(),'mioon-lut-backup-'));t.after(()=>rmSync(base,{recursive:true,force:true}));const root=path.join(base,'source'),store=openStore(root),s=createServices(store,new Map());const project=await s.call('project.create',{name:'Portable LUT'}),input={projectId:project.id,requestId:'portable-resource-request',name:'look.cube',dataBase64:Buffer.from(text).toString('base64')},response=await s.call('lut.import',input);await s.drain();if(sourceSchema===32)store.db.exec('DELETE FROM schema_version WHERE version=34'); /* Explicit historical PNG-generation fixture. */ store.close();return {base,root,input,response,backup:path.join(base,'backup'),restored:path.join(base,'restored')};}
for(const sourceSchema of [32,34])test(`offline cold capture and restore${sourceSchema+1} preserve exact bytes/hash/receipt without .cube media path`,async t=>{
 const f=await source(t,sourceSchema),created=await createWorkspaceBackup({source:f.root,destination:f.backup});assert.equal(created.databaseSchemaVersion,sourceSchema);assert.equal(created.inventory.complete,true);
 const verified=await verifyWorkspaceBackup({directory:f.backup});assert.equal(verified.integrity,'verified');
 const manifest=JSON.parse(readFileSync(path.join(f.backup,'manifest.json'),'utf8'));assert.deepEqual(manifest.entries.map(e=>e.path),['payload/workbench.sqlite']);
 assert.equal(isWorkspaceBackupPayloadPath('payload/media/11111111-1111-4111-8111-111111111111.cube'),false);
 const original=readFileSync(path.join(f.root,'workbench.sqlite'));assert.equal(sha(readFileSync(path.join(f.backup,'payload/workbench.sqlite'))),sha(original));
 const restored=await restoreWorkspaceBackup({directory:f.backup,destination:f.restored});assert.equal(restored.databaseSchemaVersion,sourceSchema+1);
 const store=openStore(f.restored),s=createServices(store,new Map());try{
  assert.equal(getWorkspaceRestoreContext(store).schemaVersion,sourceSchema+1);
  assert.deepEqual((await s.call('lut.inspect',{projectId:f.input.projectId,lutId:f.response.resource.id})).resource,f.response.resource);
  assert.deepEqual((await s.call('lut.list',{projectId:f.input.projectId})).items,[f.response.resource]);
  assert.deepEqual(Buffer.from(store.db.prepare('SELECT content FROM project_lut_resources').get().content),Buffer.from(text));
  assert.equal(store.db.prepare('SELECT inputHash FROM lut_import_requests').get().inputHash.length,64);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM workspace_restore_holds WHERE kind IN ('project_lut_resources','lut_import_requests')").get().n,2);
  await assert.rejects(s.call('lut.import',f.input),{code:'RESTORE_OPERATION_UNAVAILABLE'});
  const info=await s.call('workspace.restore.inspect',{});assert.equal(info.operationPolicy.find(p=>p.operation==='lut.list').available,true);assert.equal(info.operationPolicy.find(p=>p.operation==='lut.import').available,false);
  assert.deepEqual(readdirSync(path.join(f.restored,'media')),[]);
 }finally{await s.drain();store.close();}
 assert.equal(sha(readFileSync(path.join(f.root,'workbench.sqlite'))),sha(original),'source untouched');
 await assert.rejects(createWorkspaceBackup({source:f.restored,destination:path.join(f.base,'restored-backup')}),{code:'RESTORE_BACKUP_UNAVAILABLE'});
});
test('cold capture refuses corrupt owned LUT bytes before producing a complete backup',async t=>{
 const f=await source(t),db=new DatabaseSync(path.join(f.root,'workbench.sqlite'));db.exec('DROP TRIGGER immutable_project_lut_resources;');db.prepare('UPDATE project_lut_resources SET content=?').run(Buffer.from(text.replace('Resource portable','Resource corrupt!')));db.close();
 await assert.rejects(createWorkspaceBackup({source:f.root,destination:f.backup}));assert.throws(()=>lstatSync(path.join(f.backup,'COMPLETE.json')));
});
