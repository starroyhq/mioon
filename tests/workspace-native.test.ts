import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import type {TestContext} from 'node:test';
import {createWorkspaceNativeHost} from '../apps/desktop/src/workspace-native-host.ts';
import {createWorkspaceNativeBridges} from '../apps/desktop/src/workspace-native-preload.ts';
import {createWorkspaceNativeBroker} from '../apps/desktop/src/workspace-native-broker.ts';
import {workspaceNativeRequestSchema} from '../packages/contracts/src/workspace-native.ts';
const code=(error:unknown)=>(error as {code?:string})?.code==='WORKSPACE_NATIVE_UNAVAILABLE';
const settings=(directory:string)=>({formatVersion:1 as const,revision:1,liveGeneration:false,automaticBackup:false,backupIntervalHours:24 as const,backupLocation:'selected' as const,backupDirectory:directory});
function fixture(t:TestContext) {
 const base=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-native-workspace-')),root=path.join(base,'workspace'),media=path.join(root,'media'),chosen=path.join(base,'chosen');
 fs.mkdirSync(root,{mode:0o700});fs.mkdirSync(media,{mode:0o700});fs.mkdirSync(chosen,{mode:0o755});t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const projectId=randomUUID(),exportId=randomUUID(),assetId=randomUUID(),bytes=Buffer.from('verified synthetic mp4'),file=path.join(media,`${assetId}.mp4`);fs.writeFileSync(file,bytes,{mode:0o600});
 const output={projectId,exportId,assetId,fileLocation:file,sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),url:`/media/${assetId}`};
 let current=true;const calls:unknown[][]=[];
 const options={ownerForEvent:()=>({projectId,isCurrent:()=>current}),chooseDirectory:async()=>chosen,setBackupDirectory:async(directory:string)=>{calls.push(['setDirectory',directory]);return settings(directory);},readSettings:async()=>settings(chosen),readWorkspaceRoot:async()=>root,readExport:async(identity:unknown)=>{calls.push(['readExport',identity]);return output;},openPath:async(file:string)=>{calls.push(['open',file]);return '';},revealPath:(file:string)=>{calls.push(['reveal',file]);},restart:async()=>{calls.push(['restart']);return true;}};
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
