import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {createProjectFile} from '../packages/business/src/project-file/connection.ts';
import {LOCALES,translate} from '../packages/i18n/src/index.ts';
import {createProjectFileOpener,projectFileArguments,ProjectFileOpenError} from '../apps/desktop/src/project-file-open.ts';

const settle=async()=>{for(let index=0;index<10;index++)await Promise.resolve();};

test('project files on a command line are picked out and resolved against the caller directory',()=>{
 assert.deepEqual(projectFileArguments(undefined),[]);
 assert.deepEqual(projectFileArguments(['/Applications/Mioon','--inspect','.','notes.txt','Clip.MIOON','/abs/a.mioon'],'/Users/me/Desktop'),['/Users/me/Desktop/Clip.MIOON','/abs/a.mioon']);
 assert.deepEqual(projectFileArguments(['exe','b.mioon']),[path.resolve('b.mioon')]);
});

test('files opened before the backend runs wait, open in order once, and failures are reported per file',async()=>{
 const events:string[]=[];
 const opener=createProjectFileOpener({opened:()=>events.push('opened'),failed:(file,code)=>{events.push(`failed ${file} ${code}`);}});
 opener.add(['/a.mioon','/b.mioon','/a.mioon']);
 assert.deepEqual(opener.pending,['/a.mioon','/b.mioon']);
 const open=async(file:string)=>{events.push(`open ${file}`);if(file==='/b.mioon')throw new ProjectFileOpenError('PROJECT_INVALID');};
 opener.attach(open);await settle();
 assert.deepEqual(events,['open /a.mioon','opened','open /b.mioon','failed /b.mioon PROJECT_INVALID']);
 opener.detach(open);opener.add(['/c.mioon']);await settle();
 assert.deepEqual(opener.pending,['/c.mioon'],'a stopped backend leaves later files queued for the next one');
 opener.attach(async()=>{throw new Error('socket closed');});await settle();
 assert.equal(events.at(-1),'failed /c.mioon UNAVAILABLE');
});


test('a stale in-flight completion is discarded, never replayed, while later intents use the replacement',async()=>{
 let finish!:()=>void;const events:string[]=[];
 const opener=createProjectFileOpener({opened:()=>events.push('opened'),failed:()=>{events.push('failed');}});
 const old=async(file:string)=>{events.push('old '+file);await new Promise<void>(resolve=>{finish=resolve;});};
 opener.add(['/a.mioon','/b.mioon']);const pending=opener.attach(old);await settle();
 opener.detach(old);const replacement=async(file:string)=>{events.push('new '+file);};opener.attach(replacement);finish();await pending;await settle();
 assert.deepEqual(events,['old /a.mioon','new /b.mioon','opened']);
});


test('an owned failure presentation completes before the next queued file is opened',async()=>{
 let acknowledge!:()=>void;const events:string[]=[];
 const opener=createProjectFileOpener({opened:()=>events.push('opened'),failed:async()=>{events.push('failed');await new Promise<void>(resolve=>{acknowledge=resolve;});events.push('ack');}});
 opener.add(['/bad.mioon','/good.mioon']);
 const opening=opener.attach(async file=>{events.push(file);if(file==='/bad.mioon')throw new ProjectFileOpenError('PROJECT_INVALID');});
 await settle();assert.deepEqual(events,['/bad.mioon','failed']);assert.deepEqual(opener.pending,['/good.mioon']);
 acknowledge();await opening;assert.deepEqual(events,['/bad.mioon','failed','ack','/good.mioon','opened']);
});


test('native failures retain the bounded read-only reason without forwarding arbitrary error diagnostics',async()=>{
 const observed:unknown[]=[];
 const opener=createProjectFileOpener({opened:()=>assert.fail('Must fail'),failed:(_file,code,reason)=>{observed.push([code,reason]);}});
 opener.add(['/readonly.mioon','/newer.mioon']);
 await opener.attach(async file=>{throw file==='/readonly.mioon'?Object.assign(new Error('PRIVATE'),{code:'PROJECT_INVALID',details:{reason:'read-only',private:'do not publish'}}):new ProjectFileOpenError('PROJECT_FORMAT_NEWER');});
 assert.deepEqual(observed,[['PROJECT_INVALID','read-only'],['PROJECT_FORMAT_NEWER',undefined]]);
});

