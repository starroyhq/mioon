import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {startServer} from '../apps/server/src/index.ts';
import {lastProjectEnvelopeSchema} from '../packages/contracts/src/last-project.ts';
import {projectRpcPath} from '../packages/contracts/src/project-file.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {openServerProject} from './helpers/project-database.ts';
import {prepareNativeQaProject,closeQaProject,captureNativeQa,readNativeQaDocument,checkedNativeMetadata,checkedNativeApplication} from './helpers/native-local-qa-fixture.ts';
function directory(t:test.TestContext){const root=mkdtempSync(path.join(tmpdir(),'mioon-native-qa-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
test('cold native QA captures two actual hosts, every database role and real B1 documents',async t=>{
 const root=directory(t),a=await prepareNativeQaProject(root,'QA A');await closeQaProject(a);
 const b=await prepareNativeQaProject(root,'QA B');await closeQaProject(b);
 const app=openAppLibrary({dataDir:root}),text=JSON.stringify({synthetic:true,projectId:a.project.id});
 app.tx(()=>app.documents.write('last-project-v1.json',text));app.close();
 const captured=captureNativeQa(root);
 assert.equal(captured.rows.projects!.length,2);assert.deepEqual(Object.keys(captured.projectSnapshots).sort(),[a.project.id,b.project.id].sort());
 for(const snapshot of Object.values(captured.projectSnapshots))assert.deepEqual([...new Set(snapshot.schema.map(row=>row.database))].sort(),['cache','main','project']);
 assert.equal(captured.rows['app.app_documents']!.find(row=>row.name==='last-project-v1.json')?.data,text);
 assert.equal(readNativeQaDocument(root,'last-project-v1.json'),text);
 assert.deepEqual(checkedNativeMetadata(captured,captureNativeQa(root)),new Set(captured.metadataTableNames));
});
test('native QA refuses a live B1 or project owner without opening a second SQLite connection',async t=>{
 const root=directory(t),fixture=await prepareNativeQaProject(root,'Locked QA');await closeQaProject(fixture);
 const app=openAppLibrary({dataDir:root});const changes=app.db.prepare('SELECT total_changes() AS n').get()!.n;
 try{assert.throws(()=>captureNativeQa(root),{code:'APP_LIBRARY_LOCKED'});assert.equal(app.db.prepare('SELECT total_changes() AS n').get()!.n,changes);}finally{app.close();}
 const store=openServerProject(root,fixture.project.id);const rows=store.db.prepare('SELECT * FROM projects').all();
 try{assert.throws(()=>captureNativeQa(root),{code:'PROJECT_LOCKED'});assert.deepEqual(store.db.prepare('SELECT * FROM projects').all(),rows);}finally{store.close();}
 assert.equal(captureNativeQa(root).rows.projects!.length,1);
});
test('expected native content metadata advances only its real host and keeps all other fields exact',async t=>{
 const root=directory(t),fixture=await prepareNativeQaProject(root,'Sequence QA');await closeQaProject(fixture);const before=captureNativeQa(root);
 const store=openServerProject(root,fixture.project.id);
 store.tx(()=>store.put('assets',{id:randomUUID(),projectId:fixture.project.id,name:'Metadata only',mimeType:'video/mp4',duration:1,hasAudio:false}));store.close();
 const after=captureNativeQa(root);
 assert.throws(()=>checkedNativeMetadata(before,after),{code:'ERR_ASSERTION'});
 assert.deepEqual(checkedNativeMetadata(before,after,[fixture.project.id]),new Set(after.metadataTableNames));
 const forged=structuredClone(after);forged.kernelMetadata[fixture.project.id]!.project_file![0]!.projectId=randomUUID();
 assert.throws(()=>checkedNativeMetadata(before,forged,[fixture.project.id]),{code:'ERR_ASSERTION'});
});

test('cold native QA validates real acquire summaries and rejects unrelated application or registry changes',async t=>{
 const root=directory(t),fixture=await prepareNativeQaProject(root,'Acquire QA');await fixture.services.call('timeline.get',{projectId:fixture.project.id});await closeQaProject(fixture);
 const before=captureNativeQa(root),server=await startServer({dataDir:root,port:0,token:'native-qa-test-token',localDraftChannel:'production'});
 try{const response=await fetch(server.url+projectRpcPath(fixture.project.id),{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer native-qa-test-token'},body:JSON.stringify({operation:'project.get',input:{projectId:fixture.project.id}})});assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
  const found=await fetch(server.url+'/api/last-project',{headers:{authorization:'Bearer native-qa-test-token'}});assert.equal(found.status,200);const current=lastProjectEnvelopeSchema.parse((await found.json()).data);assert.ok(current.supported);
  const saved=await fetch(server.url+'/api/last-project',{method:'PUT',headers:{authorization:'Bearer native-qa-test-token','content-type':'application/json'},body:JSON.stringify({workspaceScope:current.workspaceScope,instanceId:current.instanceId,expectedRevision:current.revision,projectId:fixture.project.id})});assert.equal(saved.status,200);const accepted=lastProjectEnvelopeSchema.parse((await saved.json()).data);assert.ok(accepted.supported);assert.equal(accepted.revision,1);
 }finally{await server.close();}
 const after=captureNativeQa(root);assert.deepEqual(checkedNativeMetadata(before,after),new Set(after.metadataTableNames));
 assert.deepEqual(checkedNativeApplication(before,after,[fixture.project.id]),new Set(['app.app_documents','app.recent_projects']));
 assert.throws(()=>checkedNativeApplication(before,after,[]),{code:'ERR_ASSERTION'});
 const forged=structuredClone(after),registration=forged.applicationRows['main.recent_projects']![0]!;
 registration.data=JSON.stringify({...JSON.parse(String(registration.data)),projectFile:'/different/project.mioon'});
 assert.throws(()=>checkedNativeApplication(before,forged,[fixture.project.id]),{code:'ERR_ASSERTION'});
 const wrongScope=structuredClone(after),doc=wrongScope.applicationRows['main.app_documents']!.find(row=>row.name==='last-project-v1.json')!;doc.data=JSON.stringify({...JSON.parse(String(doc.data)),workspaceScope:'a'.repeat(64)});assert.throws(()=>checkedNativeApplication(before,wrongScope,[fixture.project.id]),{code:'ERR_ASSERTION'});
 const other=structuredClone(after);other.applicationRows['main.app_documents']!.push({name:'unrelated.json',data:'changed'});
 assert.throws(()=>checkedNativeApplication(before,other,[fixture.project.id]),{code:'ERR_ASSERTION'});
});
