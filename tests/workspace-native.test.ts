import {lenientFunction} from './helpers/eval-source.ts';
import {computeFullSha256,isInsideRealDirectory,referencePathForRealFile} from '../packages/business/src/media-reference/index.ts';
import {isProjectFileHeld} from '../packages/business/src/project-file/held-files.ts';
import {isAppLibraryHeld} from '../packages/business/src/app-db/connection.ts';
import {mediaMtimeMs} from '../packages/business/src/media-reference/fingerprint.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import type {TestContext} from 'node:test';
import http from 'node:http';
import {createWorkspaceNativeHost,readNativeBackendMetadata} from '../apps/desktop/src/workspace-native-host.ts';
import {projectApiPath,projectMediaPath,projectRpcPath} from '../packages/contracts/src/project-file.ts';
import {createWorkspaceNativeBridges} from '../apps/desktop/src/workspace-native-preload.ts';
import {workspaceNativeRequestSchema} from '../packages/contracts/src/workspace-native.ts';
import type {ExportOutput} from '../packages/contracts/src/export-controls.ts';
import {PROJECT_OUTPUT_FOLDERS} from '../packages/contracts/src/project-output-publication.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectFile} from '../packages/business/src/project-file/connection.ts';
import {openClosedProjectSnapshotConnection} from '../packages/business/src/project-file/connection.ts';
import type {ProjectBackupInspection,ProjectBackupRestoreResponse} from '../packages/contracts/src/project-backups.ts';
import type {ProjectEntryResponse} from '../packages/contracts/src/project-entry.ts';
import {readProjectBackupNativeActions} from '../apps/web/src/project-backup-native.ts';
const code=(error:unknown)=>(error as {code?:string})?.code==='WORKSPACE_NATIVE_UNAVAILABLE';
function fixture(t:TestContext) {
 const base=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-native-workspace-')),root=path.join(base,'workspace'),media=path.join(root,'导出'),chosen=path.join(base,'chosen');
 fs.mkdirSync(root,{mode:0o700});fs.mkdirSync(media,{mode:0o700});fs.mkdirSync(chosen,{mode:0o755});t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const projectId=randomUUID(),exportId=randomUUID(),assetId=randomUUID(),bytes=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.from([0,0,0,0]),Buffer.from('isommp42')]),file=path.join(media,`${assetId}.mp4`);fs.writeFileSync(file,bytes,{mode:0o600});
 const sha256=createHash('sha256').update(bytes).digest('hex'),fingerprint={sizeBytes:bytes.length,mtimeMs:mediaMtimeMs(fs.lstatSync(file,{bigint:true})),sampledSha256:sha256,fullSha256:sha256};
 const publication:NonNullable<ExportOutput['publication']>={version:1,publicationId:randomUUID(),projectId,assetId,owner:{kind:'export',id:exportId,requestId:exportId,inputHash:sha256},targetKind:'exports',projectRelativePath:`导出/${assetId}.mp4`,sha256,sizeBytes:bytes.length,mimeType:'video/mp4'};
 const output={projectId,exportId,assetId,fileLocation:file,sizeBytes:bytes.length,sha256,url:`/media/${assetId}`,referenceRevision:1,fingerprint,producer:{kind:'export' as const,id:exportId},publication};
 let current=true;const calls:unknown[][]=[];
 const options={ownerForEvent:()=>({projectId,isCurrent:()=>current}),readWorkspaceRoot:async(id:string)=>{assert.equal(id,projectId);return root;},readExport:async(identity:unknown)=>{calls.push(['readExport',identity]);return output;},openPath:async(file:string)=>{calls.push(['open',file]);return '';},revealPath:(file:string)=>{calls.push(['reveal',file]);return;},restart:async()=>{calls.push(['restart']);return true;}};
 return {base,root,chosen,file,output,options,calls,identity:{projectId,exportId},retire:()=>{current=false;}};
}
test('native export open and reveal re-read exact backend identities and verify published bytes before shell effects',async t=>{
 const f=fixture(t),host=createWorkspaceNativeHost(f.options);
  fs.chmodSync(f.root,0o755);
 assert.equal(await host.dispatch({}, {action:'openExport',identity:f.identity}),true);assert.equal(await host.dispatch({}, {action:'revealExport',identity:f.identity}),true);
 assert.deepEqual(f.calls,[['readExport',f.identity],['readExport',f.identity],['open',f.file],['readExport',f.identity],['readExport',f.identity],['reveal',f.file]]);
 await assert.rejects(host.dispatch({}, {action:'openExport',identity:{...f.identity,path:'/arbitrary'}}));
 await assert.rejects(host.dispatch({}, {action:'openExport',identity:{...f.identity,projectId:randomUUID()}}),code);assert.equal(f.calls.length,6);
});
test('modified bytes, symlinks and backend-returned paths outside published exports cannot be opened',async t=>{
 const f=fixture(t),host=createWorkspaceNativeHost(f.options);fs.writeFileSync(f.file,'modified media');
 await assert.rejects(host.dispatch({}, {action:'openExport',identity:f.identity}),code);assert.equal(f.calls.some(call=>call[0]==='open'),false);
 fs.unlinkSync(f.file);const target=path.join(f.base,'external.mp4');fs.writeFileSync(target,'verified synthetic mp4',{mode:0o600});fs.symlinkSync(target,f.file);
 await assert.rejects(host.dispatch({}, {action:'openExport',identity:f.identity}));assert.equal(f.calls.some(call=>call[0]==='open'),false);
 f.options.readExport=async()=>({...f.output,fileLocation:target});await assert.rejects(host.dispatch({}, {action:'openExport',identity:f.identity}),code);
});
test('late export metadata after navigation cannot open a file or disclose a native path',async t=>{
 const f=fixture(t);let finish:(value:typeof f.output)=>void=()=>{};f.options.readExport=()=>new Promise(resolve=>{finish=resolve;});
 const pending=createWorkspaceNativeHost(f.options).dispatch({}, {action:'revealExport',identity:f.identity});f.retire();finish(f.output);await assert.rejects(pending,code);assert.deepEqual(f.calls,[]);
});
test('preload exposes fixed restart, export, package and backup actions without generic path methods',async()=>{
 const calls:unknown[][]=[],bridge=createWorkspaceNativeBridges(async(channel,request)=>{calls.push([channel,request]);return true;});
 assert.equal(await bridge.exports.open({projectId:randomUUID(),exportId:randomUUID()}),true);await bridge.native.restart();
 assert.deepEqual(calls.map(call=>(call[1] as {action:string}).action),['openExport','restart']);assert.ok(calls.every(call=>call[0]==='mioon:workspace-native'));
 await assert.rejects(bridge.exports.reveal({projectId:'invalid',exportId:randomUUID()}));assert.equal(calls.length,2);
 assert.deepEqual(Object.keys(bridge).sort(),['exports','native','projectBackups','projectPackages']);
 assert.deepEqual(Object.keys(bridge.native),['restart']);
});

