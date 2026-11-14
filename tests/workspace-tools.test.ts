import test from 'node:test';
import assert from 'node:assert/strict';
import fs,{mkdtemp,mkdir,writeFile,symlink,rm,readFile,readdir,realpath} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {inspectMediaTools} from '../packages/business/src/media-tool-diagnostics.ts';
import {readWorkspaceInfo,readApplicationWorkspaceInfo} from '../apps/server/src/workspace-info.ts';
import {applicationWorkspaceInfoSchema,applicationWorkspaceStorageInfoSchema,workspaceMetadataSchema,workspaceInfoSchema} from '../packages/contracts/src/workspace-info.ts';
import {readWorkspaceInfo as readBrowserWorkspaceInfo} from '../apps/web/src/workspace-info-client.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {startServer} from './helpers/test-server.ts';
import {projectApiPath} from '../packages/contracts/src/project-file.ts';
import {createWorkspaceToolsHost} from '../apps/desktop/src/workspace-tools-host.ts';
import {createWorkspaceToolsBridge} from '../apps/desktop/src/workspace-tools-preload.ts';
import {readToolConfig,saveToolConfig,utilityEnvironment,validateTools} from '../apps/desktop/src/config.ts';
import {createProjectDeletionGate} from '../apps/server/src/project-deletion-gate.ts';
test('tool diagnostics report actual missing filters and bounded fixed invocations',async()=>{
 const calls: { command: string; args: string[]; options: { timeout: number; maxStdoutBytes: number; maxStderrBytes: number; signal?: AbortSignal; }; }[]=[];const result=await inspectMediaTools({ffmpeg:'/local/ffmpeg',ffprobe:'/local/ffprobe'},{execute:async(command,args,options)=>{calls.push({command,args,options});if(args[0]==='-version')return `${command.endsWith('ffprobe')?'ffprobe':'ffmpeg'} version test\n`;return args.includes('-encoders')?' V..... libx264\n A..... aac\n':' T.. scale\n';}});
 assert.deepEqual(result.capabilities,{libx264:true,aac:true,drawtext:false,subtitles:false});assert.equal(calls.length,4);assert.ok(calls.every(c=>c.options.timeout===10000));
 const bad=await inspectMediaTools({ffmpeg:'ffmpeg',ffprobe:'ffprobe'},{execute:async()=>{throw Error('private environment and command diagnostics');}});assert.equal(bad.ffmpeg.available,false);assert.equal(bad.ffmpeg.version,null);assert.equal(JSON.stringify(bad).includes('private environment'),false);
 let attempts=0;await assert.rejects(inspectMediaTools({ffmpeg:'ffmpeg',ffprobe:'ffprobe'},{execute:async()=>{attempts++;throw Object.assign(Error('unconfirmed'),{terminationUnconfirmed:true});}}),/unconfirmed/u);assert.equal(attempts,1);
});
test('workspace usage skips external links and reports an incomplete estimate',async t=>{
 const directory=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-workspace-info-')));t.after(()=>rm(directory,{recursive:true,force:true}));const root=path.join(directory,'workspace');await mkdir(root);await writeFile(path.join(root,'local'),'abc');await writeFile(path.join(directory,'external'),'private');await symlink(path.join(directory,'external'),path.join(root,'link'));
 const result=await readWorkspaceInfo({root,channel:'development',version:'test',tools:{ffmpeg:'ffmpeg',ffprobe:'ffprobe'},signal:new AbortController().signal});assert.deepEqual(result.usage,{bytes:3,files:1,complete:false});assert.equal(result.dataDirectory,root);
});
test('native tools reject untrusted, malformed and stale callers before a config write',async()=>{
 let trusted=true,writes=0,release;const paths={ffmpeg:'/local/ffmpeg',ffprobe:'/local/ffprobe'},result={ffmpeg:{path:paths.ffmpeg,version:'ffmpeg version test',available:true},ffprobe:{path:paths.ffprobe,version:'ffprobe version test',available:true},capabilities:{aac:true,libx264:true,subtitles:false,drawtext:false}};
 const host=createWorkspaceToolsHost({isTrusted:()=>trusted,read:async()=>paths,select:async()=>null,check:async()=>{await new Promise(resolve=>{release=resolve;});return result;},save:async()=>{writes++;},revealWorkspace:async()=>true});
 const bridge=createWorkspaceToolsBridge((channel,request)=>{assert.equal(channel,'mioon:workspace-tools');return host.dispatch({},request);});assert.deepEqual(await bridge.read(),paths);
 await assert.rejects(host.dispatch({},{action:'revealWorkspace',path:'/arbitrary'}));const pending=bridge.save(paths);trusted=false;release!();await assert.rejects(pending);assert.equal(writes,0);await assert.rejects(bridge.read());
});

