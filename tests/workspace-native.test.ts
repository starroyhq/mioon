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
import {workspaceNativeRequestSchema} from '../packages/contracts/src/workspace-native.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
const code=(error:unknown)=>(error as {code?:string})?.code==='WORKSPACE_NATIVE_UNAVAILABLE';
function fixture(t:TestContext) {
 const base=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-native-workspace-')),root=path.join(base,'workspace'),media=path.join(root,'media'),chosen=path.join(base,'chosen');
 fs.mkdirSync(root,{mode:0o700});fs.mkdirSync(media,{mode:0o700});fs.mkdirSync(chosen,{mode:0o755});t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const projectId=randomUUID(),exportId=randomUUID(),assetId=randomUUID(),bytes=Buffer.from('verified synthetic mp4'),file=path.join(media,`${assetId}.mp4`);fs.writeFileSync(file,bytes,{mode:0o600});
 const output={projectId,exportId,assetId,fileLocation:file,sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),url:`/media/${assetId}`};
 let current=true;const calls:unknown[][]=[];
 const options={ownerForEvent:()=>({projectId,isCurrent:()=>current}),readWorkspaceRoot:async(id:string)=>{assert.equal(id,projectId);return root;},readExport:async(identity:unknown)=>{calls.push(['readExport',identity]);return output;},openPath:async(file:string)=>{calls.push(['open',file]);return '';},revealPath:(file:string)=>{calls.push(['reveal',file]);return;},restart:async()=>{calls.push(['restart']);return true;}};
 return {base,root,chosen,file,output,options,calls,identity:{projectId,exportId},retire:()=>{current=false;}};
}
test('native export open and reveal re-read exact backend identities and verify managed bytes before shell effects',async t=>{
 const f=fixture(t),host=createWorkspaceNativeHost(f.options);
  fs.chmodSync(f.root,0o755);
 assert.equal(await host.dispatch({}, {action:'openExport',identity:f.identity}),true);assert.equal(await host.dispatch({}, {action:'revealExport',identity:f.identity}),true);
 assert.deepEqual(f.calls,[['readExport',f.identity],['open',f.file],['readExport',f.identity],['reveal',f.file]]);
 await assert.rejects(host.dispatch({}, {action:'openExport',identity:{...f.identity,path:'/arbitrary'}}));
 await assert.rejects(host.dispatch({}, {action:'openExport',identity:{...f.identity,projectId:randomUUID()}}),code);assert.equal(f.calls.length,4);
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
test('preload exposes generic restart, fixed export identities and no backup path methods',async()=>{
 const calls:unknown[][]=[],bridge=createWorkspaceNativeBridges(async(channel,request)=>{calls.push([channel,request]);return true;});
 assert.equal(await bridge.exports.open({projectId:randomUUID(),exportId:randomUUID()}),true);await bridge.native.restart();
 assert.deepEqual(calls.map(call=>(call[1] as {action:string}).action),['openExport','restart']);assert.ok(calls.every(call=>call[0]==='mioon:workspace-native'));
 await assert.rejects(bridge.exports.reveal({projectId:'invalid',exportId:randomUUID()}));assert.equal(calls.length,2);
 assert.deepEqual(Object.keys(bridge).sort(),['exports','native','projectPackages']);
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

test('native export rejects a shared media directory and a different trusted project root',async t=>{
 const f=fixture(t),host=createWorkspaceNativeHost(f.options);
 fs.chmodSync(path.dirname(f.file),0o755);await assert.rejects(host.dispatch({}, {action:'openExport',identity:f.identity}));
 fs.chmodSync(path.dirname(f.file),0o700);f.options.readWorkspaceRoot=async()=>f.chosen;
 await assert.rejects(host.dispatch({}, {action:'openExport',identity:f.identity}),code);assert.equal(f.calls.some(call=>call[0]==='open'),false);
});

test('native export cannot open a held application database renamed into managed media',async t=>{
 const f=fixture(t),library=openAppLibrary({dataDir:path.join(f.base,'application')});
 try {
  fs.unlinkSync(f.file);fs.renameSync(library.databaseFile,f.file);
  f.options.readExport=async()=>({...f.output,sizeBytes:fs.lstatSync(f.file).size,sha256:'a'.repeat(64)});
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
