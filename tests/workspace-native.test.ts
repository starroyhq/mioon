import {lenientFunction} from './helpers/eval-source.ts';
import {computeFullSha256,isInsideRealDirectory,referencePathForRealFile} from '../packages/business/src/media-reference/index.ts';
import {isProjectFileHeld} from '../packages/business/src/project-file/held-files.ts';
import {isAppLibraryHeld} from '../packages/business/src/app-db/connection.ts';
import {mediaMtimeMs} from '../packages/business/src/media-reference/fingerprint.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import type {TestContext} from 'node:test';
import http from 'node:http';
import {createWorkspaceNativeHost,readNativeBackendMetadata} from '../apps/desktop/src/workspace-native-host.ts';
import {projectApiPath,projectMediaPath,projectRpcPath} from '../packages/contracts/src/project-file.ts';
import {createWorkspaceNativeBridges} from '../apps/desktop/src/workspace-native-preload.ts';
import {createWorkspaceNativeBroker} from '../apps/desktop/src/workspace-native-broker.ts';
import {workspaceNativeRequestSchema} from '../packages/contracts/src/workspace-native.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
const code=(error:unknown)=>(error as {code?:string})?.code==='WORKSPACE_NATIVE_UNAVAILABLE';
const settings=(directory:string)=>({formatVersion:1 as const,revision:1,liveGeneration:false,automaticBackup:false,backupIntervalHours:24 as const,backupLocation:'selected' as const,backupDirectory:directory});
function fixture(t:TestContext) {
 const base=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-native-workspace-')),root=path.join(base,'workspace'),media=path.join(root,'media'),chosen=path.join(base,'chosen');
 fs.mkdirSync(root,{mode:0o700});fs.mkdirSync(media,{mode:0o700});fs.mkdirSync(chosen,{mode:0o755});t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const projectId=randomUUID(),exportId=randomUUID(),assetId=randomUUID(),bytes=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.from([0,0,0,0]),Buffer.from('isommp42')]),file=path.join(media,`${assetId}.mp4`);fs.writeFileSync(file,bytes,{mode:0o600});
 const sha256=createHash('sha256').update(bytes).digest('hex'),fingerprint={sizeBytes:bytes.length,mtimeMs:mediaMtimeMs(fs.lstatSync(file,{bigint:true})),sampledSha256:sha256,fullSha256:sha256};
 const output={projectId,exportId,assetId,fileLocation:file,sizeBytes:bytes.length,sha256,url:`/media/${assetId}`,referenceRevision:1,fingerprint,producer:{kind:'export' as const,id:exportId}};
 let current=true;const calls:unknown[][]=[];
 const options={ownerForEvent:()=>({projectId,isCurrent:()=>current}),chooseDirectory:async()=>chosen,setBackupDirectory:async(directory:string)=>{calls.push(['setDirectory',directory]);return settings(directory);},readSettings:async()=>settings(chosen),readWorkspaceRoot:async(id:string)=>{assert.equal(id,projectId);return root;},readExport:async(identity:unknown)=>{calls.push(['readExport',identity]);return output;},openPath:async(file:string)=>{calls.push(['open',file]);return '';},revealPath:(file:string)=>{calls.push(['reveal',file]);return;},restart:async()=>{calls.push(['restart']);return true;}};
 return {base,root,chosen,file,output,options,calls,identity:{projectId,exportId},retire:()=>{current=false;}};
}
test('native backup picker creates a private child and returns only the verified saved configuration',async t=>{
 const f=fixture(t),host=createWorkspaceNativeHost(f.options),saved=await host.dispatch({}, {action:'chooseBackupLocation'});
 const expected=path.join(f.chosen,'Mioon Backups');assert.deepEqual(saved,settings(expected));assert.equal(fs.statSync(expected).mode&0o777,0o700);assert.equal(fs.statSync(f.chosen).mode&0o777,0o755);
 assert.deepEqual(f.calls,[['setDirectory',expected]]);
 assert.equal(workspaceNativeRequestSchema.safeParse({action:'chooseBackupLocation',directory:'/arbitrary'}).success,false);
});
test('a retired picker owner cannot create a directory or dispatch a private backend write',async t=>{
 const f=fixture(t);let finish:(value:string)=>void=()=>{};f.options.chooseDirectory=()=>new Promise(resolve=>{finish=resolve;});
 const pending=createWorkspaceNativeHost(f.options).dispatch({}, {action:'chooseBackupLocation'});f.retire();finish(f.chosen);await assert.rejects(pending,code);
 assert.deepEqual(f.calls,[]);assert.equal(fs.existsSync(path.join(f.chosen,'Mioon Backups')),false);
});
test('native export open and reveal re-read exact backend identities and verify managed bytes before shell effects',async t=>{
 const f=fixture(t),host=createWorkspaceNativeHost(f.options);
  fs.chmodSync(f.root,0o755);
 assert.equal(await host.dispatch({}, {action:'openExport',identity:f.identity}),true);assert.equal(await host.dispatch({}, {action:'revealExport',identity:f.identity}),true);
 assert.deepEqual(f.calls,[['readExport',f.identity],['readExport',f.identity],['open',f.file],['readExport',f.identity],['readExport',f.identity],['reveal',f.file]]);
 await assert.rejects(host.dispatch({}, {action:'openExport',identity:{...f.identity,path:'/arbitrary'}}));
 await assert.rejects(host.dispatch({}, {action:'openExport',identity:{...f.identity,projectId:randomUUID()}}),code);assert.equal(f.calls.length,6);
});
test('modified bytes, symlinks and backend-returned paths outside managed media cannot be opened',async t=>{
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
test('preload exposes fixed actions, strict export identity and schema-checked settings without filesystem forwarding',async()=>{
 const calls:unknown[][]=[],directory='/private/backups',bridge=createWorkspaceNativeBridges(async(channel,request)=>{calls.push([channel,request]);return request&&typeof request==='object'&&'action' in request&&request.action==='chooseBackupLocation'?settings(directory):true;});
 assert.equal((await bridge.backups.chooseLocation())?.backupDirectory,directory);assert.equal(await bridge.exports.open({projectId:randomUUID(),exportId:randomUUID()}),true);await bridge.backups.restart();
 assert.deepEqual(calls.map(call=>(call[1] as {action:string}).action),['chooseBackupLocation','openExport','restart']);assert.ok(calls.every(call=>call[0]==='mioon:workspace-native'));
 await assert.rejects(bridge.exports.reveal({projectId:'invalid',exportId:randomUUID()}));assert.equal(calls.length,3);
});
test('private utility broker is bounded to one current backend and ignores malformed or foreign replies',async t=>{
 const sent:unknown[]=[];let current=true;const broker=createWorkspaceNativeBroker({send:message=>sent.push(message),isCurrent:()=>current,timeoutMs:1000});t.after(()=>broker.close());
 const pending=broker.setBackupDirectory('/private/approved'),request=sent[0] as {requestId:string};
 assert.equal(broker.handle({type:'other'}),false);assert.equal(broker.handle({type:'workspace-native:reply',requestId:randomUUID(),ok:true,settings:settings('/private/approved')}),true);
 broker.handle({type:'workspace-native:reply',requestId:request.requestId,ok:true,settings:settings('/private/approved')});assert.deepEqual(await pending,settings('/private/approved'));
 const late=broker.setBackupDirectory('/private/later');current=false;broker.handle({type:'workspace-native:reply',requestId:(sent[1] as {requestId:string}).requestId,ok:true,settings:settings('/private/later')});broker.close();await assert.rejects(late,code);
 await assert.rejects(broker.setBackupDirectory('/private/again'),code);
});
test('backend metadata reads go only to the app RPC, workspace information or one project RPC',async(t:TestContext)=>{
 const seen:string[]=[];const server=http.createServer((req,res)=>{seen.push(String(req.url));res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,data:{read:req.url}}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
 const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`,project=randomUUID();
 const read=(resource:string)=>readNativeBackendMetadata({base,token:'t'.repeat(64),resource,...(resource.endsWith('/rpc')?{input:{operation:'export.output.get',input:{}}}:{}),signal:new AbortController().signal,check:()=>{}});
 assert.deepEqual(await read(projectRpcPath(project)),{read:projectRpcPath(project)});
 assert.deepEqual(await read('/api/rpc'),{read:'/api/rpc'});
 assert.deepEqual(await read(projectApiPath(project,'workspace-info')),{read:projectApiPath(project,'workspace-info')});
 assert.deepEqual(await read('/api/ui-preferences'),{read:'/api/ui-preferences'});
 for(const resource of ['/api/tasks',projectApiPath(project,'tasks'),projectMediaPath(project,randomUUID()),`/api/projects/${project}/rpc/x`,'https://example.invalid/api/rpc'])
  await assert.rejects(read(resource),{code:'WORKSPACE_NATIVE_UNAVAILABLE'},resource);
 assert.deepEqual(seen,[projectRpcPath(project),'/api/rpc',projectApiPath(project,'workspace-info'),'/api/ui-preferences'],'refused resources never reach HTTP');
});

test('native export accepts an ordinary media directory and rejects a different trusted project root',async t=>{
 const f=fixture(t),host=createWorkspaceNativeHost(f.options);
 fs.chmodSync(path.dirname(f.file),0o755);assert.equal(await host.dispatch({}, {action:'openExport',identity:f.identity}),true);f.calls.length=0;
 fs.chmodSync(path.dirname(f.file),0o700);f.options.readWorkspaceRoot=async()=>f.chosen;
 await assert.rejects(host.dispatch({}, {action:'openExport',identity:f.identity}),code);assert.equal(f.calls.some(call=>call[0]==='open'),false);
});

test('native export cannot open a held application database renamed into managed media',async t=>{
 const f=fixture(t),library=openAppLibrary({dataDir:path.join(f.base,'application')});
 try {
  fs.unlinkSync(f.file);fs.renameSync(library.databaseFile,f.file);
  f.options.readExport=async()=>({...f.output,sizeBytes:fs.lstatSync(f.file).size,sha256:'a'.repeat(64),fingerprint:{...f.output.fingerprint,sizeBytes:fs.lstatSync(f.file).size,mtimeMs:mediaMtimeMs(fs.lstatSync(f.file,{bigint:true})),fullSha256:'a'.repeat(64)}});
  await assert.rejects(createWorkspaceNativeHost(f.options).dispatch({}, {action:'openExport',identity:f.identity}),code);
  assert.equal(f.calls.some(call=>call[0]==='open'),false);
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

test('a source replaced during the final backend acknowledgement cannot reach the shell',async t=>{
 const f=fixture(t);let reads=0;
 f.options.readExport=async()=>{if(++reads===2){const original=fs.readFileSync(f.file);fs.unlinkSync(f.file);fs.writeFileSync(f.file,original);}return f.output;};
 await assert.rejects(createWorkspaceNativeHost(f.options).dispatch({}, {action:'revealExport',identity:f.identity}),code);
 assert.equal(f.calls.some(call=>call[0]==='reveal'),false);
});

test('Windows native-export branch applies the same ordinary L1 hash and effect fences (portable fixture)',async t=>{
 const f=fixture(t);fs.chmodSync(path.dirname(f.file),0o755);fs.linkSync(f.file,path.join(f.root,'alias.mp4'));
 const source=fs.readFileSync(new URL('../apps/desktop/src/workspace-native-host.ts',import.meta.url),'utf8');
 const helper=source.slice(source.indexOf('const unavailable='),source.indexOf('/** Fixed authenticated'))+source.slice(source.indexOf('/** Native effects'),source.indexOf('/** Renderer input'));
 const scope={path,process:{platform:'win32'},lstatSync:fs.lstatSync,realpathSync:fs.realpathSync,isProjectFileHeld,isAppLibraryHeld,computeFullSha256,isInsideRealDirectory,referencePathForRealFile};
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
