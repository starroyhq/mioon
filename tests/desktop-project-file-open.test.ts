import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {createProjectFileOpener,projectFileArguments,ProjectFileOpenError,uploadProjectFile} from '../apps/desktop/src/project-file-open.ts';
import {createProjectFile} from '../packages/business/src/project-file/connection.ts';
import {LOCALES,translate} from '../packages/i18n/src/index.ts';

const settle=async()=>{for(let index=0;index<10;index++)await Promise.resolve();};

test('project files on a command line are picked out and resolved against the caller directory',()=>{
 assert.deepEqual(projectFileArguments(undefined),[]);
 assert.deepEqual(projectFileArguments(['/Applications/Mioon','--inspect','.','notes.txt','Clip.MIOON','/abs/a.mioon'],'/Users/me/Desktop'),['/Users/me/Desktop/Clip.MIOON','/abs/a.mioon']);
 assert.deepEqual(projectFileArguments(['exe','b.mioon']),[path.resolve('b.mioon')]);
});

test('files opened before the backend runs wait, upload in order once, and failures are reported per file',async()=>{
 const events:string[]=[];
 const opener=createProjectFileOpener({opened:()=>events.push('opened'),failed:(file,code)=>events.push(`failed ${file} ${code}`)});
 opener.add(['/a.mioon','/b.mioon','/a.mioon']);
 assert.deepEqual(opener.pending,['/a.mioon','/b.mioon']);
 const upload=async(file:string)=>{events.push(`upload ${file}`);if(file==='/b.mioon')throw new ProjectFileOpenError('PROJECT_PACKAGE_CORRUPT');};
 opener.attach(upload);await settle();
 assert.deepEqual(events,['upload /a.mioon','opened','upload /b.mioon','failed /b.mioon PROJECT_PACKAGE_CORRUPT']);
 opener.detach(upload);opener.add(['/c.mioon']);await settle();
 assert.deepEqual(opener.pending,['/c.mioon'],'a stopped backend leaves later files queued for the next one');
 opener.attach(async()=>{throw new Error('socket closed');});await settle();
 assert.equal(events.at(-1),'failed /c.mioon UNAVAILABLE');
});

test('system open rejects real, missing and aborted files before stat, read, stream or fetch and preserves the project bytes',async t=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-os-open-unavailable-')),file=path.join(root,'real.mioon'),missing=path.join(root,'missing.mioon');
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));createProjectFile(file);const before=fs.readFileSync(file),names=fs.readdirSync(root);
 let stats=0,reads=0,fetches=0;
 for(const name of ['stat','lstat'] as const)t.mock.method(fs.promises,name,async()=>{stats++;throw Error('Unexpected filesystem metadata');});
 for(const name of ['statSync','lstatSync'] as const)t.mock.method(fs,name,()=>{stats++;throw Error('Unexpected filesystem metadata');});
 for(const name of ['open','readFile'] as const)t.mock.method(fs.promises,name,async()=>{reads++;throw Error('Unexpected filesystem read');});
 for(const name of ['openSync','readFileSync','createReadStream'] as const)t.mock.method(fs,name,()=>{reads++;throw Error('Unexpected filesystem read');});
 syncBuiltinESMExports();const aborted=new AbortController();aborted.abort();
 try{
  for(const input of [{file},{file:missing},{file,signal:aborted.signal}])await assert.rejects(uploadProjectFile({base:'http://127.0.0.1:1',token:'synthetic-os-open-token',...input,fetchImpl:async()=>{fetches++;return Response.json({ok:true});}}),error=>error instanceof ProjectFileOpenError&&error.code==='PROJECT_FILE_OPEN_UNAVAILABLE');
  assert.equal(stats,0);assert.equal(reads,0);assert.equal(fetches,0);
 }finally{t.mock.restoreAll();syncBuiltinESMExports();}
 assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(fs.readdirSync(root),names);assert.equal(fs.existsSync(missing),false);
});

test('the real OS queue reports the exact unavailable code for each deduplicated file and keeps stopped-backend intents',async t=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-os-open-queue-')),file=path.join(root,'real.mioon'),missing=path.join(root,'missing.mioon');
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));createProjectFile(file);const before=fs.readFileSync(file),events:unknown[][]=[];let fetches=0;
 const opener=createProjectFileOpener({opened:()=>events.push(['opened']),failed:(file,code)=>events.push(['failed',file,code])});
 const run=(file:string)=>uploadProjectFile({base:'http://127.0.0.1:1',token:'synthetic-os-open-token',file,fetchImpl:async()=>{fetches++;return Response.json({ok:true});}});
 opener.add([file,missing,file]);assert.deepEqual(opener.pending,[file,missing]);opener.attach(run);await settle();
 assert.deepEqual(events,[['failed',file,'PROJECT_FILE_OPEN_UNAVAILABLE'],['failed',missing,'PROJECT_FILE_OPEN_UNAVAILABLE']]);assert.deepEqual(opener.pending,[]);assert.equal(fetches,0);
 opener.detach(run);opener.add([file]);await settle();assert.deepEqual(opener.pending,[file]);assert.equal(events.length,2);
 const aborted=new AbortController();aborted.abort();opener.attach(file=>uploadProjectFile({base:'http://127.0.0.1:1',token:'synthetic-os-open-token',file,signal:aborted.signal,fetchImpl:async()=>{fetches++;return Response.json({ok:true});}}));await settle();
 assert.deepEqual(events.at(-1),['failed',file,'PROJECT_FILE_OPEN_UNAVAILABLE']);assert.deepEqual(opener.pending,[]);assert.equal(fetches,0);assert.deepEqual(fs.readFileSync(file),before);assert.equal(fs.existsSync(missing),false);
});

test('system-open unavailable warnings have all four translations and no hidden import retry instruction',()=>{
 const values=LOCALES.map(locale=>translate(locale,'native.openProjectFileSystemUnavailable',{name:'real.mioon'}));
 assert.equal(new Set(values).size,4);for(const value of values){assert.ok(value.includes('real.mioon'));assert.equal(value.includes('native.'),false);}
 assert.equal(values[0],'从系统打开“real.mioon”尚不可用。');
 for(const locale of LOCALES)assert.doesNotMatch(translate(locale,'native.openProjectFileUnavailable',{name:'real.mioon'}),/import|导入|匯入|プロジェクトホーム/iu);
});
