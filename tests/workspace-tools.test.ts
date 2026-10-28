import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {inspectMediaTools} from '../packages/business/src/media-tool-diagnostics.ts';
import {readWorkspaceInfo} from '../apps/server/src/workspace-info.ts';
import {createWorkspaceToolsHost} from '../apps/desktop/src/workspace-tools-host.ts';
import {createWorkspaceToolsBridge} from '../apps/desktop/src/workspace-tools-preload.ts';
import {createProjectDeletionGate} from '../apps/server/src/project-deletion-gate.ts';
test('tool diagnostics report actual missing filters and bounded fixed invocations',async()=>{
 const calls: { command: string; args: string[]; options: { timeout: number; maxStdoutBytes: number; maxStderrBytes: number; signal?: AbortSignal; }; }[]=[];const result=await inspectMediaTools({ffmpeg:'/local/ffmpeg',ffprobe:'/local/ffprobe'},{execute:async(command,args,options)=>{calls.push({command,args,options});if(args[0]==='-version')return `${command.endsWith('ffprobe')?'ffprobe':'ffmpeg'} version test\n`;return args.includes('-encoders')?' V..... libx264\n A..... aac\n':' T.. scale\n';}});
 assert.deepEqual(result.capabilities,{libx264:true,aac:true,drawtext:false,subtitles:false});assert.equal(calls.length,4);assert.ok(calls.every(c=>c.options.timeout===10000));
 const bad=await inspectMediaTools({ffmpeg:'ffmpeg',ffprobe:'ffprobe'},{execute:async()=>{throw Error('private environment and command diagnostics');}});assert.equal(bad.ffmpeg.available,false);assert.equal(bad.ffmpeg.version,null);assert.equal(JSON.stringify(bad).includes('private environment'),false);
 let attempts=0;await assert.rejects(inspectMediaTools({ffmpeg:'ffmpeg',ffprobe:'ffprobe'},{execute:async()=>{attempts++;throw Object.assign(Error('unconfirmed'),{terminationUnconfirmed:true});}}),/unconfirmed/u);assert.equal(attempts,1);
});
test('workspace usage skips external links and reports an incomplete estimate',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'mioon-workspace-info-'));t.after(()=>rm(directory,{recursive:true,force:true}));const root=path.join(directory,'workspace');await mkdir(root);await writeFile(path.join(root,'local'),'abc');await writeFile(path.join(directory,'external'),'private');await symlink(path.join(directory,'external'),path.join(root,'link'));
 const result=await readWorkspaceInfo({root,channel:'development',version:'test',tools:{ffmpeg:'ffmpeg',ffprobe:'ffprobe'},signal:new AbortController().signal});assert.deepEqual(result.usage,{bytes:3,files:1,complete:false});assert.equal(result.dataDirectory,root);
});
test('native tools reject untrusted, malformed and stale callers before a config write',async()=>{
 let trusted=true,writes=0,release;const paths={ffmpeg:'/local/ffmpeg',ffprobe:'/local/ffprobe'},result={ffmpeg:{path:paths.ffmpeg,version:'ffmpeg version test',available:true},ffprobe:{path:paths.ffprobe,version:'ffprobe version test',available:true},capabilities:{aac:true,libx264:true,subtitles:false,drawtext:false}};
 const host=createWorkspaceToolsHost({isTrusted:()=>trusted,read:async()=>paths,select:async()=>null,check:async()=>{await new Promise(resolve=>{release=resolve;});return result;},save:async()=>{writes++;},revealWorkspace:async()=>true});
 const bridge=createWorkspaceToolsBridge((channel,request)=>{assert.equal(channel,'mioon:workspace-tools');return host.dispatch({},request);});assert.deepEqual(await bridge.read(),paths);
 await assert.rejects(host.dispatch({},{action:'revealWorkspace',path:'/arbitrary'}));const pending=bridge.save(paths);trusted=false;release!();await assert.rejects(pending);assert.equal(writes,0);await assert.rejects(bridge.read());
});
test('delete admission blocks streams and media but permits its own response, with exact settlement',()=>{
 let observer,unsubscribed=false;const gate=createProjectDeletionGate({subscribeMedia:receive=>{observer=receive;return()=>{unsubscribed=true;};},busy:()=>{throw Error('busy');}}),response=new EventEmitter(),deleteResponse=new EventEmitter();
 gate.track((deleteResponse as unknown as Parameters<typeof gate.track>[0]));gate.rpc((deleteResponse as unknown as Parameters<typeof gate.rpc>[0]),'project.delete',{projectId:'p'});assert.doesNotThrow(()=>gate.assertIdle('p'));gate.track((response as unknown as Parameters<typeof gate.track>[0]));assert.throws(()=>gate.assertIdle('p'),/busy/u);response.emit('finish');assert.doesNotThrow(()=>gate.assertIdle('p'));observer!({type:'started',pid:123});assert.throws(()=>gate.assertIdle('p'),/busy/u);observer!({type:'exited',pid:123});assert.doesNotThrow(()=>gate.assertIdle('p'));gate.close();assert.equal(unsubscribed,true);assert.throws(()=>gate.assertIdle('p'),/busy/u);
});
test('Mioon media tools install through fixed actions and save only usable paths for a still-trusted caller',async()=>{
 const paths={ffmpeg:'/private/media-tools/7.1.5-1/ffmpeg',ffprobe:'/private/media-tools/7.1.5-1/ffprobe'};
 const diagnostics=(usable:boolean)=>({ffmpeg:{path:paths.ffmpeg,version:'ffmpeg version 7.1.5',available:true},ffprobe:{path:paths.ffprobe,version:'ffprobe version 7.1.5',available:true},capabilities:{libx264:usable,aac:true,drawtext:true,subtitles:true}});
 const status={offer:{version:'7.1.5-1',ffmpegVersion:'7.1.5',arch:'arm64' as const,downloadBytes:30_000_000,license:'GPL-2.0-or-later',sourceUrl:'https://github.com/starroyhq/mioon/releases/tag/media-tools-7.1.5-1'},installed:null,progress:{phase:'idle' as const,receivedBytes:0,totalBytes:0,code:null}};
 let trusted=true,usable=true,installs=0,cancels=0,outcome:{ok:true;paths:typeof paths}|{ok:false;code:string}={ok:true,paths};const saved:unknown[]=[],checked:unknown[]=[];
 const host=createWorkspaceToolsHost({isTrusted:()=>trusted,read:async()=>paths,select:async()=>null,check:async value=>{checked.push(value);return diagnostics(usable);},save:async value=>{saved.push(value);},revealWorkspace:async()=>true,
  mediaTools:{status:async()=>status,install:async()=>{installs++;return outcome;},cancel:()=>{cancels++;return true;}}});
 const bridge=createWorkspaceToolsBridge((_channel,request)=>host.dispatch({},request));
 assert.deepEqual(await bridge.mediaToolsStatus(),status);
 assert.deepEqual(await bridge.installMediaTools(),{ok:true,paths,diagnostics:diagnostics(true)});
 assert.deepEqual(saved,[paths]);assert.deepEqual(checked,[paths]);
 usable=false;assert.deepEqual(await bridge.installMediaTools(),{ok:false,code:'MEDIA_TOOLS_CHECK_FAILED'});assert.equal(saved.length,1,'tools without required encoders are not saved');
 usable=true;outcome={ok:false,code:'MEDIA_TOOLS_CHECKSUM_MISMATCH'};assert.deepEqual(await bridge.installMediaTools(),{ok:false,code:'MEDIA_TOOLS_CHECKSUM_MISMATCH'});assert.equal(checked.length,2);
 outcome={ok:true,paths};const pending=host.dispatch({},{action:'installMediaTools'});trusted=false;await assert.rejects(pending);assert.equal(saved.length,1,'a closed or replaced window never writes the configuration');
 trusted=true;assert.equal(await bridge.cancelMediaToolsInstall(),true);assert.equal(cancels,1);assert.equal(installs,4);
 for(const request of [{action:'installMediaTools',url:'https://example.com/ffmpeg.gz'},{action:'mediaToolsStatus',paths},{action:'installMediaTools',paths}])await assert.rejects(host.dispatch({},request));
 const plain=createWorkspaceToolsHost({isTrusted:()=>true,read:async()=>paths,select:async()=>null,check:async()=>diagnostics(true),save:async()=>{},revealWorkspace:async()=>true});
 assert.deepEqual(await plain.dispatch({},{action:'installMediaTools'}),{ok:false,code:'MEDIA_TOOLS_UNAVAILABLE'});
 assert.equal(((await plain.dispatch({},{action:'mediaToolsStatus'})) as {offer:unknown}).offer,null);
});