// The U2-A temporary "system open unavailable" cases now exercise the trusted
// path queue. Actual metadata admission belongs to the desktop entry/window
// integration tests; no archive upload or untrusted path RPC is reintroduced.
test('system intents pass real and missing paths only to the trusted port without touching project bytes or invoking legacy upload',async t=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-os-open-paths-')),file=path.join(root,'real.mioon'),missing=path.join(root,'missing.mioon');
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));createProjectFile(file);const before=fs.readFileSync(file),names=fs.readdirSync(root);
 let stats=0,reads=0,fetches=0;const calls:string[]=[],events:string[]=[];
 for(const name of ['stat','lstat'] as const)t.mock.method(fs.promises,name,async()=>{stats++;throw Error('Queue must leave metadata to its trusted port');});
 for(const name of ['statSync','lstatSync'] as const)t.mock.method(fs,name,()=>{stats++;throw Error('Queue must leave metadata to its trusted port');});
 for(const name of ['open','readFile'] as const)t.mock.method(fs.promises,name,async()=>{reads++;throw Error('Queue must not open project bytes');});
 for(const name of ['openSync','readFileSync','createReadStream'] as const)t.mock.method(fs,name,()=>{reads++;throw Error('Queue must not open project bytes');});
 t.mock.method(globalThis,'fetch',async()=>{fetches++;throw Error('Legacy project upload is forbidden');});syncBuiltinESMExports();
 try{
  const opener=createProjectFileOpener({opened:()=>{events.push('opened');},failed:()=>assert.fail('The trusted test port accepts only these observations')});
  opener.add([file,missing,file]);assert.deepEqual(opener.pending,[file,missing]);assert.deepEqual(calls.slice(),[]);
  await opener.attach(async selected=>{calls.push(selected);});
  assert.deepEqual(calls,[file,missing]);assert.deepEqual(events,['opened','opened']);assert.deepEqual(opener.pending,[]);
  assert.equal(stats,0);assert.equal(reads,0);assert.equal(fetches,0);
 }finally{t.mock.restoreAll();syncBuiltinESMExports();}
 assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(fs.readdirSync(root),names);assert.equal(fs.existsSync(missing),false);
 const source=fs.readFileSync(new URL('../apps/desktop/src/project-file-open.ts',import.meta.url),'utf8');
 assert.doesNotMatch(source,/uploadProjectFile|api\/project-packages|createReadStream|\bfetch\(/u);
});

test('deduplicated system intents stay parked while stopped and a retired port rejection cannot report or replay its file',async t=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-os-open-detach-')),file=path.join(root,'real.mioon'),missing=path.join(root,'missing.mioon');
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));createProjectFile(file);const before=fs.readFileSync(file),events:string[]=[];
 const outcome=Promise.withResolvers<void>();const opener=createProjectFileOpener({opened:()=>{events.push('opened');},failed:(selected,code)=>{events.push('failed '+selected+' '+code);}});
 const old=async(selected:string)=>{events.push('old '+selected);await outcome.promise;};
 opener.add([file,missing,file]);assert.deepEqual(opener.pending,[file,missing]);await settle();assert.deepEqual(events.slice(),[]);
 const first=opener.attach(old);await settle();assert.deepEqual(events,['old '+file]);assert.deepEqual(opener.pending,[missing]);
 opener.detach(old);await settle();assert.deepEqual(opener.pending,[missing]);assert.equal(events.length,1);
 const next=opener.attach(async selected=>{events.push('new '+selected);throw new ProjectFileOpenError('PROJECT_MISSING');});
 outcome.reject(new Error('PRIVATE retired backend failure'));await first;await next;
 assert.deepEqual(events,['old '+file,'new '+missing,'failed '+missing+' PROJECT_MISSING']);assert.deepEqual(opener.pending,[]);
 assert.equal(events.filter(value=>value==='old '+file).length,1);assert.equal(events.some(value=>value.includes('PRIVATE')),false);
 assert.deepEqual(fs.readFileSync(file),before);assert.equal(fs.existsSync(missing),false);
});

test('trusted system-open failure warnings have four translations and never offer a retired archive import retry',()=>{
 for(const key of ['native.openProjectFileAccessDenied','native.openProjectFileReadOnly','native.openProjectFileMissing','native.openProjectFileNewer','native.openProjectFileDamaged','native.openProjectFileUnavailable'] as const){
  const values=LOCALES.map(locale=>translate(locale,key,{name:'real.mioon'}));assert.equal(new Set(values).size,4);
  for(const value of values){assert.ok(value.includes('real.mioon'));assert.equal(value.includes('native.'),false);assert.doesNotMatch(value,/import|导入|匯入|プロジェクトホーム/iu);}
 }
 assert.equal(translate('zh-Hans','native.openProjectFileAccessDenied',{name:'real.mioon'}),'系统没有允许 Mioon 访问“real.mioon”所在的位置。请检查系统隐私设置或选择另一个位置。');
 const source=fs.readFileSync(new URL('../apps/desktop/src/main.ts',import.meta.url),'utf8');assert.doesNotMatch(source,/uploadProjectFile|PROJECT_FILE_OPEN_UNAVAILABLE/u);
 assert.match(source,/projectFiles\.attach\(openSelected\)/u);assert.match(source,/await openedFiles/u);
});
