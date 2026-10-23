import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createWorkspaceNativeHost} from '../apps/desktop/src/workspace-native-host.ts';

function host(dir:string,{body=Buffer.from('package-bytes'),length=13}:{body?:Buffer;length?:number}={}){
 const revealed:string[]=[];
 const value=createWorkspaceNativeHost<object>({
  ownerForEvent:()=>({isCurrent:()=>true}),chooseDirectory:async()=>null,setBackupDirectory:async()=>({}),readSettings:async()=>({}) as never,readWorkspaceRoot:async()=>dir,
  readExport:async()=>({}),openPath:async()=>'',revealPath:file=>{revealed.push(file);},restart:async()=>true,
  chooseSaveFile:async name=>path.join(dir,name.replace(/\.mioon$/u,'')),
  fetchProjectPackage:async()=>new Response(new Uint8Array(body),{headers:{'content-length':String(length)}}),
 });
 return {host:value,revealed};
}
test('the native save keeps the chosen path in the main process behind a token',async t=>{
 const dir=realpathSync(mkdtempSync(path.join(tmpdir(),'mioon-native-package-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const {host:native,revealed}=host(dir);
 const chosen=await native.dispatch({},{action:'chooseProjectPackageDestination',suggestedName:'UI 走查项目.mioon'}) as {token:string;fileName:string};
 assert.equal(chosen.fileName,'UI 走查项目.mioon');
 assert.deepEqual(await native.dispatch({},{action:'saveProjectPackage',token:chosen.token,exportId:randomUUID()}),{fileName:'UI 走查项目.mioon'});
 assert.equal(readFileSync(path.join(dir,'UI 走查项目.mioon'),'utf8'),'package-bytes');
 assert.equal(existsSync(path.join(dir,'UI 走查项目.mioon.part')),false);
 assert.equal(await native.dispatch({},{action:'revealProjectPackage',token:chosen.token}),true);
 assert.deepEqual(revealed,[path.join(dir,'UI 走查项目.mioon')]);
 await assert.rejects(native.dispatch({},{action:'revealProjectPackage',token:randomUUID()}),{code:'WORKSPACE_NATIVE_UNAVAILABLE'});
 await assert.rejects(native.dispatch({},{action:'saveProjectPackage',token:chosen.token,exportId:'../etc'}));
});
test('a truncated download leaves no file behind',async t=>{
 const dir=realpathSync(mkdtempSync(path.join(tmpdir(),'mioon-native-package-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const {host:native}=host(dir,{length:999});
 const chosen=await native.dispatch({},{action:'chooseProjectPackageDestination',suggestedName:'p'}) as {token:string};
 await assert.rejects(native.dispatch({},{action:'saveProjectPackage',token:chosen.token,exportId:randomUUID()}),{code:'WORKSPACE_NATIVE_UNAVAILABLE'});
 assert.equal(existsSync(path.join(dir,'p.mioon')),false);assert.equal(existsSync(path.join(dir,'p.mioon.part')),false);
});
test('a cancelled save dialog returns null',async t=>{
 const dir=realpathSync(mkdtempSync(path.join(tmpdir(),'mioon-native-package-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const native=createWorkspaceNativeHost<object>({ownerForEvent:()=>({isCurrent:()=>true}),chooseDirectory:async()=>null,setBackupDirectory:async()=>({}),readSettings:async()=>({}) as never,readWorkspaceRoot:async()=>dir,readExport:async()=>({}),openPath:async()=>'',revealPath:()=>{},restart:async()=>true,chooseSaveFile:async()=>null});
 assert.equal(await native.dispatch({},{action:'chooseProjectPackageDestination',suggestedName:'p'}),null);
});
