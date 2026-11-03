import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {startServer} from '../apps/server/src/index.ts';
import {lastProjectEnvelopeSchema} from '../packages/contracts/src/last-project.ts';
import {projectRpcPath} from '../packages/contracts/src/project-file.ts';
import {run} from '../packages/business/src/media.ts';
import {createHash} from 'node:crypto';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {openServerProject} from './helpers/project-database.ts';
import {prepareNativeQaProject,closeQaProject,captureNativeQa,readNativeQaDocument,checkedNativeMetadata,checkedNativeApplication,importNativeQaAsset,nativeQaAssetFile,coldNativeQaAssetFile,coldNativeQaMediaSnapshot} from './helpers/native-local-qa-fixture.ts';
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
 try{assert.throws(()=>captureNativeQa(root),{code:'APP_LIBRARY_LOCKED'});await assert.rejects(coldNativeQaAssetFile(root,fixture.project.id,randomUUID()),{code:'APP_LIBRARY_LOCKED'});assert.equal(app.db.prepare('SELECT total_changes() AS n').get()!.n,changes);}finally{app.close();}
 const store=openServerProject(root,fixture.project.id);const rows=store.db.prepare('SELECT * FROM projects').all();
 try{assert.throws(()=>captureNativeQa(root),{code:'PROJECT_LOCKED'});await assert.rejects(coldNativeQaAssetFile(root,fixture.project.id,randomUUID()),{code:'PROJECT_LOCKED'});assert.deepEqual(store.db.prepare('SELECT * FROM projects').all(),rows);}finally{store.close();}
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

test('native QA imports video with real prepare CAS and resolves current references through held B1 and cold owners',async t=>{
 const root=directory(t),fixture=await prepareNativeQaProject(root,'Reference QA'),source=path.join(fixture.store.tempDir,randomUUID()+'.mp4');
 await run('ffmpeg',['-nostdin','-v','error','-n','-f','lavfi','-i','color=c=0x336699:s=32x32:r=30:d=1','-c:v','libx264','-threads','1','-pix_fmt','yuv420p',source]);
 const bytes=readFileSync(source),expected=createHash('sha256').update(bytes).digest('hex');
 const asset=await importNativeQaAsset(fixture,{projectId:fixture.project.id,name:'Real reference.mp4',mimeType:'video/mp4',dataBase64:bytes.toString('base64')});
 assert.equal(asset.sha256,expected);assert.equal(asset.hashState,'full');
 const proof=await nativeQaAssetFile(fixture.store,asset.id);assert.equal(proof.sha256,expected);assert.equal(proof.bytes,bytes.length);assert.ok(!proof.projectRelativeFile.startsWith('../')&&path.extname(proof.file)==='.mp4');
 const prior=JSON.stringify(fixture.store.get('assets',asset.id));await assert.rejects(fixture.services.call('asset.media.prepare',{projectId:fixture.project.id,assets:[{assetId:asset.id,referenceRevision:asset.referenceRevision+1}],purpose:'timeline'}),{code:'REVISION_CONFLICT'});assert.equal(JSON.stringify(fixture.store.get('assets',asset.id)),prior);
 await closeQaProject(fixture);const cold=await coldNativeQaAssetFile(root,fixture.project.id,asset.id);assert.deepEqual(cold,proof);const media=coldNativeQaMediaSnapshot(root,fixture.project.id);assert.deepEqual(media,[{name:proof.projectRelativeFile,bytes:bytes.length,sha256:expected}]);
});

test('cold media inventory includes ordinary generated and export files, including unregistered leftovers',async t=>{
 const root=directory(t),fixture=await prepareNativeQaProject(root,'S2 media oracle'),projectDir=fixture.store.projectDir;
 const expected=[];
 for(const [folder,name] of [['生成','预演 🎬.png'],['导出','成片.mp4']] as const){const directory=path.join(projectDir,folder);mkdirSync(directory,{mode:0o755});const bytes=Buffer.from(`Unregistered S2 inventory sentinel ${folder}`);writeFileSync(path.join(directory,name),bytes,{mode:0o644});expected.push({name:folder+'/'+name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
 await closeQaProject(fixture);assert.deepEqual(coldNativeQaMediaSnapshot(root,fixture.project.id),expected);
});
