import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,stat,symlink,unlink,writeFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createPrivateTemporaryDirectory,validatePrivateDirectory} from '@mioon/contracts/private-storage';
import {proveTimelineFloatCapability} from '../packages/business/src/timeline-float-capability.ts';
import type { PathOrFileDescriptor } from 'fs';
const video={width:720,height:720,scaling:'lanczos',pixelFormat:'yuv420p'};
const pause=()=>new Promise(resolve=>setTimeout(resolve,0));
async function sandbox(t: test.TestContext){const root=await mkdtemp(path.join(tmpdir(),'float-proof-test-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
const metadata=(concat?: boolean)=>({format:{format_name:concat?'concat':'mov,mp4,m4a,3gp,3g2,mj2'},streams:[{index:0,codec_type:'video'},{index:1,codec_type:'audio',codec_name:'pcm_f32le',sample_fmt:'flt',sample_rate:'48000',channels:2,channel_layout:'stereo',time_base:'1/48000',duration_ts:4800}]});
const pcm=()=>{const b=Buffer.alloc(9600*8);for(let at=0;at<b.length;at+=8){b.writeFloatLE(1.25,at);b.writeFloatLE(-1.5,at+4);}return b;};
function runtime(overrides: {runStreaming?: ((command: unknown,args: string|string[],options: { onStdout: (arg0: Buffer<ArrayBuffer>) => void; }) => Promise<{ stdoutBytes: number; }>)|((command: unknown,args: string|string[],options: { beforeEffect: () => void; }) => Promise<void>)|(() => Promise<never>); waitForMediaProcesses?: () => Promise<void>; run?: (command: unknown,args: string[]) => Promise<never>;}={}){const calls: ({ command: string; args: PathOrFileDescriptor[]; options: { beforeSpawn: () => void; beforeEffect: () => void; }; } | { command: unknown; args: string | string[]; options: { beforeSpawn: () => void; onStdout: (arg0: Buffer<ArrayBuffer>) => void; beforeEffect: () => void; }; })[]=[];return {calls,terminationMs:3000,createPrivateTemporaryDirectory,validatePrivateDirectory,
  checkMediaEffect(fn: () => void,signal: { aborted: unknown; }){if(signal?.aborted)throw Object.assign(Error('cancel'),{code:'MEDIA_CANCELLED'});fn?.();},
  async withProbePermit(signal: unknown,work: () => unknown){return work();},async waitForMediaProcesses(){},videoArgs(){return ['-c:v','libx264'];},verifyProof(bytes: { toString: () => unknown; }){assert.equal(bytes.toString(),'proof');},
  async run(command: string,args: PathOrFileDescriptor[],options: { beforeSpawn: () => void; beforeEffect: () => void; }){calls.push({command,args,options});options.beforeSpawn();if(command==='ffprobe')return JSON.stringify(metadata(args.includes('concat')));writeFileSync(((args.at(-1)) as unknown as Parameters<typeof writeFileSync>[0]),'generated MOV placeholder');options.beforeEffect();return '';},
  async runStreaming(command: unknown,args: string|string[],options: { beforeSpawn: () => void; onStdout: (arg0: Buffer<ArrayBuffer>) => void; beforeEffect: () => void; }){calls.push({command,args,options});options.beforeSpawn();const bytes=args.includes('f32le')?pcm():Buffer.from('proof');options.onStdout(bytes);options.beforeEffect();return {stdoutBytes:bytes.length};},...overrides};}
const options=(root: string)=>({workRoot:root,beforeEffect(){},remainingMs:()=>10000});

test('capability proves generated float MOVs, exact two-segment concat and AAC in private owned files',async t=>{
 const root=await sandbox(t),r=runtime();await proveTimelineFloatCapability(((r) as unknown as Parameters<typeof proveTimelineFloatCapability>[0]),video,options(root));
 assert.deepEqual((await readdir(root) as unknown),[]);
 const mov=r.calls.filter(call=>call.command==='ffmpeg'&&(call.args.at(-1) as string).endsWith('.mov'));assert.equal(mov.length,2);
 for(const call of mov){assert.equal(call.args[call.args.indexOf('-c:a')+1],'pcm_f32le');assert.equal(call.args[call.args.indexOf('-ar')+1],'48000');assert.equal(call.args[call.args.indexOf('-ac')+1],'2');}
 const checked=r.calls.findIndex(call=>call.args.includes('f32le')),aac=r.calls.findIndex(call=>call.args[call.args.indexOf('-c:a')+1]==='aac');assert.ok(checked>=0&&aac>checked);
 assert.equal(r.calls.filter(call=>call.command==='ffprobe').length,3);
});

test('capability refuses alias roots and rejects integer-headroom loss before final AAC',async t=>{
 const root=await sandbox(t),alias=path.join(root,'alias');await symlink(root,alias);const r=runtime();await assert.rejects(proveTimelineFloatCapability(((r) as unknown as Parameters<typeof proveTimelineFloatCapability>[0]),video,options(alias)));assert.deepEqual((r.calls as unknown),[]);
 const narrow=runtime({async runStreaming(command: unknown,args: string|string[],options: { onStdout: (arg0: Buffer<ArrayBuffer>) => void; }){assert.ok(args.includes('f32le'));options.onStdout(Buffer.alloc(9600*8));return {stdoutBytes:9600*8};}});
 await assert.rejects(proveTimelineFloatCapability(((narrow) as unknown as Parameters<typeof proveTimelineFloatCapability>[0]),video,options(root)),{code:'EXPORT_CAPABILITY_FAILED'});assert.deepEqual(await readdir(root),['alias']);
});

test('capability leaves unknown replacement staging untouched and cannot return available',async t=>{
 const root=await sandbox(t);let replacement;
 const r=runtime({async runStreaming(command: unknown,args: string|string[],options: { beforeEffect: () => void; }){const list=args[args.indexOf('-i')+1];replacement=path.join(path.dirname(list),'segment-1.mov');await unlink(replacement);await writeFile(replacement,'foreign replacement',{mode:0o600});options.beforeEffect();}});
 await assert.rejects(proveTimelineFloatCapability(((r) as unknown as Parameters<typeof proveTimelineFloatCapability>[0]),video,options(root)),{code:'EXPORT_AUDIO_STAGING_CHANGED'});
 assert.ok((await stat(((replacement) as unknown as Parameters<typeof stat>[0]))).isFile());assert.equal((await readdir(root)).length,1);
});

test('capability retains all owned files while child termination remains unconfirmed',async t=>{
 const root=await sandbox(t);let closed!:()=>void;const close=new Promise<void>(resolve=>{closed=resolve;});
 const r=runtime({async waitForMediaProcesses(){await close;},async runStreaming(){throw Object.assign(Error('unconfirmed'),{code:'MEDIA_CANCELLED',terminationUnconfirmed:true});}});
 await assert.rejects(proveTimelineFloatCapability(((r) as unknown as Parameters<typeof proveTimelineFloatCapability>[0]),video,options(root)),error=>(error as Error & {code: string; status?: number; details?: {mutationOutcome?: string; skipped?:{clipId:string;reason:string;shortByFrames?:number}[]; [key: string]: unknown}; stdout?: string; stderr?: string; dispatched?: boolean; outcomeUnknown?: boolean; terminationUnconfirmed?: boolean}).terminationUnconfirmed===true);
 const work=path.join(root,(await readdir(root))[0]);assert.equal((await readdir(work)).length,3);(closed)!();await pause();assert.deepEqual((await readdir(root) as unknown),[]);
});

test('v2 render staging confirms only exact private owned cleanup and preserves unknown replacements',async t=>{
 const {createTimelineFloatStaging}=await import('../packages/business/src/timeline-float-staging.ts');
 const root=await sandbox(t),r=runtime(),clean=createTimelineFloatStaging(path.join(root,'output.mp4'),{},((r) as unknown as Parameters<typeof createTimelineFloatStaging>[2]));
 const file=path.join(clean.work,'owned.filter');await clean.writeOwnedFile(file,'private graph');assert.equal((await stat(file)).mode&0o077,0);assert.equal((await stat(clean.work)).mode&0o077,0);assert.equal(clean.cleanup(),true);
 const changed=createTimelineFloatStaging(path.join(root,'output.mp4'),{},((r) as unknown as Parameters<typeof createTimelineFloatStaging>[2])),replacement=path.join(changed.work,'segment-000.mov');changed.reserve(replacement);await unlink(replacement);await writeFile(replacement,'foreign',{mode:0o600});
 assert.throws(()=>changed.effect(),{code:'INVALID_TIMELINE_SNAPSHOT'});assert.equal(changed.cleanup(),false);assert.ok((await stat(replacement)).isFile());
});

test('capability preserves a primary encode failure if exact cleanup also cannot finish',async t=>{
 const root=await sandbox(t),primary=Object.assign(Error('primary encode failure'),{code:'MEDIA_EXIT_FAILED'});
 const r=runtime({async run(command: unknown,args: string[]){const work=path.dirname(((args.at(-1)) as unknown as Parameters<typeof path.dirname>[0]));await writeFile(path.join(work,'unknown-file'),'foreign');throw primary;}});
 await assert.rejects(proveTimelineFloatCapability(((r) as unknown as Parameters<typeof proveTimelineFloatCapability>[0]),video,options(root)),error=>error===primary);
 const work=path.join(root,(await readdir(root))[0]);assert.deepEqual(await readdir(work),['unknown-file']);
});
