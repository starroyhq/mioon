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
