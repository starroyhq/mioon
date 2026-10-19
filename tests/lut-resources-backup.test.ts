import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync,lstatSync,writeFileSync} from 'node:fs';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
import {openStore,getWorkspaceRestoreContext} from '../packages/business/src/db.ts';import {createServices} from '../packages/business/src/services.ts';
import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import {isWorkspaceBackupPayloadPath} from '../packages/contracts/src/workspace-backup.ts';
const text='# retained lexical original\r\nTITLE "Resource portable"\r\nLUT_3D_SIZE 2\r\n0 0 0\r\n1 0 0\r\n0 1 0\r\n1 1 0\r\n0 0 1\r\n1 0 1\r\n0 1 1\r\n1 1 1';
const sha=(bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
interface ProjectView { id: string }
interface LutImportResponse { resource: { id: string } }
interface LutImportInput { projectId: string; requestId: string; name: string; dataBase64: string }
interface BackupCreated { databaseSchemaVersion: number; inventory: { complete: boolean } }
interface BackupVerified { integrity: string }
interface RestoreInfo { operationPolicy: { operation: string; available: boolean }[] }
async function source(t: import('node:test').TestContext) {
 const base=mkdtempSync(path.join(os.tmpdir(),'mioon-lut-backup-'));t.after(()=>rmSync(base,{recursive:true,force:true}));
 const root=path.join(base,'source'),store=openStore(root),s=createServices(store,new Map());
 const project=await s.call('project.create',{name:'Portable LUT'}) as ProjectView;
 const input: LutImportInput={projectId:project.id,requestId:'portable-resource-request',name:'look.cube',dataBase64:Buffer.from(text).toString('base64')};
 const response=await s.call('lut.import',input) as LutImportResponse;await s.drain();store.close();
 return {base,root,input,response,backup:path.join(base,'backup'),restored:path.join(base,'restored')};
}
for(const sourceSchema of [48])test(`offline cold capture and restore${sourceSchema+1} preserve exact bytes/hash/receipt without .cube media path`,async t=>{
 const f=await source(t),created=await createWorkspaceBackup({source:f.root,destination:f.backup}) as BackupCreated;assert.equal(created.databaseSchemaVersion,sourceSchema);assert.equal(created.inventory.complete,true);
 const verified=await verifyWorkspaceBackup({directory:f.backup}) as BackupVerified;assert.equal(verified.integrity,'verified');
 const manifest=JSON.parse(readFileSync(path.join(f.backup,'manifest.json'),'utf8'));assert.deepEqual((manifest as {entries: {path: string}[]}).entries.map((e: {path: string})=>e.path),['payload/workbench.sqlite']);
 assert.equal(isWorkspaceBackupPayloadPath('payload/media/11111111-1111-4111-8111-111111111111.cube'),false);
 const original=readFileSync(path.join(f.root,'workbench.sqlite'));assert.equal(sha(readFileSync(path.join(f.backup,'payload/workbench.sqlite'))),sha(original));
 const restored=await restoreWorkspaceBackup({directory:f.backup,destination:f.restored});assert.equal(restored.databaseSchemaVersion,sourceSchema+1);
 const store=openStore(f.restored),s=createServices(store,new Map());try{
  const restoreContext=getWorkspaceRestoreContext(store);assert.ok(restoreContext);assert.equal(restoreContext.schemaVersion,sourceSchema+1);
  assert.deepEqual((await s.call('lut.inspect',{projectId:f.input.projectId,lutId:f.response.resource.id}) as {resource: unknown}).resource,f.response.resource);
  assert.deepEqual((await s.call('lut.list',{projectId:f.input.projectId}) as {items: unknown[]}).items,[f.response.resource]);
  const contentRow=store.db.prepare('SELECT content FROM project_lut_resources').get() as {content: Uint8Array} | undefined;assert.ok(contentRow);assert.deepEqual(Buffer.from(contentRow.content),Buffer.from(text));
  const hashRow=store.db.prepare('SELECT inputHash FROM lut_import_requests').get() as {inputHash: string} | undefined;assert.ok(hashRow);assert.equal(hashRow.inputHash.length,64);
  const holdRow=store.db.prepare("SELECT count(*) AS n FROM workspace_restore_holds WHERE kind IN ('project_lut_resources','lut_import_requests')").get() as {n: number} | undefined;assert.ok(holdRow);assert.equal(holdRow.n,2);
  await assert.rejects(s.call('lut.import',f.input),{code:'RESTORE_OPERATION_UNAVAILABLE'});
  const info=await s.call('workspace.restore.inspect',{}) as RestoreInfo;const listPolicy=info.operationPolicy.find((p: {operation: string})=>p.operation==='lut.list');const importPolicy=info.operationPolicy.find((p: {operation: string})=>p.operation==='lut.import');assert.ok(listPolicy);assert.ok(importPolicy);assert.equal(listPolicy.available,true);assert.equal(importPolicy.available,false);
  assert.deepEqual(readdirSync(path.join(f.restored,'media')),[]);
 }finally{await s.drain();store.close();}
 assert.equal(sha(readFileSync(path.join(f.root,'workbench.sqlite'))),sha(original),'source untouched');
 await assert.rejects(createWorkspaceBackup({source:f.restored,destination:path.join(f.base,'restored-backup')}),{code:'RESTORE_BACKUP_UNAVAILABLE'});
});
test('cold capture refuses corrupt owned LUT bytes before producing a complete backup',async t=>{
 const f=await source(t),db=new DatabaseSync(path.join(f.root,'workbench.sqlite'));db.exec('DROP TRIGGER immutable_project_lut_resources;');db.prepare('UPDATE project_lut_resources SET content=?').run(Buffer.from(text.replace('Resource portable','Resource corrupt!')));db.close();
 await assert.rejects(createWorkspaceBackup({source:f.root,destination:f.backup}));assert.throws(()=>lstatSync(path.join(f.backup,'COMPLETE.json')));
});