test('generic restart checks the current owner and retired backup actions never reach native effects',async t=>{
 const f=fixture(t),host=createWorkspaceNativeHost(f.options);
 assert.equal(await host.dispatch({}, {action:'restart'}),true);assert.deepEqual(f.calls,[['restart']]);
 for(const action of ['chooseBackupLocation','revealBackupLocation']){
  assert.equal(workspaceNativeRequestSchema.safeParse({action}).success,false);
  await assert.rejects(host.dispatch({}, {action}),{name:'ZodError'});
 }
 assert.deepEqual(fs.readdirSync(f.chosen),[]);assert.deepEqual(f.calls,[['restart']]);
 f.retire();await assert.rejects(host.dispatch({}, {action:'restart'}),code);assert.deepEqual(f.calls,[['restart']]);
});

test('backend metadata reads go only to fixed app/project reads and one canonical registered-project GET',async(t:TestContext)=>{
 const seen:string[]=[];const server=http.createServer((req,res)=>{seen.push(String(req.url));res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,data:{read:req.url}}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
 const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`,project=randomUUID();
 const read=(resource:string)=>readNativeBackendMetadata({base,token:'t'.repeat(64),resource,...(resource.endsWith('/rpc')?{input:{operation:'export.output.get',input:{}}}:{}),signal:new AbortController().signal,check:()=>{}});
 assert.deepEqual(await read(projectRpcPath(project)),{read:projectRpcPath(project)});
 assert.deepEqual(await read('/api/rpc'),{read:'/api/rpc'});
 assert.deepEqual(await read(projectApiPath(project,'workspace-info')),{read:projectApiPath(project,'workspace-info')});
 assert.deepEqual(await read('/api/ui-preferences'),{read:'/api/ui-preferences'});
 assert.deepEqual(await read(`/api/project-entries/${project}`),{read:`/api/project-entries/${project}`});
 await assert.rejects(readNativeBackendMetadata({base,token:'t'.repeat(64),resource:`/api/project-entries/${project}`,input:{},signal:new AbortController().signal,check:()=>{}}),code);
 for(const resource of ['/api/tasks',projectApiPath(project,'tasks'),projectMediaPath(project,randomUUID()),`/api/projects/${project}/rpc/x`,'https://example.invalid/api/rpc','/api/project-entries',`/api/project-entries/${project}?x=1`,`/api/project-entries/${project}/extra`,`/api/project-entries/${project.toUpperCase()}`])
  await assert.rejects(read(resource),{code:'WORKSPACE_NATIVE_UNAVAILABLE'},resource);
 assert.deepEqual(seen,[projectRpcPath(project),'/api/rpc',projectApiPath(project,'workspace-info'),'/api/ui-preferences',`/api/project-entries/${project}`],'refused resources never reach HTTP');
});

test('native export accepts an ordinary media directory and rejects a different trusted project root',async t=>{
 const f=fixture(t),host=createWorkspaceNativeHost(f.options);
 fs.chmodSync(path.dirname(f.file),0o755);assert.equal(await host.dispatch({}, {action:'openExport',identity:f.identity}),true);f.calls.length=0;
 fs.chmodSync(path.dirname(f.file),0o700);f.options.readWorkspaceRoot=async()=>f.chosen;
 await assert.rejects(host.dispatch({}, {action:'openExport',identity:f.identity}),code);assert.equal(f.calls.some(call=>call[0]==='open'),false);
});

test('native export cannot open a held application database renamed into published exports',async t=>{
 const f=fixture(t),library=openAppLibrary({dataDir:path.join(f.base,'application')});
 try {
  fs.unlinkSync(f.file);fs.renameSync(library.databaseFile,f.file);
  let opens=0;const original=fs.promises.open;t.mock.method(fs.promises,'open',(...args:Parameters<typeof original>)=>{if(String(args[0])===f.file)opens++;return original(...args);});syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  f.options.readExport=async()=>({...f.output,sizeBytes:fs.lstatSync(f.file).size,sha256:'a'.repeat(64),fingerprint:{...f.output.fingerprint,sizeBytes:fs.lstatSync(f.file).size,mtimeMs:mediaMtimeMs(fs.lstatSync(f.file,{bigint:true})),fullSha256:'a'.repeat(64)},publication:{...f.output.publication,sizeBytes:fs.lstatSync(f.file).size,sha256:'a'.repeat(64)}});
  await assert.rejects(createWorkspaceNativeHost(f.options).dispatch({}, {action:'openExport',identity:f.identity}),code);
  assert.equal(opens,0,'held database identity is rejected before descriptor open');assert.equal(f.calls.some(call=>call[0]==='open'),false);
 } finally {library.close();}
});

test('a late project-root metadata reply cannot authorize native export after navigation',async t=>{
 const f=fixture(t),pending=Promise.withResolvers<string>();f.options.readWorkspaceRoot=()=>pending.promise;
 const action=createWorkspaceNativeHost(f.options).dispatch({}, {action:'revealExport',identity:f.identity});
 await new Promise<void>(resolve=>setImmediate(resolve));f.retire();pending.resolve(f.root);
 await assert.rejects(action,code);assert.equal(f.calls.some(call=>call[0]==='reveal'),false);
});


test('ordinary project media supports readable modes and multiple links while proof remains exact',async t=>{
 const f=fixture(t);fs.chmodSync(f.root,0o755);fs.chmodSync(path.dirname(f.file),0o755);fs.chmodSync(f.file,0o644);
 fs.linkSync(f.file,path.join(f.root,'same-content.mp4'));assert.equal(fs.lstatSync(f.file).nlink,2);
 assert.equal(await createWorkspaceNativeHost(f.options).dispatch({}, {action:'revealExport',identity:f.identity}),true);
 assert.deepEqual(f.calls,[['readExport',f.identity],['readExport',f.identity],['reveal',f.file]]);
});

test('shell effects reject producer, reference revision and same-byte owner changes',async t=>{
 for(const changed of [{producer:{kind:'export' as const,id:randomUUID()}},{referenceRevision:2},{assetId:randomUUID()}]){
  const f=fixture(t);let calls=0;
  f.options.readExport=async()=>{calls++;return calls===1?f.output:{...f.output,...changed};};
  await assert.rejects(createWorkspaceNativeHost(f.options).dispatch({}, {action:'openExport',identity:f.identity}),code);
  assert.equal(calls,2);assert.equal(f.calls.some(call=>call[0]==='open'),false);
 }
});

test('native export rejects missing or mismatched portable publication facts before shell effects',async t=>{
 const f=fixture(t),changes=[undefined,{...f.output.publication,publicationId:randomUUID(),assetId:randomUUID()},{...f.output.publication,owner:{...f.output.publication.owner,id:randomUUID()}},{...f.output.publication,projectRelativePath:`导出/${randomUUID()}.mp4`},{...f.output.publication,targetKind:'generated' as const,projectRelativePath:`生成/${path.basename(f.file)}`}];
 for(const publication of changes){f.options.readExport=async()=>({...f.output,publication} as typeof f.output);await assert.rejects(createWorkspaceNativeHost(f.options).dispatch({}, {action:'openExport',identity:f.identity}),code);}
 assert.equal(f.calls.some(call=>call[0]==='open'),false);
});

test('a source replaced during the final backend acknowledgement cannot reach the shell',async t=>{
 const f=fixture(t);let reads=0;
 f.options.readExport=async()=>{if(++reads===2){const original=fs.readFileSync(f.file);fs.unlinkSync(f.file);fs.writeFileSync(f.file,original);}return f.output;};
 await assert.rejects(createWorkspaceNativeHost(f.options).dispatch({}, {action:'revealExport',identity:f.identity}),code);
 assert.equal(f.calls.some(call=>call[0]==='reveal'),false);
});

test('a replaced output directory cannot authorize the same inode before the shell effect',async t=>{
 const f=fixture(t),directory=path.dirname(f.file),replacement=directory+'-replacement';fs.mkdirSync(replacement,{mode:0o755});fs.linkSync(f.file,path.join(replacement,path.basename(f.file)));const before=fs.lstatSync(f.file,{bigint:true});let reads=0;
 f.options.readExport=async()=>{if(++reads===2){fs.renameSync(directory,directory+'-previous');fs.renameSync(replacement,directory);const after=fs.lstatSync(f.file,{bigint:true});for(const key of ['dev','ino','size','mtimeNs','ctimeNs'] as const)assert.equal(after[key],before[key],'the file identity itself stayed exact');}return f.output;};
 await assert.rejects(createWorkspaceNativeHost(f.options).dispatch({}, {action:'revealExport',identity:f.identity}),code);
 assert.equal(f.calls.some(call=>call[0]==='reveal'),false);
});

test('Windows native-export branch applies the same ordinary L1 hash and effect fences (portable fixture)',async t=>{
 const f=fixture(t);fs.chmodSync(path.dirname(f.file),0o755);fs.linkSync(f.file,path.join(f.root,'alias.mp4'));
 const source=fs.readFileSync(new URL('../apps/desktop/src/workspace-native-host.ts',import.meta.url),'utf8');
 const helper=source.slice(source.indexOf('const unavailable='),source.indexOf('/** Fixed authenticated'))+source.slice(source.indexOf('/** Native effects'),source.indexOf('/** Renderer input'));
 const scope={path,process:{platform:'win32'},lstatSync:fs.lstatSync,realpathSync:fs.realpathSync,isProjectFileHeld,isAppLibraryHeld,computeFullSha256,isInsideRealDirectory,referencePathForRealFile,PROJECT_OUTPUT_FOLDERS};
 const verify=lenientFunction(...Object.keys(scope),helper+';return verifyExport;')(...Object.values(scope)) as (root:string,output:typeof f.output,check:()=>void)=>Promise<()=>void>;
 const proof=await verify(f.root,f.output,()=>{});proof();
 await assert.rejects(verify(f.root,{...f.output,sha256:'f'.repeat(64),fingerprint:{...f.output.fingerprint,fullSha256:'f'.repeat(64)}},()=>{}),code);
 let effects=0;await assert.rejects(verify(f.root,f.output,()=>{if(++effects===8)throw Object.assign(Error('retired'),{code:'WORKSPACE_NATIVE_UNAVAILABLE'});}),code);
 assert.ok(effects>=8);
});


test('mtime-only drift still requires the registered complete export hash',async t=>{
 const f=fixture(t),old=fs.statSync(f.file);fs.utimesSync(f.file,old.atime,new Date(old.mtimeMs+2000));
 assert.equal(await createWorkspaceNativeHost(f.options).dispatch({}, {action:'openExport',identity:f.identity}),true);
 f.calls.length=0;const changed=fs.readFileSync(f.file);changed[changed.length-1]^=1;fs.writeFileSync(f.file,changed);fs.utimesSync(f.file,old.atime,new Date(old.mtimeMs+2000));
 await assert.rejects(createWorkspaceNativeHost(f.options).dispatch({}, {action:'openExport',identity:f.identity}),code);assert.equal(f.calls.some(call=>call[0]==='open'),false);
});

function backupFixture(t:TestContext) {
 const f=fixture(t),selection={projectId:f.identity.projectId,backupId:randomUUID(),requestId:randomUUID()},projectId=randomUUID(),file=path.join(f.chosen,'restored.mioon');
 let frame:object={},document=0,selected:string|null=file;
 const backup:ProjectBackupInspection={...selection,contentSequence:4,contentToken:'b'.repeat(32),createdAt:'2026-11-05T08:09:10.000Z',reason:'close',sizeBytes:1000,projectName:'A/项目',sourceProjectDir:f.root,tableCounts:{shots:2}};
 // requestId is an intent, never a field accepted by the inspection DTO.
 delete (backup as unknown as Record<string,unknown>).requestId;
 const calls:unknown[][]=[];
 const options={...f.options,
  ownerForEvent:()=>{const key=frame,epoch=document;return{projectId:selection.projectId,key,isCurrent:()=>f.options.ownerForEvent().isCurrent()&&key===frame&&epoch===document,chooseBackupFile:async(defaultPath:string)=>{calls.push(['choose',defaultPath]);return selected;}};},
  readBackup:async(input:unknown)=>{calls.push(['inspect',input]);return backup;},
  readProjectEntry:async(id:string)=>{calls.push(['entry',id]);return entry;},
  backupFileName:(name:string|null,date:string)=>`${name??'Project'} (${date} backup)`,
  revealPath:(target:string)=>{calls.push(['reveal',target]);},
 };
 let result:ProjectBackupRestoreResponse,entry:ProjectEntryResponse;
 const publish=()=>{
  createProjectFile(file,{projectId});const info=fs.lstatSync(file,{bigint:true});
  result={requestId:selection.requestId,sourceProjectId:selection.projectId,backupId:selection.backupId,project:{projectId,projectFile:file,fileIdentity:{dev:String(info.dev),ino:String(info.ino)},name:'Restored',lastOpenedAt:null,summary:null}};
  entry={version:1,appLibraryScope:'a'.repeat(64),instanceId:randomUUID(),entry:{project:result.project,availability:{state:'available'},coverUrl:null}};
  return {result,entry};
 };
 return {...f,selection,file,backup,calls,options,publish,host:createWorkspaceNativeHost(options),choose:()=>({action:'chooseBackupRestoreDestination',selection}),changeFrame:()=>{frame={};},reloadSameFrame:()=>{document++;},cancel:()=>{selected=null;},result:()=>result,entry:()=>entry};
}

test('backup chooser inspects one real selection, defaults beside source and retains one exact owner-bound input',async t=>{
 const f=backupFixture(t),input=await f.host.dispatch({},f.choose());
 assert.deepEqual(input,{...f.selection,projectFile:f.file});
 const created=new Date(f.backup.createdAt),date=`${String(created.getMonth()+1).padStart(2,'0')}-${String(created.getDate()).padStart(2,'0')}`;
 assert.deepEqual(f.calls,[['inspect',{projectId:f.selection.projectId,backupId:f.selection.backupId}],['choose',path.join(f.root,`A_项目 (${date} backup).mioon`)],['inspect',{projectId:f.selection.projectId,backupId:f.selection.backupId}]]);
 assert.deepEqual(await f.host.dispatch({},f.choose()),input,'same request never silently chooses a new destination');assert.equal(f.calls.length,3);
 await assert.rejects(f.host.dispatch({}, {action:'chooseBackupRestoreDestination',selection:{...f.selection,backupId:randomUUID()}}),code);
 await assert.rejects(f.host.dispatch({}, {action:'chooseBackupRestoreDestination',selection:{...f.selection,projectFile:'/untrusted.mioon'}}),{name:'ZodError'});
 assert.equal(fs.existsSync(f.file),false,'a chooser neither restores nor writes a target');
});

test('backup picker cancellation and replies after source or window retirement never disclose a path',async t=>{
 const cancelled=backupFixture(t);cancelled.cancel();assert.equal(await cancelled.host.dispatch({},cancelled.choose()),null);assert.equal(cancelled.calls.filter(call=>call[0]==='inspect').length,1);assert.equal(fs.existsSync(cancelled.file),false);
 const inspection=backupFixture(t),read=Promise.withResolvers<ProjectBackupInspection>();inspection.options.readBackup=()=>read.promise;
 const pendingRead=createWorkspaceNativeHost(inspection.options).dispatch({},inspection.choose());inspection.retire();read.resolve(inspection.backup);await assert.rejects(pendingRead,code);assert.equal(inspection.calls.length,0);
 const picker=backupFixture(t),chosen=Promise.withResolvers<string|null>(),opened=Promise.withResolvers<void>();
 const originalOwner=picker.options.ownerForEvent;picker.options.ownerForEvent=()=>({...originalOwner(),chooseBackupFile:()=>{opened.resolve();return chosen.promise;}});
 const pendingPicker=createWorkspaceNativeHost(picker.options).dispatch({},picker.choose());await opened.promise;picker.changeFrame();chosen.resolve(picker.file);await assert.rejects(pendingPicker,code);
 const changed=backupFixture(t);let reads=0;changed.options.readBackup=async()=>({...changed.backup,contentSequence:++reads===1?4:5});
 await assert.rejects(createWorkspaceNativeHost(changed.options).dispatch({},changed.choose()),code);assert.equal(fs.existsSync(changed.file),false);
});

test('Finder reveals only the chosen registered restored project after two metadata and full read-only content checks',async t=>{
 const f=backupFixture(t);await f.host.dispatch({},f.choose());const {result}=f.publish(),before=fs.readFileSync(f.file),names=fs.readdirSync(f.chosen);
 f.calls.length=0;assert.equal(await f.host.dispatch({}, {action:'revealRestoredBackup',result}),true);
 assert.deepEqual(f.calls,[['entry',result.project.projectId],['entry',result.project.projectId],['reveal',f.file]]);
 assert.deepEqual(fs.readFileSync(f.file),before);assert.deepEqual(fs.readdirSync(f.chosen),names,'read-only verification creates no history, cache or sidecars');
});

test('backup reveal rejects forged receipt identities, another frame, unchosen requests and expired intents before shell effects',async t=>{
 const f=backupFixture(t);await f.host.dispatch({},f.choose());const {result}=f.publish();f.calls.length=0;
 for(const changed of [{requestId:randomUUID()},{sourceProjectId:randomUUID()},{backupId:randomUUID()},{project:{...result.project,projectId:result.sourceProjectId}},{project:{...result.project,projectFile:path.join(f.chosen,'other.mioon')}}])
  await assert.rejects(f.host.dispatch({}, {action:'revealRestoredBackup',result:{...result,...changed}}),code);
 assert.deepEqual(f.calls,[]);f.changeFrame();await assert.rejects(f.host.dispatch({}, {action:'revealRestoredBackup',result}),code);assert.deepEqual(f.calls,[]);
 const expired=backupFixture(t);await expired.host.dispatch({},expired.choose());const receipt=expired.publish().result,now=Date.now();t.mock.method(Date,'now',()=>now+3*60*60*1000);
 await assert.rejects(expired.host.dispatch({}, {action:'revealRestoredBackup',result:receipt}),code);assert.equal(expired.calls.some(call=>call[0]==='entry'||call[0]==='reveal'),false);
});

test('same frame reused by a new document cannot reuse an old backup intent or survive its creator retiring during metadata read',async t=>{
 const f=backupFixture(t);await f.host.dispatch({},f.choose());const {result}=f.publish(),key=f.options.ownerForEvent().key;f.calls.length=0;f.reloadSameFrame();
 assert.equal(f.options.ownerForEvent().key,key,'Electron reload may preserve the exact frame object');
 assert.equal(f.options.ownerForEvent().isCurrent(),true,'the new document has a current owner');
 await assert.rejects(f.host.dispatch({},f.choose()),code);await assert.rejects(f.host.dispatch({}, {action:'revealRestoredBackup',result}),code);
 assert.deepEqual(f.calls,[],'no old path, metadata read, new choice or shell effect crosses document retirement');
 const during=backupFixture(t),originalOwner=during.options.ownerForEvent;let creatorCurrent=true;
 during.options.ownerForEvent=()=>({...originalOwner(),isCurrent:()=>creatorCurrent});
 await during.host.dispatch({},during.choose());const published=during.publish();during.options.ownerForEvent=originalOwner;
 during.options.readProjectEntry=async id=>{during.calls.push(['entry',id]);creatorCurrent=false;return published.entry;};during.calls.length=0;
 await assert.rejects(during.host.dispatch({}, {action:'revealRestoredBackup',result:published.result}),code);
 assert.equal(during.options.ownerForEvent().isCurrent(),true);assert.deepEqual(during.calls,[['entry',published.result.project.projectId]],'old and new owners are rechecked after the awaited metadata reply');
});

test('backup reveal refuses held files, real content ID mismatch and changes during final registry acknowledgement without writing',async t=>{
 for(const mode of ['held','content-id','replacement','registry','retired','symlink'] as const){
  const f=backupFixture(t);await f.host.dispatch({},f.choose());const {result,entry}=f.publish();
  if(mode==='content-id'){
   fs.unlinkSync(f.file);createProjectFile(f.file,{projectId:randomUUID()});const info=fs.lstatSync(f.file,{bigint:true});result.project.fileIdentity={dev:String(info.dev),ino:String(info.ino)};
  }
  if(mode==='symlink'){const target=f.file+'.actual';fs.renameSync(f.file,target);fs.symlinkSync(target,f.file);}
  const before=fs.readFileSync(f.file),held=mode==='held'?openClosedProjectSnapshotConnection({projectFile:f.file}):null;
  let opens=0,reads=0;const originalOpen=fs.openSync;
  if(held){t.mock.method(fs,'openSync',(...args:Parameters<typeof originalOpen>)=>{if(String(args[0])===f.file)opens++;return originalOpen(...args);});syncBuiltinESMExports();}
  f.options.readProjectEntry=async()=>{
   if(++reads===2){
    if(mode==='replacement'){const bytes=fs.readFileSync(f.file);fs.unlinkSync(f.file);fs.writeFileSync(f.file,bytes);}
    if(mode==='registry')return {...entry,entry:{...entry.entry,project:{...entry.entry.project,fileIdentity:{...entry.entry.project.fileIdentity,ino:'999'}}}};
    if(mode==='retired')f.retire();
   }return entry;
  };
  // Reuse the same host intent; options retain trusted callback references.
  try{await assert.rejects(f.host.dispatch({}, {action:'revealRestoredBackup',result}),code);assert.equal(f.calls.some(call=>call[0]==='reveal'),false,mode);if(held)assert.equal(opens,0,'held project is refused before another descriptor is opened');}
  finally{held?.close();t.mock.restoreAll();syncBuiltinESMExports();}
  assert.deepEqual(fs.readFileSync(f.file),before,mode);
 }
});

test('preload and web detect only the narrow backup capability and reject unbound or nonboolean native responses',async()=>{
 const selection={projectId:randomUUID(),backupId:randomUUID(),requestId:randomUUID()},input={...selection,projectFile:path.join(fs.realpathSync(tmpdir()),'chosen.mioon')},calls:unknown[]=[];
 const bridge=createWorkspaceNativeBridges(async(_channel,request)=>{calls.push(request);return (request as {action:string}).action==='chooseBackupRestoreDestination'?input:true;});
 assert.equal(readProjectBackupNativeActions({}),null);assert.equal(readProjectBackupNativeActions({__mioonProjectBackups:{chooseDestination:()=>{},revealPath:()=>{}}}),null);
 const native=readProjectBackupNativeActions({__mioonProjectBackups:bridge.projectBackups});assert.ok(native);assert.deepEqual(await native.chooseDestination(selection),input);
 const result:ProjectBackupRestoreResponse={requestId:selection.requestId,sourceProjectId:selection.projectId,backupId:selection.backupId,project:{projectId:randomUUID(),projectFile:input.projectFile,fileIdentity:{dev:'1',ino:'2'},name:'Restored',lastOpenedAt:null,summary:null}};
 await native.reveal(result);assert.deepEqual(calls,[{action:'chooseBackupRestoreDestination',selection},{action:'revealRestoredBackup',result}]);
 const malformed=createWorkspaceNativeBridges(async()=>({...input,requestId:randomUUID()}));await assert.rejects(malformed.projectBackups.chooseDestination(selection));
 const bad=readProjectBackupNativeActions({__mioonProjectBackups:{chooseDestination:async()=>({...input,backupId:randomUUID()}),reveal:async()=>false}});assert.ok(bad);
 await assert.rejects(bad.chooseDestination(selection),code);await assert.rejects(bad.reveal(result),code);
 const cancelled=readProjectBackupNativeActions({__mioonProjectBackups:{chooseDestination:async()=>null,reveal:async()=>true}});assert.ok(cancelled);assert.equal(await cancelled.chooseDestination(selection),null);
});

test('backup OS save sheet keeps its captured parent and native-dialog lease through cancel or retired frame',async()=>{
 const source=fs.readFileSync(new URL('../apps/desktop/src/main.ts',import.meta.url),'utf8'),start=source.indexOf('async function chooseOwnedBackupFile('),end=source.indexOf('\nasync function presentForReload(',start),functionSource=source.slice(start,end);
 for(const retire of [false,true]){
  const window={},context={},tokens=new Set<unknown>(),gate=Promise.withResolvers<{canceled:boolean;filePath?:string}>(),shown=Promise.withResolvers<void>(),calls:unknown[][]=[];let current=true;
  const host={contextFor:()=>({contextId:'owner'}),prepareNativeDialog:(value:unknown)=>{calls.push(['prepare',value]);return true;}};
  const scope={windowHost:host,nativeDialogs:tokens,trayHost:null,refreshApplicationMenu:()=>{},ownsWindow:()=>current,finishNativePresentation:(...args:unknown[])=>calls.push(['finish',...args]),nt:(key:string)=>key,
   dialog:{showSaveDialog:(parent:unknown,options:unknown)=>{calls.push(['show',parent,options]);shown.resolve();return gate.promise;}}};
  const choose=lenientFunction(...Object.keys(scope),'let trayIntent=0;'+functionSource+';return chooseOwnedBackupFile;')(...Object.values(scope)) as (window:unknown,context:unknown,file:string,check:()=>void)=>Promise<string|null>;
  const pending=choose(window,context,'/chosen.mioon',()=>{if(!current)throw Error('retired');});await shown.promise;
  assert.equal(tokens.size,1);assert.equal(calls[1][1],window,'sheet parent is the retained initiating window');if(retire)current=false;
  gate.resolve({canceled:!retire,filePath:'/chosen.mioon'});if(retire)await assert.rejects(pending,/retired/u);else assert.equal(await pending,null);
  assert.equal(tokens.size,0);assert.equal(calls.some(call=>call[0]==='finish'),!retire,'cleanup cannot resume a retired frame');
 }
});