test('saved FFmpeg selections follow upgraded Homebrew-style links on the next validation', {
 skip: process.platform === 'win32' ? 'Uses executable Unix symlinks' : false,
}, async t => {
 const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-011-tool-links-')));
 t.after(() => rm(root, {recursive: true, force: true}));
 const configFile = path.join(root, 'desktop-config.json');
 const pair = (directory: string) => ({ffmpeg: path.join(directory, 'ffmpeg'), ffprobe: path.join(directory, 'ffprobe')});
 const tools = ['ffmpeg', 'ffprobe'] as const;
 const oldVersion = pair(path.join(root, 'Cellar', '1', 'bin'));
 const newVersion = pair(path.join(root, 'Cellar', '2', 'bin'));
 const selected = pair(path.join(root, 'bin'));
 for (const files of [oldVersion, newVersion]) {
  await mkdir(path.dirname(files.ffmpeg), {recursive: true});
  for (const tool of tools) await writeFile(files[tool], 'inert validation fixture', {mode: 0o700});
 }
 await mkdir(path.dirname(selected.ffmpeg));
 for (const tool of tools) await symlink(oldVersion[tool], selected[tool]);
 const execute: NonNullable<NonNullable<Parameters<typeof validateTools>[1]>['execute']> = async (file, args) => {
  assert.ok([...Object.values(oldVersion), ...Object.values(newVersion)].includes(file), 'validation executes the resolved file');
  if (args[0] === '-version') return `${path.basename(file)} version ${file === newVersion.ffmpeg || file === newVersion.ffprobe ? '2' : '1'}\n`;
  return args.includes('-encoders') ? 'libx264 aac\n' : 'drawtext subtitles\n';
 };
 const read = () => readToolConfig(configFile, {});
 const host = createWorkspaceToolsHost({isTrusted: () => true, read, select: async () => null,
  check: async paths => inspectMediaTools(await validateTools(paths, {execute}), {execute}),
  save: paths => saveToolConfig(configFile, paths), revealWorkspace: async () => true});
 const bridge = createWorkspaceToolsBridge((_channel, request) => host.dispatch({}, request));
 const initial = await bridge.save(selected);
 assert.equal(initial.ffmpeg.path, oldVersion.ffmpeg);
 assert.equal(initial.ffprobe.path, oldVersion.ffprobe);
 assert.deepEqual(await bridge.read(), selected, 'saving keeps the chosen links');
 for (const tool of tools) {
  await rm(selected[tool]);
  await symlink(newVersion[tool], selected[tool]);
 }
 await rm(path.join(root, 'Cellar', '1'), {recursive: true});
 const restarted = await validateTools(await read(), {execute});
 assert.deepEqual(restarted.selected, selected, 'startup can save the selected paths independently of execution');
 assert.equal(utilityEnvironment({}, restarted).MIOON_FFMPEG_PATH, newVersion.ffmpeg);
 assert.equal(utilityEnvironment({}, restarted).MIOON_FFPROBE_PATH, newVersion.ffprobe);
 const checked = await bridge.check(await read());
 assert.equal(checked.ffmpeg.version, 'ffmpeg version 2');
 assert.equal(checked.ffprobe.version, 'ffprobe version 2');
 assert.deepEqual(await read(), selected);

 await saveToolConfig(configFile, newVersion);
 const legacyBytes = await readFile(configFile);
 assert.equal((await validateTools(await read(), {execute})).ffmpeg, newVersion.ffmpeg);
 assert.deepEqual(await readFile(configFile), legacyBytes, 'working legacy Cellar settings are not rewritten');
 for (const tool of tools) {
  await mkdir(path.dirname(oldVersion[tool]), {recursive: true});
  await writeFile(oldVersion[tool], 'inert fallback fixture', {mode: 0o700});
  await rm(selected[tool]);
  await symlink(oldVersion[tool], selected[tool]);
 }
 await rm(path.join(root, 'Cellar', '2'), {recursive: true});
 await assert.rejects(validateTools(await read(), {execute}), {code: 'ENOENT'});
 assert.deepEqual(await readFile(configFile), legacyBytes, 'missing legacy paths stay untouched for the existing startup prompt');
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

const inventoryOptions={channel:'web' as const,version:'test',tools:{ffmpeg:'ffmpeg',ffprobe:'ffprobe'}};
test('configured workspace roots resolve ancestor aliases before inventorying and still skip discovered links',async t=>{
 const base=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-root-alias-')));t.after(()=>rm(base,{recursive:true,force:true}));
 const physical=path.join(base,'physical'),alias=path.join(base,'alias');await mkdir(path.join(physical,'data'),{recursive:true});await writeFile(path.join(physical,'data','known'),'known');await writeFile(path.join(base,'outside'),'private');await symlink(path.join(base,'outside'),path.join(physical,'data','link'));await symlink(physical,alias);
 const result=await readWorkspaceInfo({...inventoryOptions,root:path.join(alias,'data'),signal:new AbortController().signal});
 assert.deepEqual(result.usage,{bytes:5,files:1,complete:false});assert.equal(result.dataDirectory,path.join(alias,'data'));assert.equal(await readFile(path.join(base,'outside'),'utf8'),'private');
});

test('HTTP metadata view performs no inventory and storage view visits each displayed root only once',async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-info-views-')));t.after(()=>rm(root,{recursive:true,force:true}));const records=path.join(root,'records'),cacheDir=path.join(root,'cache');await mkdir(records,{mode:0o700});await mkdir(cacheDir,{mode:0o700});await writeFile(path.join(records,'history.db'),'abc');await writeFile(path.join(cacheDir,'preview'),'xyz');
 const server=await startServer({dataDir:root,cacheDir,port:0,token:'synthetic-info-views-token'});t.after(()=>server.close());
 const opened:string[]=[],original=fs.opendir,mocked=t.mock.method(fs,'opendir',async(...args:Parameters<typeof fs.opendir>)=>{opened.push(String(args[0]));return original(...args);});syncBuiltinESMExports();t.after(()=>{mocked.mock.restore();syncBuiltinESMExports();});
 const request=async(view:string)=>{const response=await fetch(server.url+'/api/workspace-info?view='+view,{headers:{authorization:'Bearer synthetic-info-views-token'}});return {status:response.status,value:await response.json()};};
 const metadata=await request('metadata');assert.equal(metadata.status,200);assert.equal(metadata.value.data.dataDirectory,root);assert.equal(metadata.value.data.channel,'web');assert.deepEqual(opened,[]);assert.equal('usage' in metadata.value.data,false);assert.equal('storage' in metadata.value.data,false);
 const storage=await request('storage');assert.equal(storage.status,200);assert.deepEqual(storage.value.data.storage.records,{bytes:3,files:1,complete:true});assert.deepEqual(storage.value.data.storage.cache,{bytes:3,files:1,complete:true});assert.equal('usage' in storage.value.data,false);assert.deepEqual(opened.sort(),[records,cacheDir].sort());
 assert.equal((await request('unrecognized')).status,400);
});
async function inventoryFixture(t:test.TestContext){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-application-storage-info-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const dataDir=path.join(root,'data'),cacheDir=path.join(root,'external-cache');await mkdir(dataDir,{mode:0o700});
 return {root,dataDir,cacheDir,read:(signal=new AbortController().signal)=>readApplicationWorkspaceInfo({...inventoryOptions,directories:{dataDir,cacheDir},signal})};
}
function mockMetadata(t:test.TestContext,replace:(file:string,metadata:Awaited<ReturnType<typeof fs.lstat>>)=>Awaited<ReturnType<typeof fs.lstat>>){
 const original=fs.lstat;
 const mocked=t.mock.method(fs,'lstat',(async(...args:Parameters<typeof fs.lstat>)=>replace(String(args[0]),await original(...args))) as typeof fs.lstat);
 const restore=()=>{mocked.mock.restore();syncBuiltinESMExports();};syncBuiltinESMExports();t.after(restore);return restore;
}

test('application storage inventories actual records and external cache without redefining whole data usage',async t=>{
 const f=await inventoryFixture(t),records=path.join(f.dataDir,'records');await mkdir(records);await mkdir(f.cacheDir);
 await writeFile(path.join(f.dataDir,'settings'),'12345');await writeFile(path.join(records,'history.db'),'abc');await writeFile(path.join(f.cacheDir,'preview'),'cache!!');
 const before=await readdir(f.dataDir),result=await readApplicationWorkspaceInfo({...inventoryOptions,directories:f,signal:new AbortController().signal,pendingProjectCleanup:3});
 assert.deepEqual(result.usage,{bytes:8,files:2,complete:true});assert.deepEqual(result.storage.records,{bytes:3,files:1,complete:true});assert.deepEqual(result.storage.cache,{bytes:7,files:1,complete:true});
 assert.equal(result.dataDirectory,f.dataDir);assert.equal(result.storage.cacheDirectory,f.cacheDir);assert.equal(result.pendingProjectCleanup,3);assert.deepEqual(result.tools,inventoryOptions.tools);
 assert.deepEqual(applicationWorkspaceInfoSchema.parse(result),result);assert.deepEqual(await readdir(f.dataDir),before);assert.equal((await readFile(path.join(records,'history.db'))).toString(),'abc');
 const base=await readWorkspaceInfo({...inventoryOptions,root:records,signal:new AbortController().signal});assert.deepEqual(base.usage,{bytes:3,files:1,complete:true});assert.deepEqual(workspaceInfoSchema.parse(base),base);assert.equal('storage'in base,false);assert.equal(base.dataDirectory,records);
 assert.equal(workspaceInfoSchema.safeParse(result).success,false);assert.equal(applicationWorkspaceInfoSchema.safeParse(base).success,false);
});

test('application record totals include live records and do not call orphan listing or sweep tombstones',async t=>{
 const f=await inventoryFixture(t),opened='10000000-0000-4000-8000-000000000001',orphan='10000000-0000-4000-8000-000000000002';
 const library=openAppLibrary({dataDir:f.dataDir,isProjectOpen:id=>id===opened});t.after(()=>library.close());
 for(const [id,content] of [[opened,'live-record'],[orphan,'lost']] as const){const dir=path.join(f.dataDir,'records',id);await mkdir(dir,{recursive:true,mode:0o700});await writeFile(path.join(dir,'history.db'),content);}
 const tombstone=path.join(f.dataDir,'records','.deleting-'+orphan+'-10000000-0000-4000-8000-000000000003');await mkdir(tombstone);await writeFile(path.join(tombstone,'retained'),'receipt');
 const changes=library.db.prepare('SELECT total_changes() AS n').get()!.n;
 let opens=0,reads=0;const open=t.mock.method(fs,'open',async()=>{opens++;throw Error('Inventory must not open a data file');}),read=t.mock.method(fs,'readFile',async()=>{reads++;throw Error('Inventory must not read file contents');});syncBuiltinESMExports();
 const result=await f.read();assert.deepEqual(result.storage.records,{bytes:22,files:3,complete:true});assert.equal(library.db.prepare('SELECT total_changes() AS n').get()!.n,changes);
 assert.equal(opens,0);assert.equal(reads,0);open.mock.restore();read.mock.restore();syncBuiltinESMExports();
 assert.equal((await readFile(path.join(tombstone,'retained'))).toString(),'receipt');assert.equal((await readFile(path.join(f.dataDir,'records',opened,'history.db'))).toString(),'live-record');
 // Listing is a different, effectful capability. Its missing-project subset
 // cannot stand in for the complete records inventory above.
 const lost=await library.localRecords.list();assert.deepEqual(lost.map(item=>item.projectId),[orphan]);assert.equal(lost[0].sizeBytes,4);assert.ok(result.storage.records.bytes>lost.reduce((sum,item)=>sum+item.sizeBytes,0));
});

test('missing records and cache are complete zero inventories, while a non-directory is incomplete',async t=>{
 const f=await inventoryFixture(t),empty=await f.read();assert.deepEqual(empty.usage,{bytes:0,files:0,complete:true});assert.deepEqual(empty.storage.records,{bytes:0,files:0,complete:true});assert.deepEqual(empty.storage.cache,{bytes:0,files:0,complete:true});
 await writeFile(f.cacheDir,'not a directory');const malformed=await f.read();assert.deepEqual(malformed.storage.cache,{bytes:0,files:0,complete:false});assert.deepEqual(malformed.storage.records,empty.storage.records);
});

test('nested and aliased cache roots are independently measured instead of added to root usage',async t=>{
 const f=await inventoryFixture(t),records=path.join(f.dataDir,'records'),nested=path.join(records,'cache');await mkdir(nested,{recursive:true});await writeFile(path.join(records,'history.db'),'123');await writeFile(path.join(nested,'cached'),'45678');
 for(const [cacheDir,expected] of [[nested,5],[records,8],[f.dataDir,8]] as const){const result=await readApplicationWorkspaceInfo({...inventoryOptions,directories:{dataDir:f.dataDir,cacheDir},signal:new AbortController().signal});assert.equal(result.usage.bytes,8);assert.equal(result.storage.records.bytes,8);assert.equal(result.storage.cache.bytes,expected);assert.equal(result.storage.cacheDirectory,cacheDir);assert.equal(result.storage.cache.complete,true);}
});

test('inventories resolve configured root aliases but never follow links discovered below selected roots',async t=>{
 const f=await inventoryFixture(t),outside=path.join(f.root,'outside'),records=path.join(f.dataDir,'records');await mkdir(outside);await mkdir(records);await mkdir(f.cacheDir);await writeFile(path.join(outside,'private'),'external private bytes');await writeFile(path.join(f.cacheDir,'own'),'ok');
 await symlink(path.join(outside,'private'),path.join(f.cacheDir,'file-link'));await symlink(outside,path.join(records,'directory-link'));
 let result=await f.read();assert.deepEqual(result.storage.cache,{bytes:2,files:1,complete:false});assert.deepEqual(result.storage.records,{bytes:0,files:0,complete:false});
 const alias=path.join(f.root,'cache-link');await symlink(outside,alias);
 for(const [cacheDir,bytes,files] of [[alias,22,1],[path.join(alias,'nested'),0,0]] as const){result=await readApplicationWorkspaceInfo({...inventoryOptions,directories:{dataDir:f.dataDir,cacheDir},signal:new AbortController().signal});assert.deepEqual(result.storage.cache,{bytes,files,complete:true});}
 assert.equal((await readFile(path.join(outside,'private'))).toString(),'external private bytes');
});

test('unreadable and disappearing entries are incomplete rather than fabricated empty totals',async t=>{
 const f=await inventoryFixture(t),denied=path.join(f.cacheDir,'denied');await mkdir(denied,{recursive:true});await writeFile(path.join(denied,'private'),'private');
 const original=fs.opendir,mocked=t.mock.method(fs,'opendir',async(...args:Parameters<typeof fs.opendir>)=>{if(String(args[0])===denied)throw Object.assign(Error('synthetic private permission detail'),{code:'EACCES'});return original(...args);});syncBuiltinESMExports();t.after(()=>{mocked.mock.restore();syncBuiltinESMExports();});
 const permission=await f.read();assert.deepEqual(permission.storage.cache,{bytes:0,files:0,complete:false});assert.equal(JSON.stringify(permission).includes('private permission'),false);
 mocked.mock.restore();syncBuiltinESMExports();const vanished=path.join(denied,'private');const restoreVanished=mockMetadata(t,(file,metadata)=>{if(file===vanished)throw Object.assign(Error('vanished after directory enumeration'),{code:'ENOENT'});return metadata;});
 const changed=await f.read();assert.deepEqual(changed.storage.cache,{bytes:0,files:0,complete:false});assert.deepEqual(changed.storage.records,{bytes:0,files:0,complete:true});
 restoreVanished();
 let cacheStats=0;mockMetadata(t,(file,metadata)=>{if(file===f.cacheDir&&++cacheStats>1)Object.defineProperty(metadata,'ino',{value:typeof metadata.ino==='bigint'?metadata.ino+1n:metadata.ino+1});return metadata;});
 assert.deepEqual((await f.read()).storage.cache,{bytes:0,files:0,complete:false},'A replaced root is not measured using an earlier directory identity.');
});

test('unsafe byte totals stay safe integers and explicitly incomplete',async t=>{
 const f=await inventoryFixture(t);await mkdir(f.cacheDir);const file=path.join(f.cacheDir,'large');await writeFile(file,'x');let size=BigInt(Number.MAX_SAFE_INTEGER)+1n;mockMetadata(t,(target,metadata)=>{if(target===file)Object.defineProperty(metadata,'size',{value:size});return metadata;});
 const result=await f.read();assert.deepEqual(result.storage.cache,{bytes:Number.MAX_SAFE_INTEGER,files:1,complete:false});assert.equal(applicationWorkspaceInfoSchema.safeParse(result).success,true);assert.equal(Number.isSafeInteger(result.storage.cache.bytes),true);
 size=BigInt(Number.MAX_SAFE_INTEGER);await writeFile(path.join(f.cacheDir,'one-more'),'x');assert.deepEqual((await f.read()).storage.cache,{bytes:Number.MAX_SAFE_INTEGER,files:2,complete:false});
});

test('streaming inventory has an entry and depth bound with explicit partial totals',async t=>{
 const f=await inventoryFixture(t);await mkdir(f.cacheDir);
 for(let begin=0;begin<20001;begin+=100)await Promise.all(Array.from({length:Math.min(100,20001-begin)},(_,offset)=>writeFile(path.join(f.cacheDir,String(begin+offset)),'x')));
 const limited=await f.read();assert.deepEqual(limited.storage.cache,{bytes:20000,files:20000,complete:false});
 await rm(f.cacheDir,{recursive:true});let nested=f.cacheDir;for(let depth=0;depth<18;depth++){nested=path.join(nested,'nested');await mkdir(nested,{recursive:true});}await writeFile(path.join(nested,'too-deep'),'private');
 const deep=await f.read();assert.deepEqual(deep.storage.cache,{bytes:0,files:0,complete:false});
});

test('aborted inventory rejects before metadata or immediately after an in-flight stat',async t=>{
 const f=await inventoryFixture(t),early=new AbortController(),reason=Error('stop inventory');early.abort(reason);let calls=0;
 const restoreCounts=mockMetadata(t,(_file,metadata)=>{calls++;return metadata;});await assert.rejects(f.read(early.signal),error=>error===reason);assert.equal(calls,0);restoreCounts();
 await mkdir(f.cacheDir);const file=path.join(f.cacheDir,'stop');await writeFile(file,'retained');const controller=new AbortController();mockMetadata(t,(target,metadata)=>{if(target===file)controller.abort(reason);return metadata;});
 await assert.rejects(f.read(controller.signal),error=>error===reason);assert.equal((await readFile(file)).toString(),'retained');
});

test('web workspace information uses the strict application DTO and forwards only the fixed read capability',async t=>{
 const f=await inventoryFixture(t),valid=await f.read(),calls:[RequestInfo|URL,RequestInit|undefined][]=[];let payload:unknown=valid;
 const fetch=t.mock.method(globalThis,'fetch',async(url:RequestInfo|URL,options?:RequestInit)=>{calls.push([url,options]);return Response.json({ok:true,data:payload});});const controller=new AbortController();
 assert.deepEqual(await readBrowserWorkspaceInfo(controller.signal),valid);assert.equal(calls[0][0],'/api/workspace-info');assert.equal(calls[0][1]?.credentials,'same-origin');assert.equal(calls[0][1]?.signal,controller.signal);assert.equal(calls[0][1]?.body,undefined);
 for(const invalid of [{...valid,storage:undefined},{...valid,extra:'unexpected'},{...valid,storage:{...valid.storage,path:'/arbitrary'}},{...valid,storage:{...valid.storage,cache:{...valid.storage.cache,bytes:-1}}},{...valid,storage:{...valid.storage,records:{...valid.storage.records,files:Number.MAX_SAFE_INTEGER+1}}},{...valid,storage:{...valid.storage,cacheDirectory:''}}]){payload=invalid;await assert.rejects(readBrowserWorkspaceInfo());}
 fetch.mock.restore();const reason=Error('cancel client');t.mock.method(globalThis,'fetch',async(_url:RequestInfo|URL,options?:RequestInit)=>{assert.equal(options?.signal,controller.signal);throw reason;});await assert.rejects(readBrowserWorkspaceInfo(controller.signal),error=>error===reason);
});

test('browser metadata and storage views request only fixed projections and reject fabricated omitted totals',async t=>{
 const f=await inventoryFixture(t),full=await f.read(),{usage:_usage,storage,...metadata}=full,projected={...metadata,storage};
 const calls:{url:string;options?:RequestInit}[]=[],abort=new AbortController();let payload:unknown=metadata;
 t.mock.method(globalThis,'fetch',async(url:RequestInfo|URL,options?:RequestInit)=>{calls.push({url:String(url),options});return Response.json({ok:true,data:payload});});
 assert.deepEqual(await readBrowserWorkspaceInfo(abort.signal,'metadata'),metadata);assert.equal(calls[0].url,'/api/workspace-info?view=metadata');assert.equal(calls[0].options?.signal,abort.signal);assert.equal(calls[0].options?.credentials,'same-origin');assert.equal(calls[0].options?.body,undefined);assert.deepEqual(workspaceMetadataSchema.parse(metadata),metadata);
 payload=projected;assert.deepEqual(await readBrowserWorkspaceInfo(abort.signal,'storage'),projected);assert.equal(calls[1].url,'/api/workspace-info?view=storage');assert.deepEqual(applicationWorkspaceStorageInfoSchema.parse(projected),projected);
 payload=full;await assert.rejects(readBrowserWorkspaceInfo(undefined,'metadata'));await assert.rejects(readBrowserWorkspaceInfo(undefined,'storage'));
});

test('real application info uses actual external cache while project native info retains the strict base DTO',async t=>{
 const f=await inventoryFixture(t),records=path.join(f.dataDir,'records','10000000-0000-4000-8000-000000000004');await mkdir(records,{recursive:true,mode:0o700});await mkdir(f.cacheDir,{mode:0o700});await writeFile(path.join(records,'history.db'),'not SQLite');await writeFile(path.join(f.cacheDir,'preview'),'external');
 const token='synthetic-workspace-info-token',server=await startServer({dataDir:f.dataDir,cacheDir:f.cacheDir,port:0,token});t.after(()=>server.close());
 try{
  const request=async(resource:string,init:Omit<RequestInit,'headers'>&{headers?:Record<string,string>}={})=>fetch(server.url+resource,{...init,headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...init.headers}});
  let response=await request('/api/workspace-info');assert.equal(response.status,200);const application=applicationWorkspaceInfoSchema.parse((await response.json()).data);assert.equal(application.dataDirectory,f.dataDir);assert.equal(application.storage.cacheDirectory,f.cacheDir);assert.deepEqual(application.storage.records,{bytes:10,files:1,complete:true});assert.deepEqual(application.storage.cache,{bytes:8,files:1,complete:true});
  response=await fetch(server.url+'/api/workspace-info');assert.equal(response.status,401);response=await request('/api/workspace-info',{headers:{origin:'https://untrusted.invalid'}});assert.equal(response.status,403);
  response=await request('/api/rpc',{method:'POST',body:JSON.stringify({operation:'project.create',input:{name:'Native base workspace'}})});assert.equal(response.status,200);const created:unknown=await response.json();assert.ok(created&&typeof created==='object'&&'data'in created&&created.data&&typeof created.data==='object'&&'id'in created.data&&typeof created.data.id==='string');
  response=await request(projectApiPath(created.data.id,'workspace-info'));assert.equal(response.status,200);const project=workspaceInfoSchema.parse((await response.json()).data);assert.notEqual(project.dataDirectory,f.dataDir);assert.equal('storage'in project,false);assert.equal(applicationWorkspaceInfoSchema.safeParse(project).success,false);assert.equal((await readFile(path.join(records,'history.db'))).toString(),'not SQLite');
 }finally{await server.close();}
});
