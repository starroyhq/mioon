import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {once} from 'node:events';
import {constants, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createQaProject, closeQaProject} from './helpers/kernel-qa-fixture.mjs';
import {auditColdNativeQa, nativeQaDomain, nativeQaFileFingerprint, prepareNativeQaAuditLayout, readNativeQaJson, writeNativeQaJson} from './helpers/native-qa-audit.mjs';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {openServerProject} from './helpers/project-database.ts';
import {openProjectStore} from '../packages/business/src/project-file/store.ts';

const REPOSITORY=fileURLToPath(new URL('../',import.meta.url));
const HELPER=pathToFileURL(path.join(REPOSITORY,'tests/helpers/native-qa-audit.mjs')).href;
function scratch(t:TestContext){const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-native-qa-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
const child=(source:string)=>JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',source],{cwd:REPOSITORY,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024}));

test('cold manifest follows the actual registry outside projects/ and logical audit preserves all hosts, B1 preferences and schemas',async t=>{
  const root=scratch(t),dataDir=path.join(root,'data');
  const first=await createQaProject(dataDir,{name:'External',media:false}),firstId:string=first.store.projectId,oldFile:string=first.store.projectFile;
  await closeQaProject(first);
  const second=await createQaProject(dataDir,{name:'Other',media:false}),secondId:string=second.store.projectId;await closeQaProject(second);
  const external=path.join(root,'external');mkdirSync(external,{mode:0o700});const moved=path.join(external,'Moved.mioon');renameSync(oldFile,moved);
  const library=openAppLibrary({dataDir});try{const entry=library.registry.get(firstId);assert.ok(entry);library.registry.upsert({...entry,projectFile:moved});library.tx(()=>library.db.prepare('INSERT INTO workspace_preferences VALUES(?,?,?)').run(firstId,1,JSON.stringify({panels:'native synthetic state'})));}finally{library.close();}
  const layout=await prepareNativeQaAuditLayout(dataDir);
  assert.equal(layout.projects.find(project=>project.projectId===firstId)?.projectFile,moved);
  assert.equal(layout.databases.length,7);assert.deepEqual(layout.projects.map(project=>project.projectId).sort(),[firstId,secondId].sort());
  const exited=execFileSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8'});
  const cold=await auditColdNativeQa(layout,{ownerPids:[Number(exited)]});
  assert.deepEqual(Object.keys(cold.projects).sort(),[firstId,secondId].sort());
  for(const snapshot of Object.values(cold.projects))assert.deepEqual(Object.keys(snapshot.databases).sort(),['cache','main','project']);
  assert.deepEqual(cold.preferences,[{projectId:firstId,revision:1,state:{panels:'native synthetic state'}}]);
  assert.ok(cold.application.databases.main.schema.some(row=>row.name==='workspace_preferences'));
  const domain=nativeQaDomain(cold);assert.ok(domain.domainHash);assert.deepEqual(domain.domain.application.databases.main.rows.workspace_preferences,[]);
  await assert.rejects(auditColdNativeQa(layout,{ownerPids:[process.pid]}),{code:'NATIVE_QA_LIVE_OWNER'});
  assert.throws(()=>nativeQaFileFingerprint(layout.databases[0]!.file,{ownerPids:[process.pid]}),{code:'NATIVE_QA_SAME_PROCESS'});
});

test('an independent physical report runs the real warmed four CLI reads without SQLite, preserves locks, then audits cold SQL', {timeout:90000},async t=>{
  if(!constants.O_NOFOLLOW){assert.equal(typeof constants.O_NOFOLLOW==='undefined'||constants.O_NOFOLLOW===0,true);return;}
  const root=scratch(t),dataDir=path.join(root,'data');
  const prepared=await createQaProject(dataDir),id:string=prepared.store.projectId;await closeQaProject(prepared);
  const other=await createQaProject(dataDir,{name:'Second physical host',media:false});await closeQaProject(other);
  const layout=await prepareNativeQaAuditLayout(dataDir);assert.equal(layout.projects.find(project=>project.projectId===id)?.coverExpected,true);
  // Force the media-bearing project to be the measured CLI host, independent
  // of random UUID ordering in the registry.
  const measured={...layout,projects:[...layout.projects].sort((a,b)=>a.projectId===id?-1:b.projectId===id?1:0)};
  measured.databases=[layout.databases[0]!,...measured.projects.flatMap(project=>layout.databases.filter(database=>database.projectId===project.projectId))];
  const connectionFile=path.join(root,'mcp-connection.json'),tokenFile=path.join(root,'mcp-token');
  const backend=spawn(process.execPath,['--input-type=module','-e',`
    import{writeFileSync,renameSync}from'node:fs';
    const{startServer}=await import(${JSON.stringify(pathToFileURL(path.join(REPOSITORY,'apps/server/src/index.ts')).href)});
    const token='synthetic-native-qa-audit-token';
    const server=await startServer({dataDir:${JSON.stringify(dataDir)},port:0,token});
    writeFileSync(${JSON.stringify(tokenFile)},token,{mode:0o600});
    writeFileSync(${JSON.stringify(connectionFile+'.tmp')},JSON.stringify({version:1,pid:process.pid,url:server.url,tokenFile:${JSON.stringify(tokenFile)}}),{mode:0o600});
    renameSync(${JSON.stringify(connectionFile+'.tmp')},${JSON.stringify(connectionFile)});
    process.once('SIGTERM',()=>server.close().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);}));
  `],{cwd:REPOSITORY,env:{...process.env,MIOON_ENABLE_LIVE_PROVIDER:'0'},stdio:['ignore','ignore','inherit']});
  const ended=once(backend,'exit'),pid=backend.pid;assert.ok(pid);
  let done=false;t.after(async()=>{if(!done){backend.kill('SIGTERM');await ended;}});
  const deadline=Date.now()+20000;while(!existsSync(connectionFile)){assert.equal(backend.exitCode,null);assert.ok(Date.now()<deadline,'real test backend startup');await new Promise(resolve=>setTimeout(resolve,20));}
  const verified=child(`
    import{registerHooks}from'node:module';
    registerHooks({resolve(specifier,context,next){if(specifier==='node:sqlite')throw Error('Physical report must not load SQLite');return next(specifier,context);}});
    const{verifyNativeQaCliInspections}=await import(${JSON.stringify(HELPER)});
    console.log(JSON.stringify(await verifyNativeQaCliInspections(${JSON.stringify(measured)},{connectionFile:${JSON.stringify(connectionFile)},ownerPids:[${pid}],cliFile:${JSON.stringify(path.join(REPOSITORY,'apps/cli/src/index.ts'))}})));
  `) as {results:{operation:string;result:{ok:boolean}}[];allTablesUnchanged:boolean;coverReady:{status:number};physicalBefore:unknown;physicalAfter:unknown};
  assert.deepEqual(verified.results.map(value=>value.operation),['project.inspect','asset.inspect','shot.inspect','timeline.inspect']);
  assert.ok(verified.results.every(value=>value.result.ok));assert.equal(verified.allTablesUnchanged,true);assert.equal(verified.coverReady.status,200);assert.deepEqual(verified.physicalAfter,verified.physicalBefore);
  assert.throws(()=>openAppLibrary({dataDir}),{code:'APP_LIBRARY_LOCKED'});
  assert.throws(()=>openServerProject(dataDir,id),{code:'APP_LIBRARY_LOCKED'});
  const location=layout.projects.find(project=>project.projectId===id)!;
  assert.throws(()=>openProjectStore({projectFile:location.projectFile,locate:()=>({localDir:path.dirname(location.historyFile),cacheDir:path.dirname(location.cacheFile),tempDir:path.join(dataDir,'tmp','projects',id)})}),{code:'PROJECT_LOCKED'});
  await assert.rejects(auditColdNativeQa(layout,{ownerPids:[pid]}),{code:'NATIVE_QA_LIVE_OWNER'});
  backend.kill('SIGTERM');const[code,signal]=await ended;done=true;assert.equal(code,0);assert.equal(signal,null);
  const cold=await auditColdNativeQa(layout,{ownerPids:[pid]});assert.equal(Object.keys(cold.projects).length,2);assert.ok(cold.application.databases.main.schema.length>0);
});

test('physical files reject symlinks, hard links, size overflow and an owner process read',t=>{
  const root=scratch(t),file=path.join(root,'sample.db');writeFileSync(file,Buffer.alloc(128),{mode:0o600});
  const result=child(`
    import assert from'node:assert/strict';import{constants,linkSync,symlinkSync}from'node:fs';
    const{nativeQaFileFingerprint}=await import(${JSON.stringify(HELPER)}),file=${JSON.stringify(file)},options={ownerPids:[${process.pid}]};
    assert.throws(()=>nativeQaFileFingerprint(file,{ownerPids:[process.pid]}),{code:'NATIVE_QA_SAME_PROCESS'});
    if(!constants.O_NOFOLLOW){assert.throws(()=>nativeQaFileFingerprint(file,options),{code:'NATIVE_QA_UNSUPPORTED'});console.log(JSON.stringify({rejected:true}));}
    else{assert.throws(()=>nativeQaFileFingerprint(file,{...options,maxBytes:64}),{code:'NATIVE_QA_LIMIT'});symlinkSync(file,file+'.link');assert.throws(()=>nativeQaFileFingerprint(file+'.link',options),{code:'NATIVE_QA_UNSAFE_FILE'});linkSync(file,file+'.hard');assert.throws(()=>nativeQaFileFingerprint(file,options),{code:'NATIVE_QA_UNSAFE_FILE'});console.log(JSON.stringify({rejected:true}));}
  `);assert.deepEqual(result,{rejected:true});
});

test('JSON evidence publication rejects database aliases without truncating the source and publishes bounded private reports',async t=>{
  const root=scratch(t),prepared=await createQaProject(path.join(root,'data'),{media:false});await closeQaProject(prepared);
  const database=path.join(root,'data','app-library.db'),before=readFileSync(database),file=path.join(root,'snapshot.json');
  if(!constants.O_NOFOLLOW){assert.throws(()=>readNativeQaJson(file),{code:'NATIVE_QA_UNSUPPORTED'});return;}
  symlinkSync(database,file);assert.throws(()=>writeNativeQaJson(file,{overwrite:false}),{code:'NATIVE_QA_UNSAFE_FILE'});unlinkSync(file);
  linkSync(database,file);assert.throws(()=>writeNativeQaJson(file,{overwrite:false}),{code:'NATIVE_QA_UNSAFE_FILE'});unlinkSync(file);
  assert.deepEqual(readFileSync(database),before);
  writeNativeQaJson(file,{phase:'live',credentialPrinted:false});assert.deepEqual(readNativeQaJson(file),{phase:'live',credentialPrinted:false});
  writeNativeQaJson(file,{phase:'cold',credentialPrinted:false});assert.deepEqual(readNativeQaJson(file),{phase:'cold',credentialPrinted:false});
  assert.deepEqual(readFileSync(database),before);
});

for(const mutation of['same-size-clock-tick','same-inode-new-birth','new-super-journal']as const)test(`physical audit refuses deterministic ${mutation} instability`,async t=>{
  if(!constants.O_NOFOLLOW){assert.equal(typeof constants.O_NOFOLLOW==='undefined'||constants.O_NOFOLLOW===0,true);return;}
  const root=scratch(t),prepared=await createQaProject(path.join(root,'data'),{media:false});await closeQaProject(prepared);
  const layout=await prepareNativeQaAuditLayout(path.join(root,'data')),file=mutation==='new-super-journal'?layout.projects[0]!.historyFile:layout.databases[0]!.file;
  const result=child(`
    import assert from'node:assert/strict';import fs from'node:fs';import{syncBuiltinESMExports}from'node:module';
    const file=${JSON.stringify(file)},kind=${JSON.stringify(mutation)},before=fs.lstatSync(file,{bigint:true}),originalRead=fs.readSync,originalLstat=fs.lstatSync,originalFstat=fs.fstatSync,originalOpen=fs.openSync,originalClose=fs.closeSync;
    let changed=false;const targetFds=new Set();
    const fake=info=>{const result=Object.assign(Object.create(Object.getPrototypeOf(info)),info);if(info.isFile()){for(const key of['dev','ino','mode','uid','gid','nlink','size'])result[key]=before[key];result.mtimeNs=111n;result.ctimeNs=111n;result.birthtimeNs=kind==='same-inode-new-birth'&&info.ino!==before.ino?before.birthtimeNs+1n:before.birthtimeNs;}return result;};
    fs.openSync=(...args)=>{const fd=originalOpen(...args);if(args[0]===file)targetFds.add(fd);return fd;};fs.closeSync=fd=>{targetFds.delete(fd);return originalClose(fd);};
    fs.lstatSync=(...args)=>args[0]===file?fake(originalLstat(...args)):originalLstat(...args);fs.fstatSync=(...args)=>targetFds.has(args[0])?fake(originalFstat(...args)):originalFstat(...args);
    fs.readSync=(...args)=>{const n=originalRead(...args);if(n&&targetFds.has(args[0])&&!changed){changed=true;if(kind==='same-size-clock-tick')fs.writeFileSync(file,Buffer.alloc(Number(before.size),0x33));else if(kind==='same-inode-new-birth'){fs.writeFileSync(file+'.replacement',fs.readFileSync(file),{mode:0o600});fs.renameSync(file+'.replacement',file);}else fs.writeFileSync(file+'-mj1234569AB',Buffer.from('new super journal'),{mode:0o600});}return n;};
    syncBuiltinESMExports();
    const{nativeQaFileFingerprint,snapshotNativeQaFiles}=await import(${JSON.stringify(HELPER)});
    assert.throws(()=>kind==='new-super-journal'?snapshotNativeQaFiles(${JSON.stringify(layout)},{ownerPids:[${process.pid}]}):nativeQaFileFingerprint(file,{ownerPids:[${process.pid}]}),{code:'NATIVE_QA_UNSTABLE'});
    assert.equal(changed,true);console.log(JSON.stringify({rejected:true}));
  `);assert.deepEqual(result,{rejected:true});
});
